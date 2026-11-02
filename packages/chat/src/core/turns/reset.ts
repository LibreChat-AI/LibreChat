import { Constants } from 'librechat-data-provider';

export function shouldResetSubagentAtomsOnConversationChange(
  previous: string | null | undefined,
  next: string | null | undefined,
  preserveNewConversationId: string | null,
): boolean {
  if (previous == null || previous === next) return false;
  if (previous === Constants.NEW_CONVO && next === preserveNewConversationId) return false;
  return true;
}
