import { Prisma } from '@prisma/client';
import { Errors, type FieldError } from '../common/errors';
import type { ResponseFilterQueryDto } from './dto';

/** توقيت الرياض ثابت (UTC+3، بلا توقيت صيفي). */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

function parseDay(value: string): number | null {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  const date = new Date(t);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return t;
}

/** بداية يوم الرياض بتوقيت UTC، ونهايته الحصرية (بداية اليوم التالي). */
export function riyadhDayRange(from?: string, to?: string): { gte?: Date; lt?: Date } {
  const fields: FieldError[] = [];
  const fromDay = from ? parseDay(from) : undefined;
  const toDay = to ? parseDay(to) : undefined;
  if (fromDay === null) fields.push({ field: 'from', message: 'تاريخ البداية غير صحيح.' });
  if (toDay === null) fields.push({ field: 'to', message: 'تاريخ النهاية غير صحيح.' });
  if (fromDay != null && toDay != null && fromDay > toDay) {
    fields.push({
      field: 'to',
      message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو مساويًا له.',
    });
  }
  if (fields.length) throw Errors.validation(fields);
  return {
    ...(fromDay != null && { gte: new Date(fromDay - RIYADH_OFFSET_MS) }),
    ...(toDay != null && { lt: new Date(toDay + 24 * 60 * 60 * 1000 - RIYADH_OFFSET_MS) }),
  };
}

/**
 * يطبّع بحث الرقم المرجعي: أحرف كبيرة دون مسافات، وتُضاف الشرطات كل 4 أحرف إن كُتب دونها.
 * يعيد null إن لم يبق شيء للبحث.
 */
export function normalizeReferenceSearch(search?: string): string | null {
  if (!search) return null;
  const compact = search.toUpperCase().replace(/[\s-]/g, '');
  if (!compact) return null;
  return compact.match(/.{1,4}/g)!.join('-');
}

/** شرط Prisma للفلاتر؛ النموذج دائمًا جزء من الشرط فلا تظهر ردود نموذج آخر. */
export function buildResponseWhere(
  formId: string,
  query: ResponseFilterQueryDto,
  versionId?: string,
): Prisma.FormResponseWhereInput {
  const reference = normalizeReferenceSearch(query.search);
  const range = riyadhDayRange(query.from, query.to);
  return {
    formId,
    ...(versionId && { versionId }),
    ...(query.status && { status: query.status }),
    ...(reference && { referenceCode: { startsWith: reference } }),
    ...((range.gte || range.lt) && { submittedAt: range }),
  };
}

export function responseOrder(
  sort: ResponseFilterQueryDto['sort'],
): Prisma.FormResponseOrderByWithRelationInput[] {
  const dir = sort === 'oldest' ? 'asc' : 'desc';
  return [{ submittedAt: dir }, { id: dir }];
}
