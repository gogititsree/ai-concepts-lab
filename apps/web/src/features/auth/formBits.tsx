import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * The handful of form pieces the four auth screens share.
 *
 * `components/ui.tsx` deliberately stops at four primitives and has no input, because
 * until M6 nothing in the app took typed input. Rather than widen that file (owned by the
 * design language, not by this feature), the auth screens get their own small set here,
 * built from the same tokens: hairline rules, `--sunk` fills, mono eyebrows.
 */

const INPUT_CLASS =
  'border-rule bg-surface text-ink w-full rounded-md border px-3 py-2 text-sm ' +
  'placeholder:text-muted/70 disabled:opacity-50';

export function Field({
  label,
  hint,
  error,
  className = '',
  ...rest
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <label htmlFor={id} className="eyebrow block">
        {label}
      </label>
      <input
        id={id}
        // `aria-invalid` + a described-by error is what makes a screen reader announce the
        // problem; a red border alone announces nothing.
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${INPUT_CLASS} mt-1 ${error ? 'border-pos' : ''}`}
        {...rest}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-muted mt-1 text-xs">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-pos mt-1 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A server-side failure, announced.
 *
 * `role="alert"` matters more here than anywhere else in the app: the user has just
 * pressed a button and nothing visible happened except a line of text somewhere above
 * the fold.
 */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      data-testid="form-error"
      className="border-pos/40 bg-pos/5 text-pos rounded-md border px-3 py-2 text-sm"
    >
      {children}
    </p>
  );
}

export function FormNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-rule bg-sunk text-muted rounded-md border px-3 py-2 text-sm">{children}</p>
  );
}

/**
 * The primary action of a form.
 *
 * `components/ui.tsx`'s `Button` hard-codes `type="button"` (correct for the playground
 * controls it was written for, wrong inside a form), so the submit button is its own
 * element here rather than a prop nobody would remember to pass.
 */
export function SubmitButton({
  children,
  pending,
  disabled,
  className = '',
}: {
  children: ReactNode;
  pending?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={
        'readout border-ink bg-ink text-paper inline-flex items-center justify-center rounded-md ' +
        'border px-3 py-2 text-xs font-medium tracking-wide transition-opacity hover:opacity-90 ' +
        `disabled:cursor-not-allowed disabled:opacity-40 ${className}`
      }
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

/** A row in the password policy checklist. */
export function CheckItem({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-2 text-xs" data-ok={ok}>
      <span aria-hidden="true" className={`readout ${ok ? 'text-ink' : 'text-muted'}`}>
        {ok ? '✓' : '·'}
      </span>
      <span className={ok ? 'text-ink' : 'text-muted'}>{children}</span>
      <span className="sr-only">{ok ? '(met)' : '(not met)'}</span>
    </li>
  );
}
