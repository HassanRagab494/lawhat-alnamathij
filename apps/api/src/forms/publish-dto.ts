import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { FormDto } from './dto';

export class PublishFormDto {
  @ApiProperty({
    minimum: 1,
    description: 'revision المسودة المحفوظة التي راجعها المستخدم؛ إن تغيّرت ⇒ 409 دون نشر',
  })
  @Min(1, { message: 'رقم المراجعة غير صحيح.' })
  @IsInt({ message: 'رقم المراجعة غير صحيح.' })
  @IsDefined({ message: 'رقم المراجعة مطلوب.' })
  @Type(() => Number)
  revision!: number;

  @ApiProperty({
    format: 'uuid',
    description: 'مفتاح إعادة محاولة يولّده العميل لكل نافذة نشر؛ إعادة الطلب به تعيد الإصدار نفسه',
  })
  @IsUUID('all', { message: 'مفتاح النشر غير صالح.' })
  @IsDefined({ message: 'مفتاح النشر مطلوب.' })
  publishKey!: string;

  @ApiPropertyOptional({
    description: 'في أول نشر فقط: فتح استقبال الردود مباشرة. يُتجاهل في التحديثات اللاحقة.',
  })
  @IsOptional()
  @IsBoolean({ message: 'قيمة فتح الاستقبال غير صحيحة.' })
  openResponses?: boolean;
}

export class PublishedVersionSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
}

export class PublishResultDto {
  @ApiProperty({ type: FormDto }) form!: FormDto;
  @ApiProperty({ type: PublishedVersionSummaryDto }) version!: PublishedVersionSummaryDto;
  @ApiProperty({ description: 'true إن كان الطلب إعادة لنشر سابق بنفس المفتاح' })
  replayed!: boolean;
}
