import { Tools, reasoningOverrideSchema } from 'librechat-data-provider';
import type { TReasoningOverride } from 'librechat-data-provider';

/** Built-in upload capabilities consumed by chat when it loads the basic agent summary. */
export function getAgentUploadTools(tools?: readonly string[] | null): string[] {
  return tools?.filter((tool) => tool === Tools.file_search || tool === Tools.execute_code) ?? [];
}

const flags = ['useResponsesApi', 'web_search', 'thinking'] as const;
const reasoning = ['reasoning_effort', 'effort', 'thinkingLevel', 'thinkingBudget'] as const;

type ChatParameters = Partial<
  Record<(typeof flags)[number], boolean> &
    Record<TReasoningOverride['key'], TReasoningOverride['value']> & {
      maxContextTokens: number;
    }
>;

/** Allowlist the scalar settings used by upload routing and chat controls. */
export function getAgentChatParameters(
  parameters?: Record<string, unknown> | null,
): ChatParameters {
  const result: ChatParameters = {};
  if (!parameters) {
    return result;
  }
  for (const flag of flags) {
    const value = parameters[flag];
    if (typeof value === 'boolean') {
      result[flag] = value;
    }
  }
  for (const key of reasoning) {
    const parsed = reasoningOverrideSchema.safeParse({ key, value: parameters[key] });
    if (parsed.success) {
      result[key] = parsed.data.value;
    }
  }
  const limit = parameters.maxContextTokens;
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0) {
    result.maxContextTokens = limit;
  }
  return result;
}
