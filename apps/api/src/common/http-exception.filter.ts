import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import type { ApiErrorBody } from './errors';

/**
 * يحوّل كل الاستثناءات إلى ApiErrorBody. لا يسجّل جسم الطلب أبدًا
 * (قد يحتوي كلمات مرور)، ويكتفي بالمسار والطريقة ونوع الخطأ.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const body = this.toBody(exception);

    if (body.statusCode >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${req.method} ${req.path} -> ${body.statusCode}: ${err.name}`, err.stack);
    }
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ApiErrorBody {
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'TOO_MANY_REQUESTS',
        message: 'عدد الطلبات كبير. انتظر قليلًا ثم حاول مرة أخرى.',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null && 'code' in response) {
        return response as ApiErrorBody;
      }
      return { statusCode: status, ...defaultForStatus(status) };
    }
    if (exception instanceof SyntaxError && 'body' in exception) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'MALFORMED_JSON',
        message: 'صيغة البيانات المرسلة غير صحيحة.',
      };
    }
    if (isClientHttpError(exception)) {
      // أخطاء body-parser (http-errors) مثل تجاوز الحجم المسموح.
      return { statusCode: exception.status, ...defaultForStatus(exception.status) };
    }
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'DATABASE_UNAVAILABLE',
        message: 'الخدمة غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل.',
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'حدث خطأ غير متوقع. حاول مرة أخرى.',
    };
  }
}

function isClientHttpError(value: unknown): value is { status: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { status, expose } = value as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true;
}

function defaultForStatus(status: number): { code: string; message: string } {
  switch (status) {
    case 400:
      return { code: 'BAD_REQUEST', message: 'الطلب غير صحيح.' };
    case 401:
      return { code: 'UNAUTHENTICATED', message: 'يلزم تسجيل الدخول للمتابعة.' };
    case 403:
      return { code: 'FORBIDDEN', message: 'لا تملك صلاحية تنفيذ هذا الإجراء.' };
    case 404:
      return { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' };
    case 413:
      return { code: 'PAYLOAD_TOO_LARGE', message: 'حجم البيانات المرسلة كبير جدًا.' };
    default:
      return { code: 'HTTP_ERROR', message: 'تعذر إكمال الطلب.' };
  }
}
