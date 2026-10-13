'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { site } from '@/config/site';
import { useAuth } from '@/lib/auth-context';
import { can, isAdmin, ROLE_LABELS } from '@/lib/permissions';
import { errorMessage } from '@/lib/api';
import { Alert, Button } from './ui';

interface NavItem {
  href: string;
  label: string;
  match: (path: string) => boolean;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const [logoutError, setLogoutError] = useState<string | null>(null);
  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (error) {
      setLogoutError('تعذر تسجيل الخروج. ' + errorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  useEffect(() => setMenuOpen(false), [pathname]);

  // روابط الوظائف المنفذة فقط، ومفلترة بالصلاحيات (والـ Backend يفرضها مستقلًا).
  const items: NavItem[] = [
    { href: '/', label: 'الرئيسية', match: (p) => p === '/' },
    ...(can(me, 'FORMS_VIEW')
      ? [{ href: '/forms', label: 'النماذج', match: (p: string) => p.startsWith('/forms') }]
      : []),
    ...(isAdmin(me)
      ? [{ href: '/users', label: 'المستخدمون', match: (p: string) => p.startsWith('/users') }]
      : []),
    { href: '/account', label: 'حسابي', match: (p) => p.startsWith('/account') },
  ];

  const navLinks = (
    <ul className="flex flex-col gap-1 md:flex-row md:items-center">
      {items.map((item) => {
        const active = item.match(pathname);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`block rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
                active ? 'bg-velvet-700 text-white' : 'text-velvet-800 hover:bg-velvet-50'
              }`}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-velvet-800 px-4 py-2 text-white focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
      >
        تخطَّ إلى المحتوى
      </a>
      <header className="glass sticky top-0 z-40 rounded-none border-x-0 border-t-0">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="flex items-center gap-2.5 text-velvet-900">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-xl bg-velvet-700 text-sm font-bold text-white"
            >
              ل
            </span>
            <span className="text-lg font-bold">{site.name}</span>
          </Link>

          <nav aria-label="القائمة الرئيسية" className="hidden md:block">
            {navLinks}
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <div className="text-end leading-tight">
              <p className="text-sm font-semibold">{me?.displayName}</p>
              <p className="text-xs text-muted">{me && ROLE_LABELS[me.role]}</p>
            </div>
            <Button variant="secondary" loading={loggingOut} onClick={() => void handleLogout()}>
              تسجيل الخروج
            </Button>
          </div>

          <button
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-xl text-velvet-800 hover:bg-velvet-50 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="sr-only">{menuOpen ? 'إغلاق القائمة' : 'فتح القائمة'}</span>
            <svg className="size-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {menuOpen ? (
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        </div>

        {menuOpen && (
          <div id="mobile-nav" className="border-t border-white/70 px-4 pb-4 pt-2 md:hidden">
            <nav aria-label="القائمة الرئيسية">{navLinks}</nav>
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-smoke-200 pt-3">
              <div className="leading-tight">
                <p className="text-sm font-semibold">{me?.displayName}</p>
                <p className="text-xs text-muted">{me && ROLE_LABELS[me.role]}</p>
              </div>
              <Button variant="secondary" loading={loggingOut} onClick={() => void handleLogout()}>
                تسجيل الخروج
              </Button>
            </div>
          </div>
        )}
      </header>

      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none"
      >
        {logoutError && <Alert tone="error">{logoutError} يمكنك إعادة المحاولة.</Alert>}
        {children}
      </main>
    </div>
  );
}
