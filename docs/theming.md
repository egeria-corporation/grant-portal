# Theming

Your portal carries your brand everywhere clients look: the sign-in screen, the portal, the favicon, the home-screen icon, and link previews. Emails follow in M4 and PDFs in M5. Set it all up in **Settings → Brand** (the first-run wizard shows the essentials).

## What you can set

| Setting | Options | Notes |
|---|---|---|
| Firm name, short name | text | The short name is used where space is tight (phone home screen). |
| Welcome line | text | On the sign-in screen and in link previews. |
| Accent color | any color | Buttons, links and highlights. See "Contrast" below. |
| Gray tone | Cool · Neutral · Warm | Tints every background, border and gray text. |
| Corners | Sharp · Soft · Round | From crisp 3 px to fully rounded buttons. |
| Density | Comfortable · Compact | Row height and spacing in tables and lists. |
| Heading font | Geist (sans) · Source Serif · Newsreader · your own WOFF2 | Body text stays Geist for legibility. |
| Logo | SVG, PNG, WebP or JPEG, up to 1 MB | Optional dark-mode variant. |
| Mark / icon | SVG, PNG or WebP, square | Becomes the favicon if you don't upload one. |
| Favicon | SVG, PNG or ICO | Otherwise generated from your mark or initials. |
| Link preview image | 1200×630 PNG or JPEG | Otherwise a card in your accent color. |
| “Powered by” line | off (default) · on | Generic wording, no product name. |

The three sample firms from the design system show what these combine into:
- **Northwind:** navy, cool grays, sharp corners, Source Serif.
- **Bloom:** coral, warm grays, round corners, Geist.
- **Evergreen:** green, neutral grays, soft corners, Newsreader.

Developers can see all three at `/_dev/kitchen-sink` in a local build.

## Contrast

You can pick any accent. From it the portal builds a full palette (four tints, a solid, a hover shade and an on-accent text color) for light and dark mode. It then checks each pair against WCAG AA (4.5:1 for text). If your exact color can't carry white or dark text on a button, the button uses the closest shade that can, and Settings tells you so. Links and accent text are checked against every background they appear on, including cards and your own accent tints.

## Light and dark

Clients and staff choose Light, Dark or System with the toggle at the bottom of the sign-in screen and in the header. System is the default. Your logo swaps to its dark variant automatically.

## How it works

For developers:

- `shared/theme/ramp.ts` ports the design's accent-ramp algorithm (OKLCH). A unit test pins it to the design's own token table.
- `shared/theme/tokens.ts` holds the gray, status, radius, density and font presets, and `themeCss()` turns a brand into CSS variables.
- The Worker serves `/brand/theme.css?v=<version>`, where the version is a hash of the brand. It writes the stylesheet link, favicon, manifest, title and link-preview tags into every page's `<head>`, so nothing flashes unbranded. Versioned URLs are cached for a year at the edge and in KV, and any change to the brand changes the URL.
- Components use semantic tokens only (`bg`, `raised`, `text2`, `acc-solid`, …); a build test fails on literal colors. `app/styles/components.css` is the design's component layer, and `app/ui/` wraps it in typed React components.
- Fonts are self-hosted from `@fontsource-variable/*` packages. There are no calls to third-party font services.
