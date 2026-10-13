/** إعداد مركزي لهوية المنصة. الاسم يُقرأ من APP_NAME في .env (عبر next.config.ts). */
export const site = {
  name: process.env.NEXT_PUBLIC_APP_NAME || 'لوحة النماذج',
  locale: 'ar-SA',
  timeZone: 'Asia/Riyadh',
} as const;
