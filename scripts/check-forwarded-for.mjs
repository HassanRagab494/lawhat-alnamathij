#!/usr/bin/env node
// يتحقق عبر المسار الفعلي (الوكيل الأمامي ⇒ Next.js ⇒ الـ API) من أن تزوير X-Forwarded-For
// لا يتجاوز حد الدخول ولا حد إرسال الردود لكل IP.
//
// الاستخدام:
//   node scripts/check-forwarded-for.mjs --base https://forms.example.com [--submit-limit 10] [--login-limit 10]
//
// يرسل من الجهاز نفسه طلبات بترويسة X-Forwarded-For مختلفة في كل مرة:
// - إرسال رد إلى publicId عشوائي غير موجود في كل طلب (فلا يتدخل حد النموذج ولا يُنشأ أي رد).
// - تسجيل دخول باسم مستخدم عشوائي غير موجود في كل طلب (فلا يُقفل أي حساب حقيقي).
// النتيجة PASS إذا ظهر 429 خلال (الحد + 1) طلبًا في الحالتين، وإلا FAIL.
// تنبيه: يستهلك حصة هذا الجهاز من الحدين لمدة دقيقة. لا يرسل أي بيانات حقيقية.

import { randomBytes, randomUUID } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const origin = arg('origin', new URL(base).origin);
const submitLimit = Number(arg('submit-limit', '10'));
const loginLimit = Number(arg('login-limit', '10'));

const spoofed = (i) => `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`;

async function probe(label, limit, send) {
  const statuses = [];
  for (let i = 0; i <= limit; i++) {
    const res = await send(i);
    statuses.push(res.status);
    if (res.status === 429) break;
  }
  const pass = statuses.includes(429);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${statuses.join(' ')}`);
  return pass;
}

const headers = (i) => ({
  'Content-Type': 'application/json',
  Origin: origin,
  'X-Forwarded-For': spoofed(i),
});

const submitOk = await probe('إرسال الردود مع ترويسة مزيفة متغيرة', submitLimit, (i) =>
  fetch(`${base}/api/public/forms/${randomBytes(16).toString('base64url')}/responses`, {
    method: 'POST',
    headers: headers(i),
    body: JSON.stringify({ versionId: randomUUID(), idempotencyKey: randomUUID(), answers: [] }),
  }),
);
const loginOk = await probe('تسجيل الدخول مع ترويسة مزيفة متغيرة', loginLimit, (i) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: headers(i),
    body: JSON.stringify({
      username: `xff-probe-${randomBytes(6).toString('hex')}`,
      password: randomBytes(12).toString('hex'),
    }),
  }),
);

process.exit(submitOk && loginOk ? 0 : 1);
