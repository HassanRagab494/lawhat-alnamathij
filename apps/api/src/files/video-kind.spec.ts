import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoBox, isoMedia, samples, webm } from '../../test/fixtures/files';
import { FileRejected, INLINE_KINDS, MIME_BY_KIND, inspectFile } from './file-kind';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lawha-video-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ALL = ['pdf', 'jpg', 'png', 'webp', 'docx', 'xlsx', 'txt', 'mp4', 'mov', 'webm'];
let n = 0;
async function check(data: Buffer, name: string, allowed: string[] = ALL) {
  const path = join(dir, `v${n++}`);
  await writeFile(path, data);
  return inspectFile(path, data.length, name, allowed);
}
const rejected = (p: Promise<unknown>, message?: RegExp) =>
  message ? expect(p).rejects.toThrow(message) : expect(p).rejects.toBeInstanceOf(FileRejected);

describe('inspectFile — الفيديو من البنية الفعلية', () => {
  it('يقبل MP4 وMOV وWebM السليمة ويحدد النوع من المحتوى', async () => {
    await expect(check(samples.mp4(), 'clip.mp4')).resolves.toBe('MP4');
    await expect(check(samples.mov(), 'clip.mov')).resolves.toBe('MOV');
    await expect(check(isoMedia(null, ['wide', 'mdat', 'moov']), 'old.mov')).resolves.toBe('MOV');
    await expect(check(samples.webm(), 'clip.webm')).resolves.toBe('WEBM');
    // تسجيل المتصفح (MediaRecorder): Segment وCluster بحجم غير معروف
    await expect(check(webm({ unknownSizes: true }), 'rec.webm')).resolves.toBe('WEBM');
  });

  it('يقبل تسجيلات متصفح حقيقية (MediaRecorder: WebM بأحجام غير معروفة وMP4 مجزأ)', async () => {
    const media = join(__dirname, '../../test/fixtures/media');
    const webmData = await readFile(join(media, 'recorded.webm'));
    const mp4Data = await readFile(join(media, 'recorded.mp4'));
    await expect(check(webmData, 'recorded.webm')).resolves.toBe('WEBM');
    await expect(check(mp4Data, 'recorded.mp4')).resolves.toBe('MP4');
  });

  it('يرفض MIME/امتدادًا مزورًا: محتوى فيديو باسم آخر أو محتوى آخر باسم فيديو', async () => {
    await rejected(check(samples.mp4(), 'clip.webm'), /لا يطابق محتواه/);
    await rejected(check(samples.mov(), 'clip.mp4'), /لا يطابق محتواه/);
    await rejected(check(samples.pdf(), 'clip.mp4'), /لا يطابق محتواه/);
    await rejected(check(samples.txt(), 'clip.webm'), /لا يطابق محتواه/);
  });

  it('يرفض الفيديو إن لم يكن نوعه مسموحًا في السؤال', async () => {
    await rejected(check(samples.mp4(), 'clip.mp4', ['pdf', 'png']), /غير مسموح/);
  });

  it('يرفض ملفات ISO BMFF الناقصة أو المكسورة', async () => {
    await rejected(check(isoMedia('isom', ['moov']), 'a.mp4'), /ناقص/);
    await rejected(check(isoMedia('isom', ['mdat']), 'a.mp4'), /ناقص/);
    const broken = samples.mp4();
    broken.writeUInt32BE(0xffff, broken.length - 40); // طول عنصر يتجاوز الملف
    await rejected(check(broken, 'a.mp4'), /غير سليمة/);
    await rejected(check(samples.mp4().subarray(0, -5), 'cut.mp4'), /غير سليمة/);
    await rejected(check(Buffer.concat([isoBox('ftyp'), isoBox('ftyp')]), 'a.mp4'));
  });

  it('يرفض صيغ ISO ليست فيديو (HEIC/AVIF/M4A)', async () => {
    await rejected(check(isoMedia('heic'), 'img.mp4'), /ليس فيديو/);
    await rejected(check(isoMedia('avif'), 'img.mp4'), /ليس فيديو/);
    await rejected(check(isoMedia('M4A '), 'song.mp4'), /ليس فيديو/);
  });

  it('يرفض WebM الناقص أو Matroska العام أو المقطوع', async () => {
    await rejected(check(webm({ docType: 'matroska' }), 'a.webm'), /ليس فيديو WebM/);
    await rejected(check(webm({ tracks: false }), 'a.webm'), /ناقص/);
    await rejected(check(webm({ cluster: false }), 'a.webm'), /ناقص/);
    await rejected(check(samples.webm().subarray(0, -10), 'cut.webm'), /مقطوع|غير سليمة/);
  });

  it('المعاينة للصور والفيديو فقط، ولكل نوع Content-Type حقيقي', () => {
    expect([...INLINE_KINDS].sort()).toEqual(['JPG', 'MOV', 'MP4', 'PNG', 'WEBM', 'WEBP']);
    expect(MIME_BY_KIND.MP4).toBe('video/mp4');
    expect(MIME_BY_KIND.MOV).toBe('video/quicktime');
    expect(MIME_BY_KIND.WEBM).toBe('video/webm');
    expect(MIME_BY_KIND.PDF).toBe('application/pdf');
  });
});
