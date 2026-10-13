import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequestMeta, RequestMetaData, RequirePermissions } from '../auth/decorators';
import { ParseIdPipe } from '../common/id.pipe';
import { CreateFormDto, FormDto, FormListDto, FormListQueryDto, UpdateFormDto } from './dto';
import { FormsService } from './forms.service';

const idPipe = new ParseIdPipe('النموذج غير موجود.');

@ApiTags('forms')
@ApiCookieAuth('session')
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @RequirePermissions(Permission.FORMS_VIEW)
  @ApiOperation({ summary: 'قائمة النماذج مع البحث بالعنوان والتصفية وترقيم الصفحات' })
  @ApiOkResponse({ type: FormListDto })
  list(@Query() query: FormListQueryDto): Promise<FormListDto> {
    return this.forms.list(query);
  }

  @Post()
  @RequirePermissions(Permission.FORMS_CREATE)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'إنشاء نموذج (مسودة غير منشورة)' })
  @ApiCreatedResponse({ type: FormDto })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateFormDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FormDto> {
    return this.forms.create(auth, dto, meta);
  }

  @Get(':id')
  @RequirePermissions(Permission.FORMS_VIEW)
  @ApiOperation({ summary: 'تفاصيل نموذج' })
  @ApiOkResponse({ type: FormDto })
  get(@Param('id', idPipe) id: string): Promise<FormDto> {
    return this.forms.get(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.FORMS_EDIT)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'تعديل العنوان والوصف (يتطلب رقم المراجعة الحالي)' })
  @ApiOkResponse({ type: FormDto })
  @ApiConflictResponse({ description: 'REVISION_CONFLICT أو FORM_ARCHIVED' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @Body() dto: UpdateFormDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FormDto> {
    return this.forms.update(auth, id, dto, meta);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.FORMS_ARCHIVE)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'أرشفة نموذج' })
  @ApiOkResponse({ type: FormDto })
  archive(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FormDto> {
    return this.forms.archive(auth, id, meta);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.FORMS_ARCHIVE)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'استعادة نموذج مؤرشف' })
  @ApiOkResponse({ type: FormDto })
  restore(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FormDto> {
    return this.forms.restore(auth, id, meta);
  }
}
