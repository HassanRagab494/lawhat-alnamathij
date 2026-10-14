-- المرحلة النهائية: رفع الملفات. إضافة فقط (جدولان وقيمة صلاحية)؛ قابلة للتطبيق بـ prisma migrate deploy دون reset.
-- محتوى الملفات خارج MySQL؛ هنا البيانات الوصفية والربط بمفاتيح مركبة فقط.
-- AlterTable
-- إضافة قيمة للـ enum فقط؛ المفتاح الأساسي لا يتغير.
ALTER TABLE `user_permissions` MODIFY `permission` ENUM('FORMS_VIEW', 'FORMS_CREATE', 'FORMS_EDIT', 'FORMS_ARCHIVE', 'FORMS_PUBLISH', 'FORMS_INTAKE', 'RESPONSES_VIEW', 'RESPONSES_REVIEW', 'RESPONSES_EXPORT', 'RESPONSES_FILES_DOWNLOAD') NOT NULL;

-- CreateTable
CREATE TABLE `fill_sessions` (
    `id` CHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `form_id` CHAR(36) NOT NULL,
    `version_id` CHAR(36) NOT NULL,
    `uploaded_bytes` INTEGER NOT NULL DEFAULT 0,
    `upload_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `fill_sessions_token_hash_key`(`token_hash`),
    INDEX `fill_sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uploaded_files` (
    `id` CHAR(36) NOT NULL,
    `fill_session_id` CHAR(36) NULL,
    `form_id` CHAR(36) NOT NULL,
    `version_id` CHAR(36) NOT NULL,
    `question_id` CHAR(36) NOT NULL,
    `storage_key` VARCHAR(64) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `kind` ENUM('PDF', 'JPG', 'PNG', 'WEBP', 'DOCX', 'XLSX', 'TXT') NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `scan_engine` VARCHAR(120) NOT NULL,
    `scanned_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `response_id` CHAR(36) NULL,
    `answer_id` CHAR(36) NULL,
    `attached_at` DATETIME(3) NULL,

    UNIQUE INDEX `uploaded_files_storage_key_key`(`storage_key`),
    INDEX `uploaded_files_fill_session_id_question_id_idx`(`fill_session_id`, `question_id`),
    INDEX `uploaded_files_response_id_idx`(`response_id`),
    INDEX `uploaded_files_expires_at_response_id_idx`(`expires_at`, `response_id`),
    INDEX `uploaded_files_form_id_created_at_idx`(`form_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `fill_sessions` ADD CONSTRAINT `fill_sessions_version_id_form_id_fkey` FOREIGN KEY (`version_id`, `form_id`) REFERENCES `form_versions`(`id`, `form_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploaded_files` ADD CONSTRAINT `uploaded_files_fill_session_id_fkey` FOREIGN KEY (`fill_session_id`) REFERENCES `fill_sessions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploaded_files` ADD CONSTRAINT `uploaded_files_version_id_form_id_fkey` FOREIGN KEY (`version_id`, `form_id`) REFERENCES `form_versions`(`id`, `form_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploaded_files` ADD CONSTRAINT `uploaded_files_question_id_version_id_fkey` FOREIGN KEY (`question_id`, `version_id`) REFERENCES `form_version_questions`(`id`, `version_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploaded_files` ADD CONSTRAINT `uploaded_files_response_id_version_id_fkey` FOREIGN KEY (`response_id`, `version_id`) REFERENCES `form_responses`(`id`, `version_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploaded_files` ADD CONSTRAINT `uploaded_files_answer_id_question_id_fkey` FOREIGN KEY (`answer_id`, `question_id`) REFERENCES `form_answers`(`id`, `question_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

