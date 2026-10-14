-- المرحلة الرابعة: مراجعة الردود. إضافة فقط، قابلة للتطبيق بـ prisma migrate deploy دون reset.
-- مفاتيح مركبة تمنع ربط إجابة بسؤال أو خيار من إصدار آخر، أو رد بإصدار من نموذج آخر.
-- DropForeignKey
ALTER TABLE `form_answer_options` DROP FOREIGN KEY `form_answer_options_answer_id_fkey`;

-- DropForeignKey
ALTER TABLE `form_answer_options` DROP FOREIGN KEY `form_answer_options_option_id_fkey`;

-- DropForeignKey
ALTER TABLE `form_answers` DROP FOREIGN KEY `form_answers_question_id_fkey`;

-- DropForeignKey
ALTER TABLE `form_answers` DROP FOREIGN KEY `form_answers_response_id_fkey`;

-- DropForeignKey
ALTER TABLE `form_responses` DROP FOREIGN KEY `form_responses_version_id_fkey`;

-- DropIndex
DROP INDEX `form_answer_options_option_id_fkey` ON `form_answer_options`;

-- DropIndex
DROP INDEX `form_answers_question_id_fkey` ON `form_answers`;

-- DropIndex
DROP INDEX `form_responses_version_id_fkey` ON `form_responses`;

-- AlterTable: يُضاف العمود فارغًا ثم يُملأ من البيانات الحالية ثم يُجعل إلزاميًا، فتنجح الـ migration على جداول فيها ردود.
ALTER TABLE `form_answers` ADD COLUMN `version_id` CHAR(36) NULL;
UPDATE `form_answers` a JOIN `form_responses` r ON r.`id` = a.`response_id` SET a.`version_id` = r.`version_id`;
ALTER TABLE `form_answers` MODIFY `version_id` CHAR(36) NOT NULL;

-- AlterTable
ALTER TABLE `form_answer_options` ADD COLUMN `question_id` CHAR(36) NULL;
UPDATE `form_answer_options` o JOIN `form_answers` a ON a.`id` = o.`answer_id` SET o.`question_id` = a.`question_id`;
ALTER TABLE `form_answer_options` MODIFY `question_id` CHAR(36) NOT NULL;

-- AlterTable
ALTER TABLE `form_responses` MODIFY `status` ENUM('NEW', 'IN_REVIEW', 'ACCEPTED', 'REJECTED') NOT NULL DEFAULT 'NEW';

-- AlterTable
-- إضافة قيم للـ enum فقط؛ المفتاح الأساسي (user_id, permission) لا يتغير.
ALTER TABLE `user_permissions` MODIFY `permission` ENUM('FORMS_VIEW', 'FORMS_CREATE', 'FORMS_EDIT', 'FORMS_ARCHIVE', 'FORMS_PUBLISH', 'FORMS_INTAKE', 'RESPONSES_VIEW', 'RESPONSES_REVIEW', 'RESPONSES_EXPORT') NOT NULL;

-- CreateTable
CREATE TABLE `form_response_status_changes` (
    `id` CHAR(36) NOT NULL,
    `response_id` CHAR(36) NOT NULL,
    `from_status` ENUM('NEW', 'IN_REVIEW', 'ACCEPTED', 'REJECTED') NOT NULL,
    `to_status` ENUM('NEW', 'IN_REVIEW', 'ACCEPTED', 'REJECTED') NOT NULL,
    `changed_by_id` CHAR(36) NOT NULL,
    `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `form_response_status_changes_response_id_changed_at_idx`(`response_id`, `changed_at`),
    INDEX `form_response_status_changes_changed_by_id_idx`(`changed_by_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `form_answer_options_option_id_question_id_idx` ON `form_answer_options`(`option_id`, `question_id`);

-- CreateIndex
CREATE INDEX `form_answers_question_id_version_id_idx` ON `form_answers`(`question_id`, `version_id`);

-- CreateIndex
CREATE UNIQUE INDEX `form_answers_id_question_id_key` ON `form_answers`(`id`, `question_id`);

-- CreateIndex
CREATE INDEX `form_responses_form_id_status_submitted_at_idx` ON `form_responses`(`form_id`, `status`, `submitted_at`);

-- CreateIndex
CREATE INDEX `form_responses_form_id_version_id_submitted_at_idx` ON `form_responses`(`form_id`, `version_id`, `submitted_at`);

-- CreateIndex
CREATE UNIQUE INDEX `form_responses_id_version_id_key` ON `form_responses`(`id`, `version_id`);

-- CreateIndex
CREATE UNIQUE INDEX `form_version_options_id_question_id_key` ON `form_version_options`(`id`, `question_id`);

-- CreateIndex
CREATE UNIQUE INDEX `form_version_questions_id_version_id_key` ON `form_version_questions`(`id`, `version_id`);

-- CreateIndex
CREATE UNIQUE INDEX `form_versions_id_form_id_key` ON `form_versions`(`id`, `form_id`);

-- AddForeignKey
ALTER TABLE `form_responses` ADD CONSTRAINT `form_responses_version_id_form_id_fkey` FOREIGN KEY (`version_id`, `form_id`) REFERENCES `form_versions`(`id`, `form_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answers` ADD CONSTRAINT `form_answers_response_id_version_id_fkey` FOREIGN KEY (`response_id`, `version_id`) REFERENCES `form_responses`(`id`, `version_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answers` ADD CONSTRAINT `form_answers_question_id_version_id_fkey` FOREIGN KEY (`question_id`, `version_id`) REFERENCES `form_version_questions`(`id`, `version_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answer_options` ADD CONSTRAINT `form_answer_options_answer_id_question_id_fkey` FOREIGN KEY (`answer_id`, `question_id`) REFERENCES `form_answers`(`id`, `question_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answer_options` ADD CONSTRAINT `form_answer_options_option_id_question_id_fkey` FOREIGN KEY (`option_id`, `question_id`) REFERENCES `form_version_options`(`id`, `question_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_response_status_changes` ADD CONSTRAINT `form_response_status_changes_response_id_fkey` FOREIGN KEY (`response_id`) REFERENCES `form_responses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_response_status_changes` ADD CONSTRAINT `form_response_status_changes_changed_by_id_fkey` FOREIGN KEY (`changed_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

