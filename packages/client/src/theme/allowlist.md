# Colours outside the theme

Every colour in `client/src` and `packages/client/src` that the theme-leakage sweep reached comes from a semantic theme role, except the ones below. Each is a colour that must not follow the theme: a brand mark, artwork, media overlays, a third party's surface, a document that leaves the app, or the theme definitions themselves. An entry names the file, what the literal paints and why the theme does not own it.

The sweep skipped files an open pull request was editing; those, with their counts, are listed in berry-13/LibreChat#195, and the avatar colours that still need roles in berry-13/LibreChat#194. Until those land, a file absent from this list is not evidence that it holds no literal colour.

A literal the design lint can see stays recorded in `eslint-suppressions.json` (inline disables
of the design rules are rejected by the static checks), so its count there is the exception, not
debt; the file-scoped allow entry for these paths belongs in `eslint.config.mjs`. Everything else
is invisible to the lint (CSS, strings passed to a canvas or an iframe), so this list is the record.

Adding an entry needs the same bar: if a theme author would reasonably want to recolour it, it
is a role, not an exception.

## Theme definitions

| File                                                           | Why                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/client/src/theme/themes/*.ts`, `themes/clickui.json` | The palettes themselves: these are the values roles resolve to. |
| `packages/client/src/theme/registry.ts`                        | Theme resolution and fallbacks written in channel triplets.     |
| `packages/client/src/theme/tokens.css`                         | Maps each role to `rgb(var(--role))`; no literal colour.        |

## Brand marks and artwork

| File                                                                          | Why                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/client/src/svgs/GoogleIcon.tsx`                                     | Google's multicolour mark, fixed by its brand guidelines.                                                                                                              |
| `packages/client/src/svgs/FacebookIcon.tsx`                                   | Facebook's mark, fixed by its brand guidelines.                                                                                                                        |
| `packages/client/src/svgs/DiscordIcon.tsx`                                    | Discord's mark, fixed by its brand guidelines.                                                                                                                         |
| `packages/client/src/svgs/GeminiIcon.tsx`                                     | Gemini's gradient mark, fixed by its brand guidelines.                                                                                                                 |
| `packages/client/src/svgs/PaLMIcon.tsx`                                       | PaLM's multicolour mark, fixed by its brand guidelines.                                                                                                                |
| `packages/client/src/svgs/BirthdayIcon.tsx`                                   | A multicolour illustration; the palette is artwork, not a UI role.                                                                                                     |
| `packages/client/src/components/PixelCard.tsx`                                | The `blue`, `yellow` and `pink` presets are decorative palettes a caller opts into, like the `colors` prop; the app renders only the default, which reads theme roles. |
| `packages/client/src/icons/provider/registry.ts`, `icons/provider/Avatar.tsx` | Provider brand colours, each already behind a `--provider-*` variable a deployment can override; the literal is only the fallback.                                     |
| `client/src/mobile.css`                                                       | `.azure-bg-color`, the Azure file-source chip's blue gradient, fixed by Azure's brand.                                                                                 |

## Elevation ink in library stylesheets

| File                                          | Why                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/client/src/components/Dropdown.css` | Popover shadows in black alpha. The app paints `.popover-ui` from its own copy of these rules in `client/src/style.css`, so moving either copy to `--theme-shadow-lg` needs both edited together. |
| `packages/client/src/components/Tooltip.css`  | Tooltip shadows are smaller than any step of the theme shadow scale; black alpha ink, dropped in high contrast where the border takes over.                                                       |

## Chat: media, artwork and documents that leave the app

| File                                                                          | Why                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/src/components/Chat/Input/Files/DragDropOverlay.tsx`                  | The drop-zone illustration's fills are artwork. Its backdrop is black at 40% in both modes; the theme scrim is gray-500 in default light, so it moves to `surface-overlay` once a theme can set scrim opacity per mode (berry-13/LibreChat#181). |
| `client/src/components/Chat/Input/Files/SourceIcon.tsx`                       | The OpenAI chip (white/75, black/65 in dark) and the code-execution badge (a black terminal mark with white ink) sit over the file's own preview: media overlays, like the upload progress.                                                      |
| `client/src/components/Chat/Input/Files/ProgressCircle.tsx`                   | Upload progress drawn over the user's own image: a media scrim, so it stays black and white whatever the theme paints around the image.                                                                                                          |
| `client/src/components/Chat/Input/Files/ImagePreview.tsx`                     | The expand hint over the thumbnail (black/20 with white ink) and the full-screen lightbox (black/90 with a white close control) frame the user's own image, so they stay black and white whatever the theme paints around it.                    |
| `client/src/utils/markdown.ts`                                                | The downloaded HTML document's GitHub Primer stylesheet; it is read outside the app, where no theme variables exist. Its high-contrast branch already reads the roles.                                                                           |
| `client/src/utils/mermaid.ts`                                                 | The mermaid artifact document and its zoom controls render in a sandboxed iframe without theme variables; the token reads' fallbacks and the luminance repair ink are literals by necessity.                                                     |
| `client/src/utils/richtext.ts`                                                | Inline styles on HTML copied to the clipboard for pasting into other apps, which must not carry the sender's theme.                                                                                                                              |
| `client/src/utils/artifacts.ts`                                               | The scrollbar thumb inside the sandboxed artifact document, which renders in its own iframe and never reads the app's theme.                                                                                                                     |
| `client/src/utils/officePreview.ts`, `client/src/hooks/ScreenshotContext.tsx` | Fallbacks for a theme role read at runtime, used only when the variable is unset.                                                                                                                                                                |

## Panels: media and third-party surfaces

| File                                                        | Why                                                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/components/Nav/SettingsTabs/Account/Avatar.tsx` | The move hint drawn over the user's photo in the avatar cropper: a media scrim with white ink, independent of the theme around the image. |
| `client/src/hooks/Files/useSharePointPicker.ts`             | Background of Microsoft's SharePoint file picker iframe, matched to that third party's own surface.                                       |
