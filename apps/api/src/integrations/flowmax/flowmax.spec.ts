import { Logger } from '@nestjs/common';
import type { FlowmaxSync } from '@prisma/client';
import { Readable } from 'node:stream';
import { startMockFlowmax, type MockFlowmax } from '../../../test/fixtures/flowmax-mock';
import type { AppEnv } from '../../config/env';
import { FlowmaxClient, FlowmaxError } from './client';
import { FlowmaxService } from './flowmax.service';
import {
  buildFlowmaxRequest,
  mappingConfigSchema,
  normalizePhone,
  type AnswerInput,
} from './mapping';
import { incompatibleMedia } from './media';

const Q = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  referenceCode: 'K7Q2-ABCD-EFGH',
  submittedAt: new Date('2026-10-14T10:00:00Z'),
};

const offerConfig = mappingConfigSchema.parse({
  fields: {
    operation: { questionId: Q(1) },
    title_ar: { questionId: Q(2) },
    description_ar: { questionId: Q(3) },
    property_category: { questionId: Q(4), values: { 'شقة دوبلكس': 'duplex' } },
    listing_purpose: { questionId: Q(5) },
    city: { questionId: Q(6) },
    district: { questionId: Q(7) },
    price: { questionId: Q(8) },
    area_sqm: { questionId: Q(9) },
    bedrooms_count: { questionId: Q(10) },
    bathrooms_count: { questionId: Q(11) },
    contact_name: { questionId: Q(12) },
    contact_phone: { questionId: Q(13) },
    images: { questionId: Q(14) },
    videos: { questionId: Q(15) },
    type_letter: { constant: 'M' },
    developer_id: { constant: '7' },
    mediation_contract_number: { constant: 'MCN-01' },
    contract_date: { constant: '2026-03-15' },
    fal_license_number: { constant: 'FAL-1' },
  },
});

function offerAnswers(
  overrides: Partial<Record<number, Partial<AnswerInput>>> = {},
): AnswerInput[] {
  const base: Record<number, Partial<AnswerInput>> = {
    1: { type: 'SINGLE_CHOICE', choices: ['عرض'] },
    2: { type: 'SHORT_TEXT', text: 'شقة مطلة في حي النرجس' },
    3: { type: 'PARAGRAPH', text: 'ثلاث غرف وصالة' },
    4: { type: 'DROPDOWN', choices: ['شقة'] },
    5: { type: 'SINGLE_CHOICE', choices: ['بيع'] },
    6: { type: 'SHORT_TEXT', text: 'الرياض' },
    7: { type: 'SHORT_TEXT', text: 'النرجس' },
    8: { type: 'NUMBER', number: '850000' },
    9: { type: 'NUMBER', number: '145.5' },
    10: { type: 'NUMBER', number: '3' },
    11: { type: 'SHORT_TEXT', text: '٢' },
    12: { type: 'SHORT_TEXT', text: 'سارة المالكة' },
    13: { type: 'SHORT_TEXT', text: '0551234567' },
    14: {
      type: 'FILE_UPLOAD',
      files: [{ id: 'img-1', name: 'واجهة.png', kind: 'PNG', size: 100 }],
    },
    15: { type: 'FILE_UPLOAD', files: [{ id: 'vid-1', name: 'جولة.mp4', kind: 'MP4', size: 200 }] },
  };
  return Object.entries({ ...base, ...overrides }).map(([n, a]) => ({
    logicalId: Q(Number(n)),
    title: `سؤال ${n}`,
    type: 'SHORT_TEXT',
    ...a,
  }));
}

describe('buildFlowmaxRequest — تحويل الإجابات إلى حقول Flowmax', () => {
  it('عرض مكتمل ⇒ مسودة عقار بالهللة ، والمشاركة بلا بيانات المالك', () => {
    const r = buildFlowmaxRequest(offerConfig, offerAnswers(), ctx);
    expect(r.problems).toEqual([]);
    expect(r.operation).toBe('OFFER');
    expect(r.body).toMatchObject({
      title_ar: 'شقة مطلة في حي النرجس',
      property_category: 'apartment',
      listing_purpose: 'sale',
      requested_price: 85_000_000,
      contract_day: '15',
      contract_month: '03',
      developer_id: 7,
      bathrooms_count: 2,
      area_sqm: 145.5,
      contact_phone: '+966551234567',
      currency: 'SAR',
    });
    expect(r.body).not.toHaveProperty('platform_code');
    expect(r.media).toEqual([
      { fileId: 'img-1', name: 'واجهة.png', kind: 'PNG', size: 100, role: 'image' },
      { fileId: 'vid-1', name: 'جولة.mp4', kind: 'MP4', size: 200, role: 'video' },
    ]);
    const share = JSON.stringify(r.share);
    expect(share).not.toMatch(/سارة|0551234567|966551234567/);
    expect(r.share).toEqual({
      title: 'شقة مطلة في حي النرجس',
      operation: 'OFFER',
      purpose: 'بيع',
      category: 'شقة',
      city: 'الرياض',
      district: 'النرجس',
      priceSar: '850000',
    });
  });

  it('جدول التحويل يسبق المرادفات، والإيجار اليومي يرسل سعر الليلة', () => {
    const r = buildFlowmaxRequest(
      offerConfig,
      offerAnswers({ 4: { choices: ['شقة دوبلكس'] }, 5: { choices: ['إيجار يومي'] } }),
      ctx,
    );
    expect(r.body.property_category).toBe('duplex');
    expect(r.body.original_nightly_price).toBe(85_000_000);
    expect(r.body.requested_price).toBeUndefined();
  });

  it('يمنع الاعتماد برسائل عربية عند نقص المطلوب أو قيمة غير معروفة', () => {
    const r = buildFlowmaxRequest(
      offerConfig,
      offerAnswers({ 6: { text: '' }, 8: { number: null }, 4: { choices: ['كوخ'] } }),
      ctx,
    );
    expect(r.problems.map((p) => p.field).sort()).toEqual(['city', 'price', 'property_category']);
    expect(r.problems.find((p) => p.field === 'city')!.message).toBe(
      '«المدينة»: الإجابة مطلوبة لإنشاء العقار.',
    );
    expect(r.problems.find((p) => p.field === 'property_category')!.message).toContain('«كوخ»');
  });

  it('حقل مطلوب غير مربوط يُذكر صراحة', () => {
    const { fal_license_number: _omit, ...fields } = offerConfig.fields;
    const r = buildFlowmaxRequest({ fields }, offerAnswers(), ctx);
    expect(r.problems).toEqual([
      {
        field: 'fal_license_number',
        message: '«رقم رخصة فال»: غير مربوط بسؤال أو قيمة في إعداد Flowmax.',
      },
    ]);
  });

  it('الطلب يحتاج جوالًا صالحًا وموافقة، ولا يحمل مفتاحًا من المتصل (Flowmax يشتقه من مفتاح المصدر)', () => {
    const config = mappingConfigSchema.parse({
      fields: {
        ...offerConfig.fields,
        consent: { questionId: Q(16) },
        consent_version: { constant: '2026-10' },
      },
    });
    const ok = buildFlowmaxRequest(
      config,
      [
        ...offerAnswers({ 1: { choices: ['طلب'] } }),
        { logicalId: Q(16), title: 'الموافقة', type: 'SINGLE_CHOICE', choices: ['نعم، أوافق'] },
      ],
      ctx,
    );
    expect(ok.problems).toEqual([]);
    expect(ok.operation).toBe('REQUEST');
    expect(ok.body).toMatchObject({
      requester_phone: '+966551234567',
      budget_max_halalas: 85_000_000,
      consent_version: '2026-10',
      criteria: { area_sqm: 145.5, bedrooms_count: 3, bathrooms_count: 2 },
    });
    expect(String(ok.body.intake_consent_evidence)).toContain(ctx.referenceCode);
    expect(ok.body).not.toHaveProperty('idempotency_key');
    expect(ok.media).toEqual([]);

    const bad = buildFlowmaxRequest(
      config,
      [
        ...offerAnswers({ 1: { choices: ['طلب'] }, 13: { text: '12' } }),
        { logicalId: Q(16), title: 'الموافقة', type: 'SINGLE_CHOICE', choices: ['لا'] },
      ],
      ctx,
    );
    expect(bad.problems.map((p) => p.field).sort()).toEqual(['consent', 'contact_phone']);
  });

  it('مخطط الربط يرفض الحقول المجهولة والمصدر المزدوج والقيم غير المقبولة', () => {
    const r = mappingConfigSchema.safeParse({
      fields: {
        nope: { constant: 'x' },
        city: { constant: 'الرياض', questionId: Q(1) },
        property_category: { questionId: Q(2), values: { كوخ: 'hut' } },
        images: { constant: 'x' },
      },
    });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'fields.nope',
        'fields.city',
        'fields.property_category.values',
        'fields.images',
      ]),
    );
  });

  it('normalizePhone', () => {
    expect(normalizePhone('0551234567')).toBe('+966551234567');
    expect(normalizePhone('٠٥٥١٢٣٤٥٦٧')).toBe('+966551234567');
    expect(normalizePhone('00971501234567')).toBe('+971501234567');
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('incompatibleMedia — حدود Flowmax قبل الاعتماد', () => {
  const MB = 1024 * 1024;
  it('يحدد الصور والفيديو التي لا يقبلها Flowmax وسبب كل منها', () => {
    const out = incompatibleMedia([
      { fileId: 'a', name: 'كبيرة.jpg', kind: 'JPG', size: 11 * MB, role: 'image' },
      { fileId: 'b', name: 'ملف.pdf', kind: 'PDF', size: MB, role: 'image' },
      { fileId: 'c', name: 'ضخم.mp4', kind: 'MP4', size: 101 * MB, role: 'video' },
      { fileId: 'd', name: 'سليم.png', kind: 'PNG', size: MB, role: 'image' },
    ]);
    expect(out.map((m) => m.fileId)).toEqual(['a', 'b', 'c']);
    expect(out[0]!.reason).toContain('10MB');
    expect(out[2]!.reason).toContain('100MB');
  });
  it('الزائد عن عدد الفيديوهات المسموح يُذكر', () => {
    const videos = Array.from({ length: 6 }, (_, i) => ({
      fileId: `v${i}`,
      name: `v${i}.mp4`,
      kind: 'MP4' as const,
      size: MB,
      role: 'video' as const,
    }));
    expect(incompatibleMedia(videos).map((m) => m.fileId)).toEqual(['v5']);
  });
});

describe('FlowmaxClient مع خادم Flowmax وهمي', () => {
  let mock: MockFlowmax;
  beforeAll(async () => {
    mock = await startMockFlowmax();
  });
  afterAll(() => mock.close());

  const client = (overrides: Partial<{ token: string; timeoutMs: number }> = {}) =>
    new FlowmaxClient({
      baseUrl: mock.url,
      token: overrides.token ?? mock.token,
      timeoutMs: overrides.timeoutMs ?? 2000,
      mediaTimeoutMs: 2000,
    });
  const OFFERS = '/api/admin/integrations/forms/offers';

  it('يرسل الرمز في Authorization فقط ويعيد data', async () => {
    const data = await client().json<{ id: number; replayed: boolean }>('POST', OFFERS, {
      source_key: 'lawha:response:c1',
      title_ar: 'أ',
    });
    expect(data.replayed).toBe(false);
    const last = mock.requests.at(-1)!;
    expect(last.auth).toBe(`Bearer ${mock.token}`);
    expect(last.path).not.toContain(mock.token);
  });

  it('رفض الرمز بوصف لا يحمل الرمز، و409 برسالة واضحة', async () => {
    const e401 = (await client({ token: 'wrong-token-wrong-token-1234' })
      .json('GET', '/api/admin/integrations/forms/records/x')
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(e401.describe()).toBe('رفض Flowmax صلاحية حساب التكامل (401).');
    expect(e401.message).not.toContain('wrong-token');
    const e409 = (await client()
      .json('POST', OFFERS, { source_key: 'lawha:response:c1', title_ar: 'مختلف' })
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(e409.status).toBe(409);
    expect(e409.code).toBe('integration_key_conflict');
    expect(e409.describe()).toContain('استُخدم ببيانات مختلفة');
  });

  it('422 ⇒ أسماء الحقول أو متطلبات النشر فقط، والمهلة ⇒ timeout', async () => {
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'http422' });
    const e422 = (await client()
      .json('POST', OFFERS, { source_key: 'lawha:response:c2' })
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(e422.describe()).toBe('رفض Flowmax الحقول: developer_id.');
    const ePublish = (await client()
      .json('POST', `${OFFERS}/lawha%3Aresponse%3Ac1/publish`, {})
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(ePublish.describe()).toBe('متطلبات النشر في Flowmax غير مكتملة: images.');
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'hang' });
    const timeout = (await client({ timeoutMs: 1000 })
      .json('POST', OFFERS, { source_key: 'lawha:response:c3' })
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(timeout.failure).toBe('timeout');
  });

  it('يرفع المرفق multipart بالتدفق مع مفتاحه وباسم مولّد', async () => {
    const content = Buffer.alloc(4096, 7);
    await client().upload(`${OFFERS}/lawha%3Aresponse%3Ac1/media`, {
      fields: { media_key: 'lawha:response:c1:file:v1', kind: 'video' },
      filename: 'media-1.mp4',
      mime: 'video/mp4',
      size: content.length,
      stream: Readable.from([content]),
    });
    const req = mock.requests.at(-1)!;
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.body.toString('latin1')).toContain('filename="media-1.mp4"');
    expect(mock.properties.find((p) => p.sourceKey === 'lawha:response:c1')!.videos).toBe(1);
  });
});

/** Prisma مصغّر في الذاكرة لسجل الإرسال والملفات فقط (لاختبار منطق الإرسال دون قاعدة). */
function fakePrisma(sync: FlowmaxSync, files: Record<string, { kind: string; sizeBytes: number }>) {
  const rows = new Map([[sync.id, sync]]);
  return {
    flowmaxSync: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.id as string);
        if (!row) return { count: 0 };
        const now = new Date();
        const or = where.OR as { status: string; leaseUntil?: { lt: Date } }[] | undefined;
        const match = or
          ? or.some(
              (c) =>
                c.status === row.status &&
                (!c.leaseUntil || (row.leaseUntil ?? now) < c.leaseUntil.lt),
            )
          : !where.status || row.status === where.status;
        if (!match) return { count: 0 };
        const { attempts, ...rest } = data as { attempts?: { increment: number } };
        Object.assign(row, rest);
        if (attempts) row.attempts += attempts.increment;
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) => ({ ...rows.get(where.id)! }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(rows.get(where.id)!, data),
    },
    uploadedFile: {
      findFirst: async ({ where }: { where: { id: string; responseId: string } }) =>
        files[where.id] && where.responseId === sync.responseId
          ? { id: where.id, storageKey: String(files[where.id]!.sizeBytes), ...files[where.id] }
          : null,
    },
    rows,
  };
}

describe('FlowmaxService.process — إرسال دون تكرار ونتيجة لكل مرفق', () => {
  let mock: MockFlowmax;
  const logs: string[] = [];
  beforeAll(async () => {
    mock = await startMockFlowmax();
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await mock.close();
  });

  const files = {
    'img-1': { kind: 'PNG', sizeBytes: 1000 },
    'vid-1': { kind: 'MP4', sizeBytes: 2000 },
  };

  function newSync(n: number, operation: 'OFFER' | 'REQUEST' = 'OFFER'): FlowmaxSync {
    return {
      id: `sync-${n}`,
      responseId: `resp-${n}`,
      formId: 'form-1',
      operation,
      status: 'PENDING',
      sourceKey: `lawha:response:resp-${n}`,
      payload: { title_ar: `عقار ${n}`, city: 'الرياض' },
      share: { title: `عقار ${n}` },
      media:
        operation === 'OFFER'
          ? [
              { fileId: 'img-1', role: 'image', status: 'PENDING' },
              { fileId: 'vid-1', role: 'video', status: 'PENDING' },
            ]
          : [],
      flowmaxId: null,
      flowmaxRef: null,
      detailUrl: null,
      remoteStatus: null,
      isPublic: false,
      publishState: 'NONE',
      publishError: null,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      leaseUntil: null,
      sentAt: null,
      approvedById: 'u',
      approvedAt: new Date(),
      updatedAt: new Date(),
    } as FlowmaxSync;
  }

  function service(sync: FlowmaxSync) {
    const prisma = fakePrisma(sync, files);
    const storage = {
      openRead: (key: string) => Readable.from([Buffer.alloc(Number(key), 3)]),
      exists: async () => true,
    };
    const client = new FlowmaxClient({
      baseUrl: mock.url,
      token: mock.token,
      timeoutMs: 2000,
      mediaTimeoutMs: 2000,
    });
    const env = { FLOWMAX_ENABLED: true } as unknown as AppEnv;
    const svc = new FlowmaxService(prisma as never, {} as never, env, storage as never, client);
    return { svc, row: () => prisma.rows.get(sync.id)! };
  }
  const count = (key: string) => mock.properties.filter((p) => p.sourceKey === key).length;

  it('ينشئ السجل وينقل كل مرفق ويحفظ معرّفه، والمسودة ليست عامة', async () => {
    const { svc, row } = service(newSync(1));
    await svc.process('sync-1');
    const r = row();
    expect(r.status).toBe('SENT');
    expect(r.isPublic).toBe(false);
    expect(r.detailUrl).toBe(`https://flowmax.test/property/${r.flowmaxId}`);
    const media = r.media as unknown as { status: string; externalId: string }[];
    expect(media.map((m) => m.status)).toEqual(['SENT', 'SENT']);
    expect(media.every((m) => m.externalId)).toBe(true);
    expect(mock.properties.find((p) => String(p.id) === r.flowmaxId)).toMatchObject({
      images: 1,
      videos: 1,
      status: 'Draft',
    });
  });

  it('وصول الإنشاء ثم ضياع الاستجابة ⇒ إعادة المحاولة تعيد السجل نفسه', async () => {
    const sync = newSync(2);
    const { svc, row } = service(sync);
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'drop-after-create' });
    await svc.process('sync-2');
    expect(row()).toMatchObject({ status: 'FAILED', flowmaxId: null });
    expect(count(sync.sourceKey)).toBe(1);
    row().status = 'PENDING';
    await svc.process('sync-2');
    expect(row().status).toBe('SENT');
    expect(count(sync.sourceKey)).toBe(1);
  });

  it('وصول المرفق ثم ضياع الاستجابة ⇒ لا يتكرر المرفق', async () => {
    const sync = newSync(3);
    const { svc, row } = service(sync);
    mock.failNext.push({ match: /\/media$/, mode: 'drop-after-create' });
    await svc.process('sync-3');
    expect(row().status).toBe('FAILED');
    expect(row().lastError).toBe('لم يكتمل نقل 1 من المرفقات؛ أعد المحاولة.');
    const media = row().media as unknown as { status: string }[];
    expect(media[0]!.status).toBe('FAILED');
    row().status = 'PENDING';
    await svc.process('sync-3');
    expect(row().status).toBe('SENT');
    const p = mock.properties.find((x) => x.sourceKey === sync.sourceKey)!;
    expect([p.images, p.videos]).toEqual([1, 1]);
  });

  it('فشل مرفق لا يُعرض نجاحًا كاملًا، ونتيجته محفوظة', async () => {
    const { svc, row } = service(newSync(4));
    mock.failNext.push({ match: /\/media$/, mode: 'http500' });
    await svc.process('sync-4');
    expect(row().status).toBe('FAILED');
    const media = row().media as unknown as { status: string; error: string | null }[];
    expect(media.map((m) => m.status)).toEqual(['FAILED', 'SENT']);
    expect(media[0]!.error).toBe('خطأ من Flowmax (500).');
  });

  it('409 من Flowmax (محتوى مختلف بالمفتاح نفسه) يظهر خطأً صريحًا', async () => {
    const sync = newSync(5);
    const first = service(sync);
    await first.svc.process('sync-5');
    const changed = newSync(5);
    changed.payload = { title_ar: 'عنوان مختلف', city: 'جدة' };
    const second = service(changed);
    await second.svc.process('sync-5');
    expect(second.row().status).toBe('FAILED');
    expect(second.row().lastError).toContain('(409)');
    expect(count(sync.sourceKey)).toBe(1);
  });

  it('الطلب يعيد رابط تفاصيل الطلب نفسه، والتكرار لا ينشئ طلبًا ثانيًا', async () => {
    const a = service(newSync(6, 'REQUEST'));
    await a.svc.process('sync-6');
    const b = service(newSync(6, 'REQUEST'));
    await b.svc.process('sync-6');
    expect(a.row().flowmaxRef).toBe(b.row().flowmaxRef);
    expect(a.row().detailUrl).toBe(`https://flowmax.test/properties/demands/${a.row().flowmaxRef}`);
    expect(mock.demands.filter((d) => d.sourceKey === 'lawha:response:resp-6')).toHaveLength(1);
  });

  it('لا يُعاد حجز إرسال مكتمل', async () => {
    const sync = newSync(7);
    sync.status = 'SENT';
    const { svc } = service(sync);
    const before = mock.requests.length;
    await svc.process('sync-7');
    expect(mock.requests.length).toBe(before);
  });

  it('السجلات لا تحمل الرمز ولا بيانات الطلب', () => {
    expect(logs.join('\n')).not.toContain(mock.token);
    expect(logs.join('\n')).not.toMatch(/الرياض|عقار \d/);
  });
});
