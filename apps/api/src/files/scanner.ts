import { createReadStream } from 'node:fs';
import { connect, type Socket } from 'node:net';

/**
 * فحص البرمجيات الخبيثة خلف واجهة قابلة للاستبدال. التنفيذ الحالي: clamd (ClamAV) عبر TCP وأمر INSTREAM.
 * أي تعطل أو انتهاء مهلة يرمي ScanUnavailable، ولا يُعامل الملف أبدًا كسليم دون نتيجة فحص صريحة.
 */
export type ScanResult = { clean: true; engine: string } | { clean: false; signature: string };

export interface MalwareScanner {
  scanFile(path: string): Promise<ScanResult>;
}

export class ScanUnavailable extends Error {}

const CHUNK = 64 * 1024;

export class ClamdScanner implements MalwareScanner {
  private engine: string | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  private command(write: (socket: Socket) => Promise<void>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(new ScanUnavailable(error.message));
        else resolve(value!);
      };
      const timer = setTimeout(() => finish(new Error('scan timeout')), this.timeoutMs);
      socket.on('error', (e) => finish(e));
      socket.on('data', (d) => {
        chunks.push(d);
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('\0')) finish(null, text.slice(0, text.indexOf('\0')).trim());
      });
      socket.on('end', () =>
        finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()),
      );
      socket.on('connect', () => {
        write(socket).catch((e: Error) => finish(e));
      });
    });
  }

  private async version(): Promise<string> {
    if (!this.engine) {
      const v = await this.command(async (s) => {
        s.write('zVERSION\0');
      });
      if (!v) throw new ScanUnavailable('empty version');
      this.engine = v.slice(0, 120);
    }
    return this.engine;
  }

  async scanFile(path: string): Promise<ScanResult> {
    const engine = await this.version();
    const reply = await this.command(async (socket) => {
      socket.write('zINSTREAM\0');
      for await (const chunk of createReadStream(path, { highWaterMark: CHUNK })) {
        const buf = chunk as Buffer;
        const len = Buffer.alloc(4);
        len.writeUInt32BE(buf.length, 0);
        if (!socket.write(Buffer.concat([len, buf]))) {
          await new Promise<void>((r) => socket.once('drain', () => r()));
        }
      }
      socket.write(Buffer.alloc(4)); // طول صفري: نهاية التدفق
    });
    // الردود: "stream: OK" أو "stream: <signature> FOUND" أو "... ERROR"
    if (/:\s*OK$/.test(reply)) return { clean: true, engine };
    const found = /:\s*(.+)\s+FOUND$/.exec(reply);
    if (found) return { clean: false, signature: found[1]!.slice(0, 200) };
    throw new ScanUnavailable(`unexpected reply: ${reply.slice(0, 120)}`);
  }
}

/** يُستخدم حين لا يوجد فاحص مضبوط: يرفض دائمًا، فلا يُقبل أي ملف دون فحص. */
export class UnavailableScanner implements MalwareScanner {
  async scanFile(): Promise<ScanResult> {
    throw new ScanUnavailable('scanner not configured');
  }
}

/** قيمة scan_engine للملفات المقبولة دون فحص برمجيات خبيثة (UPLOAD_SCAN_MODE=disabled). */
export const NOT_SCANNED_ENGINE = 'not-scanned:UPLOAD_SCAN_MODE=disabled';

/**
 * وضع تشغيل صريح دون فحص برمجيات خبيثة (UPLOAD_SCAN_MODE=disabled). لا يفحص شيئًا:
 * الملف يُقبل بعد التحقق من النوع الفعلي والحجم فقط، ويُعلَّم «غير مفحوص» في القاعدة والواجهة.
 */
export class DisabledScanner implements MalwareScanner {
  async scanFile(): Promise<ScanResult> {
    return { clean: true, engine: NOT_SCANNED_ENGINE };
  }
}
