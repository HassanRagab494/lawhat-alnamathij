-- تعديل الردود قبل الاعتماد، وسبب الرفض، وإزالة المرفقات دون حذف. إضافة فقط؛ لا حذف ولا تعديل لبيانات قائمة.

-- AlterTable
ALTER TABLE `form_responses` ADD COLUMN `edit_revision` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `form_response_status_changes` ADD COLUMN `reason` VARCHAR(500) NULL;

-- AlterTable
ALTER TABLE `uploaded_files` ADD COLUMN `removed_at` DATETIME(3) NULL,
    ADD COLUMN `removed_by_id` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `fill_sessions` ADD COLUMN `response_id` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `fill_sessions_response_id_idx` ON `fill_sessions`(`response_id`);

-- CreateTable
CREATE TABLE `form_response_edits` (
    `id` CHAR(36) NOT NULL,
    `response_id` CHAR(36) NOT NULL,
    `revision` INTEGER NOT NULL,
    `question_id` CHAR(36) NOT NULL,
    `question_title` VARCHAR(300) NOT NULL,
    `old_value` JSON NULL,
    `new_value` JSON NULL,
    `edited_by_id` CHAR(36) NOT NULL,
    `edited_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `form_response_edits_response_id_edited_at_idx`(`response_id`, `edited_at`),
    INDEX `form_response_edits_edited_by_id_idx`(`edited_by_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `form_response_edits` ADD CONSTRAINT `form_response_edits_response_id_fkey` FOREIGN KEY (`response_id`) REFERENCES `form_responses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_response_edits` ADD CONSTRAINT `form_response_edits_edited_by_id_fkey` FOREIGN KEY (`edited_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
