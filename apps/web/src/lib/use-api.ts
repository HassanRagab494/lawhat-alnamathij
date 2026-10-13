'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from './api';

interface ApiResource<T> {
  data: T | null;
  error: ApiError | null;
  errorText: string | null;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

/** يجلب مسار GET ويعيد حالات التحميل والخطأ. path=null يؤجل الطلب. */
export function useApi<T>(path: string | null): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setErrorText(null);
    api<T>(path, { signal: controller.signal })
      .then((result) => setData(result))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : null);
        setErrorText(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, errorText, loading, reload, setData };
}
