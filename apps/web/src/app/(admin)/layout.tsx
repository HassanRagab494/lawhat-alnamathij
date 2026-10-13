'use client';

import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { ErrorState, LoadingState } from '@/components/ui';
import { AuthProvider } from '@/lib/auth-context';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider
      fallback={
        <div className="flex min-h-dvh items-center justify-center">
          <LoadingState label="جارٍ التحقق من الجلسة…" />
        </div>
      }
      errorView={(message, retry) => (
        <div className="mx-auto flex min-h-dvh max-w-lg items-center px-4">
          <div className="w-full">
            <ErrorState message={message} onRetry={retry} />
          </div>
        </div>
      )}
    >
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
