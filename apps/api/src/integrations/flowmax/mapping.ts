import type { FileKind } from '@prisma/client';
import type { Operation } from './fields';
import type { MediaCandidate } from './media';

/** أنواع مشتركة بين التعرّف التلقائي (auto-property.ts) وخدمة الإرسال. */

/** إجابة سؤال واحد كما في الرد (بمفتاح السؤال المنطقي). */
export interface AnswerInput {
  logicalId: string;
  title: string;
  type: string;
  text?: string | null;
  number?: string | null;
  date?: string | null;
  choices?: string[];
  files?: { id: string; name: string; kind: FileKind; size: number }[];
  /** الهوية الدلالية للسؤال (نماذج القالب)؛ null للنماذج القديمة. */
  semanticKey?: string | null;
  /** الهويات الدلالية للخيارات المحددة، بترتيب الخيارات. */
  choiceKeys?: string[];
  /** سؤال مخفي حسب إجابات الرد (فرع غير نشط)؛ لا يُرسل شيء منه. */
  hidden?: boolean;
}

export interface Problem {
  field: string;
  message: string;
}

/** لقطة المشاركة: حقول عامة مسموحة فقط، دون اسم المالك أو جواله. */
export interface ShareInfo {
  title: string;
  operation: Operation;
  purpose: string | null;
  category: string | null;
  city: string | null;
  district: string | null;
  priceSar: string | null;
  areaSqm: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
}

export interface BuildResult {
  operation: Operation | null;
  body: Record<string, unknown>;
  share: ShareInfo | null;
  media: MediaCandidate[];
  problems: Problem[];
}

/** أرقام عربية/فارسية ⇒ لاتينية. */
export function toLatinDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

/** جوال بصيغة E.164؛ الأرقام السعودية المحلية (05xxxxxxxx) تُحوَّل إلى +9665xxxxxxxx. */
export function normalizePhone(raw: string): string | null {
  const v0 = toLatinDigits(raw).replace(/[\s()\-.٬,]/g, '');
  let v = v0;
  if (/^05\d{8}$/.test(v)) v = `+966${v.slice(1)}`;
  else if (/^9665\d{8}$/.test(v)) v = `+${v}`;
  else if (/^00[1-9]\d{7,14}$/.test(v)) v = `+${v.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
}
