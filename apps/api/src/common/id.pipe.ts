import { Injectable, PipeTransform } from '@nestjs/common';
import { Errors } from './errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** المعرّف غير الصالح يعامل كعنصر غير موجود بدل كشف تفاصيل الصيغة. */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, string> {
  constructor(private readonly notFoundMessage = 'العنصر المطلوب غير موجود.') {}

  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw Errors.notFound(this.notFoundMessage);
    }
    return value.toLowerCase();
  }
}
