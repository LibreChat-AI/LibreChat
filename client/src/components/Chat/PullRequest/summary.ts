import type { TConversationPullRequest } from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';
import { presentPullRequest } from './status';

/** One sentence that says everything the icon, dot and badges say in color. */
export function summarizePullRequest(
  pr: TConversationPullRequest,
  localize: ReturnType<typeof useLocalize>,
): string {
  const view = presentPullRequest(pr);
  return [
    `${localize('com_ui_pull_request')} ${localize('com_ui_pr_label', { 0: pr.number })}: ${pr.title}`,
    localize('com_ui_pr_state', { 0: localize(view.stateKey) }),
    localize('com_ui_pr_checks', { 0: localize(view.checksKey) }),
  ].join(', ');
}
