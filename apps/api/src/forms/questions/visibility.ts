/**
 * الأسئلة الشرطية: يظهر السؤال فقط إن كان سؤال الاختيار السابق الذي يشير إليه ظاهرًا
 * وكانت إجابته أحد الخيارات المحددة. الشرط يشير دائمًا إلى سؤال أسبق في الترتيب، فلا دورات.
 *
 * التخزين بمعرّفات منطقية (معرّف سؤال المسودة ومعرّف خيارها)، وهي نفسها logicalId في الإصدار المنشور.
 */

export interface ShowIf {
  questionId: string;
  optionIds: string[];
}

/** يقرأ شرطًا مخزّنًا (JSON) ويعيد null لأي شكل غير متوقع. */
export function readShowIf(raw: unknown): ShowIf | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.questionId !== 'string' || !Array.isArray(v.optionIds)) return null;
  const optionIds = v.optionIds.filter((o): o is string => typeof o === 'string');
  return optionIds.length ? { questionId: v.questionId, optionIds } : null;
}

export interface VisibilityQuestion {
  /** المعرّف المستخدم في الشرط (منطقي أو معرّف إصدار حسب السياق). */
  id: string;
  showIf: ShowIf | null;
}

/**
 * يعيد معرّفات الأسئلة الظاهرة حسب الخيارات المحددة لكل سؤال.
 * السؤال المخفي لا يُظهر الأسئلة المعتمدة عليه حتى لو بقيت له إجابة.
 */
export function visibleQuestionIds(
  questions: VisibilityQuestion[],
  selected: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visible = new Set<string>();
  for (const q of questions) {
    if (!q.showIf) {
      visible.add(q.id);
      continue;
    }
    const { questionId, optionIds } = q.showIf;
    if (!visible.has(questionId)) continue;
    const picked = selected.get(questionId) ?? [];
    if (picked.some((id) => optionIds.includes(id))) visible.add(q.id);
  }
  return visible;
}

export interface VersionQuestionShape {
  id: string;
  logicalId: string;
  showIf: unknown;
  options: { id: string; logicalId: string }[];
}

/**
 * شروط أسئلة إصدار منشور بمعرّفات هذا الإصدار (ما يرسله المتصفح ويُخزَّن في الإجابات)،
 * بعد تحويلها من المعرّفات المنطقية المخزّنة.
 */
export function versionConditions(questions: VersionQuestionShape[]): Map<string, ShowIf | null> {
  const byLogical = new Map(questions.map((q) => [q.logicalId, q]));
  return new Map(
    questions.map((q) => {
      const cond = readShowIf(q.showIf);
      const target = cond ? byLogical.get(cond.questionId) : undefined;
      if (!cond || !target) return [q.id, null];
      const optionIds = target.options
        .filter((o) => cond.optionIds.includes(o.logicalId))
        .map((o) => o.id);
      return [q.id, optionIds.length ? { questionId: target.id, optionIds } : null];
    }),
  );
}
