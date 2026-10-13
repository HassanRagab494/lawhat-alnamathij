-- CreateTable
CREATE TABLE `form_draft_questions` (
    `id` CHAR(36) NOT NULL,
    `draft_id` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `type` ENUM('SHORT_TEXT', 'PARAGRAPH', 'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'DROPDOWN', 'NUMBER', 'DATE', 'FILE_UPLOAD') NOT NULL,
    `title` VARCHAR(300) NOT NULL,
    `description` TEXT NULL,
    `required` BOOLEAN NOT NULL DEFAULT false,
    `settings` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `form_draft_questions_draft_id_position_idx`(`draft_id`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_draft_question_options` (
    `id` CHAR(36) NOT NULL,
    `question_id` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `form_draft_question_options_question_id_position_idx`(`question_id`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `form_draft_questions` ADD CONSTRAINT `form_draft_questions_draft_id_fkey` FOREIGN KEY (`draft_id`) REFERENCES `form_drafts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_draft_question_options` ADD CONSTRAINT `form_draft_question_options_question_id_fkey` FOREIGN KEY (`question_id`) REFERENCES `form_draft_questions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

