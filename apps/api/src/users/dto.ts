import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Permission, UserRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageMetaDto } from '../common/pagination';
import { Trim } from '../common/transforms';
import { USERNAME_PATTERN } from '../auth/password';

const PERMISSIONS_MESSAGE = 'إحدى الصلاحيات المختارة غير معروفة.';

export class CreateSupervisorDto {
  @ApiProperty({
    example: 'sara.ali',
    description: '4-32 حرفًا لاتينيًا صغيرًا أو أرقامًا أو . _ -',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(USERNAME_PATTERN, {
    message:
      'اسم المستخدم يجب أن يكون من 4 إلى 32 حرفًا لاتينيًا صغيرًا أو أرقامًا، ويمكن أن يحتوي على . أو _ أو - في الوسط.',
  })
  @IsNotEmpty({ message: 'اسم المستخدم مطلوب.' })
  @IsString({ message: 'اسم المستخدم مطلوب.' })
  username!: string;

  @ApiProperty({ example: 'سارة علي' })
  @Trim()
  @MaxLength(100, { message: 'الاسم يجب ألا يزيد عن 100 حرف.' })
  @MinLength(2, { message: 'الاسم يجب ألا يقل عن حرفين.' })
  @IsString({ message: 'الاسم مطلوب.' })
  displayName!: string;

  @ApiProperty({ format: 'password', minLength: 10 })
  @IsNotEmpty({ message: 'كلمة المرور مطلوبة.' })
  @IsString({ message: 'كلمة المرور مطلوبة.' })
  password!: string;

  @ApiProperty({ enum: Permission, isArray: true })
  @IsEnum(Permission, { each: true, message: PERMISSIONS_MESSAGE })
  @ArrayUnique({ message: 'لا تكرر الصلاحية نفسها.' })
  @IsArray({ message: 'الصلاحيات يجب أن تكون قائمة.' })
  permissions!: Permission[];
}

export class UpdateSupervisorDto {
  @ApiPropertyOptional({ example: 'سارة علي' })
  @IsOptional()
  @Trim()
  @MaxLength(100, { message: 'الاسم يجب ألا يزيد عن 100 حرف.' })
  @MinLength(2, { message: 'الاسم يجب ألا يقل عن حرفين.' })
  @IsString({ message: 'الاسم غير صحيح.' })
  displayName?: string;

  @ApiPropertyOptional({ enum: Permission, isArray: true })
  @IsOptional()
  @IsEnum(Permission, { each: true, message: PERMISSIONS_MESSAGE })
  @ArrayUnique({ message: 'لا تكرر الصلاحية نفسها.' })
  @IsArray({ message: 'الصلاحيات يجب أن تكون قائمة.' })
  permissions?: Permission[];
}

export class ResetPasswordDto {
  @ApiProperty({ format: 'password', minLength: 10 })
  @IsNotEmpty({ message: 'كلمة المرور الجديدة مطلوبة.' })
  @IsString({ message: 'كلمة المرور الجديدة مطلوبة.' })
  newPassword!: string;
}

export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ enum: Permission, isArray: true, description: 'الصلاحيات الفعلية' })
  permissions!: Permission[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastLoginAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export class UserListDto {
  @ApiProperty({ type: [UserDto] }) items!: UserDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}

export class PermissionOptionDto {
  @ApiProperty({ enum: Permission }) key!: Permission;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: Permission, nullable: true }) requires!: Permission | null;
}
