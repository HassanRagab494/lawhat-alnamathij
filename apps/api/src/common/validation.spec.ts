import { ArgumentMetadata, HttpException } from '@nestjs/common';
import { LoginDto } from '../auth/dto';
import { CreateFormDto, FormListQueryDto, UpdateFormDto } from '../forms/dto';
import { CreateSupervisorDto } from '../users/dto';
import type { ApiErrorBody } from './errors';
import { createValidationPipe } from './validation';

const pipe = createValidationPipe();

async function validate<T>(metatype: new () => T, value: unknown): Promise<T | ApiErrorBody> {
  const metadata: ArgumentMetadata = { type: 'body', metatype };
  try {
    return (await pipe.transform(value, metadata)) as T;
  } catch (error) {
    return (error as HttpException).getResponse() as ApiErrorBody;
  }
}

describe('validation pipe', () => {
  it('يرفض عنوانًا فارغًا برسالة عربية مفهومة', async () => {
    const result = (await validate(CreateFormDto, { title: '   ' })) as ApiErrorBody;
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.fields).toEqual([{ field: 'title', message: 'عنوان النموذج مطلوب.' }]);
  });

  it('يقص المسافات ويحوّل الوصف الفارغ إلى null', async () => {
    const result = (await validate(CreateFormDto, {
      title: '  نموذج  ',
      description: '  ',
    })) as CreateFormDto;
    expect(result.title).toBe('نموذج');
    expect(result.description).toBeNull();
  });

  it('يرفض العنوان الطويل جدًا', async () => {
    const result = (await validate(CreateFormDto, { title: 'ع'.repeat(201) })) as ApiErrorBody;
    expect(result.fields?.[0]?.message).toMatch(/200/);
  });

  it('يرفض الحقول غير المعروفة', async () => {
    const result = (await validate(CreateFormDto, {
      title: 'نموذج',
      createdById: 'x',
    })) as ApiErrorBody;
    expect(result.fields).toEqual([{ field: 'createdById', message: 'هذا الحقل غير مسموح به.' }]);
  });

  it('يشترط رقم المراجعة في التعديل', async () => {
    const result = (await validate(UpdateFormDto, { title: 'نموذج' })) as ApiErrorBody;
    expect(result.fields?.[0]).toEqual({ field: 'revision', message: 'رقم المراجعة مطلوب.' });
  });

  it('يرفض صلاحية غير معروفة واسم مستخدم غير صالح', async () => {
    const result = (await validate(CreateSupervisorDto, {
      username: 'س',
      displayName: 'سارة',
      password: 'a-long-enough-pass',
      permissions: ['FORMS_VIEW', 'RESPONSES_DELETE'],
    })) as ApiErrorBody;
    const fields = Object.fromEntries((result.fields ?? []).map((f) => [f.field, f.message]));
    expect(fields.username).toMatch(/اسم المستخدم/);
    expect(fields.permissions).toBe('إحدى الصلاحيات المختارة غير معروفة.');
  });

  it('الحقل المفقود يُبلَّغ بأنه مطلوب لا بأنه طويل', async () => {
    const result = (await validate(LoginDto, { username: '' })) as ApiErrorBody;
    expect(result.fields).toEqual([
      { field: 'username', message: 'اسم المستخدم مطلوب.' },
      { field: 'password', message: 'كلمة المرور مطلوبة.' },
    ]);
    const missingTitle = (await validate(CreateFormDto, {})) as ApiErrorBody;
    expect(missingTitle.fields).toEqual([{ field: 'title', message: 'عنوان النموذج مطلوب.' }]);
  });

  it('يحوّل معاملات الاستعلام ويطبق الافتراضيات', async () => {
    const metadata: ArgumentMetadata = { type: 'query', metatype: FormListQueryDto };
    const result = (await pipe.transform({ page: '2' }, metadata)) as FormListQueryDto;
    expect(result).toMatchObject({ page: 2, pageSize: 20, status: 'active' });
  });
});
