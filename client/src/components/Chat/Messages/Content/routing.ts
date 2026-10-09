import { Constants } from 'librechat-data-provider';
import parseJsonField from './Parts/parseJsonField';

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
