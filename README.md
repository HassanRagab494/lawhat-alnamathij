# لوحة النماذج — المرحلة الأولى

منصة عربية لإنشاء النماذج وإدارة الردود لشركة واحدة. هذه المرحلة تبني الأساس فقط:
تسجيل الدخول والجلسات، المستخدمين والصلاحيات، وإدارة بيانات النماذج الأساسية (بدون أسئلة أو نشر أو ردود).

| الجزء              | التقنية                                                             |
| ------------------ | ------------------------------------------------------------------- |
| الواجهة `apps/web` | Next.js 15 (App Router) + TypeScript + Tailwind CSS 4               |
| الـ API `apps/api` | NestJS 11 + TypeScript                                              |
| قاعدة البيانات     | MySQL 8.4 عبر Prisma 6 (migrations في `apps/api/prisma/migrations`) |
| مدير الحزم         | npm workspaces مع `package-lock.json`                               |

التفاصيل: [docs/architecture.md](docs/architecture.md) · الـ APIs والصلاحيات: [docs/api.md](docs/api.md) ·
OpenAPI: [docs/openapi.json](docs/openapi.json) (وواجهة تفاعلية على `/api/docs` أثناء التشغيل) ·
نتائج التحقق: [docs/verification/phase-1.md](docs/verification/phase-1.md)

## المتطلبات

- Node.js 20.19 أو أحدث (يُفضّل 22 LTS) و npm 10+
- Docker مع Compose v2 **أو** MySQL 8.x مثبت محليًا

## التشغيل المحلي من نسخة جديدة

```bash
# 1) تثبيت الحزم (يولّد Prisma Client تلقائيًا)
npm ci

# 2) الإعدادات: انسخ المثال ثم غيّر كلمات المرور المحلية
cp .env.example .env

# 3) تشغيل MySQL (ينشئ أيضًا lawha_test وlawha_shadow للمستخدم نفسه)
npm run db:up

# 4) تطبيق migrations
npm run db:migrate

# 5) إنشاء مدير النظام الأول (تُطلب كلمة المرور بشكل مخفي مرتين)
npm run admin:create -- --username admin --display-name "مدير النظام"

# 6) تشغيل الـ API والواجهة (في طرفيتين)
npm run dev:api     # http://localhost:4000/api  — التوثيق: http://localhost:4000/api/docs
npm run dev:web     # http://localhost:3000
```

ثم افتح `http://localhost:3000` وسجّل الدخول بحساب المدير.

> **MySQL مثبت على Windows بدون Docker وبدون صلاحيات مدير:** بعد إنشاء `.env` شغّل
> `powershell -ExecutionPolicy Bypass -File scripts/mysql-local.ps1 init` مرة واحدة (ينشئ مجلد بيانات في
> `%LOCALAPPDATA%lawha-mysql` ويستمع على 127.0.0.1 فقط، وينشئ القواعد الثلاث والمستخدم من قيم `.env`)،
> ثم `start` أو `stop` أو `status` لاحقًا بدل `npm run db:up`.

> بدون Docker يدويًا: أنشئ في MySQL قاعدة `lawha` (وقاعدتي `lawha_test` و`lawha_shadow` إن أردت الاختبارات
> أو إنشاء migrations جديدة) ومستخدمًا له صلاحيات عليها، وعدّل `DATABASE_URL` و`TEST_DATABASE_URL`
> و`SHADOW_DATABASE_URL` في `.env`. اضبط المنطقة الزمنية للخادم على UTC أو اتركها؛ Prisma يخزّن UTC دائمًا.

### تشغيل نسخة البناء

```bash
npm run build
npm run start:api
npm run start:web
```

## إنشاء المدير الأول

```bash
npm run admin:create -- --username <اسم المستخدم> --display-name "<الاسم الظاهر>"
```

- كلمة المرور تُكتب في الطرفية بشكل مخفي مرتين، ولا تظهر في سجل الأوامر.
- للأتمتة فقط: يمكن تمريرها لمرة واحدة عبر متغير البيئة `INITIAL_ADMIN_PASSWORD` لنفس الأمر.
- يرفض الأمر العمل إذا وُجد مدير نظام مسبقًا، ويطبق سياسة كلمة المرور (10 أحرف على الأقل، ولا تحتوي اسم المستخدم).
- يُسجَّل الإنشاء في `audit_logs` بالإجراء `user.bootstrap_admin`.
- لا يوجد أي حساب افتراضي أو كلمة مرور ثابتة في الكود.

## متغيرات البيئة

ملف واحد `.env` في جذر المستودع تقرؤه كل الأوامر (عبر `dotenv-cli`). القيم في `.env.example` للتطوير المحلي فقط.

| المتغير                                                                               | الاستخدام                                                     | مطلوب       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------- |
| `APP_NAME`                                                                            | اسم المنصة الظاهر (الافتراضي «لوحة النماذج»)                  | لا          |
| `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `MYSQL_PORT` | حاوية MySQL في `compose.yaml`                                 | مع Docker   |
| `DATABASE_URL`                                                                        | اتصال الـ API بـ MySQL (`mysql://...`)                        | نعم         |
| `SHADOW_DATABASE_URL`                                                                 | قاعدة مؤقتة لـ `prisma migrate dev` عند إنشاء migration جديدة | للتطوير فقط |
| `TEST_DATABASE_URL`                                                                   | قاعدة اختبارات التكامل (تُمسح بالكامل)                        | للاختبارات  |
| `API_PORT`                                                                            | منفذ الـ API (4000)                                           | لا          |
| `WEB_ORIGIN`                                                                          | أصل الواجهة المسموح (فحص Origin وCORS)                        | نعم         |
| `COOKIE_SECURE`                                                                       | `true` عند العمل عبر HTTPS (إلزامي في `production`)           | لا          |
| `SESSION_TTL_HOURS`, `SESSION_IDLE_MINUTES`                                           | العمر الأقصى للجلسة ومدة الخمول                               | لا          |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`                                            | الإيقاف المؤقت للحساب بعد محاولات فاشلة                       | لا          |
| `LOGIN_RATE_LIMIT_PER_MINUTE`                                                         | حد طلبات الدخول لكل IP في الدقيقة                             | لا          |
| `API_ORIGIN`                                                                          | عنوان الـ API الذي تمرر إليه الواجهة `/api/*`                 | لا          |

يرفض الـ API الإقلاع برسالة واضحة تذكر أسماء المتغيرات الناقصة أو الخاطئة (دون قيمها).

## أوامر التحقق

```bash
npm run format:check   # Prettier
npm run typecheck      # tsc للتطبيقين
npm test               # اختبارات الوحدة (لا تحتاج قاعدة بيانات)
npm run build          # بناء التطبيقين
npm run check          # كل ما سبق
npm run test:e2e       # اختبارات التكامل على MySQL حقيقية عبر TEST_DATABASE_URL
npm run openapi:export # إعادة توليد docs/openapi.json
```

`npm run test:e2e` يمسح `TEST_DATABASE_URL` ويطبق migrations من الصفر، ثم يختبر دورة HTTP → NestJS → Prisma → MySQL
كاملة (الدخول، الصلاحيات، إبطال الجلسات، النماذج، التزامن، إعادة التشغيل). يرفض العمل إذا كانت قاعدة الاختبار هي نفسها `DATABASE_URL`.

## إنشاء migration جديدة

```bash
# بعد تعديل apps/api/prisma/schema.prisma
npm run db:migrate:dev -- --name <وصف_التغيير>
```

لا تُعدَّل قاعدة البيانات يدويًا؛ كل تغيير في المخطط يمر عبر migration محفوظة في Git.

## خارج نطاق هذه المرحلة

محرر الأسئلة، النشر والصفحة العامة، الردود ومراجعتها، رفع الملفات، التصدير، الإشعارات، تعدد الشركات،
الخدمات الخلفية والتكاملات، والنشر على أي سيرفر. لا توجد في الواجهة روابط توحي بوجود هذه الوظائف.

### حماية قاعدة التكامل

يلزم DATABASE_URL صالحًا للمقارنة وTEST_DATABASE_URL باسم ينتهي بـ `_test`، وموافقة يدوية `ALLOW_TEST_DATABASE_RESET=lawha_test` تطابق الاسم حرفيًا. لا تضبط الموافقة لقواعد التطوير أو الإنتاج. يُرفض اسم القاعدة المطابق لقاعدة التطبيق حتى عبر مضيف أو منفذ مختلفين؛ اختلاف المستخدم وكلمة المرور ومعاملات الاتصال لا يثبت استقلال القاعدة. تُرفض معاملات تغيير وجهة الاتصال غير المدعومة، ويُرفض تعذر حل DNS. أسماء DNS المستعارة وNAT والأنفاق قد تشير لخادم واحد؛ لا يمكن استنتاج الهوية الفيزيائية يقينًا من URL أو DNS. يلزم حساب MySQL محدود إلى قاعدة الاختبار فقط، والتحقق الإداري من الهدف قبل الموافقة. لا يُنفذ reset دون هذه الشروط.
