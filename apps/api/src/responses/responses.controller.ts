import {
  Body,
  Controller,
  Get,
  Headers,
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
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { ThrottlerGuard } from '@nestjs/throttler';
import { THROTTLE, onlyThrottle } from '../common/throttle';
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
import { privateFileHeaders, type FileDisposition } from './file-response';

export { contentDisposition } from './file-response';

const formIdPipe = new ParseIdPipe('النموذج غير موجود.');
const responseIdPipe = new ParseIdPipe('الرد غير موجود.');
const fileIdPipe = new ParseIdPipe('الملف غير موجود.');

/**
 * إدارة ردود النموذج. كل مسار يتحقق من الصلاحية في الخادم ومن أن الرد يخص النموذج في المسار.
 * لا يوجد أي مسار عام لقراءة الردود. محدود المعدل لكل مستخدم.
 */
@ApiTags('responses')
@ApiCookieAuth('session')
@ApiForbiddenResponse({ description: 'FORBIDDEN: لا يملك الصلاحية المطلوبة' })
@Controller('forms/:id/responses')
@UseGuards(ThrottlerGuard)
@onlyThrottle(THROTTLE.responses)
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
  @onlyThrottle(THROTTLE.responsesExport)
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

  @Get(':responseId/files/:fileId')
  @RequirePermissions(
    Permission.FORMS_VIEW,
    Permission.RESPONSES_VIEW,
    Permission.RESPONSES_FILES_DOWNLOAD,
  )
  @ApiOperation({
    summary: 'تنزيل ملف مرفق برد أو معاينته',
    description:
      'يتطلب RESPONSES_FILES_DOWNLOAD للتنزيل والمعاينة معًا (وإلا 403). الملف يجب أن يخص الرد والنموذج في المسار (وإلا 404). disposition=attachment (الافتراضي): تنزيل. disposition=inline: معاينة الصور (JPG/PNG/WEBP) والفيديو (MP4/MOV/WebM) فقط مع دعم Range للفيديو؛ غيرها 400 PREVIEW_NOT_SUPPORTED. Content-Type الحقيقي، nosniff، CSP مقيدة، دون تخزين مؤقت.',
  })
  @ApiQuery({ name: 'disposition', required: false, enum: ['attachment', 'inline'] })
  @ApiOkResponse({ description: 'محتوى الملف' })
  @ApiNotFoundResponse({ description: 'النموذج أو الرد أو الملف غير موجود' })
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @Param('fileId', fileIdPipe) fileId: string,
    @Query('disposition') dispositionQuery: string | undefined,
    @Headers('range') range: string | undefined,
    @RequestMetaData() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const disposition: FileDisposition = dispositionQuery === 'inline' ? 'inline' : 'attachment';
    const file = await this.responses.openFile(
      auth,
      formId,
      responseId,
      fileId,
      meta,
      disposition,
      range,
    );
    res.set(privateFileHeaders(file.kind, file.name, disposition));
    if (file.range) {
      res.status(206);
      res.set({
        'Content-Range': `bytes ${file.range.start}-${file.range.end}/${file.size}`,
        'Content-Length': String(file.range.end - file.range.start + 1),
      });
    } else {
      res.set('Content-Length', String(file.size));
    }
    return new StreamableFile(file.stream);
  }

  @Patch(':responseId/status')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'تغيير حالة الرد',
    description:
      'NEW أو IN_REVIEW أو ACCEPTED أو REJECTED. REJECTED يتطلب reason (يُحفظ في سجل الحالات). لا تتغير الإجابات ولا الإصدار. الحالة نفسها ⇒ changed=false دون سجل جديد.',
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
    return this.responses.updateStatus(auth, formId, responseId, dto.status, meta, dto.reason);
  }
}
