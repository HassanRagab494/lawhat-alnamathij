// يوجّه التطبيق إلى قاعدة الاختبار قبل تحميل أي وحدة.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL غير معرّف. راجع .env.example وREADME (اختبارات التكامل).');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
// حد مرتفع لطلبات الدخول حتى لا تتعارض اختبارات الدخول المتكررة؛ حد IP مختبر منفصلًا في وحدات throttler.
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
process.env.LOGIN_MAX_FAILURES = '3';
