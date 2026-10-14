import type { FileKind } from '@prisma/client';

/**
 * حدود Flowmax لوسائط العقار، من كوده:
 * - الصور: jpeg/png/webp حتى 10MiB، وحتى 25 صورة (PropertyService::MAX_IMAGES_PER_PROPERTY).
 * - الفيديو: mp4/quicktime/webm حتى 100MiB، وحتى 5 فيديوهات (config properties.video_max_*).
 * أي ملف خارجها يُعرض للأدمن قبل الاعتماد، ولا يُرسل إلا بعد معالجته أو استبعاده صراحة.
 */
export const FLOWMAX_MEDIA_LIMITS = {
  imageMaxBytes: 10 * 1024 * 1024,
  imageMaxCount: 25,
  videoMaxBytes: 100 * 1024 * 1024,
  videoMaxCount: 5,
};

const IMAGE_KINDS = new Set<FileKind>(['JPG', 'PNG', 'WEBP']);
const VIDEO_KINDS = new Set<FileKind>(['MP4', 'MOV', 'WEBM']);

export type MediaRole = 'image' | 'video';
export type MediaItemStatus = 'PENDING' | 'SENT' | 'FAILED' | 'EXCLUDED';

/** نتيجة كل مرفق في سجل التكامل. */
export interface MediaItem {
  fileId: string;
  role: MediaRole;
  status: MediaItemStatus;
  /** معرّف الملف في Flowmax بعد نجاح النقل. */
  externalId?: string | null;
  error?: string | null;
  /** سبب الاستبعاد ومن استبعده (اختيار صريح من الأدمن). */
  excludedReason?: string | null;
  excludedById?: string | null;
}

export interface MediaCandidate {
  fileId: string;
  name: string;
  kind: FileKind;
  size: number;
  role: MediaRole;
}

export interface IncompatibleMedia {
  fileId: string;
  name: string;
  reason: string;
}

const MB = 1024 * 1024;

/** الملفات التي لا يقبلها Flowmax وسبب كل منها (بالترتيب، فالزائد عن العدد هو الأخير). */
export function incompatibleMedia(files: MediaCandidate[]): IncompatibleMedia[] {
  const out: IncompatibleMedia[] = [];
  let images = 0;
  let videos = 0;
  for (const f of files) {
    const reject = (reason: string) => out.push({ fileId: f.fileId, name: f.name, reason });
    if (f.role === 'image') {
      if (!IMAGE_KINDS.has(f.kind)) reject('Flowmax يقبل صور JPG وPNG وWEBP فقط.');
      else if (f.size > FLOWMAX_MEDIA_LIMITS.imageMaxBytes) {
        reject(`حجم الصورة ${(f.size / MB).toFixed(1)}MB يتجاوز حد Flowmax (10MB).`);
      } else if (++images > FLOWMAX_MEDIA_LIMITS.imageMaxCount) {
        reject(`يتجاوز الحد الأقصى لعدد الصور في Flowmax (${FLOWMAX_MEDIA_LIMITS.imageMaxCount}).`);
      }
    } else if (!VIDEO_KINDS.has(f.kind)) {
      reject('Flowmax يقبل فيديو MP4 وMOV وWebM فقط.');
    } else if (f.size > FLOWMAX_MEDIA_LIMITS.videoMaxBytes) {
      reject(`حجم الفيديو ${(f.size / MB).toFixed(1)}MB يتجاوز حد Flowmax (100MB).`);
    } else if (++videos > FLOWMAX_MEDIA_LIMITS.videoMaxCount) {
      reject(
        `يتجاوز الحد الأقصى لعدد الفيديوهات في Flowmax (${FLOWMAX_MEDIA_LIMITS.videoMaxCount}).`,
      );
    }
  }
  return out;
}
