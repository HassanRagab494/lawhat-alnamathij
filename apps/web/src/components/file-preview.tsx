'use client';

import { useEffect, useRef, useState } from 'react';
import type { AnswerFile } from '@/lib/responses';

const VIDEO_TYPES: Record<string, string> = {
  MP4: 'video/mp4',
  MOV: 'video/quicktime',
  WEBM: 'video/webm',
};

/**
 * معاينة صورة أو فيديو داخل الصفحة عبر مسار الملفات المحمي نفسه (disposition=inline)؛
 * لا روابط عامة. التشغيل والإيقاف وكتم الصوت وملء الشاشة من عناصر التحكم القياسية للمتصفح.
 * دعم الترميز يختلف بين المتصفحات (خاصة MOV/HEVC): إن تعذر التشغيل تظهر رسالة واضحة وخيار التنزيل.
 */
export function FilePreview({
  file,
  src,
  downloadHref,
}: {
  file: AnswerFile;
  src: string;
  downloadHref: string;
}) {
  const video = VIDEO_TYPES[file.kind];
  const isMov = file.kind === 'MOV';
  const ref = useRef<HTMLVideoElement>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    // canPlayType('') يعني أن المتصفح لا يعرف الحاوية أصلًا؛ وفشل فك الترميز يصل عبر حدث error.
    // MOV لا يُحكم عليه مسبقًا: متصفحات كثيرة تشغّل MOV بترميز H.264 رغم أنها لا تعلن دعم video/quicktime.
    if (video && !isMov && ref.current && ref.current.canPlayType(video) === '')
      setUnsupported(true);
  }, [video, isMov]);

  if (!file.previewable) return null;
  if (video) {
    if (unsupported) {
      return (
        <div role="status" className="rounded-lg bg-smoke-100 p-3 text-sm text-ink">
          <p>هذا المتصفح لا يدعم تشغيل ترميز هذا الفيديو داخل الصفحة.</p>
          <a
            href={downloadHref}
            download
            rel="noopener"
            className="mt-1 inline-block font-semibold text-velvet-700 underline"
          >
            تنزيل الفيديو لمشاهدته
          </a>
        </div>
      );
    }
    return (
      <video
        ref={ref}
        controls
        preload="metadata"
        playsInline
        className="max-h-[70vh] w-full rounded-lg bg-black"
        aria-label={`فيديو: ${file.name}`}
        onError={() => setUnsupported(true)}
      >
        {/* دون type لـ MOV حتى يحاول المتصفح فعليًا بدل تخطي المصدر */}
        <source src={src} type={isMov ? undefined : video} onError={() => setUnsupported(true)} />
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
