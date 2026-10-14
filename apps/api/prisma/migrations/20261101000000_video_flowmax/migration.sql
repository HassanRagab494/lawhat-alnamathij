-- معاينة المرفقات والفيديو وربط Flowmax. إضافة فقط (قيم enum وجدولان)؛ تُطبق بـ prisma migrate deploy دون reset.
-- قيم FileKind الجديدة تُضاف في آخر القائمة فلا تتغير القيم المخزنة.
-- AlterTable
ALTER TABLE `uploaded_files` MODIFY `kind` ENUM('PDF', 'JPG', 'PNG', 'WEBP', 'DOCX', 'XLSX', 'TXT', 'MP4', 'MOV', 'WEBM') NOT NULL;

-- CreateTable
CREATE TABLE `form_flowmax_mappings` (
    `form_id` CHAR(36) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `config` JSON NOT NULL,
    `updated_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`form_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flowmax_syncs` (
    `id` CHAR(36) NOT NULL,
    `response_id` CHAR(36) NOT NULL,
    `form_id` CHAR(36) NOT NULL,
    `operation` ENUM('OFFER', 'REQUEST') NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `idempotency_key` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `share` JSON NOT NULL,
    `media` JSON NOT NULL,
    `flowmax_id` VARCHAR(64) NULL,
    `flowmax_ref` VARCHAR(100) NULL,
    `flowmax_url` VARCHAR(500) NULL,
    `create_uncertain` BOOLEAN NOT NULL DEFAULT false,
    `published_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(300) NULL,
    `lease_until` DATETIME(3) NULL,
    `sent_at` DATETIME(3) NULL,
    `approved_by_id` CHAR(36) NOT NULL,
    `approved_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `flowmax_syncs_response_id_key`(`response_id`),
    UNIQUE INDEX `flowmax_syncs_idempotency_key_key`(`idempotency_key`),
    INDEX `flowmax_syncs_form_id_status_idx`(`form_id`, `status`),
    INDEX `flowmax_syncs_status_lease_until_idx`(`status`, `lease_until`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `form_flowmax_mappings` ADD CONSTRAINT `form_flowmax_mappings_form_id_fkey` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_flowmax_mappings` ADD CONSTRAINT `form_flowmax_mappings_updated_by_id_fkey` FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flowmax_syncs` ADD CONSTRAINT `flowmax_syncs_response_id_fkey` FOREIGN KEY (`response_id`) REFERENCES `form_responses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flowmax_syncs` ADD CONSTRAINT `flowmax_syncs_approved_by_id_fkey` FOREIGN KEY (`approved_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

