/**
 * Brand for email: the firm's name, logo and colors from the same tokens the
 * portal uses (light mode; email clients' dark modes are unpredictable), laid
 * out with react-email components so Outlook renders it too.
 */
import { Body } from '@react-email/body';
import { Button } from '@react-email/button';
import { Container } from '@react-email/container';
import { Head } from '@react-email/head';
import { Hr } from '@react-email/hr';
import { Html } from '@react-email/html';
import { Img } from '@react-email/img';
import { Link } from '@react-email/link';
import { Preview } from '@react-email/preview';
import { Section } from '@react-email/section';
import { Text } from '@react-email/text';
import { modeVars, SAMPLE_BRANDS, type SampleBrand, type ThemeInput } from '@shared/theme/tokens';
import type { ReactNode } from 'react';
import type { AppEnv } from '../../env';
import { getBrandState } from '../../brand/state';
import { portalOrigin } from '../../lib/origin';

export interface EmailBrand {
  firm: string;
  /** Absolute portal URL, or null when unknown (links are then omitted). */
  origin: string | null;
  /** Raster logo only: many email clients block SVG. */
  logoUrl: string | null;
  colors: { bg: string; card: string; text: string; text2: string; border: string; accent: string; onAccent: string; link: string; tint: string };
  radius: number;
}

const RADIUS: Record<ThemeInput['radius'], number> = { sharp: 3, soft: 8, round: 999 };

export function emailBrand(p: { firm: string; theme: ThemeInput; origin: string | null; logoPath: string | null }): EmailBrand {
  const v = modeVars(p.theme, 'light');
  const c = (k: string) => v[k] ?? '#000000';
  return {
    firm: p.firm,
    origin: p.origin,
    logoUrl: p.origin && p.logoPath ? `${p.origin}${p.logoPath}` : null,
    colors: {
      bg: c('bg'),
      card: c('raised'),
      text: c('text'),
      text2: c('text2'),
      border: c('border'),
      accent: c('acc-solid'),
      onAccent: c('acc-on'),
      link: c('acc-text'),
      tint: c('acc-a50'),
    },
    radius: RADIUS[p.theme.radius],
  };
}

const RASTER = /^image\/(png|jpeg|gif|webp)$/;

/** The deployment's brand, for emails sent now. */
export async function loadEmailBrand(env: AppEnv, origin?: string | null): Promise<EmailBrand> {
  const [state, known] = await Promise.all([getBrandState(env), origin === undefined ? portalOrigin(env) : Promise.resolve(origin)]);
  const logo = state.assets['logo-light'];
  return emailBrand({
    firm: state.firmName ?? 'Your consultant',
    theme: state.theme,
    origin: known,
    logoPath: logo && RASTER.test(logo.mime) ? `/brand/asset/logo-light?v=${logo.sha256.slice(0, 12)}` : null,
  });
}

/** Sample brands for snapshot tests. */
export function sampleEmailBrand(name: SampleBrand): EmailBrand {
  const s = SAMPLE_BRANDS[name];
  return emailBrand({ firm: s.name, theme: s.theme, origin: 'https://portal.example.org', logoPath: null });
}

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function Layout({ brand, preview, children, footer }: { brand: EmailBrand; preview: string; children: ReactNode; footer?: ReactNode }) {
  const c = brand.colors;
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: c.bg, margin: 0, padding: '24px 0', fontFamily: FONT, color: c.text }}>
        <Container style={{ maxWidth: 560, margin: '0 auto', padding: '0 16px' }}>
          <Section style={{ padding: '8px 0 20px' }}>
            {brand.logoUrl ? (
              <Img src={brand.logoUrl} alt={brand.firm} height={32} style={{ height: 32, width: 'auto' }} />
            ) : (
              <Text style={{ margin: 0, fontSize: 17, fontWeight: 600, color: c.text }}>{brand.firm}</Text>
            )}
          </Section>
          <Section style={{ backgroundColor: c.card, border: `1px solid ${c.border}`, borderRadius: Math.min(brand.radius, 16), padding: '28px 28px 20px' }}>{children}</Section>
          <Section style={{ padding: '16px 4px' }}>
            <Text style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: c.text2 }}>
              {brand.firm}
              {footer ? <> · {footer}</> : null}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function H({ brand, children }: { brand: EmailBrand; children: ReactNode }) {
  return <Text style={{ margin: '0 0 12px', fontSize: 20, lineHeight: '28px', fontWeight: 600, color: brand.colors.text }}>{children}</Text>;
}

export function P({ brand, children, muted }: { brand: EmailBrand; children: ReactNode; muted?: boolean }) {
  return <Text style={{ margin: '0 0 14px', fontSize: 15, lineHeight: '23px', color: muted ? brand.colors.text2 : brand.colors.text, whiteSpace: 'pre-line' }}>{children}</Text>;
}

export function Cta({ brand, href, children }: { brand: EmailBrand; href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: '6px 0 18px' }}>
      <Button
        href={href}
        style={{
          backgroundColor: brand.colors.accent,
          color: brand.colors.onAccent,
          borderRadius: Math.min(brand.radius, 8),
          padding: '11px 18px',
          fontSize: 15,
          fontWeight: 600,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        {children}
      </Button>
    </Section>
  );
}

export function A({ brand, href, children }: { brand: EmailBrand; href: string; children: ReactNode }) {
  return (
    <Link href={href} style={{ color: brand.colors.link, textDecoration: 'underline' }}>
      {children}
    </Link>
  );
}

export function Code({ brand, children }: { brand: EmailBrand; children: ReactNode }) {
  return (
    <Text style={{ margin: '0 0 16px', fontSize: 28, lineHeight: '34px', letterSpacing: 6, fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", color: brand.colors.text }}>
      {children}
    </Text>
  );
}

export function List({ brand, items }: { brand: EmailBrand; items: { title: string; detail?: string }[] }) {
  return (
    <Section style={{ margin: '0 0 16px', backgroundColor: brand.colors.tint, borderRadius: Math.min(brand.radius, 8), padding: '10px 14px' }}>
      {items.map((it, i) => (
        <Text key={i} style={{ margin: '4px 0', fontSize: 14, lineHeight: '21px', color: brand.colors.text }}>
          • <strong>{it.title}</strong>
          {it.detail ? <span style={{ color: brand.colors.text2 }}> — {it.detail}</span> : null}
        </Text>
      ))}
    </Section>
  );
}

export function Rule({ brand }: { brand: EmailBrand }) {
  return <Hr style={{ borderColor: brand.colors.border, margin: '8px 0 16px' }} />;
}
