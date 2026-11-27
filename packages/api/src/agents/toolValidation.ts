const TOOL_INPUT_SCHEMA_ERROR = 'Received tool input did not match expected schema';
const SCHEMA_ERROR_PATH_PATTERN = /(?:→|->)\s+at\s+([A-Za-z0-9_.[\]-]{1,120})/;
const ASK_OPTION_LABEL_PATH_PATTERN = /^(?:questions\[\d+\]\.)?options\[\d+\]\.label$/;
const OPTION_LABEL_LIMIT_PATTERN = /(?:at most \d+|\d+ characters or fewer)/i;

interface CompletedToolCall {
  tool_call?: {
    name?: unknown;
    output?: unknown;
  };
}

export type ToolInputValidationReason = 'invalid_tool_input' | 'option_label_too_long';

export interface ToolInputValidationError {
  fieldPath?: string;
  isLengthLimit: boolean;
}

export interface ToolInputValidationDetails {
  toolName: string;
  reason: ToolInputValidationReason;
  fieldPath?: string;
}

function getErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : null;
}

/**
 * Parse a schema-validation exception at the tool error boundary. Calling this
 * with the thrown error, rather than completed tool output, prevents successful
 * user-authored text from being mistaken for an execution failure.
 */
export function parseToolInputValidationError(error: unknown): ToolInputValidationError | null {
  const message = getErrorMessage(error);
  if (message == null || !message.includes(TOOL_INPUT_SCHEMA_ERROR)) {
    return null;
  }

  const fieldPath = message.match(SCHEMA_ERROR_PATH_PATTERN)?.[1];
  return {
    isLengthLimit: OPTION_LABEL_LIMIT_PATTERN.test(message),
    ...(fieldPath != null ? { fieldPath } : {}),
  };
}

export function recordToolInputValidationError(
  errorsByToolCallId: Map<string, ToolInputValidationError> | null | undefined,
  error: unknown,
  toolCallId: unknown,
): void {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return;
  }
  const validationError = parseToolInputValidationError(error);
  if (validationError != null) {
    errorsByToolCallId?.set(toolCallId, validationError);
  }
}

/**
 * Reduce a tool input validation failure to privacy-safe structured fields for
 * observability. Tool arguments and the raw validation message can contain
 * user/model content, so callers should log only the returned details.
 */
export function getToolInputValidationDetails(
  result: CompletedToolCall | null | undefined,
  validationError: ToolInputValidationError | null | undefined,
): ToolInputValidationDetails | null {
  const toolName = result?.tool_call?.name;
  if (typeof toolName !== 'string' || validationError == null) {
    return null;
  }

  const { fieldPath } = validationError;
  const optionLabelTooLong =
    toolName === 'ask_user_question' &&
    fieldPath != null &&
    ASK_OPTION_LABEL_PATH_PATTERN.test(fieldPath) &&
    validationError.isLengthLimit;

  return {
    toolName,
    reason: optionLabelTooLong ? 'option_label_too_long' : 'invalid_tool_input',
    ...(fieldPath != null ? { fieldPath } : {}),
  };
}
