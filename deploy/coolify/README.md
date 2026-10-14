# النشر على Coolify — lawhat-alnamathij

> المورد: `lawhat-alnamathij-staging` في مشروع `lawhat-alnamathij`. لا تُستخدم موارد Flowmax أو قواعده أو شبكاته، ولا يُعدَّل الوكيل المشترك.

## الإعداد الحالي: الرفع دون فحص برمجيات خبيثة

**`UPLOAD_SCAN_MODE=disabled` ولا تُشغَّل خدمة ClamAV.**

رفع الملفات يعمل مع بقاء هذه الضوابط:

- التحقق من النوع الفعلي للمحتوى ومطابقة الامتداد.
- فك DOCX/XLSX بحدود، ورفض المشفر.
- حدود الحجم والعدد لكل سؤال وجلسة، وسعة التخزين.
- جلسة التعبئة وملكية الملفات.
- صلاحية التنزيل المستقلة.
- حدود معدل الطلبات.

**الملفات لا تُفحص ضد البرمجيات الخبيثة:**

- تُخزَّن بعلامة `not-scanned:UPLOAD_SCAN_MODE=disabled`.
- تظهر في تفاصيل الرد بشارة «غير مفحوص ضد البرمجيات الخبيثة».
- الصفحة العامة لا تعرض أي عبارة فحص.

لا تعتبر هذه الملفات آمنة: افتحها بحذر، ويُفضّل على جهاز محدّث الحماية.

لتفعيل الفحص لاحقًا، انظر [`deploy/clamav/compose.clamav.yaml`](../clamav/compose.clamav.yaml). يحتاج ذاكرة حرة ≥ 2.5GB، ثم `UPLOAD_SCAN_MODE=required` مع `CLAMAV_HOST`.

## الملفات

| الملف                                                                                                              | الغرض                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [`compose.production.yaml`](../../compose.production.yaml)                                                         | أربع خدمات: `mysql`، `api`، `web`، `backup`             |
| [`apps/api/Dockerfile`](../../apps/api/Dockerfile) + [`docker-entrypoint.sh`](../../apps/api/docker-entrypoint.sh) | الـ API: `prisma migrate deploy` (إضافية فقط) ثم الخادم |
| [`apps/web/Dockerfile`](../../apps/web/Dockerfile)                                                                 | الواجهة (Next.js standalone)                            |
| [`deploy/backup/`](../backup/README.md)                                                                            | النسخ الاحتياطي المشفر والاستعادة والتراجع              |
| [`deploy/clamav/`](../clamav/compose.clamav.yaml)                                                                  | تعريف فاحص ClamAV عند تفعيله لاحقًا (غير منشور حاليًا)  |
| [`env.example`](env.example)                                                                                       | المتغيرات، بلا أسرار                                    |
| [`docs/trust-boundary.md`](../../docs/trust-boundary.md)                                                           | حدود الثقة لعنوان IP                                    |

## إعدادات Coolify

1. Docker Compose من `HassanRagab494/lawhat-alnamathij` على `main`.
   - Base Directory: `/`
   - Compose Location: `/compose.production.yaml`
2. **Domains:** خدمة `web` فقط بالقيمة `https://forms.flowmaxsa.cloud:3000`.
   - `:3000` هو منفذ الخدمة الداخلي الذي يوجّه إليه الوكيل، والرابط العام `https://forms.flowmaxsa.cloud` بلا منفذ.
   - لا دومين لـ `api` و`mysql` و`backup`.
3. **المتغيرات** حسب [`env.example`](env.example):

   | المتغير                                       | ملاحظة                                                                                                 |
   | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
   | `MYSQL_PASSWORD`                              | سر                                                                                                     |
   | `MYSQL_ROOT_PASSWORD`                         | سر                                                                                                     |
   | `WEB_ORIGIN`                                  |                                                                                                        |
   | `UPLOAD_SCAN_MODE`                            | `disabled`                                                                                             |
   | `BACKUP_DB_PASSWORD` و`BACKUP_ENCRYPTION_KEY` | سران لتفعيل النسخ الاحتياطي. بدونهما يعمل التطبيق، وخدمة `backup` تسجل «not configured» ولا تنسخ شيئًا |

4. لا «Expose ports» ولا منافذ منشورة على المضيف.

## خطوات النشر

1. **نسخة احتياطية للقاعدة الحالية** حسب [deploy/backup/README.md](../backup/README.md#النسخة-قبل-تحديث-الاستضافة-إلزامي-قبل-نشر-المرحلة-النهائية).
2. **ضبط `UPLOAD_SCAN_MODE=disabled`**، ثم **Redeploy** للمورد فقط. لا Docker Cleanup، ولا حذف volumes، ولا إعادة تشغيل للخادم أو الوكيل.
3. **سجل الـ API:** يجب أن يظهر `20261025000000_file_uploads` ثم `All migrations have been successfully applied`.
4. **التحقق من الواجهة:** الدخول، ونشر نموذج فيه سؤال ملفات، ورفع PDF وPNG من الرابط العام، والإرسال، والتنزيل بحساب يملك الصلاحية، ورفض امتداد غير مسموح.
5. **من جهاز خارج الخادم:**
   ```bash
   node scripts/check-forwarded-for.mjs --base https://forms.flowmaxsa.cloud
   ```

## الشبكات وحدود الثقة

```text
الزائر ⇒ Traefik ⇒ web:3000 ─[backend: internal]─► api:4000 ─► mysql:3306
backup ─[backend]─► mysql:3306   (يقرأ volume الملفات للقراءة فقط)
```

- **لا منافذ منشورة لأي خدمة.** `api` و`mysql` و`backup` على شبكة `backend` الداخلية فقط.
- **`TRUST_PROXY = BACKEND_SUBNET`.**
- **نسخة `api` واحدة فقط**، لأن حدود المعدل في الذاكرة.

## التخزين الدائم (لا تحذف أي volume)

| volume             | المحتوى                                                       |
| ------------------ | ------------------------------------------------------------- |
| `lawha-mysql-data` | قاعدة البيانات                                                |
| `lawha-uploads`    | ملفات الردود. مجلد `files` بأسماء عشوائية، يكتبه الـ API وحده |
| `lawha-backups`    | النسخ المشفرة وحالة آخر نسخة                                  |

## فحوص الصحة

| الخدمة  | الفحص             |
| ------- | ----------------- |
| `mysql` | `mysqladmin ping` |
| `api`   | `GET /api/health` |
| `web`   | `GET /login`      |

وثائق `/api/docs` معطلة في الإنتاج.

## التراجع

انظر [deploy/backup/README.md](../backup/README.md#خطة-التراجع-تحافظ-على-البيانات).
