import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FormDto } from './dto';
import {
  FILE_TYPE_KEYS,
  QUESTION_LIMITS,
  QUESTION_TYPES,
  type QuestionTypeKey,
} from './questions/limits';

const SETTINGS_DOC = [
  'إعدادات خاصة بالنوع (كل الحقول اختيارية ما لم يُذكر):',
  `SHORT_TEXT/PARAGRAPH: { minLength, maxLength } أعداد صحيحة حتى ${QUESTION_LIMITS.shortTextMaxLength}/${QUESTION_LIMITS.paragraphMaxLength}`,
  'SINGLE_CHOICE/DROPDOWN: {} ويتطلب options (2 على الأقل)',
  'MULTIPLE_CHOICE: { minSelections, maxSelections } لا تتجاوز عدد الخيارات، ويتطلب options',
  `NUMBER: { allowDecimals (مطلوب), min, max } بقيمة مطلقة حتى ${QUESTION_LIMITS.numberAbsMax}`,
  `DATE: { minDate, maxDate } بصيغة YYYY-MM-DD بين ${QUESTION_LIMITS.dateMin} و${QUESTION_LIMITS.dateMax}`,
  `FILE_UPLOAD: { allowedTypes (مطلوب: ${FILE_TYPE_KEYS.join(', ')}), maxFileSizeMb (مطلوب، 1-${QUESTION_LIMITS.fileMaxSizeMb}، وحتى ${QUESTION_LIMITS.videoMaxSizeMb} إن سمح السؤال بالفيديو), maxFiles (مطلوب، 1-${QUESTION_LIMITS.fileMaxCount}) }`,
].join('\n');

export class QuestionOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ maxLength: QUESTION_LIMITS.optionLabelMax }) label!: string;
}

export class QuestionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionTypeKey;
  @ApiProperty({ maxLength: QUESTION_LIMITS.questionTitleMax }) title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty() required!: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true, description: SETTINGS_DOC })
  settings!: Record<string, unknown>;
  @ApiProperty({ type: [QuestionOptionDto], description: 'لأنواع الاختيار فقط؛ فارغة لغيرها' })
  options!: QuestionOptionDto[];
}

export class FormDraftDto extends FormDto {
  @ApiProperty({ type: [QuestionDto], description: 'الأسئلة مرتبة' }) questions!: QuestionDto[];
}

export class SaveOptionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'معرّف خيار موجود في السؤال نفسه؛ يُحذف للخيار الجديد',
  })
  id?: string;
  @ApiProperty({ maxLength: QUESTION_LIMITS.optionLabelMax }) label!: string;
}

export class SaveQuestionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'معرّف سؤال موجود في هذه المسودة؛ يُحذف للسؤال الجديد',
  })
  id?: string;
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionTypeKey;
  @ApiProperty({ maxLength: QUESTION_LIMITS.questionTitleMax }) title!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: QUESTION_LIMITS.questionDescriptionMax,
  })
  description?: string | null;
  @ApiProperty() required!: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true, description: SETTINGS_DOC })
  settings!: Record<string, unknown>;
  @ApiPropertyOptional({ type: [SaveOptionDto], maxItems: QUESTION_LIMITS.maxOptions })
  options?: SaveOptionDto[];
}

export class SaveDraftDto {
  @ApiProperty({ minimum: 1, description: 'رقم مراجعة المسودة الذي بُني عليه الحفظ' })
  revision!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description?: string | null;
  @ApiProperty({
    type: [SaveQuestionDto],
    maxItems: QUESTION_LIMITS.maxQuestions,
    description: 'القائمة الكاملة المرتبة. الأسئلة الغائبة تُحذف.',
  })
  questions!: SaveQuestionDto[];
}
