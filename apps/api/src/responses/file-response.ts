import type { FileKind } from '@prisma/client';
import { INLINE_KINDS, MIME_BY_KIND } from '../files/file-kind';

/** طريقة تقديم ملف الرد: معاينة داخل الصفحة (صور وفيديو فقط) أو تنزيل. */
export type FileDisposition = 'inline' | 'attachment';

export const canPreview = (kind: FileKind): boolean => INLINE_KINDS.has(kind);

/** اسم ASCII احتياطي واسم UTF-8 كامل وفق RFC 6266/5987. */
export function contentDisposition(
  name: string,
  disposition: FileDisposition = 'attachment',
): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'file';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * يحلل ترويسة Range لمدى واحد (bytes=a-b أو a- أو -n). undefined = الملف كله (لا ترويسة أو مدى متعدد
 * أو وحدة غير bytes)، و'unsatisfiable' = مدى خارج الملف (416).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (!a && !b) return undefined;
  if (size === 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (!a) {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return 'unsatisfiable';
  }
  return { start, end };
}

/**
 * ترويسات ملف خاص: النوع الحقيقي، nosniff، CSP مقيدة، ومنع التخزين المؤقت.
 * المعاينة تسمح للمتصفح بعرض الصورة/الفيديو فقط؛ الصفحة نفسها في sandbox دون سكربتات.
 */
export function privateFileHeaders(
  kind: FileKind,
  name: string,
  disposition: FileDisposition,
): Record<string, string> {
  return {
    'Content-Type': MIME_BY_KIND[kind],
    'Content-Disposition': contentDisposition(name, disposition),
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      disposition === 'inline'
        ? "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
        : "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': disposition === 'inline' ? 'bytes' : 'none',
  };
}
