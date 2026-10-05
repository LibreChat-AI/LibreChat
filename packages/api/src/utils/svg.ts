import { restrictSvgReferences } from 'librechat-data-provider';
import type { DOMPurify } from 'dompurify';
import type { JSDOM } from 'jsdom';

interface SvgRuntime {
  parse(value: string): Document;
  purifier: DOMPurify;
}
let runtime: SvgRuntime | undefined;

/** Share the restricted SVG DOM and load its heavy dependencies only on first use. */
export function getSvgRuntime(): SvgRuntime {
  if (runtime) return runtime;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jsdom = require('jsdom') as { JSDOM: typeof JSDOM };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('dompurify') as DOMPurify | { default: DOMPurify };
  const window = new jsdom.JSDOM('').window;
  const create = typeof loaded === 'function' ? loaded : loaded.default;
  const purifier = create(window);
  purifier.addHook('afterSanitizeAttributes', restrictSvgReferences);
  const parser = new window.DOMParser();
  runtime = { parse: (value) => parser.parseFromString(value, 'image/svg+xml'), purifier };
  return runtime;
}
