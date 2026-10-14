# حاوية النسخ الاحتياطي: mysqldump من صورة MySQL نفسها (8.4) + أدوات الأرشفة والتشفير.
# سياق البناء: جذر المستودع.
FROM mysql:8.4
RUN microdnf install -y tar gzip openssl findutils coreutils-single tzdata \
  && microdnf clean all
COPY deploy/backup/backup.sh deploy/backup/restore.sh deploy/backup/schedule.sh /opt/lawha-backup/
RUN chmod 0755 /opt/lawha-backup/*.sh
ENV TZ=Asia/Riyadh
# لا خادم MySQL هنا: الحلقة فقط
ENTRYPOINT []
CMD ["/opt/lawha-backup/schedule.sh"]
