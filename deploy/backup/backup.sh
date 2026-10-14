#!/usr/bin/env bash
# نسخة احتياطية مشفرة لقاعدة لوحة النماذج وملفات الردود، مع manifest وتحقق واحتفاظ محدود.
#
# الاتساق بين القاعدة والملفات:
#   1) mysqldump --single-transaction: لقطة متسقة للقاعدة (اللحظة T).
#   2) بعد انتهاء النسخ: قائمة كل الملفات المرتبطة بردود (response_id غير فارغ) — مجموعة تحوي كل ما في اللقطة.
#   3) أرشفة مجلد الملفات بعد ذلك. ملفات الردود لا تُعدَّل ولا تُحذف أبدًا (التنظيف يمس غير المرتبطة فقط)،
#      فكل ملف في القائمة موجود وقت الأرشفة.
#   4) التحقق: كل ملف في القائمة موجود في الأرشيف وتجزئته تطابق القاعدة، وإلا تفشل النسخة ولا تُعتمد.
# الملفات المؤقتة غير المرسلة قد تدخل الأرشيف إن وُجدت وقت النسخ؛ لا تُتحقق ولا تُعتمد (تُنظَّف بعد الاستعادة).
#
# المتغيرات (لا يُطبع أي سر):
#   BACKUP_DB_USER, BACKUP_DB_PASSWORD   حساب قراءة فقط (create-backup-user.sql)
#   BACKUP_ENCRYPTION_KEY                مفتاح التشفير (سر خارج Git؛ احفظ نسخة منه خارج الخادم)
#   DB_HOST(mysql) DB_PORT(3306) DB_NAME(lawha) UPLOAD_DIR(/data/uploads) BACKUP_DIR(/backups)
#   KEEP_DAILY(7) KEEP_WEEKLY(4) WEEKLY_DAY(5 = الجمعة، حسب date +%u بتوقيت TZ)
#   MYSQLDUMP, MYSQL                     مسار الأوامر عند الاختبار المحلي
set -Eeuo pipefail
umask 077

DB_HOST=${DB_HOST:-mysql}
DB_PORT=${DB_PORT:-3306}
DB_NAME=${DB_NAME:-lawha}
UPLOAD_DIR=${UPLOAD_DIR:-/data/uploads}
BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}
WEEKLY_DAY=${WEEKLY_DAY:-5}
MYSQLDUMP=${MYSQLDUMP:-mysqldump}
MYSQL=${MYSQL:-mysql}
: "${BACKUP_DB_USER:?BACKUP_DB_USER مطلوب}"
: "${BACKUP_DB_PASSWORD:?BACKUP_DB_PASSWORD مطلوب}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY مطلوب}"
export MYSQL_PWD="$BACKUP_DB_PASSWORD"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="$BACKUP_DIR/.incomplete-$STAMP"
FINAL="$BACKUP_DIR/daily/$STAMP"
STARTED=$(date +%s)
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$WORK"

write_status() {
  local ok=$1 message=$2
  printf '{"time":"%s","ok":%s,"backup":"%s","durationSeconds":%s,"message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$STAMP" "$(($(date +%s) - STARTED))" "$message" \
    >"$BACKUP_DIR/last-status.json.tmp"
  mv -f "$BACKUP_DIR/last-status.json.tmp" "$BACKUP_DIR/last-status.json"
}

fail() {
  echo "backup failed: $1" >&2
  rm -rf "$WORK"
  write_status false "$1"
  exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

encrypt() {
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$1.enc"
  rm -f "$1"
}

echo "[$STAMP] dump database"
"$MYSQLDUMP" -h "$DB_HOST" -P "$DB_PORT" -u "$BACKUP_DB_USER" \
  --single-transaction --quick --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF \
  --triggers --skip-routines --skip-events --hex-blob --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -c >"$WORK/db.sql.gz"
gzip -t "$WORK/db.sql.gz" || fail "database dump is not a valid gzip"

echo "[$STAMP] list attached files (after dump)"
"$MYSQL" -h "$DB_HOST" -P "$DB_PORT" -u "$BACKUP_DB_USER" -N -B "$DB_NAME" -e \
  "SELECT storage_key, sha256, size_bytes FROM uploaded_files WHERE response_id IS NOT NULL ORDER BY storage_key" \
  | tr -d '\r' >"$WORK/attached.tsv"

echo "[$STAMP] archive files"
# مجلد الملفات للقراءة فقط هنا؛ إن لم يوجد بعد يُؤرشف مجلد فارغ
if [ -d "$UPLOAD_DIR/files" ]; then
  tar -C "$UPLOAD_DIR" -czf "$WORK/uploads.tar.gz" files
else
  mkdir -p "$WORK/empty/files"
  tar -C "$WORK/empty" -czf "$WORK/uploads.tar.gz" files
  rm -rf "$WORK/empty"
fi
tar -tzf "$WORK/uploads.tar.gz" | awk -F/ 'NF == 3 && $3 != "" { print $3 }' | sort >"$WORK/archived.txt"

echo "[$STAMP] verify attached files"
attached=0
while IFS=$'\t' read -r key sha size; do
  [ -n "$key" ] || continue
  grep -qxF "$key" "$WORK/archived.txt" || fail "attached file missing from archive"
  actual=$(sha256sum "$UPLOAD_DIR/files/${key:0:2}/$key" | cut -d' ' -f1)
  [ "$actual" = "$sha" ] || fail "attached file hash mismatch"
  attached=$((attached + 1))
done <"$WORK/attached.tsv"
archived=$(wc -l <"$WORK/archived.txt" | tr -d ' ')
rm -f "$WORK/archived.txt"

echo "[$STAMP] encrypt"
for f in db.sql.gz uploads.tar.gz attached.tsv; do encrypt "$WORK/$f"; done
# اختبار فك التشفير: الأرشيفات قابلة للاستعادة بالمفتاح الحالي
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY \
  -in "$WORK/db.sql.gz.enc" | gzip -t || fail "encrypted dump does not decrypt"

{
  printf '{\n  "format": "lawha-backup/1",\n  "createdAt": "%s",\n  "database": "%s",\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DB_NAME"
  printf '  "attachedFiles": %s,\n  "archivedFiles": %s,\n' "$attached" "$archived"
  printf '  "encryption": "openssl aes-256-cbc pbkdf2 iter=200000",\n  "artifacts": [\n'
  first=1
  for f in db.sql.gz.enc uploads.tar.gz.enc attached.tsv.enc; do
    [ $first -eq 1 ] || printf ',\n'
    first=0
    printf '    {"name": "%s", "bytes": %s, "sha256": "%s"}' \
      "$f" "$(wc -c <"$WORK/$f" | tr -d ' ')" "$(sha256sum "$WORK/$f" | cut -d' ' -f1)"
  done
  printf '\n  ]\n}\n'
} >"$WORK/manifest.json"
(cd "$WORK" && sha256sum db.sql.gz.enc uploads.tar.gz.enc attached.tsv.enc manifest.json >SHA256SUMS)

mv "$WORK" "$FINAL"
trap - ERR

# نسخة أسبوعية: رابط صلب لنسخة يوم WEEKLY_DAY (لا مساحة إضافية)
if [ "$(date +%u)" = "$WEEKLY_DAY" ]; then
  mkdir -p "$BACKUP_DIR/weekly/$STAMP"
  ln "$FINAL"/* "$BACKUP_DIR/weekly/$STAMP"/ 2>/dev/null || cp -p "$FINAL"/* "$BACKUP_DIR/weekly/$STAMP"/
fi

# الاحتفاظ: بعد نجاح النسخة الجديدة فقط، وداخل مجلدات هذا النظام وبأسماء نمطه فقط
prune() {
  local dir=$1 keep=$2
  find "$dir" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{8}T[0-9]{6}Z' -printf '%f\n' | sort -r | tail -n +"$((keep + 1))" |
    while read -r old; do rm -rf "${dir:?}/$old"; done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.incomplete-*' -mmin +1440 -exec rm -rf {} +

write_status true "ok: attached=$attached archived=$archived"
echo "[$STAMP] backup ok -> $FINAL"
