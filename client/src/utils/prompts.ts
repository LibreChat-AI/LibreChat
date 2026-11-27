import { specialVariables } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { getResponseErrorCode } from './errors';

/**
 * Detects the presence of variables in the given text, excluding those found in `specialVariables`.
 */
export const detectVariables = (text: string): boolean => {
  // Extract all variables with a simple regex
  const allVariablesRegex = /{{([^{}]+?)}}/gi;
  const matches = Array.from(text.matchAll(allVariablesRegex)).map((match) =>
    match[1].trim().toLowerCase(),
  );

  // Check if any non-special variables exist
  return matches.some((variable) => !specialVariables[variable]);
};

export const wrapVariable = (variable: string) => `{{${variable}}}`;

export const extractUniqueVariables = (text: string): string[] => {
  const regex = /{{(.*?)}}/g;
  let match: RegExpExecArray | null;
  const variables = new Set<string>();
  while ((match = regex.exec(text)) !== null) {
    variables.add(match[1]);
  }
  return Array.from(variables);
};

export const extractVariableInfo = (text: string) => {
  const regex = /{{(.*?)}}/g;
  let match: RegExpExecArray | null;
  const allVariables: string[] = [];
  const uniqueVariables: string[] = [];
  const repeatedVariables: Set<string> = new Set();
  const variableCount: Map<string, number> = new Map();
  const variableIndexMap: Map<string, number> = new Map();

  while ((match = regex.exec(text)) !== null) {
    const variable = match[1];
    allVariables.push(variable);

    const count = variableCount.get(variable) ?? 0;
    variableCount.set(variable, count + 1);

    if (count > 0) {
      repeatedVariables.add(variable);
    } else {
      uniqueVariables.push(variable);
      variableIndexMap.set(variable, uniqueVariables.length - 1);
    }
  }

  return {
    allVariables,
    uniqueVariables,
    repeatedVariables,
    variableIndexMap,
  };
};

export function formatDateTime(dateTimeString: string) {
  const date = new Date(dateTimeString);

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();

  const formattedMinutes = minutes.toString().padStart(2, '0');
  const formattedSeconds = seconds.toString().padStart(2, '0');

  const ampm = hours >= 12 ? 'PM' : 'AM';

  const formattedHours = hours % 12 || 12;

  const formattedDate = `${month}/${day}/${year}`;
  const formattedTime = `${formattedHours}:${formattedMinutes}:${formattedSeconds} ${ampm}`;

  return `${formattedDate}, ${formattedTime}`;
}

export const mapPromptGroups = (groups: TPromptGroup[]): Record<string, TPromptGroup> => {
  return groups.reduce(
    (acc, group) => {
      if (!group._id) {
        return acc;
      }
      acc[group._id] = group;
      return acc;
    },
    {} as Record<string, TPromptGroup>,
  );
};

/**
 * Maps a failed prompt mutation to a localized toast message. The server rejects a write
 * to an externally managed (e.g. Langfuse) prompt group with `{ code: 'read_only' }`
 * (`packages/api/src/prompts/handlers.ts`); every other failure keeps the caller's
 * existing generic message.
 */
export const getPromptMutationErrorKey = (
  error: unknown,
  fallbackKey: TranslationKeys,
): TranslationKeys => {
  const code = getResponseErrorCode<'read_only'>(error);
  return code === 'read_only' ? 'com_ui_prompt_read_only_error' : fallbackKey;
};
