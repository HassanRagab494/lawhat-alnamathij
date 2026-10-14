import {
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { Errors } from '../common/errors';
import { THROTTLE, onlyThrottle } from '../common/throttle';
import { UploadsService } from './uploads.service';

class FillSessionDto {
  @ApiProperty({
    description: 'رمز الجلسة؛ يُرسل في ترويسة X-Fill-Session وفي fillSession عند الإرسال',
  })
  token!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
}

class UploadedFileResultDto {
  @ApiProperty({ description: 'يُرسل ضمن قيمة إجابة سؤال الملفات' }) id!: string;
  @ApiProperty({ description: 'الاسم بعد التنظيف' }) name!: string;
  @ApiProperty() size!: number;
  @ApiProperty({ enum: ['PDF', 'JPG', 'PNG', 'WEBP', 'DOCX', 'XLSX', 'TXT', 'MP4', 'MOV', 'WEBM'] })
  kind!: string;
}

const SESSION_HEADER = 'x-fill-session';
const DRAIN_MAX_BYTES = 32 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 15_000;

/** يستهلك ما تبقى من جسم الطلب دون تخزينه، بحد للحجم والوقت؛ وإلا يقطع الاتصال. */
function drain(req: Request): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let bytes = 0;
    const done = () => {
      clearTimeout(timer);
      req.off('data', onData);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > DRAIN_MAX_BYTES) {
        req.destroy();
        done();
      }
    };
    const timer = setTimeout(() => {
      req.destroy();
      done();
    }, DRAIN_TIMEOUT_MS);
    req.on('data', onData);
    req.once('end', done);
    req.once('error', done);
    req.once('close', done);
    req.resume();
  });
}

/**
 * رفع الملفات من الصفحة العامة دون حساب. كل رفع يحتاج جلسة تعبئة قصيرة الصلاحية للإصدار الحالي.
 * لا يوجد أي مسار عام لقراءة الملفات أو تنزيلها.
 */
@ApiTags('public')
@Controller('public/forms/:publicId')
@UseGuards(ThrottlerGuard)
@onlyThrottle(THROTTLE.uploadIp, THROTTLE.uploadForm)
export class FilesController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('upload-sessions')
  @Public()
  @ApiOperation({
    summary: 'إنشاء جلسة تعبئة لرفع الملفات',
    description:
      'جلسة مجهولة مرتبطة بالنموذج وإصداره الحالي، عمرها محدود (UPLOAD_SESSION_TTL_MINUTES). 503 UPLOADS_UNAVAILABLE إن لم يُضبط فاحص الملفات.',
  })
  @ApiCreatedResponse({ type: FillSessionDto })
  createSession(@Param('publicId') publicId: string): Promise<FillSessionDto> {
    return this.uploads.createSession(publicId);
  }

  @Post('files')
  @Public()
  @ApiOperation({
    summary: 'رفع ملف لسؤال ملفات',
    description:
      'جسم الطلب هو محتوى الملف نفسه (application/octet-stream) بالتدفق. يُتحقق من الحجم والنوع الفعلي (لا الامتداد وحده) ويُفحص ضد البرمجيات الخبيثة قبل القبول عند تفعيل الفحص (UPLOAD_SCAN_MODE=required). الفيديو MP4/MOV/WebM حتى 100MB بعد التحقق من بنيته. الأخطاء: 413 FILE_TOO_LARGE أو SESSION_UPLOAD_LIMIT، 400 FILE_REJECTED، 422 FILE_INFECTED، 503 SCAN_UNAVAILABLE، 409 FILE_COUNT_LIMIT، 507 STORAGE_FULL.',
  })
  @ApiConsumes('application/octet-stream')
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiHeader({
    name: 'x-file-name',
    required: true,
    description: 'اسم الملف مرمّزًا بـ encodeURIComponent',
  })
  @ApiQuery({ name: 'questionId', required: true })
  @ApiCreatedResponse({ type: UploadedFileResultDto })
  async upload(
    @Param('publicId') publicId: string,
    @Query('questionId') questionId: string | undefined,
    @Headers(SESSION_HEADER) token: string | undefined,
    @Headers('x-file-name') encodedName: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Req() req: Request,
  ): Promise<UploadedFileResultDto> {
    if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] ?? '')) {
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
      return await this.uploads.upload(publicId, token, questionId, name, length, req);
    } catch (error) {
      // رفض مبكر قبل قراءة الجسم: يُستهلك الباقي (بحد) حتى تصل رسالة الخطأ للمتصفح بدل قطع الاتصال.
      await drain(req);
      throw error;
    }
  }

  @Delete('files/:fileId')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'إزالة ملف قبل الإرسال (من الجلسة نفسها فقط)' })
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiNoContentResponse()
  async remove(
    @Param('publicId') publicId: string,
    @Param('fileId') fileId: string,
    @Headers(SESSION_HEADER) token: string | undefined,
  ): Promise<void> {
    await this.uploads.removeFile(publicId, token, fileId);
  }
}
