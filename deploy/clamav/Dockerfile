# فاحص البرمجيات الخبيثة (ClamAV clamd) لرفع ملفات لوحة النماذج. سياق البناء: جذر المستودع.
# - يستمع على TCP 3310 داخل الشبكات الداخلية فقط (لا منفذ منشور).
# - حدود الفحص أعلى قليلًا من أقصى ملف مسموح (25MB)، ويُنبّه على الأرشيفات والمستندات المشفرة.
# - ConcurrentDatabaseReload no: لا يضاعف الذاكرة أثناء تحديث التواقيع (لتبقى ضمن mem_limit).
# freshclam داخل الصورة يحدّث التواقيع ويحتاج اتصالًا خارجيًا (شبكة default).
FROM clamav/clamav:1.4
RUN set -e; conf=/etc/clamav/clamd.conf; \
  sed -i -E '/^#?[[:space:]]*(TCPSocket|TCPAddr|StreamMaxLength|MaxFileSize|MaxScanSize|MaxRecursion|MaxFiles|ConcurrentDatabaseReload|AlertEncrypted|AlertEncryptedArchive|AlertEncryptedDoc)[[:space:]]/d' "$conf"; \
  printf '%s\n' \
    'TCPSocket 3310' \
    'TCPAddr 0.0.0.0' \
    'StreamMaxLength 30M' \
    'MaxFileSize 30M' \
    'MaxScanSize 120M' \
    'MaxRecursion 10' \
    'MaxFiles 5000' \
    'ConcurrentDatabaseReload no' \
    'AlertEncrypted yes' \
    'AlertEncryptedArchive yes' \
    'AlertEncryptedDoc yes' >>"$conf"
