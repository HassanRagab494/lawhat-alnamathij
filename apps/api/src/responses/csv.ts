import { RIYADH_OFFSET_MS } from './filters';

/** أقصى عدد صفوف في ملف تصدير واحد؛ الأكثر يُرفض ويُطلب تضييق الفلاتر. */
export const EXPORT_MAX_ROWS = 5000;
/** أقصى حجم لملف التصدير (10 ميغابايت)؛ يُبنى الملف تدريجيًا ويُرفض قبل الإرسال إن تجاوزه. */
export const EXPORT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * خلية CSV آمنة:
 * - منع حقن الصيغ: القيمة التي تبدأ بـ = + - @ أو Tab أو CR تُسبق بعلامة ' فلا ينفذها Excel أو Sheets.
 * - كل خلية بين علامتي تنصيص مع مضاعفة التنصيص الداخلي، فلا تكسر الفواصل أو الأسطر الصف.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: (string | number | null | undefined)[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** وقت UTC معروضًا بتوقيت الرياض: YYYY-MM-DD HH:mm:ss */
export function riyadhDateTime(date: Date): string {
  return new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}

/** يبني الملف بالبايت ويرفض تجاوز الحد. */
export class CsvBuilder {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes = EXPORT_MAX_BYTES) {
    this.push('﻿'); // BOM ليقرأ Excel الترميز UTF-8 والنص العربي صحيحًا
  }

  /** يعيد false إن تجاوز الحد (ولا يضيف الصف). */
  push(text: string): boolean {
    const chunk = Buffer.from(text, 'utf8');
    if (this.size + chunk.length > this.maxBytes) return false;
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  get bytes(): number {
    return this.size;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}
