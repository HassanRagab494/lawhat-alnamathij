/**
 * إنشاء حساب مدير النظام الأول.
 *
 *   npm run admin:create -- --username <اسم> --display-name "<الاسم الظاهر>"
 *
 * تُطلب كلمة المرور تفاعليًا (مخفية ومرتين). للأتمتة فقط يمكن تمريرها عبر متغير البيئة
 * INITIAL_ADMIN_PASSWORD لمرة واحدة. يرفض الأمر العمل إذا وُجد مدير نظام مسبقًا.
 */
import { PrismaClient, UserRole } from '@prisma/client';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  USERNAME_PATTERN,
  hashPassword,
  normalizeUsername,
  passwordPolicyError,
} from '../auth/password';

export class BootstrapError extends Error {}

export interface InitialAdminInput {
  username: string;
  displayName: string;
  password: string;
}

export async function createInitialAdmin(
  prisma: PrismaClient,
  input: InitialAdminInput,
): Promise<{ id: string; username: string }> {
  const username = normalizeUsername(input.username);
  const displayName = input.displayName.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new BootstrapError(
      'اسم المستخدم يجب أن يكون من 4 إلى 32 حرفًا لاتينيًا صغيرًا أو أرقامًا أو . _ -',
    );
  }
  if (displayName.length < 2 || displayName.length > 100) {
    throw new BootstrapError('الاسم الظاهر يجب أن يكون بين 2 و100 حرف.');
  }
  const policy = passwordPolicyError(input.password, username);
  if (policy) throw new BootstrapError(policy);

  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    const existingAdmins = await tx.user.count({ where: { role: UserRole.ADMIN } });
    if (existingAdmins > 0) {
      throw new BootstrapError('يوجد مدير نظام بالفعل. هذا الأمر مخصص لإنشاء المدير الأول فقط.');
    }
    if (await tx.user.findUnique({ where: { username } })) {
      throw new BootstrapError('اسم المستخدم مستخدم بالفعل.');
    }
    const user = await tx.user.create({
      data: { username, displayName, passwordHash, role: UserRole.ADMIN },
      select: { id: true, username: true },
    });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: 'user.bootstrap_admin',
        entityType: 'user',
        entityId: user.id,
        details: { username: user.username, source: 'cli' },
      },
    });
    return user;
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key?.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new BootstrapError(`القيمة مفقودة للخيار ${key}`);
      }
      args[key.slice(2)] = value;
      i++;
    }
  }
  return args;
}

function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.INITIAL_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new BootstrapError(
      'لا توجد طرفية تفاعلية لإدخال كلمة المرور. شغّل الأمر من طرفية تفاعلية أو عيّن INITIAL_ADMIN_PASSWORD لهذا الأمر فقط.',
    );
  }
  const first = await askHidden('كلمة المرور: ');
  const second = await askHidden('أعد كتابة كلمة المرور: ');
  if (first !== second) throw new BootstrapError('كلمتا المرور غير متطابقتين.');
  return first;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args['username'];
  const displayName = args['display-name'];
  if (!username || !displayName) {
    throw new BootstrapError(
      'الاستخدام: npm run admin:create -- --username <اسم المستخدم> --display-name "<الاسم الظاهر>"',
    );
  }
  if (!process.env.DATABASE_URL) throw new BootstrapError('DATABASE_URL غير معرّف.');

  const password = await readPassword();
  const prisma = new PrismaClient();
  try {
    const admin = await createInitialAdmin(prisma, { username, displayName, password });
    console.log(`تم إنشاء مدير النظام «${admin.username}» بنجاح.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof BootstrapError ? `خطأ: ${error.message}` : error);
    process.exit(1);
  });
}
