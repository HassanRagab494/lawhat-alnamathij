/**
 * حماية التنقل بزري الرجوع والتقدم داخل التطبيق (App Router لا يوفر حدثًا قابلًا للإلغاء).
 *
 * الفكرة دون إضافة مدخلات للسجل:
 * - كل مدخل سجل يُختم برقم تسلسلي `lawhaIdx` داخل history.state (pushState يزيده، replaceState يبقيه).
 * - عند popstate نعرف موقع الوجهة نسبةً للمدخل الحالي.
 * - إن كان هناك حارس يرفض المغادرة: نوقف الحدث قبل أن يعالجه Next (فلا تتغير الصفحة)،
 *   ثم نعيد المتصفح إلى المدخل نفسه بـ history.go(الفرق) — قفزة داخل السجل الموجود لا تضيف مدخلًا.
 * - إن وافق المستخدم: يمر الحدث إلى Next فيكمل التنقل عاديًا.
 */

type Guard = () => boolean;

const KEY = 'lawhaIdx';
let installed = false;
let currentIdx = 0;
let guard: Guard | null = null;
/** نعلم أن popstate التالي هو قفزة الاستعادة التي بدأناها، فنتجاهله ولا نمرره لـ Next. */
let restoring = false;
let uninstall: (() => void) | null = null;

function readIdx(state: unknown): number | undefined {
  const v = (state as Record<string, unknown> | null)?.[KEY];
  return typeof v === 'number' ? v : undefined;
}

export function installHistoryTracking(win: Window = window): void {
  if (installed) return;
  installed = true;
  const history = win.history;
  const nativePush = history.pushState.bind(history);
  const nativeReplace = history.replaceState.bind(history);

  const existing = readIdx(history.state);
  if (existing === undefined) {
    nativeReplace({ ...(history.state ?? {}), [KEY]: 0 }, '');
    currentIdx = 0;
  } else {
    currentIdx = existing;
  }

  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    currentIdx += 1;
    return nativePush({ ...((data as object) ?? {}), [KEY]: currentIdx }, unused, url);
  };
  history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
    return nativeReplace({ ...((data as object) ?? {}), [KEY]: currentIdx }, unused, url);
  };

  // capture على window: يعمل قبل مستمع Next فيمكن إيقافه.
  const onPopState = (event: PopStateEvent) => {
    // مدخل لم يُختم (أُنشئ قبل التحميل) يُعامل كأنه السابق مباشرة.
    const dest = readIdx(event.state) ?? currentIdx - 1;
    if (restoring) {
      restoring = false;
      event.stopImmediatePropagation();
      currentIdx = dest;
      return;
    }
    if (guard && dest !== currentIdx && !guard()) {
      event.stopImmediatePropagation();
      restoring = true;
      history.go(currentIdx - dest);
      return;
    }
    currentIdx = dest;
  };
  win.addEventListener('popstate', onPopState, { capture: true });
  uninstall = () => {
    win.removeEventListener('popstate', onPopState, { capture: true });
    history.pushState = nativePush;
    history.replaceState = nativeReplace;
  };
}

/** يسجّل حارسًا يعيد true للسماح بالمغادرة. يعيد دالة لإلغاء التسجيل. */
export function setNavigationGuard(fn: Guard): () => void {
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}

/** للاختبارات فقط. */
export function __resetHistoryGuardForTests(): void {
  uninstall?.();
  uninstall = null;
  installed = false;
  currentIdx = 0;
  guard = null;
  restoring = false;
}

export function currentHistoryIndex(): number {
  return currentIdx;
}
