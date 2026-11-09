# NMB branding and theme

Scope: logo, favicons, colour theme, and app name only. No scanner, review-screen or API changes.

## Colour tokens

Sampled from the supplied logo (`Image_9-11-2026_at_10_56.png`, 202x81 px) by taking the
dominant opaque pixel values.

| Token | Hex | RGB | Source |
|---|---|---|---|
| NMB navy | `#093161` | 9 49 97 | letters (1,948 px, the most common ink colour) |
| NMB gold | `#E5C577` | 229 197 119 | key bar and bow (447 px) |

The source image also carries a strip of `#1E3660` along its top edge. That is the page
header the screenshot was cropped from, not part of the logo, and it was cropped out.

### How the colours are applied

Light mode: navy `#093161` is the primary action colour (login "Continue", send button, auth links,
focus rings, scrollbar). Links are `#0B4F9E`, hover navy. Surfaces are a cool near-white
(`#F6F8FC` / `#EAEFF7`), selected sidebar rows `#D6E0F1`. Gold is decorative only
(list bullets and blockquote bars), because it is 1.67:1 on white.

Dark mode: surfaces are navy-tinted (`#08111F` page, `#0B1628` alt, `#0F1D33` cards,
`#162845` composer / user bubbles, `#0A1424` sidebar). Gold `#E5C577` carries focus rings, auth
links, and the send button (with a navy `#093161` label). Submit buttons keep the shared white
label, so they use a lighter navy `#2563B6`. Links are `#7DB2F5`.

The full token list (about 100 per mode) is in `config/nmb/nmb-theme.yaml`.

### Contrast (WCAG 2.x, computed by `config/nmb/check_contrast.py`)

The script runs 136 checks per mode across 14 surfaces. All pass; lowest text pair is 5.70:1 (light) and
5.37:1 (dark). Text needs 4.5:1, UI components 3:1.

| Pair | Light | Dark |
|---|---|---|
| text-primary on page | 17.06 | 16.67 |
| text-muted on secondary surface | 7.13 | 7.51 |
| link on page | 8.00 | 8.61 |
| text-secondary on selected nav row | 7.79 | 8.15 |
| submit button label (white) on `surface-submit` | 12.93 | 5.93 |
| send button label on `button-primary` | 12.93 (white on navy) | 7.75 (navy on gold) |
| auth link (`accent-primary`) on page | 12.93 | 11.33 |
| focus ring on page | 12.93 | 11.33 |
| focus ring on selected nav row | 9.73 | 7.23 |
| submit button vs page (non-text) | 12.93 | 3.19 |
| control border (`border-heavy`) on page | 3.56 | 3.55 |
| gold on white (why gold is decorative in light) | 1.67 | |
| gold on dark page | | 11.33 |

Run `python3 config/nmb/check_contrast.py --all` for every pair. Disabled controls and
placeholder text are not covered by the script.

## Files

Added:
- `config/nmb/nmb-theme.yaml`: the theme, as an `interface.theme` block for `librechat.yaml`
- `config/nmb/check_contrast.py`: contrast checker
- `client/public/assets/nmb-logo.png`, `nmb-logo-dark.png`: transparent PNG, 1110x310 (navy, and white-plus-gold)
- `client/public/assets/logo-dark.svg`: white-plus-gold SVG for dark surfaces
- `client/public/assets/icon-512x512.png`: 512 icon
- `docs/nmb/BRANDING.md`

Replaced (same filenames LibreChat already references):
- `client/public/assets/logo.svg` (navy SVG)
- `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon-180x180.png`, `icon-192x192.png`, `maskable-icon.png`

Edited (small):
- `client/src/components/Auth/AuthLayout.tsx`: two `<img>` tags (`dark:hidden` / `hidden dark:block`) so the login logo switches with the theme. Upstream shows one fixed image.
- `client/index.html`: `<title>`, description, `theme-color` (`#093161`)
- `client/vite.config.ts`: PWA manifest name, short name, colours, and the 512 icon
- `.env.example`: `APP_TITLE="NMB AI Assistant"`, `CUSTOM_FOOTER="NMB AI Assistant"`

Theming needs no component edits. LibreChat reads colours from CSS variables set by its theme
engine; `interface.theme` in `librechat.yaml` supplies the override at runtime, and it is the
documented upstream extension point, so upstream merges stay clean.

## Enabling the theme

1. Copy the `theme:` mapping from `config/nmb/nmb-theme.yaml` under `interface:` in the
   deployment's `librechat.yaml` (mount it per the normal LibreChat setup).
2. Set `APP_TITLE` and `CUSTOM_FOOTER` in `.env` (already in `.env.example`).
3. Rebuild the client so the new assets and manifest ship (`npm run frontend`).

Note: `HELP_AND_FAQ_URL` still defaults to `https://librechat.ai`. Point it at an internal page
or hide the Help item before go-live; this was left unchanged.

## Logo assets: how they were made

- The source is a low-resolution raster (202x81), opaque on white, with an unrelated header strip.
  It was cropped to the wordmark, upscaled 8x (Lanczos), and the white background was removed by
  unmixing each pixel against white with the navy and gold inks, which gives anti-aliased alpha.
  The key's hole is transparent.
- The dark variant swaps navy for white and keeps the gold.
- **SVG is a trace, not the original vector.** Each ink layer was contour-traced (OpenCV) to polygons.
  It is a faithful silhouette but has slightly soft corners and loses the finest white slits in the
  letters. The PNGs are the authoritative artwork at the source's real resolution; for print or
  large signage, request the original vector from NMB.
- Favicons: a navy tile with the white wordmark and gold key. At 16 px the wordmark is a
  recognisable navy/white/gold blob, not legible text.

## Swapping the logo later

1. Put the new files in `client/public/assets/` as `logo.svg` (for light surfaces) and `logo-dark.svg`
   (for dark surfaces).
2. Regenerate the favicon set at the same filenames and sizes (16, 32, 180, 192, 512; the maskable
   icon keeps the mark inside the central 60%).
3. If brand colours change, edit `config/nmb/nmb-theme.yaml` and re-run `check_contrast.py`;
   also update `theme_color` in `client/vite.config.ts` and `client/index.html`.
4. Rebuild the client.

## Verification status

- Done: `eslint` on `AuthLayout.tsx` and `vite.config.ts` (clean); the theme passes the
  repo's own `validateThemeDefinition`, and every token name exists in LibreChat's default
  and dark theme maps; contrast checker (0 failures); visual check of the login page in light
  and dark in headless Chrome against the Vite dev server, with `/api/config` served by a local
  mock that returned the theme and title. The computed `--surface-submit` matched in each mode and the
  tab title read "NMB AI Assistant".
- Not done: the signed-in chat UI (sidebar, header, composer, selected states, scrollbars) was
  not viewed, since it needs a real backend and login; those are covered by the numeric contrast
  checks only. No production `vite build`, no `tsc` of the whole client, and the existing Jest
  suites were not run. Mobile and PWA install icons were not tested on a device.
