import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResponseStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageMetaDto } from '../common/pagination';
import { Trim } from '../common/transforms';
import { QUESTION_TYPES, type QuestionTypeKey } from '../forms/questions/limits';

export const RESPONSE_STATUSES = Object.values(ResponseStatus) as ResponseStatus[];
export const RESPONSE_SORTS = ['newest', 'oldest'] as const;
export type ResponseSort = (typeof RESPONSE_SORTS)[number];

export const RESPONSE_STATUS_LABELS: Record<ResponseStatus, string> = {
  NEW: 'جديد',
  IN_REVIEW: 'قيد المراجعة',
  ACCEPTED: 'مقبول',
  REJECTED: 'مرفوض',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** فلاتر القائمة والتصدير. التواريخ أيام بتوقيت الرياض (YYYY-MM-DD) شاملة للطرفين. */
export class ResponseFilterQueryDto {
  @ApiPropertyOptional({
    maxLength: 20,
    description: 'بحث بالرقم المرجعي (كاملًا أو بدايته، مع الشرطات أو دونها)',
  })
  @IsOptional()
  @Trim()
  @Matches(/^[0-9A-Za-z\- ]*$/, { message: 'ابحث بالرقم المرجعي: حروف لاتينية وأرقام فقط.' })
  @MaxLength(20, { message: 'الرقم المرجعي يجب ألا يزيد عن 20 حرفًا.' })
  @IsString({ message: 'نص البحث غير صحيح.' })
  search?: string;

  @ApiPropertyOptional({ enum: RESPONSE_STATUSES })
  @IsOptional()
  @IsIn(RESPONSE_STATUSES, { message: 'الحالة غير معروفة.' })
  status?: ResponseStatus;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'من يوم (بتوقيت الرياض)' })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'تاريخ البداية يجب أن يكون بصيغة YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'حتى يوم (بتوقيت الرياض، شامل)' })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'تاريخ النهاية يجب أن يكون بصيغة YYYY-MM-DD.' })
  to?: string;

  @ApiPropertyOptional({ minimum: 1, description: 'رقم الإصدار' })
  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'رقم الإصدار غير صحيح.' })
  @IsInt({ message: 'رقم الإصدار غير صحيح.' })
  version?: number;

  @ApiPropertyOptional({ enum: RESPONSE_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(RESPONSE_SORTS, { message: 'الترتيب يجب أن يكون newest أو oldest.' })
  sort: ResponseSort = 'newest';
}

export class ResponseListQueryDto extends ResponseFilterQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'رقم الصفحة يجب أن يكون 1 أو أكثر.' })
  @IsInt({ message: 'رقم الصفحة يجب أن يكون عددًا صحيحًا.' })
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @Max(50, { message: 'عدد العناصر يجب ألا يزيد عن 50.' })
  @Min(1, { message: 'عدد العناصر يجب أن يكون 1 أو أكثر.' })
  @IsInt({ message: 'عدد العناصر يجب أن يكون عددًا صحيحًا.' })
  pageSize: number = 20;
}

export class ResponseListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'K7Q2-M9XD-4TPB' }) referenceCode!: string;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ enum: RESPONSE_STATUSES }) status!: ResponseStatus;
  @ApiProperty() versionNumber!: number;
}

export class ResponseListDto {
  @ApiProperty({ type: [ResponseListItemDto] }) items!: ResponseListItemDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}

export const ANSWER_KINDS = ['empty', 'text', 'number', 'date', 'choice', 'files'] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export class AnswerFileDto {
  @ApiProperty({ description: 'للتنزيل عبر مسار الملفات المحمي فقط' }) id!: string;
  @ApiProperty({ description: 'الاسم الأصلي بعد التنظيف' }) name!: string;
  @ApiProperty() size!: number;
  @ApiProperty({
    enum: ['PDF', 'JPG', 'PNG', 'WEBP', 'DOCX', 'XLSX', 'TXT', 'MP4', 'MOV', 'WEBM'],
  })
  kind!: string;
  @ApiProperty({
    description: 'false إن قُبل الملف دون فحص برمجيات خبيثة (UPLOAD_SCAN_MODE=disabled)',
  })
  malwareScanned!: boolean;
  @ApiProperty({
    description: 'صورة أو فيديو يُعرض داخل الصفحة (disposition=inline)؛ غيرها تنزيل فقط',
  })
  previewable!: boolean;
}

export class AnswerOptionViewDto {
  @ApiProperty() label!: string;
  @ApiProperty() selected!: boolean;
}

export class AnswerViewDto {
  @ApiProperty({ description: 'معرّف السؤال داخل الإصدار' }) questionId!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionTypeKey;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty() required!: boolean;
  @ApiProperty({
    description:
      'true إن كان السؤال مخفيًا حسب إجابات هذا الرد (فرع غير نشط في سؤال شرطي)؛ لا إجابة له.',
  })
  hidden!: boolean;
  @ApiProperty({
    enum: ANSWER_KINDS,
    description:
      'empty: لم يُجب (سؤال اختياري)؛ text/number/date: قيمة في value؛ choice: options مع selected؛ files: الملفات المرفقة في files',
  })
  kind!: AnswerKind;
  @ApiPropertyOptional({ description: 'النص، أو الرقم كنص عشري، أو التاريخ YYYY-MM-DD' })
  value?: string;
  @ApiPropertyOptional({ type: [AnswerOptionViewDto] }) options?: AnswerOptionViewDto[];
  @ApiPropertyOptional({ type: () => [AnswerFileDto] }) files?: AnswerFileDto[];
}

export class StatusChangeDto {
  @ApiProperty({ enum: RESPONSE_STATUSES }) fromStatus!: ResponseStatus;
  @ApiProperty({ enum: RESPONSE_STATUSES }) toStatus!: ResponseStatus;
  @ApiProperty({ type: String, nullable: true }) changedBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) changedAt!: string;
}

export class ResponseVersionDto {
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ description: 'عنوان النموذج كما نُشر في هذا الإصدار' }) title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) publishedAt!: string;
}

export class ResponseDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() referenceCode!: string;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ enum: RESPONSE_STATUSES }) status!: ResponseStatus;
  @ApiProperty() formId!: string;
  @ApiProperty({ description: 'عنوان النموذج الحالي' }) formTitle!: string;
  @ApiProperty({ type: ResponseVersionDto }) version!: ResponseVersionDto;
  @ApiProperty({ type: [AnswerViewDto] }) answers!: AnswerViewDto[];
  @ApiProperty({ type: [StatusChangeDto], description: 'من الأقدم إلى الأحدث' })
  statusHistory!: StatusChangeDto[];
}

export class UpdateResponseStatusDto {
  @ApiProperty({ enum: RESPONSE_STATUSES })
  @IsIn(RESPONSE_STATUSES, { message: 'الحالة غير معروفة.' })
  @IsDefined({ message: 'الحالة مطلوبة.' })
  status!: ResponseStatus;
}

export class UpdateStatusResultDto {
  @ApiProperty({ description: 'false إن كانت الحالة نفسها (لا يُضاف سجل)' }) changed!: boolean;
  @ApiProperty({ type: ResponseDetailDto }) response!: ResponseDetailDto;
}
