'use client';

import { useRef } from 'react';
import type { RenderQuestion } from '@/lib/answer-validation';
import { FILE_TYPE_LABELS } from '@/lib/question-limits';
import { acceptAttribute, formatBytes, type UploadItem } from '@/lib/uploads';

/** تديره الصفحة العامة: حالة الملفات لكل سؤال وإضافة ملفات وإزالتها. */
export interface UploadsController {
  items: Record<string, UploadItem[]>;
  onAdd: (questionKey: string, files: File[]) => void;
  onRemove: (questionKey: string, localId: string) => void;
}

const STATUS_TEXT: Record<UploadItem['status'], string> = {
  uploading: 'جارٍ الرفع',
  scanning: 'جارٍ التحقق والفحص',
  ready: 'جاهز',
  error: 'لم يُقبل',
};

export function FileUploadControl({
  id,
  question: q,
  describedBy,
  invalid,
  controller,
}: {
  id: string;
  question: RenderQuestion;
  describedBy?: string;
  invalid: boolean;
  controller: UploadsController;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const items = controller.items[q.key] ?? [];
  const s = q.settings;
  const active = items.filter((i) => i.status !== 'error').length;
  const max = s.maxFiles ?? 1;
  const full = active >= max;

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={inputRef}
        id={id}
        type="file"
        multiple={max > 1}
        accept={acceptAttribute(s.allowedTypes)}
        disabled={full}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={q.required}
        className="w-full rounded-xl border border-dashed border-velvet-300 bg-white/70 p-3 text-sm text-ink file:me-3 file:rounded-lg file:border-0 file:bg-velvet-100 file:px-3 file:py-2 file:font-semibold file:text-velvet-800 disabled:cursor-not-allowed disabled:opacity-60"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) controller.onAdd(q.key, files);
          e.target.value = '';
        }}
      />
      <ul className="flex flex-col gap-1 text-xs text-muted">
        <li>
          الأنواع المسموحة: {(s.allowedTypes ?? []).map((t) => FILE_TYPE_LABELS[t]).join('، ')}
        </li>
        <li>
          حتى {max} {max === 1 ? 'ملف' : 'ملفات'}، والحجم الأقصى لكل ملف {s.maxFileSizeMb ?? 1}{' '}
          ميغابايت
        </li>
        <li>يُفحص كل ملف قبل قبوله؛ الملفات المشفرة أو المحمية بكلمة مرور لا تُقبل.</li>
      </ul>
      {items.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={`ملفات «${q.title}»`}>
          {items.map((item) => (
            <li
              key={item.localId}
              className={`flex flex-col gap-1.5 rounded-xl border p-3 text-sm ${
                item.status === 'error'
                  ? 'border-red-200 bg-red-50'
                  : item.status === 'ready'
                    ? 'border-emerald-200 bg-emerald-50/60'
                    : 'border-smoke-300 bg-white/70'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p dir="auto" className="break-all font-semibold text-ink">
                    {item.name}
                  </p>
                  <p className="text-xs text-muted">
                    {formatBytes(item.size)} ·{' '}
                    <span
                      className={
                        item.status === 'error'
                          ? 'font-semibold text-red-800'
                          : item.status === 'ready'
                            ? 'font-semibold text-emerald-800'
                            : ''
                      }
                    >
                      {STATUS_TEXT[item.status]}
                      {item.status === 'uploading' && ` ${item.progress}%`}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => controller.onRemove(q.key, item.localId)}
                  className="min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold text-red-800 hover:bg-red-100"
                  aria-label={`إزالة ${item.name}`}
                >
                  {item.status === 'uploading' || item.status === 'scanning' ? 'إلغاء' : 'إزالة'}
                </button>
              </div>
              {(item.status === 'uploading' || item.status === 'scanning') && (
                <div
                  role="progressbar"
                  aria-label={`تقدم ${item.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.status === 'scanning' ? 100 : item.progress}
                  className="h-1.5 overflow-hidden rounded-full bg-smoke-200"
                >
                  <div
                    className={`h-full rounded-full bg-velvet-600 transition-all ${
                      item.status === 'scanning' ? 'animate-pulse' : ''
                    }`}
                    style={{ width: `${item.status === 'scanning' ? 100 : item.progress}%` }}
                  />
                </div>
              )}
              {item.error && (
                <p role="alert" className="text-xs font-medium text-red-800">
                  {item.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {items
          .filter((i) => i.status !== 'uploading')
          .map((i) => `${i.name}: ${STATUS_TEXT[i.status]}`)
          .join('، ')}
      </span>
    </div>
  );
}
