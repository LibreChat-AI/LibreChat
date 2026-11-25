import {
  actionDelimiter,
  actionDomainSeparator,
  isActionTool,
  type AgentToolOptions,
  type AllowedCaller,
} from './types/tools';

const actionDomainSeparatorRegex = new RegExp(actionDomainSeparator, 'g');

/**
 * Collapses the encoded-domain suffix of an action tool name to the shape used
 * by runtime tool definitions. The operation id is deliberately preserved.
 */
export function normalizeActionToolName(toolName: string): string {
  if (!isActionTool(toolName)) {
    return toolName;
  }
  const delimiterIndex = toolName.lastIndexOf(actionDelimiter);
  const prefixEnd = delimiterIndex + actionDelimiter.length;
  const encodedDomain = toolName.slice(prefixEnd);
  return toolName.slice(0, prefixEnd) + encodedDomain.replace(actionDomainSeparatorRegex, '_');
}

/**
 * Removes Code Interpreter as an allowed caller without mutating the input.
 * Tool entries and unrelated options are preserved; an empty entry is removed.
 */
export function removeCodeExecutionCaller(
  toolOptions: AgentToolOptions | undefined,
): AgentToolOptions | undefined {
  if (toolOptions == null) {
    return toolOptions;
  }

  const normalized: AgentToolOptions = {};
  for (const [toolName, options] of Object.entries(toolOptions)) {
    const callers = options.allowed_callers;
    if (callers?.includes('code_execution') !== true) {
      normalized[toolName] = options;
      continue;
    }

    const allowedCallers = callers.filter(
      (caller): caller is AllowedCaller => caller !== 'code_execution',
    );
    const { allowed_callers: _removed, ...remainingOptions } = options;
    const nextOptions =
      allowedCallers.length > 0
        ? { ...remainingOptions, allowed_callers: allowedCallers }
        : remainingOptions;
    if (Object.keys(nextOptions).length > 0) {
      normalized[toolName] = nextOptions;
    }
  }

  return normalized;
}
