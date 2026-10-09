import { DEFAULT_VISUAL_SOURCES, VISUAL_THEME_VARIABLES } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/**
 * Instructions for writing inline visuals. Layout and theming guidance is adapted from T3 Code's
 * HTML renders (MIT, https://github.com/pingdotgg/t3code).
 */
export function generateVisualsPrompt({ sources }: { sources: readonly string[] }): string {
  const libraries =
    sources.length > 0
      ? `Libraries may load from ${sources.join(', ')} (for example Chart.js, D3, ECharts, Mermaid or three.js). Every other origin is blocked.`
      : 'No external origins are allowed, so inline any library code or draw with plain SVG and canvas.';

  return `## Inline visuals

You can show a visual inline in your reply when a chart, table, diagram, timeline, comparison, small interactive widget or mockup would say more than prose. Write it as one self-contained HTML document inside a \`visual\` container directive, with a short title:

:::visual{title="Quarterly revenue by region"}
\`\`\`html
<!doctype html>
<html>
<head><style>/* … */</style></head>
<body><!-- … --><script>/* … */</script></body>
</html>
\`\`\`
:::

The reader sees the rendered page where you wrote it, with its title above it. Do not announce it or restate what it shows; refer to it the way you would refer to a figure.

When to use one: reach for a visual when quantities, comparisons, structure, processes or spatial relationships matter. Skip it for short answers and for anything a sentence or a markdown list says as well. Prefer one strong visual over several weak ones. Code the user will run, edit or keep belongs in a code block, and a full application or document belongs in an artifact when artifacts are available.

Page rules:
- Write a complete document with inline <style> and <script>, with all data in the page. ${libraries} The page cannot make other network requests, submit forms, or use cookies and storage.
- The frame is as wide as the reply column (about 700px on desktop, 360px on phones) and sits on the conversation background. Leave html and body without a background, use a fluid width, and add no outer card, border or heading: the title is shown above the frame.
- Keep it compact, ideally under 600px tall. Use tabs or steps rather than a long page, give charts a fixed pixel height, and never use 100vh.
- Buttons, inputs, selects, sliders, checkboxes, tables and headings are already styled to match the app. Use them as they are instead of restyling them, and mark a selected button or tab with aria-pressed="true" or aria-selected="true" so it is highlighted.
- For your own styles use the theme variables on :root, which follow light and dark mode: ${VISUAL_THEME_VARIABLES.join(', ')}. Use --chart-1 onward, in order, for data series. Canvas charts need concrete colors: read them with getComputedStyle and redraw on the window's \`themechange\` event.
- Favor whitespace over boxes, avoid boxes inside boxes, and use color for data and status rather than decoration.
- Label axes and units, give charts an aria-label, and never encode meaning in color alone.
- Keep the document under about 100 KB.`;
}

/**
 * The visuals instructions for a request, or `null` when the user's setting is off or the
 * deployment turned visuals off with `interface.visuals`.
 */
export function getVisualsPrompt({
  requested,
  appConfig,
}: {
  requested?: boolean;
  appConfig?: AppConfig;
}): string | null {
  if (requested !== true || appConfig?.interfaceConfig?.visuals === false) {
    return null;
  }
  return generateVisualsPrompt({ sources: appConfig?.visuals?.sources ?? DEFAULT_VISUAL_SOURCES });
}
