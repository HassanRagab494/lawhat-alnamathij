import { NextResponse, type NextRequest } from 'next/server';

/**
 * توجيه مبكر لصفحة الدخول عند غياب Cookie الجلسة، لتجنب وميض الصفحات المحمية.
 * هذا تحسين للتجربة فقط؛ التحقق الحقيقي من الجلسة والصلاحيات يتم في الـ Backend.
 */
export function middleware(request: NextRequest) {
  if (request.cookies.has('lp_session')) return NextResponse.next();
  const url = request.nextUrl.clone();
  const next = request.nextUrl.pathname;
  url.pathname = '/login';
  url.search = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api|login|_next|favicon.ico).*)'],
};
