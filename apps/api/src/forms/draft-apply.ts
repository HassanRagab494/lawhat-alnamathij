import { Prisma } from '@prisma/client';
import type { OptionInput, QuestionInput } from './questions/draft-schema';
import { readShowIf, type ShowIf } from './questions/visibility';

/** تطبيق محتوى المسودة داخل معاملة قائمة؛ يستخدمه حفظ المسودة وإنشاء نموذج من قالب. */

type StoredQuestion = Prisma.FormDraftQuestionGetPayload<{ include: { options: true } }>;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** يطبق فروق الأسئلة والخيارات فقط (حذف الغائب، تحديث المتغير، إنشاء الجديد) مع ترتيب position من ترتيب القائمة. */
export async function applyQuestions(
  tx: Prisma.TransactionClient,
  draftId: string,
  stored: StoredQuestion[],
  incoming: QuestionInput[],
): Promise<{ added: number; removed: number; updated: number }> {
  const storedById = new Map(stored.map((q) => [q.id, q]));
  const keepIds = incoming.flatMap((q) => (q.id ? [q.id] : []));
  const removed = await tx.formDraftQuestion.deleteMany({
    where: { draftId, id: { notIn: keepIds } },
  });

  let added = 0;
  let updated = 0;
  for (const [position, q] of incoming.entries()) {
    const options = q.options as OptionInput[];
    const fields = {
      position,
      type: q.type,
      title: q.title,
      description: q.description,
      required: q.required,
      settings: q.settings as Prisma.InputJsonValue,
      semanticKey: q.semanticKey,
    };

    if (!q.id) {
      const created = await tx.formDraftQuestion.create({
        data: { ...fields, draftId },
        select: { id: true },
      });
      if (options.length) {
        await tx.formDraftQuestionOption.createMany({
          data: options.map((o, i) => ({
            questionId: created.id,
            position: i,
            label: o.label,
            semanticKey: o.semanticKey ?? null,
          })),
        });
      }
      added++;
      continue;
    }

    const before = storedById.get(q.id)!;
    let changed =
      before.position !== position ||
      before.type !== q.type ||
      before.title !== q.title ||
      before.description !== q.description ||
      before.required !== q.required ||
      before.semanticKey !== q.semanticKey ||
      JSON.stringify(sortKeys(before.settings)) !== JSON.stringify(sortKeys(q.settings));
    if (changed) await tx.formDraftQuestion.update({ where: { id: q.id }, data: fields });

    const keepOptionIds = options.flatMap((o) => (o.id ? [o.id] : []));
    const removedOptions = await tx.formDraftQuestionOption.deleteMany({
      where: { questionId: q.id, id: { notIn: keepOptionIds } },
    });
    if (removedOptions.count) changed = true;
    const beforeOptions = new Map(before.options.map((o) => [o.id, o]));
    const newOptions: {
      questionId: string;
      position: number;
      label: string;
      semanticKey: string | null;
    }[] = [];
    for (const [i, o] of options.entries()) {
      const semanticKey = o.semanticKey ?? null;
      if (!o.id) {
        newOptions.push({ questionId: q.id, position: i, label: o.label, semanticKey });
        continue;
      }
      const prev = beforeOptions.get(o.id)!;
      if (prev.position !== i || prev.label !== o.label || prev.semanticKey !== semanticKey) {
        await tx.formDraftQuestionOption.update({
          where: { id: o.id },
          data: { position: i, label: o.label, semanticKey },
        });
        changed = true;
      }
    }
    if (newOptions.length) {
      await tx.formDraftQuestionOption.createMany({ data: newOptions });
      changed = true;
    }
    if (changed) updated++;
  }
  return { added, removed: removed.count, updated };
}

/**
 * بعد تطبيق الأسئلة والخيارات (وصار لكل جديد معرّف): يحوّل شروط الظهور من مواقع القائمة المرسلة
 * إلى معرّفات ثابتة، ويحدّث فقط ما تغيّر. ترتيب position يطابق ترتيب القائمة المرسلة.
 */
export async function applyConditions(
  tx: Prisma.TransactionClient,
  draftId: string,
  incoming: QuestionInput[],
  hadConditions: boolean,
): Promise<void> {
  // نموذج بلا شروط قبل الحفظ وبعده: لا شيء يُحدَّث ولا حاجة لقراءة إضافية.
  if (!hadConditions && incoming.every((q) => !q.showIf)) return;
  const saved = await tx.formDraftQuestion.findMany({
    where: { draftId },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      showIf: true,
      options: { orderBy: { position: 'asc' }, select: { id: true } },
    },
  });
  for (const [i, q] of incoming.entries()) {
    const row = saved[i]!;
    let next: ShowIf | null = null;
    if (q.showIf) {
      const target = saved[q.showIf.questionIndex]!;
      next = {
        questionId: target.id,
        optionIds: q.showIf.optionIndexes.map((oi) => target.options[oi]!.id),
      };
    }
    if (JSON.stringify(readShowIf(row.showIf)) !== JSON.stringify(next)) {
      await tx.formDraftQuestion.update({
        where: { id: row.id },
        data: { showIf: next ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
      });
    }
  }
}
