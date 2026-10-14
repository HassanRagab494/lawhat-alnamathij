-- حساب النسخ الاحتياطي بأقل صلاحيات لازمة (قراءة فقط على قاعدة lawha).
-- يُنفَّذ مرة واحدة بحساب root من Terminal خدمة mysql في Coolify:
--   1) mysql -uroot -p          (تُطلب كلمة root تفاعليًا)
--   2) الصق الأوامر أدناه بعد استبدال <BACKUP_DB_PASSWORD> بكلمة قوية (أحرف وأرقام)، ولا تحفظها في ملف.
--   3) ضع الكلمة نفسها في متغير Coolify السري BACKUP_DB_PASSWORD.
-- --single-transaction لا يحتاج LOCK TABLES، و--no-tablespaces لا يحتاج PROCESS.
CREATE USER IF NOT EXISTS 'lawha_backup'@'%' IDENTIFIED BY '<BACKUP_DB_PASSWORD>';
GRANT SELECT, SHOW VIEW, TRIGGER ON `lawha`.* TO 'lawha_backup'@'%';
FLUSH PRIVILEGES;
