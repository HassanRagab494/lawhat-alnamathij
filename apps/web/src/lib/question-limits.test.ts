import { describe, expect, it } from 'vitest';
import * as server from '../../../api/src/forms/questions/limits';
import { FILE_TYPE_KEYS, QUESTION_LIMITS, QUESTION_TYPES, CHOICE_TYPES } from './question-limits';

describe('الحدود المركزية', () => {
  it('نسخة الواجهة مطابقة لنسخة الخادم', () => {
    expect(QUESTION_LIMITS).toEqual(server.QUESTION_LIMITS);
    expect([...FILE_TYPE_KEYS]).toEqual([...server.FILE_TYPE_KEYS]);
    expect([...QUESTION_TYPES]).toEqual([...server.QUESTION_TYPES]);
    expect([...CHOICE_TYPES]).toEqual([...server.CHOICE_TYPES]);
  });
});
