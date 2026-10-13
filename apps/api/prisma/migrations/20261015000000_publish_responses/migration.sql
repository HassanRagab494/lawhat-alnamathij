-- AlterTable
ALTER TABLE `forms` ADD COLUMN `accepting_responses` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `public_id` VARCHAR(32) NULL;

-- AlterTable
-- توسيع enum فقط؛ القيم الحالية والمفتاح الأساسي يبقيان كما هما.
ALTER TABLE `user_permissions` MODIFY `permission` ENUM('FORMS_VIEW', 'FORMS_CREATE', 'FORMS_EDIT', 'FORMS_ARCHIVE', 'FORMS_PUBLISH', 'FORMS_INTAKE') NOT NULL;

-- CreateTable
CREATE TABLE `form_versions` (
    `id` CHAR(36) NOT NULL,
    `form_id` CHAR(36) NOT NULL,
    `version_number` INTEGER NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `source_draft_revision` INTEGER NOT NULL,
    `publish_key` CHAR(36) NOT NULL,
    `published_by_id` CHAR(36) NOT NULL,
    `published_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `form_versions_form_id_version_number_key`(`form_id`, `version_number`),
    UNIQUE INDEX `form_versions_form_id_publish_key_key`(`form_id`, `publish_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_version_questions` (
    `id` CHAR(36) NOT NULL,
    `version_id` CHAR(36) NOT NULL,
    `logical_id` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `type` ENUM('SHORT_TEXT', 'PARAGRAPH', 'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'DROPDOWN', 'NUMBER', 'DATE', 'FILE_UPLOAD') NOT NULL,
    `title` VARCHAR(300) NOT NULL,
    `description` TEXT NULL,
    `required` BOOLEAN NOT NULL,
    `settings` JSON NOT NULL,

    INDEX `form_version_questions_version_id_position_idx`(`version_id`, `position`),
    UNIQUE INDEX `form_version_questions_version_id_logical_id_key`(`version_id`, `logical_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_version_options` (
    `id` CHAR(36) NOT NULL,
    `question_id` CHAR(36) NOT NULL,
    `logical_id` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `label` VARCHAR(200) NOT NULL,

    INDEX `form_version_options_question_id_position_idx`(`question_id`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_responses` (
    `id` CHAR(36) NOT NULL,
    `form_id` CHAR(36) NOT NULL,
    `version_id` CHAR(36) NOT NULL,
    `reference_code` VARCHAR(16) NOT NULL,
    `status` ENUM('NEW') NOT NULL DEFAULT 'NEW',
    `idempotency_key` CHAR(36) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `form_responses_reference_code_key`(`reference_code`),
    INDEX `form_responses_form_id_submitted_at_idx`(`form_id`, `submitted_at`),
    UNIQUE INDEX `form_responses_form_id_idempotency_key_key`(`form_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_answers` (
    `id` CHAR(36) NOT NULL,
    `response_id` CHAR(36) NOT NULL,
    `question_id` CHAR(36) NOT NULL,
    `text_value` TEXT NULL,
    `number_value` DECIMAL(23, 10) NULL,
    `date_value` DATE NULL,

    UNIQUE INDEX `form_answers_response_id_question_id_key`(`response_id`, `question_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_answer_options` (
    `answer_id` CHAR(36) NOT NULL,
    `option_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`answer_id`, `option_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `forms_public_id_key` ON `forms`(`public_id`);

-- AddForeignKey
ALTER TABLE `form_versions` ADD CONSTRAINT `form_versions_form_id_fkey` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_versions` ADD CONSTRAINT `form_versions_published_by_id_fkey` FOREIGN KEY (`published_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_version_questions` ADD CONSTRAINT `form_version_questions_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `form_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_version_options` ADD CONSTRAINT `form_version_options_question_id_fkey` FOREIGN KEY (`question_id`) REFERENCES `form_version_questions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_responses` ADD CONSTRAINT `form_responses_form_id_fkey` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_responses` ADD CONSTRAINT `form_responses_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `form_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answers` ADD CONSTRAINT `form_answers_response_id_fkey` FOREIGN KEY (`response_id`) REFERENCES `form_responses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answers` ADD CONSTRAINT `form_answers_question_id_fkey` FOREIGN KEY (`question_id`) REFERENCES `form_version_questions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answer_options` ADD CONSTRAINT `form_answer_options_answer_id_fkey` FOREIGN KEY (`answer_id`) REFERENCES `form_answers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_answer_options` ADD CONSTRAINT `form_answer_options_option_id_fkey` FOREIGN KEY (`option_id`) REFERENCES `form_version_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

