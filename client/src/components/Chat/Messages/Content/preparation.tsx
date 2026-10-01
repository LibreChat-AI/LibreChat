import { createContext, useContext } from 'react';
import { Constants, actionDelimiter } from 'librechat-data-provider';
import type { PartMetadata } from 'librechat-data-provider';
import { areToolCallArgsComplete } from './Parts/parseJsonField';
import { getToolDisplayLabel } from '~/utils/toolLabels';
import { useLocalize } from '~/hooks';

export interface ToolPreparationInput
  extends Pick<PartMetadata, 'toolPreparationStartedAt' | 'toolDispatchedAt' | 'runStepStatus'> {
  args?: string | Record<string, unknown>;
  output?: string | null;
  progress?: number;
}

/** Dispatch and result signals outrank argument completeness on legacy and resumed calls. */
export function isToolCallPreparing(call: ToolPreparationInput): boolean {
  if (
    call.toolDispatchedAt != null ||
    call.runStepStatus != null ||
    (call.output?.length ?? 0) > 0 ||
    (call.progress ?? 0) >= 1
  ) {
    return false;
  }
  return call.toolPreparationStartedAt != null || !areToolCallArgsComplete(call.args);
}

const ToolPreparationContext = createContext<string | undefined>(undefined);

export function useToolPreparation(): string | undefined {
  return useContext(ToolPreparationContext);
}

/** The host supplies the call's preparation state without widening every specialized card's props. */
export function ToolPreparation({
  call,
  isSubmitting,
  children,
}: {
  call: ToolPreparationInput & { name?: string };
  isSubmitting: boolean;
  children: React.ReactNode;
}) {
  const localize = useLocalize();
  const name = call.name ?? '';
  let text: string | undefined;
  /** Generic integration cards own their configured MCP/action name parsing. */
  const usesIntegrationName =
    name.includes(Constants.mcp_delimiter) || name.includes(actionDelimiter);
  if (isSubmitting && !usesIntegrationName && isToolCallPreparing(call)) {
    const label = getToolDisplayLabel(name, localize);
    text = label
      ? localize('com_ui_tool_preparing', { 0: label })
      : localize('com_assistants_preparing_action');
  }
  return <ToolPreparationContext.Provider value={text}>{children}</ToolPreparationContext.Provider>;
}
