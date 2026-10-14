import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * خادم Flowmax وهمي محلي للاختبارات فقط (127.0.0.1 بمنفذ عشوائي): لا يتصل بأي Flowmax حقيقي.
 * يحاكي إنشاء مسودة العقار والبحث برمز المنصة ورفع الصور والفيديو والنشر وإنشاء الطلب بمفتاح منع التكرار.
 */
export interface MockRequest {
  method: string;
  path: string;
  auth: string | undefined;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

export interface MockFlowmax {
  url: string;
  token: string;
  requests: MockRequest[];
  properties: {
    id: number;
    property_code: string;
    platform_code: string;
    title_ar: string;
    city: string;
    images: number;
    videos: number;
    status: string;
  }[];
  demands: Map<string, { id: number; reference: string }>;
  /** أعطال قادمة حسب المسار (أول عنصر يُستهلك عند كل طلب مطابق). */
  failNext: { match: RegExp; mode: 'http500' | 'http422' | 'hang' | 'drop-after-create' }[];
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export async function startMockFlowmax(
  token = 'test-integration-token-0123456789',
): Promise<MockFlowmax> {
  const state: Omit<MockFlowmax, 'url' | 'close'> = {
    token,
    requests: [],
    properties: [],
    demands: new Map(),
    failNext: [],
  };
  let nextId = 1000;
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '';
    state.requests.push({
      method: req.method ?? '',
      path,
      auth: req.headers.authorization,
      idempotencyKey: req.headers['idempotency-key'] as string | undefined,
      contentType: req.headers['content-type'],
      body,
    });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { message: 'Unauthenticated.' });
    const fault = state.failNext.findIndex((f) => f.match.test(`${req.method} ${path}`));
    let dropAfterCreate = false;
    if (fault >= 0) {
      const [f] = state.failNext.splice(fault, 1);
      if (f!.mode === 'http500') return send(500, { message: 'Server Error' });
      if (f!.mode === 'http422') {
        return send(422, {
          message: 'invalid',
          errors: { developer_id: ['The selected developer id is invalid.'] },
        });
      }
      if (f!.mode === 'hang') return; // لا رد ⇒ مهلة عند العميل
      dropAfterCreate = true;
    }
    const url = new URL(path, 'http://mock');
    if (req.method === 'POST' && url.pathname === '/api/admin/properties') {
      const p = JSON.parse(body.toString('utf8')) as Record<string, string>;
      const id = nextId++;
      state.properties.push({
        id,
        property_code: `M-${id}`,
        platform_code: p.platform_code ?? '',
        title_ar: p.title_ar ?? '',
        city: p.city ?? '',
        images: 0,
        videos: 0,
        status: 'Draft',
      });
      if (dropAfterCreate) return req.socket.destroy(); // أُنشئ العقار وضاع الرد
      return send(201, {
        success: true,
        data: { id, property_code: `M-${id}`, platform_code: p.platform_code },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/properties') {
      const search = url.searchParams.get('search') ?? '';
      const data = state.properties.filter((p) => p.title_ar.includes(search));
      return send(200, { success: true, data, meta: { total: data.length } });
    }
    const media = /^\/api\/admin\/properties\/(\d+)\/(images|videos)$/.exec(url.pathname);
    if (req.method === 'POST' && media) {
      const p = state.properties.find((x) => x.id === Number(media[1]));
      if (!p) return send(404, { message: 'Not found' });
      if (!/multipart\/form-data; boundary=/.test(req.headers['content-type'] ?? '')) {
        return send(422, { errors: { [media[2] === 'images' ? 'image' : 'video']: ['required'] } });
      }
      if (media[2] === 'images') p.images++;
      else p.videos++;
      return send(201, { success: true, data: { id: nextId++, property_id: p.id } });
    }
    const publish = /^\/api\/admin\/properties\/(\d+)\/publish$/.exec(url.pathname);
    if (req.method === 'POST' && publish) {
      const p = state.properties.find((x) => x.id === Number(publish[1]));
      if (!p) return send(404, { message: 'Not found' });
      p.status = 'Published';
      return send(200, { success: true, data: { id: p.id, status: p.status } });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/property-demands') {
      const d = JSON.parse(body.toString('utf8')) as Record<string, string>;
      const key = d.idempotency_key ?? '';
      let demand = state.demands.get(key);
      if (!demand) {
        const id = nextId++;
        demand = { id, reference: `PD-${id}` };
        state.demands.set(key, demand);
      }
      return send(201, { success: true, data: { id: demand.id, reference: demand.reference } });
    }
    return send(404, { message: 'Not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
