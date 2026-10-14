#!/usr/bin/env bash
# حلقة الجدولة داخل حاوية النسخ: تشغيل يومي في BACKUP_TIME (الافتراضي 02:30) بتوقيت TZ (Asia/Riyadh).
# فشل نسخة لا يوقف الحلقة؛ الحالة في /backups/last-status.json.
set -u
BACKUP_TIME=${BACKUP_TIME:-02:30}
export TZ=${TZ:-Asia/Riyadh}
echo "lawha backup scheduler: daily at $BACKUP_TIME ($TZ)"
while true; do
  now=$(date +%s)
  next=$(date -d "today $BACKUP_TIME" +%s)
  [ "$next" -gt "$now" ] || next=$(date -d "tomorrow $BACKUP_TIME" +%s)
  sleep $((next - now))
  /opt/lawha-backup/backup.sh || echo "backup run failed (see last-status.json)" >&2
done
