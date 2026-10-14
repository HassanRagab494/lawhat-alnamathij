import { SkipThrottle } from '@nestjs/throttler';

/** أسماء محددات المعدل. ThrottlerGuard يطبق كلها افتراضيًا، فكل مسار يحدد ما يخصه عبر onlyThrottle. */
export const THROTTLE = {
  login: 'login',
  submitIp: 'submitIp',
  submitForm: 'submitForm',
  uploadIp: 'uploadIp',
  uploadForm: 'uploadForm',
  responses: 'responses',
  responsesExport: 'responsesExport',
} as const;

export type ThrottleName = (typeof THROTTLE)[keyof typeof THROTTLE];

/** يطبق المحددات المذكورة فقط ويتخطى البقية (على مستوى الدالة أو الصنف). */
export const onlyThrottle = (...names: ThrottleName[]) =>
  SkipThrottle(Object.fromEntries(Object.values(THROTTLE).map((n) => [n, !names.includes(n)])));
