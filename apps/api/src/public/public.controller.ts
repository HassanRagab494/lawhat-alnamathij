import { Body, Controller, Get, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { PublicFormDto, SubmitResponseDto, SubmitResultDto } from './public-dto';
import { PublicService } from './public.service';

/**
 * مسارات عامة بلا جلسة ولا CSRF. حارس Origin العام ما زال يرفض الطلبات المعدِّلة من أصل آخر،
 * وإرسال الرد محدود المعدل لكل IP ولكل نموذج.
 */
@ApiTags('public')
@Controller('public/forms')
export class PublicController {
  constructor(private readonly publicForms: PublicService) {}

  @Get(':publicId')
  @Public()
  @ApiOperation({
    summary: 'قراءة أحدث إصدار منشور للنموذج العام',
    description:
      'يعيد العنوان والوصف والأسئلة فقط. عند إغلاق الاستقبال أو الأرشفة: acceptingResponses=false دون أسئلة. نموذج غير موجود أو غير منشور ⇒ 404.',
  })
  @ApiOkResponse({ type: PublicFormDto })
  @ApiNotFoundResponse({ description: 'NOT_FOUND' })
  getForm(@Param('publicId') publicId: string): Promise<PublicFormDto> {
    return this.publicForms.getPublicForm(publicId);
  }

  @Post(':publicId/responses')
  @Public()
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ login: true })
  @ApiOperation({
    summary: 'إرسال رد',
    description:
      'يتحقق الخادم من الإجابات وفق الإصدار المنشور ويحفظ الرد كاملًا في معاملة واحدة. 201 لرد جديد؛ إعادة الطلب نفسه بنفس idempotencyKey ⇒ 200 بالرقم المرجعي الأصلي. الحجم حتى 512KB، ومحدود المعدل لكل IP ولكل نموذج.',
  })
  @ApiBody({ type: SubmitResponseDto })
  @ApiCreatedResponse({ type: SubmitResultDto, description: 'رد جديد' })
  @ApiOkResponse({ type: SubmitResultDto, description: 'إعادة طلب محفوظ سابقًا' })
  @ApiConflictResponse({
    description: 'RESPONSES_CLOSED أو VERSION_OUTDATED أو IDEMPOTENCY_KEY_REUSED',
  })
  @ApiTooManyRequestsResponse({ description: 'TOO_MANY_REQUESTS' })
  async submit(
    @Param('publicId') publicId: string,
    // يُتحقق منه بمخطط zod صارم ثم مقابل الإصدار المنشور في PublicService.
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitResultDto> {
    const { result, replayed } = await this.publicForms.submit(publicId, body);
    res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }
}
