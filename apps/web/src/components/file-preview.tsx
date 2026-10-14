'use client';

import type { AnswerFile } from '@/lib/responses';

const VIDEO_TYPES: Record<string, string> = {
  MP4: 'video/mp4',
  MOV: 'video/quicktime',
  WEBM: 'video/webm',
};

/**
 * معاينة صورة أو فيديو داخل الصفحة عبر مسار الملفات المحمي نفسه (disposition=inline)؛
 * لا روابط عامة. التشغيل والإيقاف وكتم الصوت وملء الشاشة من عناصر التحكم القياسية للمتصفح.
 */
export function FilePreview({ file, src }: { file: AnswerFile; src: string }) {
  if (!file.previewable) return null;
  const video = VIDEO_TYPES[file.kind];
  if (video) {
    return (
      <video
        controls
        preload="metadata"
        playsInline
        className="max-h-[70vh] w-full rounded-lg bg-black"
        aria-label={`فيديو: ${file.name}`}
      >
        <source src={src} type={video} />
        <p className="p-3 text-sm text-white">
          المتصفح لا يدعم تشغيل هذا الفيديو داخل الصفحة؛ نزّله لمشاهدته.
        </p>
      </video>
    );
  }
  return (
    // ملف خاص عبر مسار محمي؛ لا يمر بمحسّن الصور في Next.js
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`صورة: ${file.name}`}
      loading="lazy"
      className="max-h-[70vh] w-full rounded-lg bg-smoke-100 object-contain"
    />
  );
}
