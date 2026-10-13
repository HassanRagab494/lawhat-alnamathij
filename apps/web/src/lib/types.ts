// أنواع مطابقة لاستجابات الـ API (انظر docs/openapi.json).

export type Permission = 'FORMS_VIEW' | 'FORMS_CREATE' | 'FORMS_EDIT' | 'FORMS_ARCHIVE';
export type UserRole = 'ADMIN' | 'SUPERVISOR';

export interface Me {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  permissions: Permission[];
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  items: T[];
  meta: PageMeta;
}

export interface FormItem {
  id: string;
  title: string;
  description: string | null;
  publicationStatus: 'draft';
  isArchived: boolean;
  revision: number;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface UserItem {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  permissions: Permission[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSummary {
  forms?: { active: number; archived: number };
  users?: { supervisors: number; activeSupervisors: number; inactiveSupervisors: number };
}

export interface FieldError {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  fields?: FieldError[];
  details?: Record<string, unknown>;
}
