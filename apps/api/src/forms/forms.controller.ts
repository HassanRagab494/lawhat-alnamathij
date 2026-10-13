import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
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
import { DraftService } from './draft.service';
import { FormDraftDto, SaveDraftDto } from './draft-dto';
import { FormsService } from './forms.service';

const idPipe = new ParseIdPipe('النموذج غير موجود.');

@ApiTags('forms')
@ApiCookieAuth('session')
@Controller('forms')
export class FormsController {
  constructor(
    private readonly forms: FormsService,
    private readonly drafts: DraftService,
  ) {}

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

  @Get(':id/draft')
  @RequirePermissions(Permission.FORMS_VIEW)
  @ApiOperation({ summary: 'قراءة المسودة الكاملة مع الأسئلة والخيارات مرتبة' })
  @ApiOkResponse({ type: FormDraftDto })
  getDraft(@Param('id', idPipe) id: string): Promise<FormDraftDto> {
    return this.drafts.getDraft(id);
  }

  @Put(':id/draft')
  @RequirePermissions(Permission.FORMS_EDIT)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'حفظ المسودة كاملة في معاملة واحدة',
    description:
      'يحفظ العنوان والوصف والأسئلة والخيارات والترتيب معًا. الأسئلة الغائبة تُحذف، والمعرّفات المرسلة يجب أن تخص هذه المسودة. يزيد revision مرة واحدة إن تغيّر المحتوى. revision قديم ⇒ 409 REVISION_CONFLICT ومعه details.current (المسودة الكاملة الأحدث) دون أي حفظ جزئي.',
  })
  @ApiBody({ type: SaveDraftDto })
  @ApiOkResponse({ type: FormDraftDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED مع fields بمسارات مثل questions.0.settings.maxLength',
  })
  @ApiConflictResponse({
    description: 'REVISION_CONFLICT (مع details.current) أو FORM_ARCHIVED أو WRITE_CONFLICT',
  })
  saveDraft(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idPipe) id: string,
    // يُتحقق منه بمخطط zod صارم في DraftService (أنواع أسئلة متعددة الأشكال).
    @Body() body: unknown,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FormDraftDto> {
    return this.drafts.saveDraft(auth, id, body, meta);
  }
}
