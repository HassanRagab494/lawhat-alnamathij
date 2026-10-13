#!/bin/sh
# يُنفَّذ مرة واحدة عند أول تهيئة لحجم البيانات.
# ينشئ قاعدة shadow الخاصة بـ `prisma migrate dev` لمستخدم التطبيق،
# وقاعدة الاختبارات بحساب مستقل (MYSQL_TEST_USER) لا يصل إلى القاعدة الأساسية.
set -e
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}_test\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}_shadow\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '${MYSQL_TEST_USER}'@'%' IDENTIFIED BY '${MYSQL_TEST_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}_test\`.* TO '${MYSQL_TEST_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}_shadow\`.* TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
SQL
