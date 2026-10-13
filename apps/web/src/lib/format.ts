import { site } from '@/config/site';

// التقويم الميلادي بتوقيت الرياض مع أرقام لاتينية لوضوح القراءة في الجداول.
const dateTimeFormatter = new Intl.DateTimeFormat(`${site.locale}-u-ca-gregory-nu-latn`, {
  timeZone: site.timeZone,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const dateFormatter = new Intl.DateTimeFormat(`${site.locale}-u-ca-gregory-nu-latn`, {
  timeZone: site.timeZone,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const numberFormatter = new Intl.NumberFormat(`${site.locale}-u-nu-latn`);

/** يعرض وقت UTC القادم من الـ API بتوقيت الرياض. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateTimeFormatter.format(new Date(iso));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateFormatter.format(new Date(iso));
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}
