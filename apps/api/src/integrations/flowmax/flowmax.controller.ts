import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Permission } from '@prisma/client';
import type { AuthContext } from '../../auth/auth-context';
import {
  CurrentAuth,
  RequestMeta,
  RequestMetaData,
  RequirePermissions,
} from '../../auth/decorators';
import { ParseIdPipe } from '../../common/id.pipe';
import { THROTTLE, onlyThrottle } from '../../common/throttle';
import { FlowmaxService, type FlowmaxStateView, type MappingView } from './flowmax.service';

const formIdPipe = new ParseIdPipe('النموذج غير موجود.');
const responseIdPipe = new ParseIdPipe('الرد غير موجود.');

/**
 * ربط Flowmax: إعداد الربط لكل نموذج، واعتماد الرد وإرساله، وإعادة المحاولة.
 * الاعتماد وإعادة المحاولة يتطلبان مراجعة الردود؛ رؤية الحالة والرابط تتطلب عرض الردود.
 */
@ApiTags('flowmax')
@ApiCookieAuth('session')
@ApiForbiddenResponse({ description: 'FORBIDDEN: لا يملك الصلاحية المطلوبة' })
@Controller('forms/:id')
@UseGuards(ThrottlerGuard)
@onlyThrottle(THROTTLE.responses)
export class FlowmaxController {
  constructor(private readonly flowmax: FlowmaxService) {}

  @Get('flowmax-mapping')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.FORMS_EDIT)
  @ApiOperation({ summary: 'إعداد ربط النموذج مع حقول Flowmax' })
  getMapping(@Param('id', formIdPipe) formId: string): Promise<MappingView> {
    return this.flowmax.getMapping(formId);
  }

  @Put('flowmax-mapping')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.FORMS_EDIT)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'حفظ ربط النموذج مع Flowmax',
    description:
      'enabled وconfig.fields: لكل حقل Flowmax إما questionId (المعرّف المنطقي لسؤال في آخر إصدار منشور) أو constant، مع values اختياري لتحويل قيم الاختيار.',
  })
  saveMapping(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Body() body: { enabled?: unknown; config?: unknown },
    @RequestMetaData() meta: RequestMeta,
  ): Promise<MappingView> {
    return this.flowmax.saveMapping(auth, formId, body ?? {}, meta);
  }

  @Get('responses/:responseId/flowmax')
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW)
  @ApiOperation({ summary: 'حالة إرسال الرد إلى Flowmax ورابط العقار' })
  @ApiOkResponse({ description: 'integrationEnabled وmappingEnabled وsync' })
  state(
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
  ): Promise<FlowmaxStateView> {
    return this.flowmax.state(formId, responseId);
  }

  @Post('responses/:responseId/flowmax/approve')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'اعتماد الرد وإرساله إلى Flowmax',
    description:
      'يتحقق من اكتمال الحقول المطلوبة (422 FLOWMAX_INCOMPLETE) ومن توافق المرفقات مع Flowmax (422 FLOWMAX_MEDIA_INCOMPATIBLE ما لم تُستبعد صراحة في excludeFileIds)، ويغيّر الحالة إلى مقبول، ثم يرسل في الخلفية. تكرار الاعتماد لا ينشئ سجلًا ثانيًا.',
  })
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @Body() body: { excludeFileIds?: unknown } | undefined,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    return this.flowmax.approve(auth, formId, responseId, body ?? {}, meta);
  }

  @Post('responses/:responseId/flowmax/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'إعادة محاولة الإرسال بعد الفشل' })
  retry(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    return this.flowmax.retry(auth, formId, responseId, meta);
  }

  @Post('responses/:responseId/flowmax/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'نشر العرض في Flowmax',
    description:
      'بعد اكتمال الإرسال فقط، وبقواعد النشر في Flowmax. الفشل يحفظ السبب ويمكن إعادة المحاولة. المشاركة العامة لا تظهر إلا بعد تأكيد النشر.',
  })
  publish(
    @CurrentAuth() auth: AuthContext,
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    return this.flowmax.publish(auth, formId, responseId, meta);
  }

  @Post('responses/:responseId/flowmax/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.FORMS_VIEW, Permission.RESPONSES_VIEW, Permission.RESPONSES_REVIEW)
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'تحديث حالة السجل من Flowmax (النشر والرابط)' })
  refresh(
    @Param('id', formIdPipe) formId: string,
    @Param('responseId', responseIdPipe) responseId: string,
  ): Promise<FlowmaxStateView> {
    return this.flowmax.refresh(formId, responseId);
  }
}
