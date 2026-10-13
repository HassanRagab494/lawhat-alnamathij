import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Trim } from './transforms';

export class PageQueryDto {
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

  @ApiPropertyOptional({ maxLength: 100, description: 'بحث نصي' })
  @IsOptional()
  @Trim()
  @MaxLength(100, { message: 'نص البحث يجب ألا يزيد عن 100 حرف.' })
  @IsString({ message: 'نص البحث غير صحيح.' })
  search?: string;
}

export class PageMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export function pageMeta(page: number, pageSize: number, total: number): PageMetaDto {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
