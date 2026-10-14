import { createServer, type Server } from 'node:net';
import { deflateRawSync } from 'node:zlib';

/** ملفات اختبار صغيرة صالحة لكل نوع مدعوم، ومولد ZIP بسيط لبناء DOCX/XLSX وحالات ZIP bomb. */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  /** يضبط علم التشفير (bit 0) دون تشفير فعلي. */
  encryptedFlag?: boolean;
  store?: boolean;
}

export function buildZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const compressed = e.store ? e.data : deflateRawSync(e.data);
    const method = e.store ? 0 : 8;
    const flags = e.encryptedFlag ? 1 : 0;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xml = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${s}`);

/** عنصر ISO BMFF: طول 32 بت ثم النوع ثم المحتوى. */
export function isoBox(type: string, payload: Buffer = Buffer.alloc(8)): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
}

/** فيديو MP4/MOV صغير البنية (ftyp بعلامة brand ثم العناصر المطلوبة). brand=null ⇒ بلا ftyp. */
export function isoMedia(brand: string | null, boxes: string[] = ['moov', 'mdat']): Buffer {
  const ftyp = brand
    ? [isoBox('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), Buffer.alloc(4)]))]
    : [];
  return Buffer.concat([...ftyp, ...boxes.map((t) => isoBox(t, Buffer.alloc(32, 1)))]);
}

/** عنصر EBML: المعرّف كما هو ثم حجم بصيغة 8 بايت؛ size=null ⇒ حجم غير معروف (كل البتات 1). */
export function ebml(id: number[], data: Buffer, size: number | null = data.length): Buffer {
  const s = Buffer.alloc(8, 0xff);
  if (size !== null) s.writeBigUInt64BE(BigInt(size), 0);
  s[0] = 0x01;
  return Buffer.concat([Buffer.from(id), s, data]);
}

/** فيديو WebM صغير البنية: ترويسة EBML (DocType) ثم Segment يحتوي Tracks وCluster. */
export function webm(
  opts: { docType?: string; tracks?: boolean; cluster?: boolean; unknownSizes?: boolean } = {},
): Buffer {
  const { docType = 'webm', tracks = true, cluster = true, unknownSizes = false } = opts;
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], Buffer.from(docType, 'latin1')));
  const children = [
    ebml([0x15, 0x49, 0xa9, 0x66], Buffer.alloc(16, 2)), // Info
    ...(tracks ? [ebml([0x16, 0x54, 0xae, 0x6b], Buffer.alloc(24, 3))] : []),
    ...(cluster
      ? [ebml([0x1f, 0x43, 0xb6, 0x75], Buffer.alloc(64, 4), unknownSizes ? null : 64)]
      : []),
  ];
  const body = Buffer.concat(children);
  const segment = ebml([0x18, 0x53, 0x80, 0x67], body, unknownSizes ? null : body.length);
  return Buffer.concat([header, segment]);
}

export const samples = {
  pdf: () =>
    Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    ),
  encryptedPdf: () =>
    Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R/Encrypt 5 0 R>>\n%%EOF\n'),
  png: () =>
    Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
      'hex',
    ),
  jpg: () =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0'),
      Buffer.alloc(20),
      Buffer.from([0xff, 0xd9]),
    ]),
  webp: () => {
    const body = Buffer.concat([Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
    const head = Buffer.alloc(8);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  },
  docx: () =>
    buildZip([
      { name: '[Content_Types].xml', data: xml('<Types/>') },
      { name: 'word/document.xml', data: xml('<w:document>مرحبا</w:document>') },
    ]),
  xlsx: () =>
    buildZip([
      { name: '[Content_Types].xml', data: xml('<Types/>') },
      { name: 'xl/workbook.xml', data: xml('<workbook/>') },
    ]),
  txt: () => Buffer.from('سطر عربي\nsecond line\twith tab\r\n', 'utf8'),
  mp4: () => isoMedia('isom'),
  mov: () => isoMedia('qt  '),
  webm: () => webm(),
  /** ملف اختبار EICAR القياسي (غير ضار) لاختبار مسار الكشف. */
  eicar: () =>
    Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1'),
};

/**
 * خادم clamd وهمي لاختبار البروتوكول ومسارات الفشل دون ClamAV حقيقي:
 * يجمع INSTREAM ويعيد FOUND إن احتوى سلسلة EICAR، وإلا OK. يمكن جعله يتعطل أو يتأخر.
 */
export async function startFakeClamd(
  mode: { current: 'ok' | 'down' | 'slow' | 'garbage' } = { current: 'ok' },
): Promise<{ port: number; server: Server; mode: typeof mode; scans: () => number }> {
  let scans = 0;
  const server = createServer((socket) => {
    if (mode.current === 'down') {
      socket.destroy();
      return;
    }
    let buf = Buffer.alloc(0);
    let command: string | null = null;
    const chunks: Buffer[] = [];
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (command === null) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        command = buf.subarray(0, z).toString();
        buf = buf.subarray(z + 1);
        if (command === 'zVERSION') {
          socket.end('ClamAV 1.4.3/27800/Fake\0');
          return;
        }
      }
      if (command !== 'zINSTREAM') return;
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          scans++;
          const data = Buffer.concat(chunks);
          const reply = data.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
            ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
            : 'stream: OK\0';
          if (mode.current === 'slow') return; // لا رد: انتهاء المهلة
          if (mode.current === 'garbage') {
            socket.end('???\0');
            return;
          }
          socket.end(reply);
          return;
        }
        if (buf.length < 4 + len) return;
        chunks.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, server, mode, scans: () => scans };
}
