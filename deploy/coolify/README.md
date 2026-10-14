# النشر على Coolify — lawhat-alnamathij

> إعداد للمسؤول عن Coolify. لم تُغيَّر الاستضافة من هذا المستودع.
> المورد: `lawhat-alnamathij-staging` في مشروع `lawhat-alnamathij`. لا تُستخدم موارد Flowmax أو قواعده أو شبكاته، ولا يُعدَّل الوكيل المشترك.

## الملفات

| الملف                                                                                                              | الغرض                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [`compose.production.yaml`](../../compose.production.yaml)                                                         | خمس خدمات: `mysql`، `api`، `web`، `clamav`، `backup`    |
| [`apps/api/Dockerfile`](../../apps/api/Dockerfile) + [`docker-entrypoint.sh`](../../apps/api/docker-entrypoint.sh) | الـ API: `prisma migrate deploy` (إضافية فقط) ثم الخادم |
| [`apps/web/Dockerfile`](../../apps/web/Dockerfile)                                                                 | الواجهة (Next.js standalone)                            |
| [`deploy/clamav/Dockerfile`](../clamav/Dockerfile)                                                                 | فاحص ClamAV (clamd) بإعداد حدود الفحص                   |
| [`deploy/backup/`](../backup/README.md)                                                                            | النسخ الاحتياطي المشفر والاستعادة والتراجع              |
| [`env.example`](env.example)                                                                                       | المتغيرات، بلا أسرار                                    |
| [`docs/trust-boundary.md`](../../docs/trust-boundary.md)                                                           | حدود الثقة لعنوان IP                                    |

## إعدادات Coolify

**المورد:**

1. Docker Compose من `HassanRagab494/lawhat-alnamathij` على `main`.
   - Base Directory: `/`
   - Compose Location: `/compose.production.yaml`
2. **Domains:** خدمة `web` فقط. الإعداد الحالي `https://forms.flowmaxsa.cloud:3000` صحيح ويبقى كما هو.
   - `:3000` هو منفذ الخدمة الداخلي الذي يوجّه إليه الوكيل، أما الرابط العام فبلا منفذ.
   - لا دومين لـ `api` و`mysql` و`clamav` و`backup`.
3. **المتغيرات** حسب [`env.example`](env.example):

   | المتغير                 | ملاحظة                              |
   | ----------------------- | ----------------------------------- |
   | `MYSQL_PASSWORD`        | سر                                  |
   | `MYSQL_ROOT_PASSWORD`   | سر                                  |
   | `WEB_ORIGIN`            |                                     |
   | `BACKUP_DB_PASSWORD`    | سر، **جديد**                        |
   | `BACKUP_ENCRYPTION_KEY` | سر، **جديد**؛ احفظ نسخة خارج الخادم |

4. لا «Expose ports» ولا منافذ منشورة على المضيف، ولا «Connect To Predefined Network».

## الموارد (يجب التحقق قبل النشر)

لم يكن لدي وصول للخادم، فلم أقس موارده.

ClamAV يحمّل التواقيع في الذاكرة (نحو 1.2–1.5GB)، ولذلك له سقف صريح: `mem_limit 2g` و`cpus 1.0`، ويمكن ضبطهما بـ `CLAMAV_MEM_LIMIT` و`CLAMAV_CPUS`. وللنسخ الاحتياطي سقف `512m` و`0.5` CPU.

**قبل النشر**، من الخادم دون تغيير أي خدمة:

```bash
free -h
df -h /var/lib/docker
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
```

**الشرط:** ذاكرة متاحة ≥ 2.5GB بعد الخدمات الحالية، ومساحة قرص ≥ 10GB للملفات والنسخ.

**إن لم يتحقق الشرط، القرار للمالك:**

| الخيار             | النتيجة                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (أ) ترقية الخادم   | تكلفة: قرار منك                                                                                                                                             |
| (ب) النشر بلا فاحص | تُحذف خدمة `clamav` ومتغير `CLAMAV_HOST`. **رفع الملفات يبقى معطلًا**: نشر نموذج فيه سؤال ملفات يُرفض برسالة «رفع الملفات غير مفعّل»، ولا يُقبل ملف دون فحص |

## خطوات النشر (بالترتيب)

1. **نسخة احتياطية موثوقة للقاعدة الحالية** حسب [deploy/backup/README.md](../backup/README.md#النسخة-قبل-تحديث-الاستضافة-إلزامي-قبل-نشر-المرحلة-النهائية)، والتأكد بـ `gzip -t`.
2. **الإعداد لمرة واحدة:**
   - إنشاء حساب النسخ `lawha_backup` (`create-backup-user.sql`).
   - إضافة السرين الجديدين في Coolify.
3. **Redeploy** للمورد `lawhat-alnamathij-staging` فقط. لا Docker Cleanup، ولا إعادة تشغيل للخادم أو الوكيل.
4. **سجل الـ API:** يجب أن يظهر `Applying migration 20261025000000_file_uploads` ثم `All migrations have been successfully applied`.
5. **من Terminal خدمة `api`:**
   ```bash
   node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>r.text()).then(console.log)"
   ```
   والنتيجة المطلوبة `"database":"up"`.
6. **من Terminal خدمة `clamav`** (بعد اكتمال تحميل التواقيع، وقد يستغرق دقائق):
   ```bash
   clamdcheck.sh && echo clamd-ok
   ```
7. **من Terminal خدمة `backup`:**
   ```bash
   /opt/lawha-backup/backup.sh && cat /backups/last-status.json
   ```
   ثم اختبار الاستعادة إلى قاعدة مؤقتة حسب دليل النسخ.
8. **من جهاز خارج الخادم:**
   ```bash
   node scripts/check-forwarded-for.mjs --base https://forms.flowmaxsa.cloud
   ```
   المطلوب PASS للسطرين.
9. **تجربة الملفات الحقيقية بنموذج اختبار واضح الاسم:**
   - رفع PDF سليم ⇒ «جاهز».
   - رفع ملف EICAR النصي ⇒ «رُفض الملف لأن الفحص اكتشف محتوى ضارًا» (هذا يثبت الفحص الحقيقي).
   - إرسال، ثم تنزيل الملف بحساب يملك الصلاحية.

## الشبكات وحدود الثقة

```text
الزائر ⇒ Traefik ⇒ web:3000 ─[backend: internal]─► api:4000 ─► mysql:3306
                                                    └──────► clamav:3310 (الاسم lawha-clamav-backend)
backup ─[backend]─► mysql:3306   (يقرأ volume الملفات للقراءة فقط)
```

- **لا منافذ منشورة لأي خدمة.** `api` و`mysql` و`backup` على شبكة `backend` الداخلية فقط.
- **`clamav`** على `default` أيضًا، لتحديث التواقيع (freshclam) فقط. لا router ولا دومين.
- **`TRUST_PROXY = BACKEND_SUBNET`**؛ التفاصيل في `docs/trust-boundary.md`.
- **نسخة `api` واحدة فقط**، لأن حدود المعدل في الذاكرة.

## التخزين الدائم (لا تحذف أي volume)

| volume             | المحتوى                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `lawha-mysql-data` | قاعدة البيانات                                                                             |
| `lawha-uploads`    | ملفات الردود. مجلد `files` بأسماء عشوائية، يكتبه الـ API وحده، ويقرؤه `backup` للقراءة فقط |
| `lawha-backups`    | النسخ المشفرة وحالة آخر نسخة                                                               |
| `lawha-clamav-db`  | تواقيع ClamAV                                                                              |

## فحوص الصحة

| الخدمة   | الفحص                                                                                  |
| -------- | -------------------------------------------------------------------------------------- |
| `mysql`  | `mysqladmin ping`                                                                      |
| `api`    | `GET /api/health`. لا ينتظر جاهزية `clamav`، والرفع يُرفض برسالة واضحة حتى يجهز الفاحص |
| `web`    | `GET /login`                                                                           |
| `clamav` | `clamdcheck.sh` المضمّن في الصورة الرسمية                                              |

وثائق `/api/docs` معطلة في الإنتاج.

## التراجع

انظر [deploy/backup/README.md](../backup/README.md#خطة-التراجع-تحافظ-على-البيانات). الـ migration إضافية ولا تُعكس، والتراجع يحافظ على كل البيانات والملفات.
