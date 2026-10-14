/**
 * ينظّف اسم الملف الأصلي للعرض فقط (لا يُستخدم أبدًا في مسار التخزين):
 * يزيل أي مسار، ومحارف التحكم واتجاه النص المخفية، والمحارف المحجوزة في أنظمة الملفات،
 * ويقص الطول مع الحفاظ على الامتداد.
 */
const MAX_NAME = 150;

export function sanitizeFileName(raw: string | undefined | null): string {
  let name = String(raw ?? '').normalize('NFC');
  // آخر جزء بعد / أو \ فقط (منع path traversal في الاسم المعروض)
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    // محارف التحكم، وعلامات الاتجاه وعزلها (تُستخدم لإخفاء الامتداد الحقيقي)، ومحارف بلا عرض
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) return 'ملف';
  if (name.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return `${name.slice(0, MAX_NAME - ext.length).trimEnd()}${ext}`;
}

/** امتداد الاسم بأحرف صغيرة دون النقطة، أو '' */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
