import { canPreview, contentDisposition, parseRange, privateFileHeaders } from './file-response';

describe('parseRange', () => {
  it('يحلل مدى واحدًا بصيغه الثلاث ويقصّه على حجم الملف', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
  });
  it('الملف كله عند غياب الترويسة أو صيغة غير مدعومة؛ 416 عند مدى خارج الملف', () => {
    expect(parseRange(undefined, 1000)).toBeUndefined();
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeUndefined();
    expect(parseRange('items=0-1', 1000)).toBeUndefined();
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });
});

describe('ترويسات الملفات الخاصة', () => {
  it('المعاينة inline بالنوع الحقيقي، والتنزيل attachment، مع nosniff وCSP ومنع التخزين', () => {
    const inline = privateFileHeaders('MP4', 'مقطع.mp4', 'inline');
    expect(inline['Content-Type']).toBe('video/mp4');
    expect(inline['Content-Disposition']).toMatch(
      /^inline; filename="_+\.mp4"; filename\*=UTF-8''/,
    );
    expect(inline['Cache-Control']).toBe('no-store, private');
    expect(inline['X-Content-Type-Options']).toBe('nosniff');
    expect(inline['Content-Security-Policy']).toContain("media-src 'self'");
    expect(inline['Content-Security-Policy']).toContain('sandbox');
    const dl = privateFileHeaders('PDF', 'a.pdf', 'attachment');
    expect(dl['Content-Disposition']).toMatch(/^attachment;/);
    expect(dl['Content-Type']).toBe('application/pdf');
    expect(dl['Content-Security-Policy']).toBe("default-src 'none'; sandbox");
  });
  it('PDF وDOCX وXLSX وTXT لا تُعاين', () => {
    expect(['PDF', 'DOCX', 'XLSX', 'TXT'].map((k) => canPreview(k as never))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(canPreview('PNG')).toBe(true);
    expect(contentDisposition('a"b.pdf')).toBe(
      `attachment; filename="a_b.pdf"; filename*=UTF-8''a%22b.pdf`,
    );
  });
});
