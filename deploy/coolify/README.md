# تجهيز بيئة التجربة على Coolify — lawhat-alnamathij

> هذا إعداد ليراجعه المسؤول عن Coolify ويشغّله. لم يُطبَّق أي شيء على الاستضافة.
> **النشر للاستخدام الفعلي غير معتمد بعد.** البنود المفتوحة في آخر الملف.

## الملفات

| الملف                                                                  | الغرض                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`compose.production.yaml`](../../compose.production.yaml)             | ثلاث خدمات: `mysql`، `api`، `web`. مستقل عن `compose.yaml` الخاص بالتطوير |
| [`apps/api/Dockerfile`](../../apps/api/Dockerfile)                     | صورة الـ API                                                              |
| [`apps/api/docker-entrypoint.sh`](../../apps/api/docker-entrypoint.sh) | تشغيل الـ API: `prisma migrate deploy` ثم الخادم                          |
| [`apps/web/Dockerfile`](../../apps/web/Dockerfile)                     | صورة الواجهة (Next.js standalone)                                         |
| [`.dockerignore`](../../.dockerignore)                                 | يستبعد `.env*` و`node_modules` وملفات البناء من سياق البناء               |
| [`env.example`](env.example)                                           | قائمة المتغيرات بلا أسرار                                                 |
| [`docs/trust-boundary.md`](../../docs/trust-boundary.md)               | حدود الثقة لعنوان IP العميل، والاختبار المطلوب عبر الوكيل الفعلي          |

## إعدادات Coolify المطلوبة

**المورد:**

1. مشروع مستقل باسم **lawhat-alnamathij**، وبيئة باسم `staging`.
   - لا تُستخدم موارد Flowmax أو قواعده أو شبكاته، ولا يُعدَّل الوكيل المشترك.
2. مورد جديد من نوع **Docker Compose** من مستودع `HassanRagab494/lawhat-alnamathij` على فرع `main`.
3. الإعدادات:
   - Base Directory: `/`
   - Docker Compose Location: `/compose.production.yaml`
   - Build Pack: Docker Compose
4. **Domains:** يُربط `https://forms.flowmaxsa.cloud` بخدمة **web** على المنفذ **3000** فقط.
   - لا دومين لخدمتي `api` و`mysql`.
   - يمكن استخدام نطاق فرعي للتجربة بدلًا منه، مع ضبط `WEB_ORIGIN` عليه.
5. **المتغيرات:** حسب [`env.example`](env.example):
   - `MYSQL_PASSWORD` و`MYSQL_ROOT_PASSWORD` كأسرار. `MYSQL_PASSWORD` بأحرف وأرقام فقط لأنها تدخل في `DATABASE_URL`.
   - `WEB_ORIGIN` = الأصل الذي يفتحه المستخدم بالضبط، مع `https://` وبلا `/` في النهاية.
6. لا تُفعَّل الخيارات التالية:
   - «Connect To Predefined Network»: لا حاجة لربط الخدمات بشبكة Coolify العامة؛ يكفي ربط الوكيل بخدمة web.
   - «Expose ports».
   - أي منفذ منشور على المضيف لأي خدمة.
7. **DNS:** سجل `forms.flowmaxsa.cloud` يشير إلى خادم Coolify. يغيّره المسؤول، ولم يُغيَّر في هذه المهمة.

**النشر الأول والمدير:**

8. **النشر الأول:** تبني Coolify الصورتين، ثم تبدأ `mysql` (تخزين دائم في volume `lawha-mysql-data`)، ثم `api` بعد أن تصبح القاعدة سليمة. عند كل إقلاع يطبق `api` الأمر `prisma migrate deploy` فقط، فلا reset ولا `db push` ولا seed. تبدأ `web` بعد أن يصبح فحص صحة `api` ناجحًا.
9. **المدير الأول:** لا تُنشأ حسابات تلقائيًا ولا توجد بيانات اختبار. من Terminal خدمة `api` في Coolify:

   ```bash
   node dist/cli/create-admin.js --username <اسم-المستخدم> --display-name "<الاسم الظاهر>"
   ```

   تُطلب كلمة المرور تفاعليًا مرتين وهي مخفية. لا تُستخدم `INITIAL_ADMIN_PASSWORD` في متغيرات Coolify، ويرفض الأمر العمل إذا وُجد مدير مسبقًا.

## الشبكات وحدود الثقة

```text
الزائر ⇒ وكيل Coolify (Traefik) ⇒ web:3000 ─[backend: internal]─► api:4000 ─► mysql:3306
```

**الشبكات:**

- لا تملك أي خدمة `ports:`، وكل المنافذ داخلية (`expose`).
- `api` و`mysql` موجودتان على شبكة `backend` وحدها. هذه الشبكة `internal: true` بلا خروج للإنترنت، وبلا دومين.
- `web` موجودة على `default`، وهي الشبكة التي يصلها وكيل Coolify، وعلى `backend` أيضًا.
- تصل `web` إلى الـ API عبر الاسم `lawha-api-backend`، وهو معرّف على شبكة `backend` فقط. لذلك يأتي الاتصال دائمًا من `BACKEND_SUBNET`.
- `TRUST_PROXY` في `api` = `BACKEND_SUBNET` (افتراضيًا `10.213.47.0/28`). يرفض الـ API الإقلاع في الإنتاج إذا غاب `TRUST_PROXY` أو كان `true` أو `false` أو `*` أو شبكة شاملة أو عدد قفزات.
- إذا أضافت Coolify خدمة `api` إلى شبكة الوكيل تلقائيًا، فلا يتغير الأمان: عناوين تلك الشبكة خارج `TRUST_PROXY`، فلا تُصدَّق منها `X-Forwarded-For`، ولا يوجد router إلى `api`.

**ما يجب أن يتحقق منه المسؤول في الوكيل المشترك (دون تعديله):**

- مدخل `https` في Traefik لا يحتوي `forwardedHeaders.insecure=true`، ولا `trustedIPs` تشمل مصادر يصل إليها الزائر.
- إن وجدت CDN (مثل Cloudflare) أمام Traefik، تُراجَع إعداداتها بحسب [`docs/trust-boundary.md`](../../docs/trust-boundary.md).
- لماذا يكفي هذا: Traefik يضيف عنوان الاتصال الحقيقي أو يستبدل به الترويسة، وNext.js يمرر الترويسة، والـ API يثق بـ `web` وحدها. في الحالتين يأخذ Express العنوان الحقيقي، لأنه أقرب عنوان غير موثوق من اليمين.
- الشرط الحاسم أن الزائر لا يصل إلى `web` أو `api` إلا عبر Traefik، والاختبار أدناه يثبت ذلك.

## فحوص الصحة

| الخدمة  | الفحص                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------- |
| `mysql` | `mysqladmin ping`                                                                                    |
| `api`   | `GET /api/health` يعيد 200 عند اتصال القاعدة، و503 عند انقطاعها. مهلة بدء 60 ثانية لتطبيق migrations |
| `web`   | `GET /login` يعيد 200                                                                                |

وثائق `/api/docs` معطلة في الإنتاج (`API_DOCS_ENABLED=false`). الوثيقة الثابتة موجودة في `docs/openapi.json`.

## ما تحقق محليًا وما لم يتحقق

Docker غير مثبت على جهاز التطوير، فلم تُبنَ الصور ولم يُشغَّل `compose.production.yaml`. أي أن تشغيلها **NOT_RUN**.

ما نُفذ دون Docker لمحاكاة مراحل الصور:

| الفحص                                                                                               | النتيجة                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `compose.production.yaml` يُقرأ كـ YAML صحيح؛ لا `ports` لأي خدمة؛ `api` و`mysql` على `backend` فقط | PASS                                                                                                                      |
| مرحلة `deps`: `npm ci --omit=dev --workspace @lawha/api` في مجلد معزول                              | PASS: فيه `prisma` وPrisma Client، وليس فيه next وjest وnest CLI                                                          |
| `prisma migrate deploy` من تلك الاعتماديات على `lawha_test`                                         | PASS: `No pending migrations to apply`                                                                                    |
| تشغيل `node dist/main.js` بوضع الإنتاج دون `TRUST_PROXY` أو مع `TRUST_PROXY=true`                   | PASS: رفض الإقلاع برسالة واضحة                                                                                            |
| تشغيله بإعداد صحيح                                                                                  | PASS: `/api/health` يعيد 200 مع `database: up`، و`/api/docs` و`/api/docs.json` يعيدان 404                                 |
| بناء الواجهة بـ `NEXT_OUTPUT=standalone` و`API_ORIGIN=http://127.0.0.1:4100`                        | PASS: الوجهة مثبتة في `routes-manifest.json`                                                                              |
| تشغيل `apps/web/server.js` من نسخة معزولة بتخطيط الصورة                                             | PASS: `/login` 200، و`/api/health` عبر الواجهة 200، و`/f/...` 200، و`/forms` تحويل 307 إلى الدخول، وملفات CSS الثابتة 200 |

## البنود المفتوحة قبل الاستخدام الفعلي

1. **بناء الصور وتشغيل الـ Compose على Coolify:** لم ينفذ، وهو أول خطوة في بيئة التجربة.
2. **اختبار تزوير `X-Forwarded-For` عبر الوكيل الفعلي:** لم ينفذ. من جهاز خارج الخادم:

   ```bash
   node scripts/check-forwarded-for.mjs --base https://forms.flowmaxsa.cloud
   ```

   - المطلوب `PASS` للسطرين.
   - يجب أن يفشل الاتصال من الخارج بالمنافذ 3000 و4000 و3306 على عنوان الخادم.

3. **اختبار المتصفح** (375 و1280 بكسل): إنشاء نموذج، ثم نشر، ثم تعبئة دون جلسة، ثم إرسال ورقم مرجعي، ثم أخطاء التحقق وانقطاع الشبكة والإغلاق والتحديث أثناء التعبئة. لم ينفذ محليًا بقرار المالك، ويُنفذ على بيئة التجربة.
4. **التنبيهات الأمنية للتبعيات:** ما زالت مفتوحة في [`docs/verification/dependency-advisories.md`](../../docs/verification/dependency-advisories.md)، ولم تُقبل نهائيًا.
5. **النسخ الاحتياطي لـ volume `lawha-mysql-data`:** لم يُضبط بعد. يُضبط في Coolify أو على الخادم قبل إدخال بيانات حقيقية.
6. **عدادات حدود المعدل في ذاكرة العملية:** لا يُشغَّل أكثر من نسخة واحدة من `api` حتى تُنقل العدادات إلى مخزن مشترك.
