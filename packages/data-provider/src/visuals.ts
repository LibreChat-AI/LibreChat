import { z } from 'zod';

/**
 * Inline visuals are self-contained HTML pages the model writes into its reply as a
 * `:::visual{title="…"}` container around an html fence. The client shows each one inline in a
 * sandboxed frame served from `/api/visuals/frame`, whose response carries its own CSP.
 */
export const VISUAL_DIRECTIVE = 'visual';

/**
 * JSON-RPC methods between a visual's frame and its host, named after the MCP Apps bridge: the
 * shell announces itself and receives the page, then the page reports its size, asks to open links
 * and receives theme updates.
 */
export const VisualBridgeMethod = {
  proxyReady: 'ui/notifications/sandbox-proxy-ready',
  resourceReady: 'ui/notifications/sandbox-resource-ready',
  sizeChanged: 'ui/notifications/size-changed',
  hostContextChanged: 'ui/notifications/host-context-changed',
  openLink: 'ui/open-link',
} as const;

/** Color variables a visual's `:root` receives from the active theme. */
export const VISUAL_COLOR_VARIABLES = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--card',
  '--card-foreground',
  '--border',
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--success',
  '--warning',
  '--destructive',
  '--info',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
  '--chart-7',
  '--chart-8',
] as const;

export type VisualColorVariable = (typeof VISUAL_COLOR_VARIABLES)[number];

/** Every variable a visual's `:root` receives: the theme colors plus shape and type. */
export const VISUAL_THEME_VARIABLES = [
  ...VISUAL_COLOR_VARIABLES,
  '--radius',
  '--font-sans',
  '--font-mono',
] as const;

/** Public package CDNs a visual can load chart and diagram libraries from. */
export const DEFAULT_VISUAL_SOURCES: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
  'https://esm.sh',
];

/** A bare https origin, so a configured value cannot inject CSP syntax. */
const VISUAL_SOURCE_PATTERN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/i;

/**
 * Set only in `librechat.yaml` (`BASE_ONLY_CONFIG_SECTIONS`), like other sandbox policy, so the
 * prompt and the frame route (which serves no particular user) always agree. Whether visuals are
 * offered at all is `interface.visuals`.
 */
export const visualsConfigSchema = z.object({
  /**
   * Origins a visual may load scripts, styles, fonts, images and data from. Requests to any other
   * origin, including the app's own API, and every form post stay blocked.
   */
  sources: z
    .array(
      z
        .string()
        .trim()
        .regex(
          VISUAL_SOURCE_PATTERN,
          'Visual sources must be https origins, e.g. https://cdn.example.com',
        ),
    )
    .max(32)
    .default(() => [...DEFAULT_VISUAL_SOURCES]),
});

export type TVisualsConfig = z.infer<typeof visualsConfigSchema>;
