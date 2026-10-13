import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  __resetHistoryGuardForTests,
  currentHistoryIndex,
  installHistoryTracking,
  setNavigationGuard,
} from './history-guard';

const tick = () => new Promise((r) => setTimeout(r, 30));

/** يحاكي مستمع Next على popstate (يُسجَّل بعد حارسنا كما في التطبيق). */
let nextHandler: Mock<(event: PopStateEvent) => void>;

beforeEach(() => {
  __resetHistoryGuardForTests();
  installHistoryTracking();
  nextHandler = vi.fn<(event: PopStateEvent) => void>();
  window.addEventListener('popstate', nextHandler);
  history.pushState({ __NA: true }, '', '/forms');
  history.pushState({ __NA: true }, '', '/forms/f1');
});

afterEach(() => {
  window.removeEventListener('popstate', nextHandler);
  __resetHistoryGuardForTests();
});

describe('history-guard', () => {
  it('يختم المدخلات برقم تسلسلي دون فقد حالة Next', () => {
    expect(history.state).toMatchObject({ __NA: true, lawhaIdx: currentHistoryIndex() });
    history.replaceState({ __NA: true, tree: 1 }, '', '/forms/f1');
    expect(history.state).toMatchObject({ __NA: true, tree: 1, lawhaIdx: currentHistoryIndex() });
  });

  it('دون حارس: الرجوع يصل إلى Next عاديًا', async () => {
    const before = currentHistoryIndex();
    history.back();
    await tick();
    expect(nextHandler).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/forms');
    expect(currentHistoryIndex()).toBe(before - 1);
  });

  it('إلغاء المغادرة: لا يصل الحدث إلى Next ويعود المتصفح للمدخل نفسه دون مدخلات جديدة', async () => {
    const length = history.length;
    const before = currentHistoryIndex();
    const confirmFn = vi.fn(() => false);
    const off = setNavigationGuard(confirmFn);
    history.back();
    await tick();
    await tick();
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(nextHandler).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/forms/f1');
    expect(currentHistoryIndex()).toBe(before);
    expect(history.length).toBe(length);
    off();
  });

  it('إلغاء التقدم يعيد إلى المدخل الحالي أيضًا', async () => {
    history.back();
    await tick();
    expect(location.pathname).toBe('/forms');
    nextHandler.mockClear();
    const off = setNavigationGuard(() => false);
    history.forward();
    await tick();
    await tick();
    expect(nextHandler).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/forms');
    off();
  });

  it('تأكيد المغادرة: يمر الحدث إلى Next وتكتمل الملاحة', async () => {
    const off = setNavigationGuard(() => true);
    history.back();
    await tick();
    expect(nextHandler).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/forms');
    off();
  });
});
