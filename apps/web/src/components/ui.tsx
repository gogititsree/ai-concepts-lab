import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The small set of surfaces and controls every page is built from. Deliberately tiny: four
 * primitives, one spacing rhythm, no variants nobody asked for.
 */

export function Panel({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`border-rule bg-surface rounded-lg border ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-paper hover:opacity-90 border-ink',
  secondary: 'bg-surface text-ink border-rule hover:bg-sunk',
  ghost: 'bg-transparent text-muted border-transparent hover:text-ink hover:bg-sunk',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...rest
}: { variant?: ButtonVariant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`readout inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

/**
 * A labelled number. Every measurement in the app goes through this, in mono with tabular
 * figures, so a value that changes 60 times a second does not shift the layout under the
 * cursor.
 */
export function Readout({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  /**
   * Optional hook for the Playwright E2E. The label and the value are two sibling
   * paragraphs with no programmatic association between them, so there is no accessible
   * name a test could use to ask for "the value next to Accuracy"; rather than teach the
   * test to walk the DOM, the one readout an assertion depends on names itself.
   */
  testId?: string;
}) {
  return (
    <div title={hint} data-testid={testId}>
      <p className="eyebrow">{label}</p>
      <p className="readout text-lg leading-tight font-medium">{value}</p>
    </div>
  );
}

/** Progress as a ring: it reads at a glance on a card and costs one SVG circle. */
export function ProgressRing({ fraction, size = 34 }: { fraction: number; size?: number }) {
  const radius = size / 2 - 3;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${Math.round(clamped * 100)}% complete`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--rule)"
        strokeWidth="3"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--ink)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v: number) => v.toFixed(2),
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <span className="readout text-xs">{format(value)}</span>
      </span>
      <input
        type="range"
        className="accent-ink mt-1 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
