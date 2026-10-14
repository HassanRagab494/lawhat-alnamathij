import { FileKind } from '@prisma/client';
import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { extensionOf } from './filename';

/**
 * تحديد نوع الملف من محتواه الفعلي والتحقق من سلامته، دون الاعتماد على الامتداد أو MIME المرسل.
 * الامتداد يجب أن يطابق النوع المكتشف أيضًا (يُرفض ملف PNG باسم .pdf).
 * أي ملف مشفر أو يتعذر التحقق منه يُرفض في هذه النسخة.
 */

export const KIND_BY_KEY: Record<string, FileKind> = {
  pdf: 'PDF',
  jpg: 'JPG',
  png: 'PNG',
  webp: 'WEBP',
  docx: 'DOCX',
  xlsx: 'XLSX',
  txt: 'TXT',
};

const EXTENSIONS: Record<FileKind, string[]> = {
  PDF: ['pdf'],
  JPG: ['jpg', 'jpeg'],
  PNG: ['png'],
  WEBP: ['webp'],
  DOCX: ['docx'],
  XLSX: ['xlsx'],
  TXT: ['txt'],
};

/** حدود فحص حاويات DOCX/XLSX (ZIP) لمنع ZIP bombs. */
export const ZIP_LIMITS = {
  maxEntries: 2000,
  maxTotalUncompressed: 100 * 1024 * 1024,
  maxEntryUncompressed: 50 * 1024 * 1024,
  /** نسبة الفك القصوى لكل عنصر (للعناصر الأكبر من 1MB بعد الفك). */
  maxRatio: 100,
};

export class FileRejected extends Error {}

const reject = (message: string): never => {
  throw new FileRejected(message);
};

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** يبحث عن نص في الملف بالتدفق (دون تحميله كاملًا). */
async function fileContains(fh: FileHandle, size: number, needle: Buffer): Promise<boolean> {
  const chunk = 1024 * 1024;
  for (let pos = 0; pos < size; pos += chunk - needle.length) {
    const buf = await readAt(fh, pos, Math.min(chunk, size - pos));
    if (buf.includes(needle)) return true;
    if (buf.length < chunk) break;
  }
  return false;
}

function detectMagic(head: Buffer): FileKind | 'ZIP' | 'OLE' | null {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'JPG';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'PNG';
  }
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'WEBP';
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'ZIP';
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return 'OLE';
  }
  return null;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** يقرأ الدليل المركزي لملف ZIP (دون ZIP64). */
async function readZipEntries(fh: FileHandle, size: number): Promise<ZipEntry[]> {
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await readAt(fh, size - tailLen, tailLen);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) reject('الملف ليس مستند Office سليمًا (بنية الحاوية ناقصة).');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    reject('صيغة ZIP64 غير مدعومة في هذه النسخة.');
  }
  if (count > ZIP_LIMITS.maxEntries) reject('عدد العناصر داخل المستند كبير جدًا.');
  if (cdOffset + cdSize > size) reject('بنية المستند غير سليمة.');
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) reject('بنية المستند غير سليمة.');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      reject('صيغة ZIP64 غير مدعومة في هذه النسخة.');
    }
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * يتحقق من حاوية DOCX/XLSX: العناصر المطلوبة، لا تشفير، لا مسارات خطرة،
 * ويفك كل عنصر فعليًا بحد أقصى للحجم (لا يثق بالأحجام المعلنة) ويقيس نسبة الضغط.
 */
async function inspectOfficeZip(fh: FileHandle, size: number): Promise<'DOCX' | 'XLSX'> {
  const entries = await readZipEntries(fh, size);
  const names = new Set(entries.map((e) => e.name));
  const kind: 'DOCX' | 'XLSX' | null = names.has('[Content_Types].xml')
    ? names.has('word/document.xml')
      ? 'DOCX'
      : names.has('xl/workbook.xml')
        ? 'XLSX'
        : null
    : null;
  if (!kind) reject('الملف المضغوط ليس مستند Word أو Excel.');
  let total = 0;
  for (const e of entries) {
    if (e.flags & 0x1) reject('المستندات المحمية بكلمة مرور أو المشفرة غير مقبولة.');
    if (e.name.startsWith('/') || e.name.includes('..') || e.name.includes('\\')) {
      reject('المستند يحتوي مسارات غير آمنة.');
    }
    if (e.method !== 0 && e.method !== 8) reject('طريقة ضغط غير مدعومة داخل المستند.');
    const local = await readAt(fh, e.localOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50)
      reject('بنية المستند غير سليمة.');
    const dataStart = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataStart + e.compressedSize > size) reject('بنية المستند غير سليمة.');
    const remaining = ZIP_LIMITS.maxTotalUncompressed - total;
    const cap = Math.min(ZIP_LIMITS.maxEntryUncompressed, remaining);
    let out: number;
    if (e.method === 0) {
      out = e.compressedSize;
    } else {
      const compressed = await readAt(fh, dataStart, e.compressedSize);
      try {
        out = inflateRawSync(compressed, { maxOutputLength: Math.max(cap, 1) }).length;
      } catch {
        reject('حجم المستند بعد فك الضغط يتجاوز الحد المسموح أو أن محتواه تالف.');
      }
    }
    if (out! > cap) reject('حجم المستند بعد فك الضغط يتجاوز الحد المسموح.');
    if (out! > 1024 * 1024 && out! / Math.max(e.compressedSize, 1) > ZIP_LIMITS.maxRatio) {
      reject('نسبة ضغط المستند مرتفعة بشكل غير طبيعي.');
    }
    total += out!;
  }
  return kind!;
}

/** نص UTF-8 صالح (مع BOM اختياري)، دون NUL أو محارف تحكم غير نصية. يُقرأ بالتدفق. */
async function inspectText(fh: FileHandle, size: number): Promise<void> {
  if (size === 0) reject('الملف النصي فارغ.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunk = 256 * 1024;
  try {
    for (let pos = 0; pos < size; pos += chunk) {
      const buf = await readAt(fh, pos, Math.min(chunk, size - pos));
      const text = decoder.decode(buf, { stream: pos + buf.length < size });
      // يُسمح بـ Tab وLF وCR وFF فقط من محارف التحكم
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
        reject('الملف النصي يحتوي بيانات ثنائية غير مسموحة.');
      }
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof FileRejected) throw error;
    reject('الملف النصي ليس بترميز UTF-8 صالح.');
  }
}

/**
 * يحدد النوع من المحتوى، ويتحقق من مطابقة الامتداد ومن الأنواع المسموحة للسؤال.
 * @param allowed مفاتيح الأنواع المسموحة في إعداد السؤال (pdf، jpg، …)
 */
export async function inspectFile(
  path: string,
  size: number,
  displayName: string,
  allowed: readonly string[],
): Promise<FileKind> {
  const fh = await open(path, 'r');
  try {
    if (size === 0) reject('الملف فارغ.');
    const head = await readAt(fh, 0, 16);
    const magic = detectMagic(head);
    let kind: FileKind;
    if (magic === 'OLE') {
      throw new FileRejected(
        'صيغ Office القديمة والمستندات المشفرة غير مقبولة؛ احفظ الملف بصيغة DOCX أو XLSX.',
      );
    }
    if (magic === 'ZIP') kind = await inspectOfficeZip(fh, size);
    else if (magic) kind = magic;
    else {
      await inspectText(fh, size);
      kind = 'TXT';
    }
    if (kind! === 'PDF' && (await fileContains(fh, size, Buffer.from('/Encrypt')))) {
      reject('ملفات PDF المحمية بكلمة مرور أو المشفرة غير مقبولة.');
    }
    const allowedKinds = new Set(allowed.map((k) => KIND_BY_KEY[k]).filter(Boolean));
    if (!allowedKinds.has(kind!)) reject('نوع الملف غير مسموح في هذا السؤال.');
    if (!EXTENSIONS[kind!].includes(extensionOf(displayName))) {
      reject('امتداد الملف لا يطابق محتواه الفعلي.');
    }
    return kind!;
  } finally {
    await fh.close();
  }
}
