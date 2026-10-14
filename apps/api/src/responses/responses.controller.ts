import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiSecurity,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequestMeta, RequestMetaData, RequirePermissions } from '../auth/decorators';
import { ParseIdPipe } from '../common/id.pipe';
import {
  ResponseDetailDto,
  ResponseFilterQueryDto,
  ResponseListDto,
  ResponseListQueryDto,
  UpdateResponseStatusDto,
  UpdateStatusResultDto,
} from './dto';
import { ResponsesService } from './responses.service';

const formIdPipe = new ParseIdPipe('النموذج غير موجود.');
const responseIdPipe = new ParseIdPipe('الرد غير موجود.');

/**
 * إدارة ردود النموذج. كل مسار يتحقق من الصلاحية في الخادم ومن أن الرد يخص النموذج في المسار.
 * لا يوجد أي مسار عام لقراءة الردود. محدود المعدل لكل مستخدم.
 */
@ApiTags('responses')
@ApiCookieAuth('session')
@ApiForbiddenResponse({ description: 'FORBIDDEN: لا يملك الصلاحية المطلوبة' })
@Controller('forms/:id/responses')
@UseGuards(ThrottlerGuard)
@SkipThrottle({ login: true, submitIp: true, submitForm: true, responsesExport: true })
export class ResponsesController {
  constructor(private readonly responses: ResponsesService) {}

  @Get()
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW)
  @ApiOperation({
    summary: 'قائمة ردود النموذج',
    description:
      'ترقيم من قاعدة البيانات، بحث بالرقم المرجعي (كاملًا أو بدايته)، فلترة بالحالة وبالأيام من/إلى بتوقيت الرياض وبرقم الإصدار، وترتيب بتاريخ الإرسال. لا تتضمن الإجابات.',
  })
  @ApiOkResponse({ type: ResponseListDto })
  @ApiNotFoundResponse({ description: 'النموذج غير موجود' })
  list(
    @Param('id', formIdPipe) formId: string,
    @Query() query: ResponseListQueryDto,
  ): Promise<ResponseListDto> {
    return this.responses.list(formId, query);
  }

  @Get('export')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_EXPORT)
  @SkipThrottle({
    login: true,
    submitIp: true,
    submitForm: true,
    responses: true,
    responsesExport: false,
  })
  @ApiOperation({
    summary: 'تصدير الردود CSV',
    description:
      "يحترم فلاتر القائمة نفسها. أعمدة ثابتة: الرقم المرجعي، تاريخ الإرسال (الرياض)، الحالة، الإصدار، ثم الأسئلة. حتى 5000 صف و10 ميغابايت (وإلا 422 EXPORT_TOO_LARGE). القيم التي تبدأ بـ = + - @ تُسبق بعلامة ' لمنع حقن الصيغ.",
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'ملف CSV بترميز UTF-8 مع BOM' })
  @ApiUnprocessableEntityResponse({ description: 'EXPORT_TOO_LARGE' })
  async export(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Query() query: ResponseFilterQueryDto,
    @RequestMetaData() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.responses.exportCsv(auth, formId, query, meta);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(file.rows),
    });
    return new StreamableFile(file.content);
  }

  @Get(':responseId')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW)
  @ApiOperation({
    summary: 'تفاصيل رد',
    description:
      'الأسئلة كما كانت في الإصدار الذي أُرسل عليه الرد، مع الإجابة حسب النوع وسجل تغييرات الحالة. رد من نموذج آخر ⇒ 404.',
  })
  @ApiOkResponse({ type: ResponseDetailDto })
  @ApiNotFoundResponse({ description: 'النموذج أو الرد غير موجود' })
  get(
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
  ): Promise<ResponseDetailDto> {
    return this.responses.get(formId, responseId);
  }

  @Patch(':responseId/status')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'تغيير حالة الرد',
    description:
      'NEW أو IN_REVIEW أو ACCEPTED أو REJECTED. لا تتغير الإجابات ولا الإصدار. الحالة نفسها ⇒ changed=false دون سجل جديد.',
  })
  @ApiBody({ type: UpdateResponseStatusDto })
  @ApiOkResponse({ type: UpdateStatusResultDto })
  @ApiNotFoundResponse({ description: 'النموذج أو الرد غير موجود' })
  updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @Body() dto: UpdateResponseStatusDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<UpdateStatusResultDto> {
    return this.responses.updateStatus(auth, formId, responseId, dto.status, meta);
  }
}
