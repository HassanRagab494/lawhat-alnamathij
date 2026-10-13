#!/bin/sh
# يطبق migrations الجديدة فقط ثم يشغّل الـ API. لا يستخدم migrate dev ولا reset ولا db push ولا seed.
set -eu
cd /app/apps/api
echo "تطبيق migrations (deploy فقط)..."
/app/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
exec node dist/main.js
