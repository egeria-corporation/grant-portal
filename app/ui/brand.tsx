/** Firm identity in the chrome: logo (light/dark variants) or a monogram, and the light/dark toggle. */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { currentPreference, setPreference, type ThemePreference, useConfig } from '@/lib/session';
import { Segmented } from './controls';
import { initialsOf } from './display';

export function FirmMark({ name, size = 40 }: { name: string | null | undefined; size?: number }) {
  return (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md bg-acc font-semibold text-acc-on"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initialsOf(name ?? '')}
    </div>
  );
}

/**
 * The uploaded logo when there is one (the dark variant in dark mode, following
 * the same rules as theme.css, so the in-app toggle works too), otherwise the
 * mark or a monogram plus the firm name.
 */
export function FirmLogo({ height = 32, showName = true }: { height?: number; showName?: boolean }) {
  const { data } = useConfig();
  const name = data?.shortName || data?.firmName || '';
  if (data?.logoLight) {
    return (
      <span className="inline-flex">
        <img src={data.logoLight} alt={data.firmName ?? ''} style={{ height, width: 'auto' }} className={data.logoDark ? 'logo-light has-dark' : 'logo-light'} />
        {data.logoDark ? <img src={data.logoDark} alt={data.firmName ?? ''} style={{ height, width: 'auto' }} className="logo-dark" /> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2.5">
      {data?.mark ? <img src={data.mark} alt="" style={{ height, width: height }} /> : <FirmMark name={name} size={height} />}
      {showName ? <span className="hd truncate text-[15px]">{name}</span> : null}
    </span>
  );
}

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(() => currentPreference());
  return (
    <Segmented<ThemePreference>
      label="Color mode"
      value={pref}
      onChange={(p) => {
        setPreference(p);
        setPref(p);
      }}
      options={[
        { value: 'light', label: <Sun aria-label="Light" className="i size-3.5" /> },
        { value: 'system', label: <Monitor aria-label="System" className="i size-3.5" /> },
        { value: 'dark', label: <Moon aria-label="Dark" className="i size-3.5" /> },
      ]}
    />
  );
}
