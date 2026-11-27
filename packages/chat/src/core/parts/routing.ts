import { Constants } from 'librechat-data-provider';
import { parseJsonField } from './parseJsonField';

const PYTHON_PROGRAMMATIC_LANGS = new Set(['py', 'python']);

export function isBashProgrammaticToolCall(
  name: string | undefined,
  args?: string | Record<string, unknown>,
): boolean {
  if (name === Constants.BASH_PROGRAMMATIC_TOOL_CALLING) {
    return true;
  }
  if (name !== Constants.PROGRAMMATIC_TOOL_CALLING) {
    return false;
  }

  const lang =
    parseJsonField(args, 'lang') ||
    parseJsonField(args, 'runtime') ||
    parseJsonField(args, 'language');

  return !PYTHON_PROGRAMMATIC_LANGS.has(lang.toLowerCase());
}

/**
 * The image tools whose card previews the picture as it is made: a placeholder the size the call
 * asked for, filling in while the run goes, then the image in its place.
 */
export const AGENT_STYLE_TOOLS: ReadonlySet<string> = new Set([
  'image_gen_oai',
  'image_edit_oai',
  'gemini_image_gen',
]);
