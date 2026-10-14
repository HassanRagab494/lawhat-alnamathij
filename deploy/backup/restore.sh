#!/usr/bin/env bash
# استعادة نسخة احتياطية إلى قاعدة وتخزين **منفصلين** ثم التحقق منها. لا يكتب فوق الإنتاج أبدًا.
#
#   restore.sh <مجلد-النسخة>
#
# المتغيرات:
#   BACKUP_ENCRYPTION_KEY                       مفتاح التشفير نفسه المستخدم في النسخ
#   RESTORE_DB_HOST RESTORE_DB_PORT RESTORE_DB_NAME RESTORE_DB_USER RESTORE_DB_PASSWORD   قاعدة الهدف
#   RESTORE_UPLOAD_DIR                          مجلد فارغ أو غير موجود لاستعادة الملفات
#   PROD_DB_NAME(lawha) PROD_DB_HOST(mysql) PROD_UPLOAD_DIR(/data/uploads)   للرفض إن كان الهدف هو الإنتاج
#   RESTORE_RESET_TARGET=yes                    يحذف جداول قاعدة الهدف أولًا (ممنوع إن كانت هي الإنتاج)
#   MYSQL                                       مسار mysql عند الاختبار المحلي
set -Eeuo pipefail
umask 077

SRC=${1:?مسار مجلد النسخة مطلوب}
MYSQL=${MYSQL:-mysql}
PROD_DB_NAME=${PROD_DB_NAME:-lawha}
PROD_DB_HOST=${PROD_DB_HOST:-mysql}
PROD_UPLOAD_DIR=${PROD_UPLOAD_DIR:-/data/uploads}
RESTORE_DB_PORT=${RESTORE_DB_PORT:-3306}
: "${BACKUP_ENCRYPTION_KEY:?}" "${RESTORE_DB_HOST:?}" "${RESTORE_DB_NAME:?}" "${RESTORE_DB_USER:?}"
: "${RESTORE_DB_PASSWORD:?}" "${RESTORE_UPLOAD_DIR:?}"

die() { echo "restore refused/failed: $1" >&2; exit 1; }

# حماية الإنتاج: اسم القاعدة نفسه (بأي مضيف) أو مجلد الملفات نفسه مرفوضان دائمًا
[ "$RESTORE_DB_NAME" != "$PROD_DB_NAME" ] || die "target database name equals production ($PROD_DB_NAME)"
[ "$(cd "$(dirname "$RESTORE_UPLOAD_DIR")" 2>/dev/null && pwd)/$(basename "$RESTORE_UPLOAD_DIR")" != "$PROD_UPLOAD_DIR" ] ||
  die "target upload dir equals production"
if [ -d "$RESTORE_UPLOAD_DIR" ] && [ -n "$(ls -A "$RESTORE_UPLOAD_DIR")" ]; then
  die "target upload dir is not empty"
fi

export MYSQL_PWD="$RESTORE_DB_PASSWORD"
q() { "$MYSQL" -h "$RESTORE_DB_HOST" -P "$RESTORE_DB_PORT" -u "$RESTORE_DB_USER" -N -B "$RESTORE_DB_NAME" "$@" | tr -d '\r'; }

echo "verify artifacts"
(cd "$SRC" && sha256sum -c SHA256SUMS --quiet) || die "checksum mismatch (corrupted or altered backup)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
dec() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY -in "$SRC/$1.enc" -out "$TMP/$1" ||
    die "cannot decrypt $1 (wrong key?)"
}
dec db.sql.gz
dec uploads.tar.gz
dec attached.tsv
gzip -t "$TMP/db.sql.gz" && gzip -t "$TMP/uploads.tar.gz" || die "archive corrupted"

tables=$(q -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()")
if [ "$tables" != "0" ]; then
  [ "${RESTORE_RESET_TARGET:-}" = "yes" ] || die "target database is not empty (set RESTORE_RESET_TARGET=yes for a scratch database)"
  echo "reset scratch target database"
  drops=$(q -e "SELECT CONCAT('DROP TABLE IF EXISTS \`', table_name, '\`;') FROM information_schema.tables WHERE table_schema = DATABASE()")
  q -e "SET FOREIGN_KEY_CHECKS=0; $drops SET FOREIGN_KEY_CHECKS=1;"
fi

echo "import database"
gzip -dc "$TMP/db.sql.gz" | q
echo "extract files"
mkdir -p "$RESTORE_UPLOAD_DIR"
tar -C "$RESTORE_UPLOAD_DIR" -xzf "$TMP/uploads.tar.gz"

echo "verify restore"
problems=0
check_zero() {
  local label=$1 sql=$2 n
  n=$(q -e "$sql")
  if [ "$n" != "0" ]; then echo "FAIL $label: $n"; problems=$((problems + 1)); else echo "OK   $label"; fi
}
for t in users forms form_drafts form_versions form_version_questions form_responses form_answers form_response_status_changes uploaded_files; do
  echo "count $t: $(q -e "SELECT COUNT(*) FROM \`$t\`")"
done
check_zero "responses without version of same form" \
  "SELECT COUNT(*) FROM form_responses r LEFT JOIN form_versions v ON v.id = r.version_id AND v.form_id = r.form_id WHERE v.id IS NULL"
check_zero "answers without response/question of same version" \
  "SELECT COUNT(*) FROM form_answers a LEFT JOIN form_responses r ON r.id = a.response_id AND r.version_id = a.version_id LEFT JOIN form_version_questions q ON q.id = a.question_id AND q.version_id = a.version_id WHERE r.id IS NULL OR q.id IS NULL"
check_zero "attached files without matching response/answer" \
  "SELECT COUNT(*) FROM uploaded_files f LEFT JOIN form_responses r ON r.id = f.response_id AND r.version_id = f.version_id LEFT JOIN form_answers a ON a.id = f.answer_id AND a.question_id = f.question_id WHERE f.response_id IS NOT NULL AND (r.id IS NULL OR a.id IS NULL)"
check_zero "status changes without response" \
  "SELECT COUNT(*) FROM form_response_status_changes c LEFT JOIN form_responses r ON r.id = c.response_id WHERE r.id IS NULL"

files_ok=0
while IFS=$'\t' read -r key sha; do
  [ -n "$key" ] || continue
  path="$RESTORE_UPLOAD_DIR/files/${key:0:2}/$key"
  if [ ! -f "$path" ]; then echo "FAIL missing file for attached record"; problems=$((problems + 1)); continue; fi
  actual=$(sha256sum "$path" | cut -d' ' -f1)
  if [ "$actual" != "$sha" ]; then echo "FAIL hash mismatch"; problems=$((problems + 1)); else files_ok=$((files_ok + 1)); fi
done < <(q -e "SELECT storage_key, sha256 FROM uploaded_files WHERE response_id IS NOT NULL")
echo "attached files verified: $files_ok"

[ "$problems" -eq 0 ] || die "$problems verification problem(s)"
echo "restore verified OK"
