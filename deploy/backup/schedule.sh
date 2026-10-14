#!/usr/bin/env bash
# حلقة الجدولة داخل حاوية النسخ: تشغيل يومي في BACKUP_TIME (الافتراضي 02:30) بتوقيت TZ (Asia/Riyadh).
# فشل نسخة لا يوقف الحلقة؛ الحالة في /backups/last-status.json.
set -u
BACKUP_TIME=${BACKUP_TIME:-02:30}
export TZ=${TZ:-Asia/Riyadh}
echo "lawha backup scheduler: daily at $BACKUP_TIME ($TZ)"
if [ -z "${BACKUP_DB_PASSWORD:-}" ] || [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  # غير مضبوط بعد: تُسجَّل الحالة ولا تُعاد محاولة التشغيل (المتغيرات لا تتغير دون إعادة نشر)
  mkdir -p "${BACKUP_DIR:-/backups}"
  status='{"time":"%s","ok":false,"backup":null,"message":"not configured: set BACKUP_DB_PASSWORD and BACKUP_ENCRYPTION_KEY"}'
  printf "$status\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${BACKUP_DIR:-/backups}/last-status.json"
  echo "backup not configured: set BACKUP_DB_PASSWORD and BACKUP_ENCRYPTION_KEY" >&2
  while true; do sleep 86400; done
fi
while true; do
  now=$(date +%s)
  next=$(date -d "today $BACKUP_TIME" +%s)
  [ "$next" -gt "$now" ] || next=$(date -d "tomorrow $BACKUP_TIME" +%s)
  sleep $((next - now))
  /opt/lawha-backup/backup.sh || echo "backup run failed (see last-status.json)" >&2
done
