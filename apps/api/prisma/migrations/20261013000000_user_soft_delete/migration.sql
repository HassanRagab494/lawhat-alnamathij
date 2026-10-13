-- AlterTable
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL,
    ADD COLUMN `deleted_by_id` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `users_deleted_at_idx` ON `users`(`deleted_at`);

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_deleted_by_id_fkey` FOREIGN KEY (`deleted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

