import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from './auth-context';
import { AppShell } from '@/components/app-shell';
const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/' }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const me = { id: 'u', username: 'admin', displayName: 'Admin', role: 'ADMIN', permissions: [] };
async function mount(logout: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url === '/api/auth/me' ? Promise.resolve(new Response(JSON.stringify(me))) : logout(),
    ),
  );
  render(
    <AuthProvider fallback={<p>loading</p>} errorView={(m) => <p>{m}</p>}>
      <AppShell>
        <p>protected content</p>
      </AppShell>
    </AuthProvider>,
  );
  await screen.findByText('protected content');
}
describe('logout through provider and shell', () => {
  it('redirects only after successful revocation', async () => {
    await mount(async () => new Response(null, { status: 204 }));
    fireEvent.click(screen.getByText('تسجيل الخروج'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
  it('keeps user, displays connection failure, enables retry and succeeds on retry', async () => {
    const logout = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await mount(logout);
    fireEvent.click(screen.getByText('تسجيل الخروج'));
    await screen.findByText(/تعذر تسجيل الخروج/);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('protected content')).toBeTruthy();
    const button = screen.getByText('تسجيل الخروج').closest('button')!;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
  it('accepts an already expired session', async () => {
    await mount(
      async () =>
        new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'expired' }), {
          status: 401,
        }),
    );
    fireEvent.click(screen.getByText('تسجيل الخروج'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
