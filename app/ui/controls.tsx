/**
 * Controls from docs/design/boards/04-components-controls.html: buttons,
 * inputs, select, sign-in code, checkbox/radio/toggle, segmented control.
 * Thin typed wrappers over the ported component classes (styles/components.css).
 */
import { Check, CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useId, useRef } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'quiet' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
  /** Square icon-only button; pass an aria-label. */
  icon?: boolean;
}

export function Button({ variant = 'primary', size = 'md', block, loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, icon && 'btn-icon', block && 'btn-block', className)}
    >
      {loading ? <Loader2 aria-hidden className="i spin" /> : null}
      {children}
    </button>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: 'md' | 'lg';
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ inputSize = 'md', invalid, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx('input', inputSize === 'lg' && 'input-lg', invalid && 'is-error', rest.disabled && 'is-disabled', className)}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ invalid, className, ...rest }, ref) {
    return <textarea ref={ref} {...rest} aria-invalid={invalid || undefined} className={cx('input', invalid && 'is-error', className)} />;
  },
);

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...rest} aria-invalid={invalid || undefined} className={cx('input select', invalid && 'is-error', className)}>
      {children}
    </select>
  );
}

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
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children({ id, 'aria-describedby': hintId })}
      {error ? (
        <p id={hintId} className="err">
          <CircleAlert aria-hidden className="i size-3.5" />
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2.5 text-[13.5px]', disabled && 'is-disabled')}>
      <input type="checkbox" className="sr-only peer" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden className={cx('cb', checked && 'on', 'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-acc-focus')}>
        {checked ? <Check className="i" /> : null}
      </span>
      {label}
    </label>
  );
}

export function Radio({ checked, onChange, label, name, value }: { checked: boolean; onChange: () => void; label: ReactNode; name: string; value: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13.5px]">
      <input type="radio" className="sr-only peer" name={name} value={value} checked={checked} onChange={onChange} />
      <span aria-hidden className={cx('radio', checked && 'on', 'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-acc-focus')} />
      {label}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('toggle', checked && 'on', disabled && 'is-disabled')}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'md' | 'lg';
}) {
  return (
    <div className={cx('seg', size === 'lg' && 'seg-lg')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Six boxes for the sign-in code, with paste support and one accessible label. */
export function OtpInput({ value, onChange, invalid, ok, label = 'Sign-in code' }: { value: string; onChange: (v: string) => void; invalid?: boolean; ok?: boolean; label?: string }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.replace(/\D/g, '').slice(0, 6).padEnd(6, ' ').split('');
  const set = (i: number, d: string) => {
    const next = digits.map((c, j) => (j === i ? d : c)).join('').replace(/\s+$/, '');
    onChange(next.replace(/ /g, ''));
  };
  return (
    <div role="group" aria-label={label} className={cx('otp', invalid && 'is-error', ok && 'is-ok')}>
      {digits.map((d, i) => (
        <span key={i} className="contents">
          {i === 3 ? <span className="gap" aria-hidden /> : null}
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={cx('cell', invalid && 'border-danger', ok && 'border-ok')}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${i + 1}`}
            maxLength={1}
            value={d.trim()}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '');
              if (v.length > 1) {
                onChange(v.slice(0, 6));
                refs.current[Math.min(v.length, 5)]?.focus();
                return;
              }
              set(i, v || ' ');
              if (v) refs.current[i + 1]?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !d.trim()) refs.current[i - 1]?.focus();
            }}
            onPaste={(e) => {
              const v = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
              if (v) {
                e.preventDefault();
                onChange(v);
                refs.current[Math.min(v.length, 5)]?.focus();
              }
            }}
          />
        </span>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('card p-6', className)}>{children}</section>;
}

type Tone = 'info' | 'ok' | 'warn' | 'danger' | 'acc';
const TONE_ICON = { info: Info, ok: CircleCheck, warn: TriangleAlert, danger: CircleAlert, acc: Info } as const;
const TONE_CLASS: Record<Tone, string> = {
  info: 'banner-info',
  ok: 'banner-ok',
  warn: 'banner-warn',
  danger: 'bg-danger-bg text-danger-text shadow-[inset_0_0_0_1px_var(--danger-bd)]',
  acc: 'banner-acc',
};

/** Banner from board 06; `tone="danger"` is announced as an alert. */
export function Notice({ tone = 'info', children, action }: { tone?: Tone; children: ReactNode; action?: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('banner', TONE_CLASS[tone])}>
      <Icon aria-hidden className="i size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center" role="status">
      <Loader2 aria-hidden className="i spin size-6 text-text3" />
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
