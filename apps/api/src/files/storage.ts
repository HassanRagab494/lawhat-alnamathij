import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * تخزين الملفات خلف واجهة قابلة للاستبدال (مثلًا بتخزين متوافق مع S3 لاحقًا).
 * الملف يُكتب أولًا في منطقة مؤقتة محلية خاصة ليُفحص (النوع والبرمجيات الخبيثة) ثم يُثبَّت بمفتاح عشوائي.
 * المفاتيح لا تُشتق من أسماء المستخدمين أبدًا، فلا path traversal.
 */
export interface FileStorage {
  /** يكتب التدفق إلى ملف مؤقت ويقطع الكتابة إن تجاوز maxBytes؛ الجزء المكتوب يُحذف عند أي فشل. */
  writeTemp(source: Readable, maxBytes: number): Promise<TempFile>;
  /** ينقل الملف المؤقت إلى التخزين الدائم بمفتاح عشوائي جديد. */
  commit(temp: TempFile): Promise<string>;
  removeTemp(temp: TempFile): Promise<void>;
  openRead(key: string): Readable;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** يحذف الملفات المؤقتة الأقدم من olderThanMs (رفع مقطوع)؛ داخل المنطقة المؤقتة فقط. */
  removeStaleTemp(olderThanMs: number): Promise<number>;
}

export interface TempFile {
  id: string;
  /** مسار محلي للقراءة العشوائية أثناء التحقق والفحص. */
  path: string;
  size: number;
  sha256: string;
}

export class TooLarge extends Error {}

const KEY_RE = /^[a-f0-9]{64}$/;
const TEMP_RE = /^[a-f0-9]{32}\.part$/;

export class LocalDiskStorage implements FileStorage {
  private readonly tempDir: string;
  private readonly filesDir: string;

  constructor(root: string) {
    this.tempDir = join(root, 'tmp');
    this.filesDir = join(root, 'files');
  }

  async init(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    await mkdir(this.filesDir, { recursive: true, mode: 0o700 });
  }

  private keyPath(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('invalid storage key');
    return join(this.filesDir, key.slice(0, 2), key);
  }

  async writeTemp(source: Readable, maxBytes: number): Promise<TempFile> {
    const id = randomBytes(16).toString('hex');
    const path = join(this.tempDir, `${id}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new TooLarge());
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return { id, path, size, sha256: hash.digest('hex') };
  }

  async commit(temp: TempFile): Promise<string> {
    const key = randomBytes(32).toString('hex');
    const target = this.keyPath(key);
    await mkdir(join(this.filesDir, key.slice(0, 2)), { recursive: true, mode: 0o700 });
    await rename(temp.path, target);
    return key;
  }

  async removeTemp(temp: TempFile): Promise<void> {
    if (!TEMP_RE.test(`${temp.id}.part`)) return;
    await rm(join(this.tempDir, `${temp.id}.part`), { force: true });
  }

  openRead(key: string): Readable {
    return createReadStream(this.keyPath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.keyPath(key))).isFile();
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.keyPath(key), { force: true });
  }

  async removeStaleTemp(olderThanMs: number): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const name of await readdir(this.tempDir)) {
      if (!TEMP_RE.test(name)) continue; // لا يُحذف إلا ما أنشأه هذا النظام
      const path = join(this.tempDir, name);
      try {
        if (now - (await stat(path)).mtimeMs > olderThanMs) {
          await rm(path, { force: true });
          removed++;
        }
      } catch {
        // حُذف بالتوازي
      }
    }
    return removed;
  }
}
