import { ApiProperty } from '@nestjs/swagger';
import { Permission, UserRole } from '@prisma/client';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from './password';

// ملاحظة: class-validator ينفّذ المزخرفات من الأسفل إلى الأعلى ويتوقف عند أول خطأ،
// لذلك يأتي فحص الوجود/النوع في الأسفل وفحوص الطول فوقه.

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @MaxLength(64, { message: 'اسم المستخدم طويل جدًا.' })
  @IsNotEmpty({ message: 'اسم المستخدم مطلوب.' })
  @IsString({ message: 'اسم المستخدم مطلوب.' })
  username!: string;

  @ApiProperty({ format: 'password' })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: 'كلمة المرور طويلة جدًا.' })
  @IsNotEmpty({ message: 'كلمة المرور مطلوبة.' })
  @IsString({ message: 'كلمة المرور مطلوبة.' })
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: 'كلمة المرور طويلة جدًا.' })
  @IsNotEmpty({ message: 'كلمة المرور الحالية مطلوبة.' })
  @IsString({ message: 'كلمة المرور الحالية مطلوبة.' })
  currentPassword!: string;

  @ApiProperty({ format: 'password', minLength: 10 })
  @IsNotEmpty({ message: 'كلمة المرور الجديدة مطلوبة.' })
  @IsString({ message: 'كلمة المرور الجديدة مطلوبة.' })
  newPassword!: string;
}

export class MeDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ enum: Permission, isArray: true }) permissions!: Permission[];
}

export class LoginResponseDto {
  @ApiProperty({ type: MeDto }) user!: MeDto;
  @ApiProperty({ description: 'يُرسل أيضًا في Cookie باسم lp_csrf' }) csrfToken!: string;
}
