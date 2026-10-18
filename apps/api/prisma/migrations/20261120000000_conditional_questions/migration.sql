-- الأسئلة الشرطية والهويات الدلالية. إضافة أعمدة قابلة للفراغ فقط؛ لا حذف ولا تعديل لبيانات قائمة.
-- الأسئلة والخيارات الحالية تبقى بلا شرط (ظاهرة دائمًا) وبلا هوية دلالية.

-- AlterTable
ALTER TABLE `form_draft_questions` ADD COLUMN `show_if` JSON NULL,
    ADD COLUMN `semantic_key` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `form_draft_question_options` ADD COLUMN `semantic_key` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `form_version_questions` ADD COLUMN `show_if` JSON NULL,
    ADD COLUMN `semantic_key` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `form_version_options` ADD COLUMN `semantic_key` VARCHAR(64) NULL;
