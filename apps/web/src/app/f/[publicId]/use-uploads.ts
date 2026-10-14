'use client';

import { useCallback, useRef, useState } from 'react';
import { ApiError, errorMessage } from '@/lib/api';
import type { PublicForm } from '@/lib/public-form';
import {
  createFillSession,
  deleteUploadedFile,
  precheckFile,
  uploadFile,
  type UploadItem,
} from '@/lib/uploads';

let seq = 0;

/**
 * رفع ملفات الصفحة العامة: جلسة تعبئة تُنشأ عند أول ملف (رمزها في الذاكرة فقط)،
 * وحالة كل ملف: رفع ⇒ تحقق (وفحص إن كان مفعّلًا) ⇒ جاهز أو مرفوض. الملف لا يُرسل مع الرد إلا إذا قبله الخادم.
 */
export function usePublicUploads(publicId: string, form: PublicForm | null) {
  const [items, setItems] = useState<Record<string, UploadItem[]>>({});
  const token = useRef<string | null>(null);
  const sessionPromise = useRef<Promise<string> | null>(null);
  const aborts = useRef(new Map<string, () => void>());

  const patch = useCallback((key: string, localId: string, change: Partial<UploadItem>) => {
    setItems((all) => ({
      ...all,
      [key]: (all[key] ?? []).map((i) => (i.localId === localId ? { ...i, ...change } : i)),
    }));
  }, []);

  const ensureSession = useCallback(async () => {
    if (token.current) return token.current;
    sessionPromise.current ??= createFillSession(publicId).then((t) => {
      token.current = t;
      return t;
    });
    try {
      return await sessionPromise.current;
    } catch (error) {
      sessionPromise.current = null;
      throw error;
    }
  }, [publicId]);

  const onAdd = useCallback(
    (key: string, files: File[]) => {
      const q = form?.questions.find((x) => x.key === key);
      if (!q) return;
      const current = (items[key] ?? []).filter((i) => i.status !== 'error').length;
      const max = q.settings.maxFiles ?? 1;
      const added: { item: UploadItem; file: File }[] = files.map((file, idx) => {
        const localId = `u${++seq}`;
        const pre =
          current + idx >= max
            ? `الحد الأقصى ${max} ${max === 1 ? 'ملف' : 'ملفات'} لهذا السؤال.`
            : precheckFile(file, q.settings);
        return {
          file,
          item: {
            localId,
            name: file.name,
            size: file.size,
            status: pre ? 'error' : 'uploading',
            progress: 0,
            error: pre ?? undefined,
          },
        };
      });
      setItems((all) => ({ ...all, [key]: [...(all[key] ?? []), ...added.map((a) => a.item)] }));
      for (const { item, file } of added) {
        if (item.status === 'error') continue;
        void (async () => {
          try {
            const t = await ensureSession();
            const { promise, abort } = uploadFile(
              publicId,
              t,
              q.id,
              file,
              (progress) => patch(key, item.localId, { progress }),
              () => patch(key, item.localId, { status: 'checking', progress: 100 }),
            );
            aborts.current.set(item.localId, abort);
            const result = await promise;
            patch(key, item.localId, { status: 'ready', fileId: result.id, name: result.name });
          } catch (error) {
            if (error instanceof ApiError && error.code === 'ABORTED') return;
            patch(key, item.localId, { status: 'error', error: errorMessage(error) });
          } finally {
            aborts.current.delete(item.localId);
          }
        })();
      }
    },
    [ensureSession, form, items, patch, publicId],
  );

  const onRemove = useCallback(
    (key: string, localId: string) => {
      const item = items[key]?.find((i) => i.localId === localId);
      aborts.current.get(localId)?.();
      if (item?.fileId && token.current)
        void deleteUploadedFile(publicId, token.current, item.fileId);
      setItems((all) => ({ ...all, [key]: (all[key] ?? []).filter((i) => i.localId !== localId) }));
    },
    [items, publicId],
  );

  /** يبدأ من جديد (بعد الإرسال الناجح أو تغيّر الإصدار). الملفات غير المرسلة تُنظف تلقائيًا في الخادم. */
  const reset = useCallback(() => {
    aborts.current.forEach((abort) => abort());
    aborts.current.clear();
    token.current = null;
    sessionPromise.current = null;
    setItems({});
  }, []);

  const readyIds = (key: string) =>
    (items[key] ?? []).filter((i) => i.status === 'ready' && i.fileId).map((i) => i.fileId!);
  const busy = Object.values(items).some((list) =>
    list.some((i) => i.status === 'uploading' || i.status === 'checking'),
  );
  const any = Object.values(items).some((list) => list.length > 0);

  return { items, onAdd, onRemove, reset, readyIds, busy, any, token: () => token.current };
}
