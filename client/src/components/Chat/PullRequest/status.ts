import type { TConversationPullRequest } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

export type PullRequestTone = 'success' | 'error' | 'warning' | 'neutral';

export type PullRequestIcon = 'open' | 'draft' | 'merged' | 'closed';

export type PullRequestPresentation = {
  icon: PullRequestIcon;
  /** Colors the pull request icon: ready, conflicting, or no signal (draft, closed). */
  iconTone: PullRequestTone;
  /** Colors the CI dot on the avatar; null when the repository reports no checks. */
  dotTone: PullRequestTone | null;
  stateKey: TranslationKeys;
  stateTone: PullRequestTone;
  checksKey: TranslationKeys;
  checksTone: PullRequestTone;
};

const CHECKS: Record<
  TConversationPullRequest['checks'],
  { key: TranslationKeys; tone: PullRequestTone; dot: PullRequestTone | null }
> = {
  passing: { key: 'com_ui_pr_checks_passing', tone: 'success', dot: 'success' },
  failing: { key: 'com_ui_pr_checks_failing', tone: 'error', dot: 'error' },
  running: { key: 'com_ui_pr_checks_running', tone: 'warning', dot: 'warning' },
  none: { key: 'com_ui_pr_checks_none', tone: 'neutral', dot: null },
};

function stateOf(
  pr: TConversationPullRequest,
): Pick<PullRequestPresentation, 'icon' | 'iconTone' | 'stateKey' | 'stateTone'> {
  if (pr.state === 'merged') {
    return {
      icon: 'merged',
      iconTone: 'neutral',
      stateKey: 'com_ui_pr_state_merged',
      stateTone: 'neutral',
    };
  }
  if (pr.state === 'closed') {
    return {
      icon: 'closed',
      iconTone: 'neutral',
      stateKey: 'com_ui_pr_state_closed',
      stateTone: 'neutral',
    };
  }
  if (pr.isDraft) {
    return {
      icon: 'draft',
      iconTone: 'neutral',
      stateKey: 'com_ui_pr_state_draft',
      stateTone: 'neutral',
    };
  }
  if (pr.mergeable === 'conflicting') {
    return {
      icon: 'open',
      iconTone: 'error',
      stateKey: 'com_ui_pr_state_conflicts',
      stateTone: 'error',
    };
  }
  return {
    icon: 'open',
    iconTone: pr.mergeable === 'clean' ? 'success' : 'neutral',
    stateKey: 'com_ui_pr_state_open',
    stateTone: 'success',
  };
}

/** The one place a pull request becomes icon, dot and badges, so the chip and card never disagree. */
export function presentPullRequest(pr: TConversationPullRequest): PullRequestPresentation {
  const checks = CHECKS[pr.checks];
  return {
    ...stateOf(pr),
    dotTone: pr.state === 'open' ? checks.dot : null,
    checksKey: checks.key,
    checksTone: checks.tone,
  };
}

export const TONE_ICON_CLASS: Record<PullRequestTone, string> = {
  success: 'text-status-success',
  error: 'text-status-error',
  warning: 'text-status-warning',
  neutral: 'text-text-secondary',
};

export const TONE_DOT_CLASS: Record<PullRequestTone, string> = {
  success: 'bg-status-success',
  error: 'bg-status-error',
  warning: 'bg-status-warning',
  neutral: 'bg-status-neutral',
};
