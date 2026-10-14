import type { FileKind } from '@prisma/client';
import { z } from 'zod';
import {
  FIELD_BY_KEY,
  FLOWMAX_FIELDS,
  LISTING_PURPOSES,
  PROPERTY_CATEGORIES,
  SYNONYMS,
  normalizeArabic,
  type FieldDef,
  type Operation,
} from './fields';
import type { MediaCandidate, MediaRole } from './media';

/**
 * الربط بين إجابات النموذج وحقول Flowmax: لكل حقل إما سؤال (بمعرّفه المنطقي الثابت عبر الإصدارات)
 * أو قيمة ثابتة، مع جدول تحويل اختياري لقيم الاختيار (نص الإجابة ⇒ قيمة Flowmax).
 * التحويل حتمي وقابل للتفسير: كل حقل ناقص أو غير صالح يُعاد برسالة عربية تذكر اسمه.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const fieldSourceSchema = z
  .object({
    questionId: z.string().regex(UUID, 'معرّف السؤال غير صالح.').optional(),
    constant: z.string().trim().min(1, 'القيمة الثابتة فارغة.').max(500).optional(),
    values: z
      .record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(100))
      .optional(),
  })
  .strict()
  .refine((s) => Boolean(s.questionId) !== Boolean(s.constant), {
    message: 'اختر سؤالًا أو قيمة ثابتة (واحدًا فقط).',
  });

export const mappingConfigSchema = z
  .object({
    fields: z.record(z.string(), fieldSourceSchema).superRefine((fields, ctx) => {
      for (const key of Object.keys(fields)) {
        const def = FIELD_BY_KEY.get(key);
        if (!def) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'حقل Flowmax غير معروف.',
          });
          continue;
        }
        const source = fields[key]!;
        if ((def.type === 'files' || def.type === 'consent') && source.constant) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'هذا الحقل يُربط بسؤال فقط.',
          });
        }
        if (source.values && def.type !== 'enum') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, 'values'],
            message: 'جدول التحويل لحقول الاختيار فقط.',
          });
        }
        for (const target of Object.values(source.values ?? {})) {
          if (def.values && !(target in def.values)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key, 'values'],
              message: `القيمة «${target}» غير مقبولة في Flowmax.`,
            });
          }
        }
      }
    }),
  })
  .strict();

export type FieldSource = z.infer<typeof fieldSourceSchema>;
export type MappingConfig = z.infer<typeof mappingConfigSchema>;

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
}

export interface Problem {
  field: string;
  message: string;
}

export interface ShareInfo {
  title: string;
  operation: Operation;
  purpose: string | null;
  category: string | null;
  city: string | null;
  district: string | null;
  priceSar: string | null;
}

export interface BuildResult {
  operation: Operation | null;
  body: Record<string, unknown>;
  share: ShareInfo | null;
  media: MediaCandidate[];
  problems: Problem[];
}

export interface BuildContext {
  referenceCode: string;
  submittedAt: Date;
}

const TRUTHY = new Set(['نعم', 'موافق', 'اوافق', 'موافقه', 'yes', 'true', 'agree', '1']);

/** أرقام عربية/فارسية ⇒ لاتينية، وحذف فواصل الآلاف والعملة. */
function toLatinNumber(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٬,\s]/g, '')
    .replace(/٫/g, '.')
    .replace(/(ريال|ر\.س|sar)$/i, '');
}

/** جوال بصيغة E.164؛ الأرقام السعودية المحلية (05xxxxxxxx) تُحوَّل إلى +9665xxxxxxxx. */
export function normalizePhone(raw: string): string | null {
  const digits = toLatinNumber(raw).replace(/[()\-.]/g, '');
  let v = digits;
  if (/^05\d{8}$/.test(v)) v = `+966${v.slice(1)}`;
  else if (/^9665\d{8}$/.test(v)) v = `+${v}`;
  else if (/^00[1-9]\d{7,14}$/.test(v)) v = `+${v.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
}

/** المصدر النصي للحقل (من الإجابة أو الثابت)؛ null إن لم يُجب. */
function rawValue(source: FieldSource, answer: AnswerInput | undefined): string | null {
  if (source.constant) return source.constant;
  if (!answer) return null;
  if (answer.text != null && answer.text.trim()) return answer.text.trim();
  if (answer.number != null) return answer.number;
  if (answer.date != null) return answer.date;
  if (answer.choices?.length) return answer.choices.join('، ');
  return null;
}

function enumValue(def: FieldDef, source: FieldSource, raw: string): string | null {
  const allowed = def.values ?? {};
  const table = source.values ?? {};
  const n = normalizeArabic(raw);
  for (const [from, to] of Object.entries(table)) {
    if (normalizeArabic(from) === n) return to;
  }
  const synonym = SYNONYMS[def.key]?.[n];
  if (synonym) return synonym;
  for (const [value, label] of Object.entries(allowed)) {
    if (value.toLowerCase() === n || normalizeArabic(label) === n) return value;
  }
  return null;
}

/**
 * يحوّل إجابات رد إلى طلب Flowmax وفق الربط. لا يتصل بالشبكة ولا يقرأ ملفات.
 * يعيد problems بكل حقل مطلوب ناقص أو قيمة غير صالحة؛ الاعتماد يُمنع ما دامت غير فارغة.
 */
export function buildFlowmaxRequest(
  config: MappingConfig,
  answers: AnswerInput[],
  ctx: BuildContext,
): BuildResult {
  const byId = new Map(answers.map((a) => [a.logicalId, a]));
  const problems: Problem[] = [];
  const values: Record<string, unknown> = {};
  const media: MediaCandidate[] = [];

  const read = (def: FieldDef): unknown => {
    const source = config.fields[def.key];
    if (!source) return undefined;
    const answer = source.questionId ? byId.get(source.questionId) : undefined;
    if (def.type === 'files') {
      return answer?.files?.length ? answer.files : undefined;
    }
    if (def.type === 'consent') {
      const raw = rawValue(source, answer);
      if (raw === null) return undefined;
      const ok = raw.split('، ').some((part) => TRUTHY.has(normalizeArabic(part)));
      if (!ok) problems.push({ field: def.key, message: `«${def.label}»: لم يوافق المرسل.` });
      return ok ? true : undefined;
    }
    const raw = rawValue(source, answer);
    if (raw === null) return undefined;
    const invalid = (why: string) => {
      problems.push({ field: def.key, message: `«${def.label}»: ${why}` });
      return null;
    };
    switch (def.type) {
      case 'enum':
        return enumValue(def, source, raw) ?? invalid(`القيمة «${raw}» غير معروفة لـ Flowmax.`);
      case 'integer': {
        const v = toLatinNumber(raw);
        return /^\d+$/.test(v) && Number.isSafeInteger(Number(v))
          ? Number(v)
          : invalid('يجب أن يكون عددًا صحيحًا.');
      }
      case 'decimal': {
        const v = toLatinNumber(raw);
        return /^\d+(\.\d+)?$/.test(v) ? Number(v) : invalid('يجب أن يكون رقمًا.');
      }
      case 'money': {
        const v = toLatinNumber(raw);
        if (!/^\d+(\.\d{1,2})?$/.test(v) || Number(v) <= 0) {
          return invalid('يجب أن يكون مبلغًا موجبًا بالريال.');
        }
        return v;
      }
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : invalid('يجب أن يكون تاريخًا YYYY-MM-DD.');
      case 'phone':
        return normalizePhone(raw) ?? invalid('رقم الجوال غير صالح.');
      default:
        return raw.slice(0, 5000);
    }
  };

  for (const def of FLOWMAX_FIELDS) {
    const v = read(def);
    if (v !== undefined && v !== null) values[def.key] = v;
  }

  const opValue = values.operation as string | undefined;
  const operation: Operation | null =
    opValue === 'offer' ? 'OFFER' : opValue === 'request' ? 'REQUEST' : null;
  if (!operation) {
    if (!problems.some((p) => p.field === 'operation')) {
      problems.push({ field: 'operation', message: '«نوع العملية (عرض أو طلب)»: الإجابة مطلوبة.' });
    }
    return { operation: null, body: {}, share: null, media, problems };
  }

  for (const def of FLOWMAX_FIELDS) {
    if (!def.requiredFor.includes(operation)) continue;
    if (values[def.key] === undefined && !problems.some((p) => p.field === def.key)) {
      problems.push({
        field: def.key,
        message: config.fields[def.key]
          ? `«${def.label}»: الإجابة مطلوبة لإنشاء ${operation === 'OFFER' ? 'العقار' : 'الطلب'}.`
          : `«${def.label}»: غير مربوط بسؤال أو قيمة في إعداد Flowmax.`,
      });
    }
  }

  const purpose = (values.listing_purpose as string | undefined) ?? null;
  const category = (values.property_category as string | undefined) ?? null;
  const halalas = values.price ? Math.round(Number(values.price) * 100) : undefined;
  // كل ملفات أسئلة الصور والفيديو تُرشَّح للإرسال؛ ما لا يقبله Flowmax يُعرض للأدمن قبل الاعتماد (media.ts)
  const files = (key: 'images' | 'videos', role: MediaRole): MediaCandidate[] =>
    ((values[key] as AnswerInput['files']) ?? []).map((f) => ({
      fileId: f.id,
      name: f.name,
      kind: f.kind,
      size: f.size,
      role,
    }));

  let body: Record<string, unknown>;
  if (operation === 'OFFER') {
    media.push(...files('images', 'image'), ...files('videos', 'video'));
    const date = values.contract_date as string | undefined;
    body = {
      title_ar: values.title_ar,
      description_ar: values.description_ar,
      type_letter: values.type_letter,
      developer_id: values.developer_id,
      mediation_contract_number: values.mediation_contract_number,
      contract_day: date?.slice(8, 10),
      contract_month: date?.slice(5, 7),
      fal_license_number: values.fal_license_number,
      property_category: category ?? undefined,
      listing_purpose: purpose ?? undefined,
      city: values.city,
      district: values.district,
      currency: 'SAR',
      ...(purpose === 'daily_rental'
        ? { original_nightly_price: halalas }
        : { requested_price: halalas }),
      area_sqm: values.area_sqm,
      bedrooms_count: values.bedrooms_count,
      bathrooms_count: values.bathrooms_count,
      contact_phone: values.contact_phone,
      // اسم المالك في الملاحظات الإدارية فقط (لا تظهر في واجهات Flowmax العامة)
      listing_notes: values.contact_name
        ? `اسم المالك: ${String(values.contact_name)} — رد لوحة النماذج ${ctx.referenceCode}`
        : `رد لوحة النماذج ${ctx.referenceCode}`,
    };
  } else {
    const criteria: Record<string, unknown> = {};
    for (const k of ['area_sqm', 'bedrooms_count', 'bathrooms_count'] as const) {
      if (values[k] !== undefined) criteria[k] = values[k];
    }
    body = {
      requester_name: values.contact_name,
      requester_phone: values.contact_phone,
      property_category: category,
      listing_purpose: purpose,
      city: values.city,
      district: values.district,
      budget_max_halalas: halalas,
      ...(purpose === 'daily_rental' && { budget_basis: 'stay_total' }),
      ...(Object.keys(criteria).length && { criteria }),
      consent_version: values.consent_version,
      intake_consent_evidence: `موافقة المرسل ضمن رد لوحة النماذج ${ctx.referenceCode} بتاريخ ${ctx.submittedAt.toISOString()}`,
    };
  }
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

  const categoryLabel = category ? (PROPERTY_CATEGORIES[category] ?? null) : null;
  const share: ShareInfo = {
    title:
      (values.title_ar as string | undefined) ??
      [
        operation === 'OFFER' ? 'عرض' : 'طلب',
        categoryLabel,
        values.city ? `في ${String(values.city)}` : null,
      ]
        .filter(Boolean)
        .join(' '),
    operation,
    purpose: purpose ? (LISTING_PURPOSES[purpose] ?? null) : null,
    category: categoryLabel,
    city: (values.city as string | undefined) ?? null,
    district: (values.district as string | undefined) ?? null,
    priceSar: (values.price as string | undefined) ?? null,
  };
  return { operation, body, share, media, problems };
}
