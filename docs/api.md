# ملخص الـ APIs والصلاحيات

البادئة: `/api`. الوثيقة الكاملة: [openapi.json](openapi.json) أو `http://localhost:4000/api/docs` أثناء التشغيل.

- المصادقة: Cookie `lp_session` (HttpOnly).
- كل طلب معدِّل يتطلب الترويسة `x-csrf-token` بقيمة Cookie `lp_csrf`، ويُرفض إن حمل Origin غير `WEB_ORIGIN`.
- الأخطاء: `{ statusCode, code, message, fields?, details? }`.

| الطريقة والمسار                                           | الوصف                                                                                                                       | الصلاحية           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `GET /health`                                             | حالة التطبيق وقاعدة البيانات (200 أو 503)                                                                                   | عام                |
| `POST /auth/login`                                        | تسجيل الدخول، يضبط Cookies الجلسة وCSRF                                                                                     | عام (محدود المعدل) |
| `POST /auth/logout`                                       | إبطال الجلسة الحالية                                                                                                        | أي مستخدم مسجل     |
| `GET /auth/me`                                            | المستخدم الحالي وصلاحياته الفعلية                                                                                           | أي مستخدم مسجل     |
| `POST /auth/change-password`                              | تغيير كلمة المرور بعد التحقق من الحالية؛ يبطل الجلسات الأخرى                                                                | أي مستخدم مسجل     |
| `GET /dashboard/summary`                                  | أرقام حقيقية حسب الصلاحيات (النماذج لمن يملك العرض، المستخدمون للمدير)                                                      | أي مستخدم مسجل     |
| `GET /forms?search&status=active\|archived&page&pageSize` | قائمة النماذج                                                                                                               | `FORMS_VIEW`       |
| `GET /forms/:id`                                          | تفاصيل نموذج                                                                                                                | `FORMS_VIEW`       |
| `POST /forms`                                             | إنشاء نموذج (مسودة) `{title, description?}`                                                                                 | `FORMS_CREATE`     |
| `PATCH /forms/:id`                                        | تعديل `{title, description?, revision}`؛ 409 عند تعارض المراجعة أو الأرشفة                                                  | `FORMS_EDIT`       |
| `POST /forms/:id/archive`                                 | أرشفة                                                                                                                       | `FORMS_ARCHIVE`    |
| `POST /forms/:id/restore`                                 | استعادة                                                                                                                     | `FORMS_ARCHIVE`    |
| `GET /users?search&page&pageSize`                         | قائمة المستخدمين                                                                                                            | مدير النظام        |
| `GET /users/permissions`                                  | فهرس الصلاحيات المتاحة                                                                                                      | مدير النظام        |
| `GET /users/:id`                                          | تفاصيل مستخدم                                                                                                               | مدير النظام        |
| `POST /users`                                             | إنشاء مشرف `{username, displayName, password, permissions[]}`                                                               | مدير النظام        |
| `PATCH /users/:id`                                        | تعديل اسم المشرف و/أو صلاحياته (تسري فورًا)                                                                                 | مدير النظام        |
| `POST /users/:id/activate`                                | تفعيل مشرف                                                                                                                  | مدير النظام        |
| `POST /users/:id/deactivate`                              | تعطيل مشرف وإبطال جلساته                                                                                                    | مدير النظام        |
| `POST /users/:id/reset-password`                          | `{newPassword}`؛ إعادة تعيين وإبطال جلساته                                                                                  | مدير النظام        |
| `DELETE /users/:id`                                       | حذف مشرف (حذف ناعم): يختفي من القوائم والإحصاءات، يُمنع دخوله، تُبطل جلساته؛ يبقى سجل نماذجه وعملياته واسم المستخدم محجوزًا | مدير النظام        |

مدير النظام يملك كل الصلاحيات دائمًا. حسابه لا يُعدَّل عبر `/users/*` (403 `ADMIN_ACCOUNT_PROTECTED`).

## رموز الأخطاء الشائعة

| code                                                            | الحالة | المعنى                                                        |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| `UNAUTHENTICATED`                                               | 401    | لا جلسة، أو جلسة ملغاة/منتهية، أو المستخدم معطّل              |
| `INVALID_CREDENTIALS`                                           | 401    | بيانات دخول خاطئة أو حساب غير مفعّل                           |
| `LOGIN_TEMPORARILY_LOCKED`                                      | 429    | إيقاف مؤقت بعد محاولات فاشلة متتالية                          |
| `TOO_MANY_REQUESTS`                                             | 429    | تجاوز حد طلبات الدخول لعنوان IP                               |
| `CSRF_INVALID`                                                  | 403    | رمز CSRF مفقود/خاطئ أو Origin غير معتمد                       |
| `FORBIDDEN`                                                     | 403    | لا يملك الصلاحية المطلوبة                                     |
| `ADMIN_ACCOUNT_PROTECTED`                                       | 403    | محاولة تعديل حساب مدير النظام من إدارة المستخدمين             |
| `VALIDATION_FAILED`                                             | 400    | بيانات غير صحيحة، مع `fields[]` برسائل عربية                  |
| `NOT_FOUND`                                                     | 404    | العنصر غير موجود                                              |
| `USERNAME_TAKEN`                                                | 409    | اسم المستخدم مستخدم                                           |
| `REVISION_CONFLICT`                                             | 409    | تعديل على مراجعة قديمة؛ `details.current` فيها النسخة الحالية |
| `FORM_ARCHIVED` / `FORM_ALREADY_ARCHIVED` / `FORM_NOT_ARCHIVED` | 409    | تعارض حالة الأرشفة                                            |
| `DATABASE_UNAVAILABLE`                                          | 503    | قاعدة البيانات غير متاحة                                      |
