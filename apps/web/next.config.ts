import path from 'node:path';
import type { NextConfig } from 'next';

// يُقرأ وقت البناء: إعادة توجيه /api/* تُثبَّت في ناتج البناء، فتغييره يتطلب إعادة بناء الصورة.
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';
// صورة الإنتاج فقط تبني بالوضع standalone (انظر apps/web/Dockerfile)؛ التطوير و`next start` بلا تغيير.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // رفع ملف حتى 25MB ثم فحصه قد يتجاوز مهلة وكيل /api الافتراضية (30 ثانية).
  experimental: { proxyTimeout: 120_000 },
  ...(standalone && {
    output: 'standalone' as const,
    outputFileTracingRoot: path.join(__dirname, '..', '..'),
  }),
  env: {
    NEXT_PUBLIC_APP_NAME: process.env.APP_NAME ?? 'لوحة النماذج',
  },
  // الواجهة والـ API على نفس الأصل من منظور المتصفح، فتبقى Cookies الجلسة first-party وSameSite=Lax.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
