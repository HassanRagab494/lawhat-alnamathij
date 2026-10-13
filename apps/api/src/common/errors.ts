import { HttpException, HttpStatus } from '@nestjs/common';

export interface FieldError {
  field: string;
  message: string;
}

/** شكل موحد لكل أخطاء الـ API. `code` ثابت للبرمجة و`message` عربي للعرض. */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  fields?: FieldError[];
  details?: Record<string, unknown>;
}

export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    extra: { fields?: FieldError[]; details?: Record<string, unknown> } = {},
  ) {
    const body: ApiErrorBody = { statusCode: status, code, message, ...extra };
    super(body, status);
  }
}

export const Errors = {
  unauthenticated: () =>
    new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.'),
  invalidCredentials: () =>
    new AppError(
      HttpStatus.UNAUTHORIZED,
      'INVALID_CREDENTIALS',
      'اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب غير مفعّل.',
    ),
  loginLocked: () =>
    new AppError(
      HttpStatus.TOO_MANY_REQUESTS,
      'LOGIN_TEMPORARILY_LOCKED',
      'تم إيقاف الدخول مؤقتًا بسبب محاولات متكررة. حاول مرة أخرى لاحقًا.',
    ),
  csrf: () =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'CSRF_INVALID',
      'تعذر التحقق من مصدر الطلب. حدّث الصفحة ثم أعد المحاولة.',
    ),
  forbidden: () =>
    new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذا الإجراء.'),
  notFound: (message = 'العنصر المطلوب غير موجود.') =>
    new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message),
  validation: (fields: FieldError[]) =>
    new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'بعض البيانات المدخلة غير صحيحة.', {
      fields,
    }),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(HttpStatus.CONFLICT, code, message, details ? { details } : {}),
};
