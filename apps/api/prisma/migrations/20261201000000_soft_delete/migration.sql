-- حذف ناعم للنماذج والردود. إضافة فقط؛ لا حذف ولا تعديل لبيانات قائمة.

-- AlterTable
ALTER TABLE `forms` ADD COLUMN `deleted_at` DATETIME(3) NULL,
    ADD COLUMN `deleted_by_id` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `form_responses` ADD COLUMN `deleted_at` DATETIME(3) NULL,
    ADD COLUMN `deleted_by_id` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `forms_deleted_at_idx` ON `forms`(`deleted_at`);

-- CreateIndex
CREATE INDEX `form_responses_deleted_at_submitted_at_idx` ON `form_responses`(`deleted_at`, `submitted_at`);
