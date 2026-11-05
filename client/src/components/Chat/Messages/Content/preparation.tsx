import { createContext, useContext } from 'react';
import { Constants, actionDelimiter } from 'librechat-data-provider';
import { getToolDisplayLabel, isToolCallPreparing } from '@librechat/chat';
import type { ToolPreparationInput } from '@librechat/chat';
import { useLocalize } from '~/hooks';

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
