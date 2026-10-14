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

const Q = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  idempotencyKey: 'lawha-11111111-1111-4111-8111-111111111111',
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
    14: { type: 'FILE_UPLOAD', files: [{ id: 'img-1', kind: 'PNG', size: 100 }] },
    15: { type: 'FILE_UPLOAD', files: [{ id: 'vid-1', kind: 'MP4', size: 200 }] },
  };
  return Object.entries({ ...base, ...overrides }).map(([n, a]) => ({
    logicalId: Q(Number(n)),
    title: `سؤال ${n}`,
    type: 'SHORT_TEXT',
    ...a,
  }));
}

describe('buildFlowmaxRequest — تحويل الإجابات إلى حقول Flowmax', () => {
  it('عرض مكتمل ⇒ مسودة عقار بالهللة ورمز المنصة، والمشاركة بلا بيانات المالك', () => {
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
      platform_code: ctx.idempotencyKey,
      currency: 'SAR',
    });
    expect(r.media).toEqual({ images: ['img-1'], videos: ['vid-1'] });
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

  it('الطلب يحتاج جوالًا صالحًا وموافقة، ويحمل مفتاح منع التكرار', () => {
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
      idempotency_key: ctx.idempotencyKey,
      requester_phone: '+966551234567',
      budget_max_halalas: 85_000_000,
      consent_version: '2026-10',
      criteria: { area_sqm: 145.5, bedrooms_count: 3, bathrooms_count: 2 },
    });
    expect(String(ok.body.intake_consent_evidence)).toContain(ctx.referenceCode);
    expect(ok.media).toEqual({ images: [], videos: [] });

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

  it('يرسل الرمز في Authorization فقط ويعيد data', async () => {
    const data = await client().json<{ id: number }>(
      'POST',
      '/api/admin/properties',
      { title_ar: 'أ', city: 'ب', platform_code: 'k' },
      'k',
    );
    expect(data.id).toBeGreaterThan(0);
    const last = mock.requests.at(-1)!;
    expect(last.auth).toBe(`Bearer ${mock.token}`);
    expect(last.idempotencyKey).toBe('k');
    expect(last.path).not.toContain(mock.token);
  });

  it('رفض الرمز ⇒ خطأ مؤكد (غير ملتبس) بوصف لا يحمل الرمز', async () => {
    const error = await client({ token: 'wrong-token-wrong-token-1234' })
      .json('GET', '/api/admin/properties')
      .catch((e: FlowmaxError) => e);
    expect(error).toBeInstanceOf(FlowmaxError);
    expect((error as FlowmaxError).uncertain).toBe(false);
    expect((error as FlowmaxError).describe()).toBe('رفض Flowmax صلاحية حساب التكامل (401).');
    expect(String((error as Error).message)).not.toContain('wrong-token');
  });

  it('422 ⇒ أسماء الحقول فقط، والمهلة والخطأ 500 ⇒ نتيجة ملتبسة', async () => {
    mock.failNext.push({ match: /POST \/api\/admin\/properties$/, mode: 'http422' });
    const e422 = (await client()
      .json('POST', '/api/admin/properties', {})
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(e422.fields).toEqual(['developer_id']);
    expect(e422.describe()).toBe('رفض Flowmax الحقول: developer_id.');
    expect(e422.uncertain).toBe(false);

    mock.failNext.push({ match: /POST \/api\/admin\/properties$/, mode: 'hang' });
    const timeout = (await client({ timeoutMs: 1000 })
      .json('POST', '/api/admin/properties', {})
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(timeout.failure).toBe('timeout');
    expect(timeout.uncertain).toBe(true);

    mock.failNext.push({ match: /POST \/api\/admin\/properties$/, mode: 'http500' });
    const e500 = (await client()
      .json('POST', '/api/admin/properties', {})
      .catch((e: unknown) => e)) as FlowmaxError;
    expect(e500.uncertain).toBe(true);
  });

  it('يرفع الوسائط multipart بالتدفق باسم مولّد', async () => {
    const created = await client().json<{ id: number }>('POST', '/api/admin/properties', {
      title_ar: 'وسائط',
      city: 'جدة',
    });
    const content = Buffer.alloc(4096, 7);
    await client().upload(`/api/admin/properties/${created.id}/videos`, {
      field: 'video',
      filename: 'media-1.mp4',
      mime: 'video/mp4',
      size: content.length,
      stream: Readable.from([content]),
    });
    const req = mock.requests.at(-1)!;
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.body.toString('latin1')).toContain('filename="media-1.mp4"');
    expect(req.body.length).toBeGreaterThan(content.length);
    expect(mock.properties.find((p) => p.id === created.id)!.videos).toBe(1);
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

describe('FlowmaxService.process — إرسال حتمي دون تكرار', () => {
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

  const env = (autoPublish = false) =>
    ({
      FLOWMAX_ENABLED: true,
      FLOWMAX_PUBLIC_SITE_URL: 'https://flowmax.example/',
      FLOWMAX_AUTO_PUBLISH: autoPublish,
    }) as AppEnv;
  const client = (timeoutMs = 2000) =>
    new FlowmaxClient({ baseUrl: mock.url, token: mock.token, timeoutMs, mediaTimeoutMs: 2000 });

  function newSync(n: number, operation: 'OFFER' | 'REQUEST' = 'OFFER'): FlowmaxSync {
    const key = `lawha-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    return {
      id: `sync-${n}`,
      responseId: `resp-${n}`,
      formId: 'form-1',
      operation,
      status: 'PENDING',
      idempotencyKey: key,
      payload:
        operation === 'OFFER'
          ? { title_ar: `عقار ${n}`, city: 'الرياض', platform_code: key }
          : { idempotency_key: key, city: 'الرياض' },
      share: { title: `عقار ${n}` },
      media: { images: ['img-1', 'img-big'], videos: ['vid-1'], sent: [], skipped: [] },
      flowmaxId: null,
      flowmaxRef: null,
      flowmaxUrl: null,
      createUncertain: false,
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

  const files = {
    'img-1': { kind: 'PNG', sizeBytes: 1000 },
    'img-big': { kind: 'JPG', sizeBytes: 11 * 1024 * 1024 }, // أكبر من حد Flowmax للصور ⇒ يُتخطى
    'vid-1': { kind: 'MP4', sizeBytes: 2000 },
  };

  function service(sync: FlowmaxSync, opts: { autoPublish?: boolean; timeoutMs?: number } = {}) {
    const prisma = fakePrisma(sync, files);
    const storage = { openRead: (key: string) => Readable.from([Buffer.alloc(Number(key))]) };
    const svc = new FlowmaxService(
      prisma as never,
      {} as never,
      env(opts.autoPublish),
      storage as never,
      client(opts.timeoutMs),
    );
    return { svc, row: () => prisma.rows.get(sync.id)! };
  }

  it('ينشئ العقار ويرفع الصور والفيديو ويحفظ الرابط', async () => {
    const { svc, row } = service(newSync(1), { autoPublish: true });
    await svc.process('sync-1');
    const r = row();
    expect(r.status).toBe('SENT');
    expect(r.flowmaxUrl).toBe(`https://flowmax.example/property/${r.flowmaxId}`);
    expect(r.publishedAt).toBeInstanceOf(Date);
    expect(r.media).toMatchObject({ sent: ['img-1', 'vid-1'], skipped: ['img-big'] });
    const p = mock.properties.find((x) => String(x.id) === r.flowmaxId)!;
    expect(p).toMatchObject({ images: 1, videos: 1, status: 'Published' });
  });

  it('ضياع رد الإنشاء ثم إعادة المحاولة ⇒ يجد العقار بمرجعه ولا ينشئ ثانيًا', async () => {
    const sync = newSync(2);
    const { svc, row } = service(sync);
    mock.failNext.push({ match: /POST \/api\/admin\/properties$/, mode: 'drop-after-create' });
    await svc.process('sync-2');
    expect(row()).toMatchObject({ status: 'FAILED', createUncertain: true, flowmaxId: null });
    expect(row().lastError).toBe('تعذر الاتصال بـ Flowmax.');
    expect(mock.properties.filter((p) => p.platform_code === sync.idempotencyKey)).toHaveLength(1);

    row().status = 'PENDING'; // ما يفعله retry()
    await svc.process('sync-2');
    expect(row().status).toBe('SENT');
    expect(row().attempts).toBe(2);
    expect(mock.properties.filter((p) => p.platform_code === sync.idempotencyKey)).toHaveLength(1);
  });

  it('فشل الوسائط بعد الإنشاء ⇒ إعادة المحاولة تكمل دون عقار ثانٍ ودون إعادة ما أُرسل', async () => {
    const sync = newSync(3);
    const { svc, row } = service(sync);
    mock.failNext.push({ match: /\/videos$/, mode: 'http500' });
    await svc.process('sync-3');
    expect(row()).toMatchObject({ status: 'FAILED', lastError: 'خطأ من Flowmax (500).' });
    expect(row().flowmaxId).not.toBeNull();
    const before = mock.requests.filter((r) => r.path.endsWith('/images')).length;
    row().status = 'PENDING';
    await svc.process('sync-3');
    expect(row().status).toBe('SENT');
    expect(mock.requests.filter((r) => r.path.endsWith('/images')).length).toBe(before);
    expect(mock.properties.filter((p) => p.platform_code === sync.idempotencyKey)).toHaveLength(1);
  });

  it('الرفض المؤكد (422) لا يُعلَّم ملتبسًا ويحفظ خطأً مختصرًا', async () => {
    const { svc, row } = service(newSync(4));
    mock.failNext.push({ match: /POST \/api\/admin\/properties$/, mode: 'http422' });
    await svc.process('sync-4');
    expect(row()).toMatchObject({
      status: 'FAILED',
      createUncertain: false,
      lastError: 'رفض Flowmax الحقول: developer_id.',
    });
  });

  it('الطلب يُرسل بمفتاح منع التكرار؛ التكرار يعيد الطلب نفسه', async () => {
    const a = service(newSync(5, 'REQUEST'));
    await a.svc.process('sync-5');
    const b = service(newSync(5, 'REQUEST'));
    await b.svc.process('sync-5');
    expect(a.row().flowmaxRef).toBe(b.row().flowmaxRef);
    expect(a.row().flowmaxUrl).toBe(
      `https://flowmax.example/properties/demands/${a.row().flowmaxRef}`,
    );
    expect(mock.demands.size).toBe(1);
  });

  it('لا يُعاد حجز إرسال جارٍ أو مكتمل', async () => {
    const sync = newSync(6);
    sync.status = 'SENT';
    const { svc } = service(sync);
    const count = mock.requests.length;
    await svc.process('sync-6');
    expect(mock.requests.length).toBe(count);
  });

  it('السجلات لا تحمل الرمز ولا بيانات الطلب', () => {
    expect(logs.join('\n')).not.toContain(mock.token);
    expect(logs.join('\n')).not.toMatch(/الرياض|عقار \d/);
  });
});
