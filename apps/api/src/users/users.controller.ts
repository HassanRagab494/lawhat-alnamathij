import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context';
import { AdminOnly, CurrentAuth, RequestMeta, RequestMetaData } from '../auth/decorators';
import { ParseIdPipe } from '../common/id.pipe';
import { PageQueryDto } from '../common/pagination';
import {
  CreateSupervisorDto,
  PermissionOptionDto,
  ResetPasswordDto,
  UpdateSupervisorDto,
  UserDto,
  UserListDto,
} from './dto';
import { UsersService } from './users.service';

const idPipe = new ParseIdPipe('المستخدم غير موجود.');

@ApiTags('users')
@ApiCookieAuth('session')
@AdminOnly()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة المستخدمين (مدير النظام فقط)' })
  @ApiOkResponse({ type: UserListDto })
  list(@Query() query: PageQueryDto): Promise<UserListDto> {
    return this.users.list(query);
  }

  @Get('permissions')
  @ApiOperation({ summary: 'فهرس الصلاحيات المتاحة للمشرفين' })
  @ApiOkResponse({ type: [PermissionOptionDto] })
  permissions(): PermissionOptionDto[] {
    return this.users.permissionCatalog();
  }

  @Post()
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'إنشاء مشرف' })
  @ApiCreatedResponse({ type: UserDto })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateSupervisorDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<UserDto> {
    return this.users.createSupervisor(auth, dto, meta);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل مستخدم' })
  @ApiOkResponse({ type: UserDto })
  get(@Param('id', idPipe) id: string): Promise<UserDto> {
    return this.users.get(id);
  }

  @Patch(':id')
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'تعديل اسم المشرف وصلاحياته',
    description: 'تسري الصلاحيات الجديدة فورًا على جلسات المشرف القائمة لأنها تُقرأ في كل طلب.',
  })
  @ApiOkResponse({ type: UserDto })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body() dto: UpdateSupervisorDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<UserDto> {
    return this.users.updateSupervisor(auth, id, dto, meta);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'تفعيل حساب مشرف' })
  @ApiOkResponse({ type: UserDto })
  activate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<UserDto> {
    return this.users.setActive(auth, id, true, meta);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'تعطيل حساب مشرف وإبطال جلساته' })
  @ApiOkResponse({ type: UserDto })
  deactivate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<UserDto> {
    return this.users.setActive(auth, id, false, meta);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'إعادة تعيين كلمة مرور مشرف وإبطال جلساته' })
  @ApiNoContentResponse()
  resetPassword(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<void> {
    return this.users.resetPassword(auth, id, dto.newPassword, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'حذف مشرف (حذف ناعم)',
    description:
      'يخفي الحساب من القوائم ويمنع دخوله ويبطل جلساته. لا يُحذف الصف فعليًا حتى يبقى سجل النماذج والعمليات سليمًا، ويبقى اسم المستخدم محجوزًا.',
  })
  @ApiNoContentResponse()
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<void> {
    return this.users.deleteSupervisor(auth, id, meta);
  }
}
