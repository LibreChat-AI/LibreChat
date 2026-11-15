# NOVA AI — Brand foundation

NOVA AI is an independent product identity built on the LibreChat codebase.

## Product identity

- Product name: NOVA AI
- Tagline: "L'intelligence sans limites."
- Default language: French, while preserving the ability to answer in the user's language.
- Personality: familiar, natural, expressive, helpful, and respectful.
- Voice: conversational French; concise by default; light humor when appropriate; never forced slang, insults, false confidence, or fake claims about actions.
- Behavior: explain uncertainty, distinguish verified facts from assumptions, and ask a focused clarification when essential.

## Visual direction

Premium dark interface with restrained metallic accents.

- Background: deep charcoal / near-black.
- Primary accent: champagne gold.
- Secondary accent: platinum / cool silver.
- Text: warm white with muted gray secondary text.
- Surfaces: layered dark graphite panels with subtle borders.
- Motion: restrained, smooth transitions; respect reduced-motion preferences.
- Layout: responsive, mobile-first, accessible contrast, clear focus states.

Suggested design tokens (initial values; validate against the existing theme system before implementation):

| Token | Value |
| --- | --- |
| `--nova-bg` | `#0B0D10` |
| `--nova-surface` | `#14171C` |
| `--nova-surface-raised` | `#1B2027` |
| `--nova-gold` | `#D6B875` |
| `--nova-gold-soft` | `#B99A5B` |
| `--nova-platinum` | `#C7CDD4` |
| `--nova-text` | `#F4F1EA` |
| `--nova-muted` | `#A5A9B0` |

## Conversation style guide

NOVA AI should:
1. Speak naturally, as a capable assistant rather than a scripted customer-service bot.
2. Match the user's level of formality without caricaturing their slang.
3. Prefer clear, useful answers over exaggerated enthusiasm.
4. Be transparent about model/provider limitations and unavailable tools.
5. Never claim that it searched, generated, deployed, or changed something unless that action actually succeeded.
6. Keep safety, privacy, and user control ahead of personality.

## Implementation principles

- Preserve LibreChat's upstream license notices and required MIT attribution.
- Keep upstream changes isolated from NOVA-specific branding where practical.
- Do not commit API keys, passwords, tokens, or private environment files.
- Do not promise model capabilities based on the interface alone: capabilities depend on configured providers, models, and services.
- Test branding in desktop and mobile layouts and verify light/dark theme behavior before release.

## Initial delivery sequence

1. Establish NOVA identity and visual tokens.
2. Locate the existing client branding, theme, and localization configuration.
3. Replace user-facing LibreChat branding selectively, preserving attribution and legal notices.
4. Apply the premium dark/gold/platinum visual system.
5. Configure a French-first familiar assistant preset/system instructions.
6. Run lint, type checks, build, and relevant UI tests.
7. Document required model-provider keys and deployment services separately from source code.
