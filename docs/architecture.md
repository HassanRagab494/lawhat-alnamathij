# البنية والقرارات — المراحل الأولى إلى الثالثة

## هيكل المستودع

```
lawhat-alnamathij/
├── package.json / package-lock.json   npm workspaces + أوامر موحدة
├── .env.example                       كل متغيرات البيئة (بدون أسرار)
├── compose.yaml                       MySQL 8.4 للتطوير المحلي فقط
├── docker/mysql/init/                 ينشئ قاعدتي الاختبار وshadow عند أول تهيئة
├── docs/                              التوثيق وopenapi.json وسجل التحقق
├── apps/api/                          NestJS
│   ├── prisma/schema.prisma           مخطط المرحلة الأولى
│   ├── prisma/migrations/             migrations (SQL محفوظ في Git)
│   ├── src/
│   │   ├── main.ts / bootstrap.ts     الإقلاع والإعداد المشترك (helmet، cookies، التحقق، الأخطاء، OpenAPI)
│   │   ├── config/                    التحقق من متغيرات البيئة (zod)
│   │   ├── common/                    الأخطاء الموحدة، ValidationPipe بالعربية، الترقيم
│   │   ├── auth/                      الجلسات، كلمات المرور، الحارس العام، الصلاحيات
│   │   ├── users/                     إدارة المشرفين (للمدير فقط)
│   │   ├── forms/                     النماذج ومسوداتها
│   │   ├── dashboard/                 ملخص الصفحة الرئيسية
│   │   ├── health/                    فحص الحالة وقاعدة البيانات
│   │   ├── audit/                     سجل العمليات
│   │   └── cli/                       create-admin، export-openapi
│   └── test/                          اختبارات التكامل على MySQL
└── apps/web/                          Next.js
    └── src/
        ├── app/login/                 صفحة الدخول
        ├── app/(admin)/               الصفحات المحمية: الرئيسية، النماذج، المستخدمون، حسابي
        ├── app/not-found.tsx          الصفحة غير الموجودة
        ├── components/                مكونات الواجهة (أزرار، حقول، نوافذ تأكيد، الهيكل)
        ├── config/site.ts             الإعداد المركزي لاسم المنصة والتوقيت
        ├── lib/                       عميل الـ API، الصلاحيات، التنسيق بتوقيت الرياض
        └── middleware.ts              توجيه مبكر لصفحة الدخول
```

## القرارات الرئيسية

### الاتصال بين الواجهة والـ API

- الواجهة تمرر `/api/*` إلى NestJS عبر `rewrites` في Next.js. من منظور المتصفح كل شيء على أصل واحد،
  فتبقى Cookies الجلسة first-party مع `SameSite=Lax` دون الحاجة إلى CORS مع credentials.
- كل منطق الأعمال والوصول إلى القاعدة في الـ API. الواجهة لا تتصل بقاعدة البيانات.
- الصفحات المحمية مكونات عميل تجلب البيانات من الـ API؛ `middleware.ts` يوجّه إلى الدخول عند غياب Cookie فقط (تحسين تجربة لا حماية).

### الجلسات

- رمز عشوائي 256 بت في Cookie `lp_session` (HttpOnly، SameSite=Lax، Secure عبر `COOKIE_SECURE`).
- القاعدة تخزن **تجزئة SHA-256** للرمز فقط؛ تسريب جدول `sessions` لا يكفي لانتحال جلسة.
- الجلسة قابلة للإلغاء (`revoked_at`، `revoked_reason`)، لها عمر أقصى (`SESSION_TTL_HOURS`) ومهلة خمول (`SESSION_IDLE_MINUTES`).
- رمز جديد عند كل دخول (لا تثبيت جلسة). الخروج يبطل الجلسة في القاعدة ويمسح الـ Cookies.
- لا يُخزَّن أي رمز في localStorage.

### CSRF

- رمز CSRF عشوائي مرتبط بالجلسة: تجزئته في `sessions.csrf_token_hash`، وقيمته في Cookie غير HttpOnly باسم `lp_csrf`.
- كل طلب معدِّل (POST/PATCH...) يجب أن يرسل الترويسة `x-csrf-token` المطابقة، وتُقارن بزمن ثابت.
- إضافة لذلك: أي طلب معدِّل يحمل Origin مختلفًا عن `WEB_ORIGIN` يُرفض (يشمل طلب الدخول نفسه).

### كلمات المرور ومحاولات الدخول

- التجزئة بـ **scrypt** المدمج في Node.js وفق الحد الأدنى في توصيات OWASP (N=2^17، r=8، p=1، ملح 16 بايت).
  المعاملات محفوظة مع كل تجزئة (`scrypt$N$r$p$salt$hash`) لرفعها لاحقًا دون كسر الحسابات.
  اخترنا scrypt بدل Argon2 لأن مكتبة Argon2 الأصلية لم تُحمَّل على جهاز التطوير (تعتمد على Visual C++ runtime)،
  وscrypt المدمج لا يحتاج أي مكتبة أصلية.
- سياسة: 10 أحرف على الأقل، 128 كحد أقصى، لا تحتوي اسم المستخدم.
- حماية التخمين على مستويين: حد طلبات لكل IP على مسار الدخول (`@nestjs/throttler`)، وإيقاف مؤقت للحساب بعد
  `LOGIN_MAX_FAILURES` محاولات فاشلة متتالية لمدة `LOGIN_LOCK_MINUTES`. إعادة التعيين أو التفعيل بواسطة المدير يفك الإيقاف.
- رسالة الفشل عامة («اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب غير مفعّل») مع تحقق وهمي بنفس الكلفة عند عدم وجود المستخدم.
- لا تُسجَّل كلمات المرور ولا الرموز: مرشّح الأخطاء لا يسجل جسم الطلب، وسجل العمليات لا يستقبل إلا تفاصيل غير سرية.

### الصلاحيات

- نوعان: `ADMIN` (كل الصلاحيات دائمًا) و`SUPERVISOR` (ما يُمنح له في `user_permissions`).
- صلاحيات المرحلة: `FORMS_VIEW`، `FORMS_CREATE`، `FORMS_EDIT`، `FORMS_ARCHIVE`. الإنشاء والتعديل والأرشفة تتطلب العرض (يُفرض في الـ API).
- إدارة المستخدمين لمدير النظام فقط (`@AdminOnly`). حساب المدير محمي من التعديل عبر شاشات المستخدمين.
- **حارس عام واحد** (`AuthGuard` كـ `APP_GUARD`) يطبق الجلسة وCSRF والصلاحيات على كل مسار ما لم يكن `@Public` صراحة،
  فلا يمكن نسيان الحماية على مسار جديد.
- **أثر تغيير الصلاحيات على الجلسات القائمة:** الصلاحيات وحالة التفعيل تُقرأ من القاعدة في كل طلب، لذا يسري
  أي تغيير فورًا على كل جلسات المشرف دون إبطالها. التعطيل وإعادة تعيين كلمة المرور يبطلان الجلسات صراحة.
  تغيير المستخدم لكلمة مروره يبطل جلساته الأخرى ويُبقي الحالية.
- الواجهة تستخدم الصلاحيات نفسها (من `/api/auth/me`) لإظهار الروابط والأزرار فقط.
- لإضافة صلاحية مستقبلًا: قيمة جديدة في enum `Permission` + migration، ثم وصفها في `auth/permissions.ts` و`web/src/lib/permissions.ts`.

### النماذج والمسودات والتزامن

- `forms` سجل مستقل للنموذج (المنشئ، الأوقات، الأرشفة) بلا محتوى.
- `form_drafts` مسودة الإصدار الحالية (واحدة لكل نموذج، `form_id` فريد) تحمل العنوان والوصف و`revision`.
- الإصدارات المنشورة (المرحلة الثالثة) نسخ مستقلة في `form_versions` وأسئلتها وخياراتها، لا تتغير بتعديل المسودة.
- كل نموذج جديد مسودة غير منشورة (`publicationStatus: "draft"`)، ويصبح `published` بعد أول نشر.
- **قفل النموذج:** الحفظ والتعديل والأرشفة والنشر وفتح الاستقبال وإغلاقه وإرسال الرد كلها تبدأ بـ `SELECT ... FOR UPDATE` على صف `forms` نفسه. لذلك تتسلسل هذه العمليات لكل نموذج: لا يُحفظ رد بعد إغلاق الاستقبال، ولا على إصدار لم يعد الأحدث.
- **منع الكتابة الصامتة:** التعديل يرسل `revision` الذي بُني عليه، والتحديث `UPDATE ... WHERE form_id=? AND revision=?`
  يزيده بواحد. إن لم يطابق يُرجع 409 `REVISION_CONFLICT` مع النسخة الحالية، وتعرض الواجهة خيار الإبقاء على التعديلات أو تحميل النسخة الحالية.
- النموذج المؤرشف لا يُعدَّل حتى يُستعاد. لا يوجد حذف نهائي.
- العنوان غير فريد. البحث بالعنوان (`LIKE` غير حساس لحالة الأحرف بترتيب `utf8mb4_unicode_ci`).

### المعرّفات والأوقات

- كل المعرّفات UUIDv7 (`CHAR(36)`): غير متسلسلة للمستخدم الخارجي ومرتبة زمنيًا لصالح الفهارس.
- الأوقات `DATETIME(3)` بتوقيت UTC، وتعرضها الواجهة بتوقيت `Asia/Riyadh` بالتقويم الميلادي.

### الأخطاء والتحقق

- شكل موحد لكل الأخطاء: `{ statusCode, code, message, fields?, details? }` مع `message` عربي و`code` ثابت.
- `ValidationPipe` عام مع `whitelist` و`forbidNonWhitelisted` ورسائل عربية لكل حقل.
- المعرّف غير الصالح في المسار يُعامل كـ 404.

## تصميم الجداول

| الجدول                   | الأعمدة الرئيسية                                                                                                                                                                                                                  | ملاحظات                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `users`                  | `id`، `username` (فريد، صغير)، `display_name`، `password_hash`، `role` (ADMIN/SUPERVISOR)، `is_active`، `failed_login_count`، `locked_until`، `last_login_at`، `password_changed_at`، `created_by_id`، `created_at`، `updated_at` |                                    |
| `user_permissions`       | (`user_id`، `permission`) مفتاح مركب، `granted_by_id`، `granted_at`                                                                                                                                                               | enum قابل للتوسعة بـ migration     |
| `sessions`               | `id`، `token_hash` (فريد)، `csrf_token_hash`، `user_id`، `created_at`، `last_seen_at`، `expires_at`، `revoked_at`، `revoked_reason`، `ip_address`، `user_agent`                                                                   | لا يُخزن الرمز نفسه                |
| `forms`                  | `id`، `public_id` (فريد، عشوائي 128 بت)، `accepting_responses`، `created_by_id`، `created_at`، `updated_at`، `archived_at`، `archived_by_id`                                                                                      | فهرس (`archived_at`، `updated_at`) |
| `form_drafts`            | `id`، `form_id` (فريد)، `title`، `description`، `revision`، `updated_by_id`، `created_at`، `updated_at`                                                                                                                           | فهرس على `title`                   |
| `form_versions`          | `id`، `form_id`، `version_number` (فريد مع النموذج)، `title`، `description`، `source_draft_revision`، `publish_key` (فريد مع النموذج)، `published_by_id`، `published_at`                                                          | لا تحديث ولا حذف                   |
| `form_version_questions` | `id`، `version_id`، `logical_id` (معرّف سؤال المسودة)، `position`، `type`، `title`، `description`، `required`، `settings` (JSON)                                                                                                  |                                    |
| `form_version_options`   | `id`، `question_id`، `logical_id`، `position`، `label`                                                                                                                                                                            |                                    |
| `form_responses`         | `id`، `form_id`، `version_id`، `reference_code` (فريد)، `status` (NEW)، `idempotency_key` و`request_hash` (فريد مع النموذج)، `submitted_at`                                                                                       | بلا IP ولا User-Agent              |
| `form_answers`           | `id`، `response_id`، `question_id` (فريد مع الرد)، `text_value`، `number_value` DECIMAL(23,10)، `date_value` DATE                                                                                                                 | تُحذف مع الرد فقط                  |
| `form_answer_options`    | (`answer_id`، `option_id`) مفتاح مركب                                                                                                                                                                                             |                                    |
| `audit_logs`             | `id`، `actor_id`، `action`، `entity_type`، `entity_id`، `details` (JSON)، `ip_address`، `created_at`                                                                                                                              | بلا أسرار                          |

الإجراءات المسجلة: `user.bootstrap_admin`، `user.created`، `user.updated`، `user.permissions_changed`، `user.activated`،
`user.deactivated`، `user.password_reset`، `auth.login`، `auth.login_failed`، `auth.login_locked`، `auth.logout`،
`auth.password_changed`، `form.created`، `form.updated` (مع القيم قبل/بعد)، `form.archived`، `form.restored`، `form.draft_saved`، `form.published`، `form.responses_opened`، `form.responses_closed`.
لا يُسجَّل إرسال الردود ولا محتواها.
تُكتب داخل نفس المعاملة مع التغيير الذي تسجله.
