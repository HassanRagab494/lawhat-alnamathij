import { ValidationError, ValidationPipe } from '@nestjs/common';
import { Errors, FieldError } from './errors';

const FALLBACK_MESSAGE = 'القيمة غير صحيحة.';

export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  const result: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) {
      const constraints = error.constraints;
      // whitelistValidation تعني حقلًا غير معروف أُرسل في الطلب.
      const message = constraints.whitelistValidation
        ? 'هذا الحقل غير مسموح به.'
        : (Object.values(constraints)[0] ?? FALLBACK_MESSAGE);
      result.push({ field, message: isArabic(message) ? message : FALLBACK_MESSAGE });
    }
    if (error.children?.length) {
      result.push(...flattenValidationErrors(error.children, field));
    }
  }
  return result;
}

function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
    exceptionFactory: (errors) => Errors.validation(flattenValidationErrors(errors)),
  });
}
