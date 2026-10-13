import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../common/pagination';
import { Trim, TrimToNull } from '../common/transforms';

export const FORM_TITLE_MAX = 200;
export const FORM_DESCRIPTION_MAX = 2000;

export class CreateFormDto {
  @ApiProperty({ maxLength: FORM_TITLE_MAX, example: 'نموذج طلب خدمة' })
  @Trim()
  @MaxLength(FORM_TITLE_MAX, { message: `عنوان النموذج يجب ألا يزيد عن ${FORM_TITLE_MAX} حرف.` })
  @IsNotEmpty({ message: 'عنوان النموذج مطلوب.' })
  @IsString({ message: 'عنوان النموذج مطلوب.' })
  title!: string;

  @ApiPropertyOptional({ maxLength: FORM_DESCRIPTION_MAX, nullable: true })
  @IsOptional()
  @TrimToNull()
  @ValidateIf((_, value) => value !== null)
  @MaxLength(FORM_DESCRIPTION_MAX, {
    message: `الوصف يجب ألا يزيد عن ${FORM_DESCRIPTION_MAX} حرف.`,
  })
  @IsString({ message: 'الوصف غير صحيح.' })
  description?: string | null;
}

export class UpdateFormDto extends CreateFormDto {
  @ApiProperty({
    minimum: 1,
    description: 'رقم مراجعة المسودة الذي بُني عليه التعديل. يُرفض الطلب بـ 409 إن كان قديمًا.',
  })
  @Min(1, { message: 'رقم المراجعة غير صحيح.' })
  @IsInt({ message: 'رقم المراجعة غير صحيح.' })
  @IsDefined({ message: 'رقم المراجعة مطلوب.' })
  @Type(() => Number)
  revision!: number;
}

export const FORM_STATUS_FILTERS = ['active', 'archived'] as const;
export type FormStatusFilter = (typeof FORM_STATUS_FILTERS)[number];

export class FormListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: FORM_STATUS_FILTERS, default: 'active' })
  @IsOptional()
  @IsIn(FORM_STATUS_FILTERS, { message: 'حالة التصفية يجب أن تكون active أو archived.' })
  status: FormStatusFilter = 'active';
}

export class UserRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() displayName!: string;
}

export class PublishedVersionRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ type: String, format: 'date-time' }) publishedAt!: string;
  @ApiProperty({ type: UserRefDto }) publishedBy!: UserRefDto;
}

export class FormPublicationDto {
  @ApiProperty({ type: String, nullable: true, description: 'المعرّف العام للرابط /f/<publicId>' })
  publicId!: string | null;
  @ApiProperty() acceptingResponses!: boolean;
  @ApiProperty({ type: PublishedVersionRefDto, nullable: true })
  latestVersion!: PublishedVersionRefDto | null;
  @ApiProperty({ description: 'المسودة الحالية تختلف عن آخر إصدار منشور (أو لا يوجد إصدار)' })
  hasUnpublishedChanges!: boolean;
}

export class FormDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({
    enum: ['draft', 'published'],
    description: 'draft: لم يُنشر أي إصدار بعد؛ published: يوجد إصدار منشور واحد على الأقل.',
  })
  publicationStatus!: 'draft' | 'published';
  @ApiProperty({ type: () => FormPublicationDto }) publication!: FormPublicationDto;
  @ApiProperty() isArchived!: boolean;
  @ApiProperty({ description: 'رقم مراجعة المسودة الحالية' }) revision!: number;
  @ApiProperty({ type: UserRefDto }) createdBy!: UserRefDto;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
}

export class FormListDto {
  @ApiProperty({ type: [FormDto] }) items!: FormDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}
