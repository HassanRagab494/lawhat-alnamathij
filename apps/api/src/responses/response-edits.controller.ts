import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequestMeta, RequestMetaData, RequirePermissions } from '../auth/decorators';
import { Errors } from '../common/errors';
import { ParseIdPipe } from '../common/id.pipe';
import { THROTTLE, onlyThrottle } from '../common/throttle';
import { drain } from '../files/files.controller';
import type { UploadedFileDto } from '../files/uploads.service';
import type { ResponseDetailDto } from './dto';
import { ResponseEditsService, type EditFormDto } from './response-edits.service';

const formIdPipe = new ParseIdPipe('النموذج غير موجود.');
const responseIdPipe = new ParseIdPipe('الرد غير موجود.');

/**
 * تعديل رد قبل اعتماده، ومشاركة سبب الرفض. كلها لمن يملك «مراجعة الردود» فقط؛
 * من يملك العرض وحده يحصل على 403.
 */
@ApiTags('responses')
@ApiCookieAuth('session')
@ApiForbiddenResponse({ description: 'FORBIDDEN: لا يملك صلاحية مراجعة الردود' })
@Controller('forms/:id/responses/:responseId')
@UseGuards(ThrottlerGuard)
@onlyThrottle(THROTTLE.responses)
@RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
export class ResponseEditsController {
  constructor(private readonly edits: ResponseEditsService) {}

  @Get('edit')
  @ApiOperation({
    summary: 'بيانات تعديل الرد',
    description:
      'أسئلة إصدار الرد بإعداداتها وشروط ظهورها (بمعرّفات الإصدار)، والقيم الحالية، ورقم المراجعة revision.',
  })
  editForm(
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
  ): Promise<EditFormDto> {
    return this.edits.editForm(formId, responseId);
  }

  @Patch('answers')
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'تعديل إجابات الرد قبل اعتماده',
    description:
      '{revision, answers: [{questionId, value}]} حيث value كإرسال الرد العام أو null للمسح. يُعاد التحقق من الرد كاملًا بقواعد إصداره وشروط الظهور. revision قديم ⇒ 409 RESPONSE_EDIT_CONFLICT مع القيم الحالية؛ الرد المرسل إلى Flowmax ⇒ 409 RESPONSE_LOCKED. كل تغيير يُسجل بالقيمة الأصلية والمعدلة ومن عدّل ومتى.',
  })
  save(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @Body() body: unknown,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<ResponseDetailDto> {
    return this.edits.save(auth, formId, responseId, body, meta);
  }

  @Post('files')
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'رفع مرفق لتعديل الرد',
    description:
      'جسم الطلب محتوى الملف (application/octet-stream) مع x-file-name. بالتحقق نفسه للرفع العام. لا يُربط بالرد إلا عند حفظ التعديل.',
  })
  @ApiConsumes('application/octet-stream')
  @ApiQuery({ name: 'questionId', required: true })
  async upload(
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @Query('questionId') questionId: string | undefined,
    @Headers('x-file-name') encodedName: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Req() req: Request,
  ): Promise<UploadedFileDto> {
    if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] ?? '')) {
      await drain(req);
      throw Errors.validation([
        { field: 'content-type', message: 'يُرسل الملف بنوع application/octet-stream.' },
      ]);
    }
    let name: string | undefined;
    try {
      name = encodedName ? decodeURIComponent(encodedName) : undefined;
    } catch {
      name = undefined;
    }
    const length = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;
    try {
      return await this.edits.upload(formId, responseId, questionId, name, length, req);
    } catch (error) {
      await drain(req);
      throw error;
    }
  }

  @Post('rejection-share')
  @HttpCode(HttpStatus.OK)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'رابط مشاركة سبب الرفض عبر واتساب',
    description:
      'للرد المرفوض فقط. يعيد رابط wa.me برقم الجوال الموجود في الرد ورسالة جاهزة (التحية، سبب الرفض، الرقم المرجعي). لا يرسل شيئًا؛ يُسجَّل فتح المشاركة فقط. بلا رقم صالح ⇒ 422 REJECTION_SHARE_NO_PHONE.',
  })
  rejectionShare(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<{ url: string; text: string; phone: string }> {
    return this.edits.rejectionShare(auth, formId, responseId, meta);
  }
}
