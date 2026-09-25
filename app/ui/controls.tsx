/**
 * Small themed primitives following docs/design/boards/04-components-controls.html.
 * Semantic tokens only. The full component set arrives in M2.
 */
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';

type Variant = 'primary' | 'secondary' | 'quiet' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-acc text-acc-on hover:bg-acc-hover',
  secondary: 'bg-raised text-text border-binput hover:bg-hover',
  quiet: 'bg-sunken text-text hover:bg-active',
  ghost: 'text-text2 hover:bg-hover hover:text-text',
  danger: 'bg-raised text-danger-text border-danger-bd hover:bg-danger-bg',
  link: 'h-auto! px-0! border-0 text-acc-text hover:underline',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5',
  md: 'h-[34px] px-[13px] text-[13.5px] gap-[7px]',
  lg: 'h-12 px-5 text-[15.5px] gap-[9px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', block, loading, className = '', children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-btn border border-transparent font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: 'md' | 'lg';
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ inputSize = 'md', invalid, className = '', ...rest }, ref) {
  return (
    <input
      ref={ref}
      {...rest}
      aria-invalid={invalid || undefined}
      className={`w-full rounded-sm border bg-raised text-text outline-none placeholder:text-text3 focus:border-acc-focus focus:shadow-[0_0_0_3px_var(--acc-ring)] disabled:bg-sunken disabled:text-text3 ${
        invalid ? 'border-danger shadow-[0_0_0_3px_var(--danger-bg)]' : 'border-binput'
      } ${inputSize === 'lg' ? 'h-12 px-3.5 text-base' : 'h-[34px] px-[11px] text-sm'} ${className}`}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-text">
        {label}
      </label>
      {children({ id, 'aria-describedby': hintId })}
      {error ? (
        <p id={hintId} className="text-[12.5px] text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[12.5px] text-text3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-card border border-border bg-raised p-6 shadow-panel ${className}`}>{children}</section>;
}

type Tone = 'info' | 'ok' | 'warn' | 'danger';
const TONES: Record<Tone, { cls: string; Icon: typeof Info }> = {
  info: { cls: 'border-info-bd bg-info-bg text-info-text', Icon: Info },
  ok: { cls: 'border-ok-bd bg-ok-bg text-ok-text', Icon: CircleCheck },
  warn: { cls: 'border-warn-bd bg-warn-bg text-warn-text', Icon: TriangleAlert },
  danger: { cls: 'border-danger-bd bg-danger-bg text-danger-text', Icon: CircleAlert },
};

export function Notice({ tone = 'info', children, action }: { tone?: Tone; children: ReactNode; action?: ReactNode }) {
  const { cls, Icon } = TONES[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-md border px-3.5 py-2.5 ${cls}`}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-[13.5px]">{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center" role="status">
      <Loader2 aria-hidden className="size-6 animate-spin text-text3" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Copy-to-clipboard row for invite links and codes. */
export function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="font-code text-[12.5px]" />
      <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(value)}>
        Copy
      </Button>
    </div>
  );
}
