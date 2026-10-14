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
  mp4: 'MP4',
  mov: 'MOV',
  webm: 'WEBM',
};

const EXTENSIONS: Record<FileKind, string[]> = {
  PDF: ['pdf'],
  JPG: ['jpg', 'jpeg'],
  PNG: ['png'],
  WEBP: ['webp'],
  DOCX: ['docx'],
  XLSX: ['xlsx'],
  TXT: ['txt'],
  MP4: ['mp4'],
  MOV: ['mov'],
  WEBM: ['webm'],
};

/** أنواع الفيديو. */
export const VIDEO_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['MP4', 'MOV', 'WEBM']);

/** الأنواع التي تُعرض داخل صفحة الإدارة (صور وفيديو)؛ غيرها تنزيل فقط. */
export const INLINE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'JPG',
  'PNG',
  'WEBP',
  'MP4',
  'MOV',
  'WEBM',
]);

/** نوع المحتوى الحقيقي لكل نوع مكتشف (يُرسل في Content-Type عند العرض والتنزيل). */
export const MIME_BY_KIND: Record<FileKind, string> = {
  PDF: 'application/pdf',
  JPG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  TXT: 'text/plain; charset=utf-8',
  MP4: 'video/mp4',
  MOV: 'video/quicktime',
  WEBM: 'video/webm',
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

const EBML_ID = 0x1a45dfa3;
const ISO_HEADLESS_FIRST = new Set(['moov', 'mdat', 'wide', 'free', 'skip']);
/** علامات ISO BMFF لصيغ ليست فيديو (صور HEIF/AVIF وصوت M4A) تُرفض حتى لو صحت بنيتها. */
const NON_VIDEO_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);
const NON_VIDEO_BRAND_PREFIX = ['M4A', 'M4B', 'M4P', 'crx'];
/** حد عدد العناصر التي تُقرأ عند التحقق من بنية الفيديو (يمنع ملفات مصممة لإبطاء الفحص). */
const MEDIA_MAX_ELEMENTS = 200_000;

function detectMagic(head: Buffer): FileKind | 'ZIP' | 'OLE' | 'ISO' | 'EBML' | null {
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
  const boxType = head.subarray(4, 8).toString('latin1');
  if (boxType === 'ftyp') return 'ISO';
  // QuickTime قديم بلا ftyp: أول عنصر moov/mdat/wide/free/skip بطول معقول (≥ 8)
  if (ISO_HEADLESS_FIRST.has(boxType) && head.length >= 8 && head.readUInt32BE(0) >= 8) {
    return 'ISO';
  }
  if (head.length >= 4 && head.readUInt32BE(0) === EBML_ID) return 'EBML';
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

const BAD_VIDEO = 'بنية ملف الفيديو غير سليمة.';

/**
 * MP4/MOV (ISO BMFF): يمشي العناصر العليا كلها ويتحقق أن أطوالها متسقة مع حجم الملف،
 * وأن ftyp (إن وجد) أولًا، وأن الملف يحتوي moov وmdat. علامة qt (أو غياب ftyp) ⇒ MOV، وغيرها ⇒ MP4.
 */
async function inspectIsoMedia(fh: FileHandle, size: number): Promise<'MP4' | 'MOV'> {
  let pos = 0;
  let brand: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; pos < size; i++) {
    if (i >= MEDIA_MAX_ELEMENTS) reject(BAD_VIDEO);
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) reject(BAD_VIDEO);
    const type = h.subarray(4, 8).toString('latin1');
    if (!/^[\x20-\x7e]{4}$/.test(type)) reject(BAD_VIDEO);
    let len = h.readUInt32BE(0);
    let header = 8;
    if (len === 1) {
      if (h.length < 16) reject(BAD_VIDEO);
      const big = h.readBigUInt64BE(8);
      if (big > BigInt(size)) reject(BAD_VIDEO);
      len = Number(big);
      header = 16;
    } else if (len === 0) {
      len = size - pos; // العنصر الأخير يمتد حتى نهاية الملف
    }
    if (len < header || pos + len > size) reject(BAD_VIDEO);
    if (i === 0 && type === 'ftyp') {
      if (len < header + 8) reject(BAD_VIDEO);
      brand = (await readAt(fh, pos + header, 4)).toString('latin1');
    } else if (i === 0 && !ISO_HEADLESS_FIRST.has(type)) {
      reject('الملف ليس فيديو MP4 أو MOV.');
    } else if (type === 'ftyp') {
      reject(BAD_VIDEO);
    }
    seen.add(type);
    pos += len;
  }
  if (
    brand &&
    (NON_VIDEO_BRANDS.has(brand) || NON_VIDEO_BRAND_PREFIX.some((p) => brand!.startsWith(p)))
  ) {
    reject('الملف ليس فيديو (صورة أو صوت بصيغة مشابهة).');
  }
  if (!seen.has('moov') || !seen.has('mdat')) {
    reject('ملف الفيديو ناقص: لا يحتوي بيانات التشغيل والمحتوى معًا.');
  }
  return brand === null || brand === 'qt  ' ? 'MOV' : 'MP4';
}

interface EbmlElement {
  id: number;
  dataStart: number;
  /** null = حجم غير معروف (يمتد حتى نهاية الأب). */
  dataSize: number | null;
}

const vintLength = (byte: number): number => {
  for (let i = 0; i < 8; i++) if (byte & (0x80 >> i)) return i + 1;
  return 0;
};

async function readEbml(fh: FileHandle, pos: number): Promise<EbmlElement> {
  const b = await readAt(fh, pos, 12);
  const idLen = b.length ? vintLength(b[0]!) : 0;
  if (!idLen || idLen > 4 || b.length < idLen + 1) reject(BAD_VIDEO);
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[i]!;
  const sLen = vintLength(b[idLen]!);
  if (!sLen || b.length < idLen + sLen) reject(BAD_VIDEO);
  const mask = 0xff >> sLen;
  let value = b[idLen]! & mask;
  let allOnes = value === mask;
  for (let i = 1; i < sLen; i++) {
    const x = b[idLen + i]!;
    value = value * 256 + x;
    if (x !== 0xff) allOnes = false;
  }
  return { id, dataStart: pos + idLen + sLen, dataSize: allOnes ? null : value };
}

const EBML = {
  docType: 0x4282,
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  cluster: 0x1f43b675,
};

/**
 * WebM: ترويسة EBML بنوع مستند webm (لا Matroska عام)، ثم Segment يحتوي Tracks وCluster،
 * مع اتساق أطوال العناصر مع حجم الملف. الحجم غير المعروف مسموح لـ Segment وCluster فقط (تسجيل المتصفح).
 */
async function inspectWebm(fh: FileHandle, size: number): Promise<'WEBM'> {
  const header = await readEbml(fh, 0);
  if (header.id !== EBML_ID || header.dataSize === null || header.dataSize > 4096)
    reject(BAD_VIDEO);
  const headerEnd = header.dataStart + header.dataSize!;
  if (headerEnd > size) reject(BAD_VIDEO);
  let docType: string | null = null;
  for (let p = header.dataStart; p < headerEnd;) {
    const el = await readEbml(fh, p);
    if (el.dataSize === null || el.dataStart + el.dataSize > headerEnd) reject(BAD_VIDEO);
    if (el.id === EBML.docType) {
      docType = (await readAt(fh, el.dataStart, el.dataSize!))
        .toString('latin1')
        .replace(/\0+$/, '');
    }
    p = el.dataStart + el.dataSize!;
  }
  if (docType !== 'webm') reject('الملف ليس فيديو WebM.');
  const segment = await readEbml(fh, headerEnd);
  if (segment.id !== EBML.segment) reject(BAD_VIDEO);
  const segEnd = segment.dataSize === null ? size : segment.dataStart + segment.dataSize;
  if (segEnd > size) reject('ملف الفيديو مقطوع أو ناقص.');
  let tracks = false;
  let cluster = false;
  let p = segment.dataStart;
  for (let i = 0; p < segEnd; i++) {
    if (i >= MEDIA_MAX_ELEMENTS) reject(BAD_VIDEO);
    const el = await readEbml(fh, p);
    if (el.id === EBML.tracks) tracks = true;
    if (el.id === EBML.cluster) cluster = true;
    if (el.dataSize === null) {
      if (el.id !== EBML.cluster) reject(BAD_VIDEO);
      break; // Cluster بحجم غير معروف يمتد حتى النهاية
    }
    if (el.dataStart + el.dataSize > segEnd) reject('ملف الفيديو مقطوع أو ناقص.');
    p = el.dataStart + el.dataSize;
  }
  if (!tracks || !cluster) reject('ملف الفيديو ناقص: لا يحتوي المسارات والمحتوى معًا.');
  return 'WEBM';
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
    else if (magic === 'ISO') kind = await inspectIsoMedia(fh, size);
    else if (magic === 'EBML') kind = await inspectWebm(fh, size);
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
