'use client';

import Link from 'next/link';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/* ---------- الأزرار ---------- */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-velvet-700 text-white hover:bg-velvet-800 active:bg-velvet-900 disabled:bg-velvet-300',
  secondary:
    'border-2 border-velvet-600 text-velvet-700 bg-white/60 hover:bg-velvet-50 disabled:border-velvet-200 disabled:text-velvet-300',
  danger: 'border-2 border-red-700 text-red-800 bg-white/60 hover:bg-red-50 disabled:opacity-50',
  ghost: 'text-velvet-700 hover:bg-velvet-50',
};

const buttonBase =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonBase, variantClasses[variant], className)}
      {...props}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'primary',
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cx(buttonBase, variantClasses[variant], className)}>
      {children}
    </Link>
  );
}

/* ---------- الحقول ---------- */

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, error, hint, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
        {required && (
          <span className="text-red-700" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClasses =
  'w-full rounded-xl border border-smoke-300 bg-white px-3.5 py-2.5 text-base text-ink placeholder:text-muted/70 shadow-inner shadow-smoke-100 transition-colors hover:border-velvet-300 focus:border-velvet-500 focus:outline-none focus-visible:outline-3 focus-visible:outline-velvet-500/40 aria-[invalid=true]:border-red-700 disabled:bg-smoke-100';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <input ref={ref} className={cx(inputClasses, className)} {...props} />;
  },
);

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx(inputClasses, 'min-h-32', className)} {...props} />;
});

export const SelectInput = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SelectInput({ className, ...props }, ref) {
    return <select ref={ref} className={cx(inputClasses, 'pe-9', className)} {...props} />;
  },
);

/** زر أيقونة صغير مع اسم مقروء لقارئات الشاشة (للنقل والحذف). */
export function IconButton({
  label,
  icon,
  tone = 'default',
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  icon: 'up' | 'down' | 'delete' | 'add';
  tone?: 'default' | 'danger';
}) {
  const paths = {
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    delete: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
    add: 'M12 5v14M5 12h14',
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger'
          ? 'border-red-200 bg-white/70 text-red-800 hover:bg-red-50'
          : 'border-velvet-200 bg-white/70 text-velvet-700 hover:bg-velvet-50',
        className,
      )}
      {...props}
    >
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d={paths[icon]}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/* ---------- الحالة والتنبيهات ---------- */

export function Spinner({ className = 'size-6' }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LoadingState({ label = 'جارٍ التحميل…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-velvet-700">
      <Spinner />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

type AlertTone = 'error' | 'success' | 'info' | 'warning';

const alertTones: Record<AlertTone, string> = {
  error: 'border-red-200 bg-red-50 text-red-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  info: 'border-velvet-200 bg-velvet-50 text-velvet-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
};

export function Alert({
  tone,
  title,
  children,
  action,
}: {
  tone: AlertTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('rounded-xl border px-4 py-3 text-sm', alertTones[tone])}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          {title && <p className="font-bold">{title}</p>}
          {children && <div className="leading-relaxed">{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert
      tone="error"
      title="تعذر تحميل البيانات"
      action={
        onRetry && (
          <Button variant="secondary" onClick={onRetry} className="min-h-9 py-1">
            إعادة المحاولة
          </Button>
        )
      }
    >
      {message}
    </Alert>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <svg className="size-12 text-velvet-300" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M14 3v5h5M9 13h6M9 17h4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <p className="text-base font-bold text-ink">{title}</p>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

/* ---------- التخطيط ---------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx('glass rounded-2xl', className)}>{children}</section>;
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        {back && (
          <Link
            href={back.href}
            className="mb-1 inline-flex w-fit items-center gap-1 text-sm font-medium text-velvet-700 hover:underline"
          >
            <span aria-hidden="true">→</span>
            {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-bold text-velvet-900">{title}</h1>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'velvet' | 'success' | 'muted' | 'warning';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-smoke-200 text-ink',
    velvet: 'bg-velvet-100 text-velvet-800',
    success: 'bg-emerald-100 text-emerald-900',
    muted: 'bg-smoke-200 text-muted',
    warning: 'bg-amber-100 text-amber-900',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav
      aria-label="ترقيم الصفحات"
      className="flex flex-wrap items-center justify-between gap-3 pt-4"
    >
      <p className="text-sm text-muted">
        صفحة {page} من {totalPages} · {total} عنصر
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          السابق
        </Button>
        <Button
          variant="secondary"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          التالي
        </Button>
      </div>
    </nav>
  );
}

/* ---------- نافذة التأكيد ---------- */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  loading,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  loading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!loading) onClose();
      }}
      className="glass m-auto w-[min(92vw,28rem)] rounded-2xl p-0 text-ink"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <h2 id={titleId} className="text-lg font-bold text-velvet-900">
          {title}
        </h2>
        {description && <div className="text-sm leading-relaxed text-muted">{description}</div>}
        {children}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            إلغاء
          </Button>
          <Button
            type="submit"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
