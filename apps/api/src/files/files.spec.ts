import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buildZip, samples, startFakeClamd } from '../../test/fixtures/files';
import { FileRejected, inspectFile } from './file-kind';
import { extensionOf, sanitizeFileName } from './filename';
import { ClamdScanner, ScanUnavailable } from './scanner';
import { LocalDiskStorage, TooLarge } from './storage';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lawha-files-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function check(
  data: Buffer,
  name: string,
  allowed: string[] = ['pdf', 'jpg', 'png', 'webp', 'docx', 'xlsx', 'txt'],
) {
  const path = join(dir, `f${n++}`);
  await writeFile(path, data);
  return inspectFile(path, data.length, name, allowed);
}

describe('sanitizeFileName', () => {
  it('يزيل المسار ومحارف التحكم والاتجاه والمحجوزة ويحافظ على الامتداد', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\سيرة.pdf')).toBe('سيرة.pdf');
    expect(sanitizeFileName('evil\u202Efdp.exe')).toBe('evilfdp.exe');
    expect(sanitizeFileName('a<b>:c|d?.txt')).toBe('a_b__c_d_.txt');
    expect(sanitizeFileName('\u0000\u0007 ')).toBe('ملف');
    expect(sanitizeFileName('...hidden.')).toBe('hidden');
    const long = `${'ن'.repeat(300)}.docx`;
    expect(sanitizeFileName(long)).toHaveLength(150);
    expect(sanitizeFileName(long).endsWith('.docx')).toBe(true);
    expect(extensionOf('Report.PDF')).toBe('pdf');
  });
});

describe('inspectFile — النوع من المحتوى الفعلي', () => {
  it.each([
    ['pdf', 'a.pdf', 'PDF'],
    ['jpg', 'a.jpeg', 'JPG'],
    ['png', 'a.png', 'PNG'],
    ['webp', 'a.webp', 'WEBP'],
    ['docx', 'a.docx', 'DOCX'],
    ['xlsx', 'a.xlsx', 'XLSX'],
    ['txt', 'a.txt', 'TXT'],
  ] as const)('يقبل %s صالحًا', async (key, name, kind) => {
    await expect(check(samples[key](), name)).resolves.toBe(kind);
  });

  it('يرفض امتدادًا مزيفًا ونوعًا غير مسموح في السؤال', async () => {
    await expect(check(samples.png(), 'photo.pdf')).rejects.toThrow('امتداد الملف لا يطابق');
    await expect(check(samples.pdf(), 'a.pdf', ['png'])).rejects.toThrow('غير مسموح');
    // ملف تنفيذي باسم .txt: بيانات ثنائية
    await expect(check(Buffer.from([0x4d, 0x5a, 0, 0, 3, 0, 0, 0]), 'a.txt')).rejects.toThrow(
      'بيانات ثنائية',
    );
  });

  it('يرفض PDF المشفر وصيغ OLE والملف الفارغ', async () => {
    await expect(check(samples.encryptedPdf(), 'a.pdf')).rejects.toThrow('المشفرة');
    const ole = Buffer.from('d0cf11e0a1b11ae1' + '00'.repeat(32), 'hex');
    await expect(check(ole, 'a.docx')).rejects.toThrow('Office القديمة');
    await expect(check(Buffer.alloc(0), 'a.txt')).rejects.toThrow('فارغ');
  });

  it('يرفض نصًا بترميز غير UTF-8', async () => {
    await expect(check(Buffer.from([0x61, 0xff, 0xfe, 0x62]), 'a.txt')).rejects.toThrow('UTF-8');
  });

  it('يرفض ZIP ليس مستند Office، والمحمي بكلمة مرور، والمسارات الخطرة', async () => {
    const plain = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    await expect(check(plain, 'a.docx')).rejects.toThrow('ليس مستند Word أو Excel');
    const enc = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<x/>') },
      { name: 'word/document.xml', data: Buffer.from('<x/>'), encryptedFlag: true },
    ]);
    await expect(check(enc, 'a.docx')).rejects.toThrow('المحمية بكلمة مرور');
    const traversal = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<x/>') },
      { name: 'word/document.xml', data: Buffer.from('<x/>') },
      { name: '../../evil.sh', data: Buffer.from('x') },
    ]);
    await expect(check(traversal, 'a.docx')).rejects.toThrow('مسارات غير آمنة');
  });

  it('يمنع ZIP bomb مصغرة: فك فعلي بحد للحجم ونسبة الضغط', async () => {
    // 60MB أصفار تُضغط لبضعة كيلوبايت: تتجاوز حد العنصر (50MB) عند الفك الفعلي
    const big = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<x/>') },
      { name: 'word/document.xml', data: Buffer.alloc(60 * 1024 * 1024) },
    ]);
    expect(big.length).toBeLessThan(200 * 1024);
    await expect(check(big, 'bomb.docx')).rejects.toThrow('فك الضغط');
    // 4MB أصفار: ضمن الحجم لكن نسبة الضغط > 100
    const ratio = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<x/>') },
      { name: 'xl/workbook.xml', data: Buffer.alloc(4 * 1024 * 1024) },
    ]);
    await expect(check(ratio, 'bomb.xlsx')).rejects.toThrow('نسبة ضغط');
  }, 30_000);
});

describe('LocalDiskStorage', () => {
  it('يكتب بالتدفق مع التجزئة، ويقطع ويحذف الجزء عند تجاوز الحد', async () => {
    const root = join(dir, 'store');
    const s = new LocalDiskStorage(root);
    await s.init();
    const temp = await s.writeTemp(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 10);
    expect(temp.size).toBe(6);
    expect(temp.sha256).toBe('bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
    const key = await s.commit(temp);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(await s.exists(key)).toBe(true);
    await expect(s.writeTemp(Readable.from([Buffer.alloc(20)]), 10)).rejects.toBeInstanceOf(
      TooLarge,
    );
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
    expect(() => s.openRead('../../etc/passwd')).toThrow('invalid storage key');
  });

  it('ينظف الأجزاء المؤقتة القديمة التي أنشأها فقط', async () => {
    const root = join(dir, 'store2');
    const s = new LocalDiskStorage(root);
    await s.init();
    const old = join(root, 'tmp', `${'a'.repeat(32)}.part`);
    const foreign = join(root, 'tmp', 'notes.txt');
    await writeFile(old, 'x');
    await writeFile(foreign, 'y');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, past, past);
    await utimes(foreign, past, past);
    expect(await s.removeStaleTemp(60 * 60 * 1000)).toBe(1);
    await expect(stat(old)).rejects.toThrow();
    expect((await stat(foreign)).isFile()).toBe(true);
  });
});

describe('ClamdScanner مع خادم clamd وهمي', () => {
  it('سليم، EICAR، تعطل، مهلة، ورد غير مفهوم: لا يُعد الملف سليمًا إلا بنتيجة صريحة', async () => {
    const fake = await startFakeClamd();
    const scanner = new ClamdScanner('127.0.0.1', fake.port, 1500);
    const clean = join(dir, 'clean.txt');
    const eicar = join(dir, 'eicar.txt');
    await writeFile(clean, 'hello');
    await writeFile(eicar, samples.eicar());
    try {
      await expect(scanner.scanFile(clean)).resolves.toEqual({
        clean: true,
        engine: 'ClamAV 1.4.3/27800/Fake',
      });
      await expect(scanner.scanFile(eicar)).resolves.toEqual({
        clean: false,
        signature: 'Win.Test.EICAR_HDB-1',
      });
      fake.mode.current = 'slow';
      await expect(scanner.scanFile(clean)).rejects.toBeInstanceOf(ScanUnavailable);
      fake.mode.current = 'garbage';
      await expect(scanner.scanFile(clean)).rejects.toBeInstanceOf(ScanUnavailable);
      fake.mode.current = 'down';
      await expect(scanner.scanFile(clean)).rejects.toBeInstanceOf(ScanUnavailable);
    } finally {
      fake.server.close();
    }
    const nobody = new ClamdScanner('127.0.0.1', 1, 1000);
    await expect(nobody.scanFile(clean)).rejects.toBeInstanceOf(ScanUnavailable);
  }, 20_000);

  it('FileRejected نوع خطأ مستقل', () => {
    expect(new FileRejected('x')).toBeInstanceOf(Error);
  });
});
