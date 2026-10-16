import { Logger } from '@nestjs/common';
import type { FlowmaxSync } from '@prisma/client';
import { Readable } from 'node:stream';
import { startMockFlowmax, type MockFlowmax } from '../../../test/fixtures/flowmax-mock';
import type { AppEnv } from '../../config/env';
import {
  buildAutoRequest,
  detectField,
  detectFields,
  extractPhone,
  splitLocation,
} from './auto-property';
import { FlowmaxClient, FlowmaxError } from './client';
import { normalizeArabic } from './fields';
import { FlowmaxService } from './flowmax.service';
import { normalizePhone, type AnswerInput } from './mapping';
import { incompatibleMedia } from './media';

const ctx = {
  referenceCode: 'K7Q2-ABCD-EFGH',
  submittedAt: new Date('2026-10-14T10:00:00Z'),
  approvedAt: new Date('2026-10-15T21:30:00Z'), // 16 أكتوبر بتوقيت الرياض
  developerId: 7,
};

let seq = 0;
const ans = (title: string, value: Partial<AnswerInput> = {}): AnswerInput => ({
  logicalId: `q-${++seq}`,
  title,
  type: 'SHORT_TEXT',
  ...value,
});
const text = (title: string, t: string) => ans(title, { text: t });
const choice = (title: string, c: string) => ans(title, { type: 'SINGLE_CHOICE', choices: [c] });
const num = (title: string, n: string) => ans(title, { type: 'NUMBER', number: n });

/** نموذج عرض بعناوين متنوعة كما يكتبها الناس. */
function offerAnswers(over: Record<string, AnswerInput | null> = {}): AnswerInput[] {
  const base: Record<string, AnswerInput> = {
    name: text('الاسم', 'سارة المالكة'),
    role: choice('الصفة', 'مالك'),
    op: choice('نوع العملية', 'بيع'),
    category: choice('نوع العقار', 'شقة'),
    location: text('المدينة / الحي', 'الرياض / النرجس'),
    area: text('مساحة العقار بالمتر', '145.5 م²'),
    price: num('السعر', '850000'),
    rooms: num('عدد الغرف', '3'),
    baths: text('الحمامات', '٢'),
    contact: text('وسيلة التواصل', 'واتساب 0551234567'),
    media: ans('صور وفيديو العقار', {
      type: 'FILE_UPLOAD',
      files: [
        { id: 'img-1', name: 'واجهة.png', kind: 'PNG', size: 100 },
        { id: 'vid-1', name: 'جولة.mp4', kind: 'MP4', size: 200 },
      ],
    }),
  };
  return Object.entries({ ...base, ...over })
    .filter(([, v]) => v)
    .map(([, v]) => v!);
}

describe('تطبيع عناوين الأسئلة العربية', () => {
  it('يزيل التشكيل ويوحّد الهمزات والياء والتاء المربوطة ويتجاهل المسافات والشرطات والرموز', () => {
    expect(normalizeArabic('المَدِينَة / الحَيّ')).toBe(normalizeArabic('المدينه-الحي'));
    expect(normalizeArabic('إيجار')).toBe(normalizeArabic('ايجار'));
    expect(normalizeArabic('مبنى')).toBe(normalizeArabic('مبني'));
    expect(normalizeArabic('مسؤول')).toBe(normalizeArabic('مسوول'));
    expect(normalizeArabic('  نوع   العقار؟ ')).toBe('نوعالعقار');
    expect(normalizeArabic('المساحة (م²)')).toBe(normalizeArabic('المساحة م2'));
  });
});

describe('التعرّف التلقائي على الحقول من العناوين', () => {
  it.each([
    ['الاسم', 'contact_name'],
    ['اسم المالك', 'contact_name'],
    ['الصفة', 'contact_role'],
    ['وصف العقار', 'description'],
    ['المدينة', 'city'],
    ['الحي', 'district'],
    ['المدينة / الحي', 'location'],
    ['موقع العقار', 'location'],
    ['نوع العقار', 'category'],
    ['نوع العملية', 'operation'],
    ['نوع الطلب', 'operation'],
    ['مساحة العقار بالمتر', 'area'],
    ['السعر المطلوب', 'price'],
    ['الميزانية', 'budget'],
    ['عدد الغرف', 'bedrooms'],
    ['دورات المياه', 'bathrooms'],
    ['عدد الوحدات', 'units'],
    ['رقم التواصل', 'phone'],
    ['وسيلة التواصل', 'phone'],
    ['الموافقة على التواصل', 'consent'],
  ])('«%s» ⇒ %s', (title, field) => {
    expect(detectField(title, false)).toBe(field);
  });

  it('أسئلة الملفات: الصور والفيديوهات فقط، وغيرها لا يُرسل', () => {
    expect(detectField('صور العقار', true)).toBe('media');
    expect(detectField('الصور والفيديوهات', true)).toBe('media');
    expect(detectField('صورة الصك', true)).toBeNull();
    expect(detectField('الصور', false)).toBeNull();
  });

  it('يكتشف كل حقول النموذج دون أي إعداد', () => {
    const d = detectFields(offerAnswers());
    expect(Object.keys(d).sort()).toEqual(
      [
        'area',
        'bathrooms',
        'bedrooms',
        'category',
        'contact_name',
        'contact_role',
        'location',
        'media',
        'operation',
        'phone',
        'price',
      ].sort(),
    );
  });

  it('splitLocation وextractPhone', () => {
    expect(splitLocation('الرياض / النرجس')).toEqual(['الرياض', 'النرجس']);
    expect(splitLocation('جدة - حي الشاطئ')).toEqual(['جدة', 'الشاطئ']);
    expect(splitLocation('الدمام، الفيصلية')).toEqual(['الدمام', 'الفيصلية']);
    expect(extractPhone('واتساب ٠٥٥١٢٣٤٥٦٧')).toBe('+966551234567');
    expect(extractPhone('اتصل على 055 123 4567')).toBe('+966551234567');
    expect(extractPhone('بالبريد')).toBeNull();
    expect(normalizePhone('00971501234567')).toBe('+971501234567');
  });

  it.each(['بيع', 'ايجار', 'طلب شراء'])('يميّز سؤالين بعنوان نوع العقار عند اختيار %s', (value) => {
    const category = choice('نوع العقار', 'شقه');
    const operation = choice('نوع العقار', value);
    for (const answers of [
      [category, operation],
      [operation, category],
    ]) {
      const detected = detectFields(answers);
      expect(detected.category).toEqual([category]);
      expect(detected.operation).toEqual([operation]);
    }
  });

  it('لا يستنتج عملية من نص حر أو سؤال غير متعلق أو اختيارات مختلطة', () => {
    expect(detectFields([text('نوع العقار', 'بيع')]).operation).toBeUndefined();
    expect(detectFields([choice('الصفة', 'بيع')]).operation).toBeUndefined();
    expect(
      detectFields([ans('نوع العقار', { choices: ['بيع', 'شقة'] })]).operation,
    ).toBeUndefined();
  });
});

describe('buildAutoRequest — من الرد إلى Flowmax تلقائيًا', () => {
  it('ينشئ عرضًا من سؤالَي نوع العقار دون ربط يدوي أو تغيير العنوان', () => {
    const result = buildAutoRequest(offerAnswers({ op: choice('نوع العقار', 'بيع') }), ctx);
    expect(result.problems).toEqual([]);
    expect(result.operation).toBe('OFFER');
    expect(result.body).toMatchObject({ property_category: 'apartment', listing_purpose: 'sale' });
  });
  it('عرض مكتمل ⇒ عقار بقيم الخادم الثابتة، والمشاركة بلا بيانات المالك', () => {
    const r = buildAutoRequest(offerAnswers(), ctx);
    expect(r.problems).toEqual([]);
    expect(r.operation).toBe('OFFER');
    expect(r.body).toMatchObject({
      title_ar: 'شقة للبيع في الرياض — النرجس',
      property_category: 'apartment',
      listing_purpose: 'sale',
      city: 'الرياض',
      district: 'النرجس',
      requested_price: 85_000_000,
      area_sqm: 145.5,
      bedrooms_count: 3,
      bathrooms_count: 2,
      contact_phone: '+966551234567',
      developer_id: 7,
      type_letter: 'M',
      mediation_contract_number: 'LAWHA-K7Q2-ABCD-EFGH',
      contract_day: '16',
      contract_month: '10',
      currency: 'SAR',
    });
    expect(String(r.body.description_ar)).toContain('المساحة 145.5 م²');
    expect(String(r.body.listing_notes)).toContain('الصفة: مالك');
    expect(r.body).not.toHaveProperty('fal_license_number'); // يملؤه Flowmax من المطور الداخلي
    expect(r.media.map((m) => [m.fileId, m.role])).toEqual([
      ['img-1', 'image'],
      ['vid-1', 'video'],
    ]);
    expect(JSON.stringify(r.share)).not.toMatch(/سارة|0551234567|966551234567/);
    expect(r.share).toMatchObject({
      category: 'شقة',
      purpose: 'بيع',
      city: 'الرياض',
      district: 'النرجس',
      priceSar: '850000',
      areaSqm: 145.5,
      bedrooms: 3,
      bathrooms: 2,
    });
  });

  it('عناوين بديلة: «موقع العقار» و«نوع الطلب» و«رقم التواصل» و«عنوان العقار» و«وصف العقار»', () => {
    const r = buildAutoRequest(
      [
        choice('نوع الطلب', 'إيجار'),
        choice('نوع العقار', 'فيلا'),
        text('عنوان العقار', 'فيلا مودرن'),
        text('وصف العقار', 'تشطيب فاخر'),
        text('موقع العقار', 'جدة - حي الشاطئ'),
        num('المساحة', '420'),
        num('عدد الغرف', '6'),
        num('قيمة الإيجار', '120000'),
        text('رقم التواصل', '0500000098'),
      ],
      ctx,
    );
    expect(r.problems).toEqual([]);
    expect(r.body).toMatchObject({
      title_ar: 'فيلا مودرن',
      description_ar: 'تشطيب فاخر',
      listing_purpose: 'rent',
      property_category: 'villa',
      city: 'جدة',
      district: 'الشاطئ',
      requested_price: 12_000_000,
    });
  });

  it('رد ناقص ⇒ يمنع الاعتماد ويذكر كل حقل ناقص بالعربية', () => {
    const r = buildAutoRequest(
      offerAnswers({ location: text('المدينة', 'الرياض'), price: null }),
      ctx,
    );
    expect(r.problems).toEqual([
      { field: 'district', message: '«الحي»: الإجابة مطلوبة.' },
      { field: 'price', message: '«السعر»: الإجابة مطلوبة.' },
    ]);
  });

  it('الحقول المطلوبة حسب نوع العقار', () => {
    const land = buildAutoRequest(
      offerAnswers({ category: choice('نوع العقار', 'أرض'), rooms: null, area: null }),
      ctx,
    );
    expect(land.problems.map((p) => p.field)).toEqual(['area']);
    const apt = buildAutoRequest(offerAnswers({ rooms: null }), ctx);
    expect(apt.problems).toEqual([{ field: 'bedrooms', message: '«عدد الغرف»: الإجابة مطلوبة.' }]);
    const building = buildAutoRequest(
      offerAnswers({ category: choice('نوع العقار', 'عمارة') }),
      ctx,
    );
    expect(building.problems).toEqual([
      { field: 'units', message: '«عدد الوحدات»: الإجابة مطلوبة.' },
    ]);
  });

  it('نوع العملية: غيابه أو قيمة غير معروفة يمنع الاعتماد', () => {
    expect(buildAutoRequest(offerAnswers({ op: null }), ctx).problems).toEqual([
      { field: 'operation', message: '«نوع العملية»: الإجابة مطلوبة.' },
    ]);
    expect(
      buildAutoRequest(offerAnswers({ op: choice('نوع العملية', 'هبة') }), ctx).problems[0]!
        .message,
    ).toContain('«هبة»');
  });

  it('المطور الداخلي من FLOWMAX_DEVELOPER_ID: غيابه يمنع اعتماد العرض', () => {
    expect(buildAutoRequest(offerAnswers(), { ...ctx, developerId: undefined }).problems).toEqual([
      {
        field: 'developer_id',
        message: 'المطور الداخلي في Flowmax غير مضبوط على الخادم (FLOWMAX_DEVELOPER_ID).',
      },
    ]);
  });

  it('طلب شراء ⇒ طلب عقار بالميزانية والجوال والموافقة، دون وسائط', () => {
    const r = buildAutoRequest(
      [
        text('الاسم', 'باحث تجريبي'),
        choice('نوع العملية', 'طلب شراء'),
        choice('نوع العقار', 'شقة'),
        text('المدينة', 'الرياض'),
        num('الميزانية', '900000'),
        num('عدد الغرف', '4'),
        text('رقم الجوال', '0551234567'),
        choice('الموافقة على التواصل', 'نعم، أوافق'),
      ],
      ctx,
    );
    expect(r.problems).toEqual([]);
    expect(r.operation).toBe('REQUEST');
    expect(r.body).toMatchObject({
      listing_purpose: 'sale',
      budget_max_halalas: 90_000_000,
      requester_phone: '+966551234567',
      requester_name: 'باحث تجريبي',
      criteria: { bedrooms_count: 4 },
    });
    expect(r.body).not.toHaveProperty('idempotency_key');
    expect(r.media).toEqual([]);
  });

  it('الطلب دون موافقة أو جوال صالح يُمنع', () => {
    const r = buildAutoRequest(
      [
        choice('نوع الطلب', 'طلب إيجار'),
        choice('نوع العقار', 'شقة'),
        text('المدينة', 'الرياض'),
        num('الميزانية', '50000'),
        text('رقم الجوال', '12'),
      ],
      ctx,
    );
    expect(r.problems.map((p) => p.field)).toEqual(['phone', 'consent']);
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

  it('ينشئ السجل وينقل كل مرفق ويحفظ معرّفه، ثم ينشر العرض ويحفظ الرابط', async () => {
    const { svc, row } = service(newSync(1));
    await svc.process('sync-1');
    const r = row();
    expect(r.status).toBe('SENT');
    expect(r.publishState).toBe('PUBLISHED');
    expect(r.isPublic).toBe(true);
    expect(r.detailUrl).toBe(`https://flowmax.test/property/${r.flowmaxId}`);
    const media = r.media as unknown as { status: string; externalId: string }[];
    expect(media.map((m) => m.status)).toEqual(['SENT', 'SENT']);
    expect(media.every((m) => m.externalId)).toBe(true);
    expect(mock.properties.find((p) => String(p.id) === r.flowmaxId)).toMatchObject({
      images: 1,
      videos: 1,
      status: 'Published',
    });
  });

  it('فشل النشر بعد الإنشاء: يبقى المعرّف والسبب، والسجل غير عام', async () => {
    const sync = newSync(8);
    sync.media = [{ fileId: 'vid-1', role: 'video', status: 'PENDING' }]; // لا صورة ⇒ متطلبات النشر ناقصة
    const { svc, row } = service(sync);
    await svc.process('sync-8');
    expect(row()).toMatchObject({
      status: 'SENT',
      publishState: 'FAILED',
      publishError: 'متطلبات النشر في Flowmax غير مكتملة: images.',
      isPublic: false,
    });
    expect(row().flowmaxId).toBeTruthy();
  });

  it('إعادة المحاولة تبحث بالمفتاح الفريد أولًا، ولا ترسل طلب إنشاء إن وُجد السجل', async () => {
    const sync = newSync(9);
    const first = service(sync);
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'drop-after-create' });
    await first.svc.process('sync-9');
    expect(first.row()).toMatchObject({ status: 'FAILED', flowmaxId: null });
    first.row().status = 'PENDING';
    const before = mock.requests.length;
    await first.svc.process('sync-9');
    const calls = mock.requests.slice(before).map((r) => `${r.method} ${r.path.split('?')[0]}`);
    expect(calls[0]).toBe(
      `GET /api/admin/integrations/forms/records/${encodeURIComponent(sync.sourceKey)}`,
    );
    expect(calls).not.toContain('POST /api/admin/integrations/forms/offers');
    expect(first.row().status).toBe('SENT');
    expect(count(sync.sourceKey)).toBe(1);
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
