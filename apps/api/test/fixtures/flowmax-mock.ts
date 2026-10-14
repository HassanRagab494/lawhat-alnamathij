import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * خادم Flowmax وهمي محلي (127.0.0.1 بمنفذ عشوائي) يحاكي نقاط التكامل المضافة في Flowmax
 * (/api/admin/integrations/forms/*، انظر FormsIntegrationController هناك): مفتاح مصدر فريد لكل سجل
 * ولكل مرفق، إعادة السجل نفسه عند التكرار، و409 لمحتوى مختلف بالمفتاح نفسه، وقواعد نشر مبسطة.
 * لا يتصل بأي Flowmax حقيقي.
 */
export interface MockRequest {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

interface Intake {
  operation: string;
  hash: string;
  targetId: number;
}

export interface MockProperty {
  id: number;
  sourceKey: string;
  title_ar: string;
  status: 'Draft' | 'Published';
  images: number;
  videos: number;
  payload: Record<string, unknown>;
}

export interface MockDemand {
  id: number;
  sourceKey: string;
  reference: string;
  status: string;
  payload: Record<string, unknown>;
}

type Fault = 'http500' | 'http422' | 'hang' | 'drop-after-create';

export interface MockFlowmax {
  url: string;
  token: string;
  requests: MockRequest[];
  properties: MockProperty[];
  demands: MockDemand[];
  intakes: Map<string, Intake>;
  /** أعطال قادمة حسب «الطريقة المسار» (أول عنصر مطابق يُستهلك). */
  failNext: { match: RegExp; mode: Fault }[];
  /** محاكاة نشر الطلب من مراجعة Flowmax. */
  publishDemand(reference: string): void;
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

/** تحليل multipart بسيط: حقول نصية وملف واحد باسم file. */
function multipart(body: Buffer, contentType: string) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  const fields: Record<string, string> = {};
  let file: { contentType: string; data: Buffer } | null = null;
  if (!boundary) return { fields, file };
  const sep = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(sep);
  while (pos >= 0) {
    const next = body.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = body.subarray(pos + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString('utf8');
    const data = part.subarray(headEnd + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? '';
    if (/filename=/.test(head)) {
      file = { contentType: /Content-Type: (.+)/i.exec(head)?.[1]?.trim() ?? '', data };
    } else {
      fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, file };
}

export async function startMockFlowmax(
  token = 'test-integration-token-0123456789',
): Promise<MockFlowmax> {
  const state = {
    token,
    requests: [] as MockRequest[],
    properties: [] as MockProperty[],
    demands: [] as MockDemand[],
    intakes: new Map<string, Intake>(),
    failNext: [] as { match: RegExp; mode: Fault }[],
  };
  let nextId = 1000;
  const site = 'https://flowmax.test';

  const offerRecord = (p: MockProperty, replayed: boolean) => ({
    source_key: p.sourceKey,
    operation: 'offer',
    id: p.id,
    reference: `M-${p.id}`,
    status: p.status,
    is_public: p.status === 'Published',
    detail_url: `${site}/property/${p.id}`,
    images_count: p.images,
    videos_count: p.videos,
    replayed,
  });
  const demandRecord = (d: MockDemand, replayed: boolean) => ({
    source_key: d.sourceKey,
    operation: 'demand',
    id: d.id,
    reference: d.reference,
    status: d.status,
    is_public: d.status === 'published',
    detail_url: `${site}/properties/demands/${d.reference}`,
    replayed,
  });

  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '';
    state.requests.push({
      method: req.method ?? '',
      path,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
      body,
    });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const fail = (status: number, code: string, details?: unknown) =>
      send(status, { success: false, error: { code, message: code, details } });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return fail(401, 'unauthenticated');
    }
    const faultAt = state.failNext.findIndex((f) => f.match.test(`${req.method} ${path}`));
    let dropAfter = false;
    if (faultAt >= 0) {
      const [f] = state.failNext.splice(faultAt, 1);
      if (f!.mode === 'http500') return fail(500, 'server_error');
      if (f!.mode === 'http422') {
        return fail(422, 'validation_error', {
          developer_id: ['The selected developer id is invalid.'],
        });
      }
      if (f!.mode === 'hang') return; // لا رد ⇒ مهلة عند العميل
      dropAfter = true;
    }
    const reply = (status: number, data: unknown) =>
      dropAfter ? req.socket.destroy() : send(status, { success: true, data });

    /** يطالب بالمفتاح: يعيد السجل الموجود، أو 409 لمحتوى مختلف، أو ينشئ عبر create. */
    const claim = (key: string, operation: string, hash: string, create: () => number) => {
      const found = state.intakes.get(key);
      if (found && (found.operation !== operation || found.hash !== hash))
        return 'conflict' as const;
      if (found) return { id: found.targetId, replayed: true };
      const id = create();
      state.intakes.set(key, { operation, hash, targetId: id });
      return { id, replayed: false };
    };

    const base = '/api/admin/integrations/forms';
    const url = new URL(path, 'http://mock');
    if (
      req.method === 'POST' &&
      (url.pathname === `${base}/offers` || url.pathname === `${base}/demands`)
    ) {
      const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const key = String(payload.source_key ?? '');
      const { source_key: _k, ...content } = payload;
      const offer = url.pathname.endsWith('/offers');
      const result = claim(key, offer ? 'offer' : 'demand', sha(JSON.stringify(content)), () => {
        const id = nextId++;
        if (offer) {
          state.properties.push({
            id,
            sourceKey: key,
            title_ar: String(content.title_ar ?? ''),
            status: 'Draft',
            images: 0,
            videos: 0,
            payload: content,
          });
        } else {
          state.demands.push({
            id,
            sourceKey: key,
            reference: `PD${id}`,
            status: 'under_review',
            payload: content,
          });
        }
        return id;
      });
      if (result === 'conflict') return fail(409, 'integration_key_conflict');
      const record = offer
        ? offerRecord(
            state.properties.find((p) => p.id === result.id)!,
            result.replayed,
          )
        : demandRecord(
            state.demands.find((d) => d.id === result.id)!,
            result.replayed,
          );
      return reply(result.replayed ? 200 : 201, record);
    }
    const media = new RegExp(`^${base}/offers/([^/]+)/media$`).exec(url.pathname);
    if (req.method === 'POST' && media) {
      const offerKey = decodeURIComponent(media[1]!);
      const offer = state.intakes.get(offerKey);
      const property = offer && state.properties.find((p) => p.id === offer.targetId);
      if (!property) return fail(404, 'not_found');
      const { fields, file } = multipart(body, req.headers['content-type'] ?? '');
      if (!file || !fields.media_key || !['image', 'video'].includes(fields.kind ?? '')) {
        return fail(422, 'validation_error', { file: ['required'] });
      }
      const expected = fields.kind === 'image' ? /^image\// : /^video\//;
      if (!expected.test(file.contentType)) return fail(422, 'invalid_media', { file: ['type'] });
      const result = claim(
        fields.media_key,
        `offer_${fields.kind}`,
        sha(`${offer.targetId}|${fields.kind}|${sha(file.data)}`),
        () => {
          if (fields.kind === 'image') property.images++;
          else property.videos++;
          return nextId++;
        },
      );
      if (result === 'conflict') return fail(409, 'integration_key_conflict');
      return reply(result.replayed ? 200 : 201, {
        media_key: fields.media_key,
        operation: `offer_${fields.kind}`,
        id: result.id,
        replayed: result.replayed,
      });
    }
    const publish = new RegExp(`^${base}/offers/([^/]+)/publish$`).exec(url.pathname);
    if (req.method === 'POST' && publish) {
      const offer = state.intakes.get(decodeURIComponent(publish[1]!));
      const property = offer && state.properties.find((p) => p.id === offer.targetId);
      if (!property) return fail(404, 'not_found');
      if (property.images < 1) {
        return fail(422, 'property_publish_requirements_not_met', {
          missing: { images: { required: 1 } },
        });
      }
      property.status = 'Published';
      return reply(200, offerRecord(property, false));
    }
    const record = new RegExp(`^${base}/records/([^/]+)$`).exec(url.pathname);
    if (req.method === 'GET' && record) {
      const intake = state.intakes.get(decodeURIComponent(record[1]!));
      if (!intake) return fail(404, 'not_found');
      if (intake.operation === 'offer') {
        return send(200, {
          success: true,
          data: offerRecord(
            state.properties.find((p) => p.id === intake.targetId)!,
            false,
          ),
        });
      }
      return send(200, {
        success: true,
        data: demandRecord(
          state.demands.find((d) => d.id === intake.targetId)!,
          false,
        ),
      });
    }
    return fail(404, 'not_found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    publishDemand(reference: string) {
      const d = state.demands.find((x) => x.reference === reference);
      if (d) d.status = 'published';
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
