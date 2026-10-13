import { Permission, UserRole } from '@prisma/client';

export interface AuthContext {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  /** الصلاحيات الفعلية المقروءة من القاعدة في هذا الطلب نفسه. */
  permissions: Permission[];
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
