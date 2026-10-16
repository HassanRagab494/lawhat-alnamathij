/**
 * قيم Flowmax المعتمدة للعقارات والطلبات، والتطبيع العربي المستخدم في التعرّف التلقائي.
 * المرجع في Flowmax: backend/docs/api/property-listing-fields.md و backend/docs/property-demand-marketplace-api.md.
 */

export type Operation = 'OFFER' | 'REQUEST';

export const PROPERTY_CATEGORIES: Record<string, string> = {
  apartment: 'شقة',
  villa: 'فيلا',
  duplex: 'دوبلكس',
  studio: 'استوديو',
  traditional_house: 'بيت شعبي',
  palace: 'قصر',
  residential_land: 'أرض سكنية',
  commercial_land: 'أرض تجارية',
  office: 'مكتب',
  shop: 'محل',
  building: 'عمارة',
  warehouse: 'مستودع',
  hotel: 'فندق',
  chalet: 'شاليه',
  farm: 'مزرعة',
};

export const LISTING_PURPOSES: Record<string, string> = {
  sale: 'بيع',
  rent: 'إيجار',
  investment: 'استثمار',
  daily_rental: 'إيجار يومي',
};

/**
 * تطبيع عربي للمطابقة: يزيل التشكيل والتطويل، ويوحّد الهمزات (أ إ آ ٱ ⇒ ا، ؤ ⇒ و، ئ ⇒ ي)
 * والياء والتاء المربوطة، ويحذف المسافات والشرطات وكل الرموز، ويحوّل اللاتيني إلى أحرف صغيرة.
 * «المدينة / الحي» و«المدينه-الحي» و«المَدِينَة الحَيّ» تعطي النتيجة نفسها.
 */
export function normalizeArabic(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}
