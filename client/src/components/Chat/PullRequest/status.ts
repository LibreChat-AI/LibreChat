import type { PullRequestProvider, TConversationPullRequest } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

export type PullRequestTone = 'success' | 'error' | 'warning' | 'neutral' | 'merged';

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
  provider: PullRequestProvider;
  /** What the provider calls it ("Merge request" on GitLab), and its short label ("MR !7"). */
  nounKey: TranslationKeys;
  labelKey: TranslationKeys;
  /** Names the provider the card's link opens. */
  openKey: TranslationKeys;
};

const PROVIDERS: Record<
  PullRequestProvider,
  Pick<PullRequestPresentation, 'nounKey' | 'labelKey' | 'openKey'>
> = {
  github: {
    nounKey: 'com_ui_pull_request',
    labelKey: 'com_ui_pr_label',
    openKey: 'com_ui_pr_open_in_github',
  },
  gitlab: {
    nounKey: 'com_ui_merge_request',
    labelKey: 'com_ui_pr_label_gitlab',
    openKey: 'com_ui_pr_open_in_gitlab',
  },
  bitbucket: {
    nounKey: 'com_ui_pull_request',
    labelKey: 'com_ui_pr_label',
    openKey: 'com_ui_pr_open_in_bitbucket',
  },
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
      iconTone: 'merged',
      stateKey: 'com_ui_pr_state_merged',
      stateTone: 'merged',
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
  /** A server from before providers sends none, and only knew GitHub. */
  const provider = pr.provider ?? 'github';
  return {
    ...stateOf(pr),
    ...PROVIDERS[provider],
    provider,
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
  merged: 'text-brand-purple',
};

export const TONE_DOT_CLASS: Record<PullRequestTone, string> = {
  success: 'bg-status-success',
  error: 'bg-status-error',
  warning: 'bg-status-warning',
  neutral: 'bg-status-neutral',
  merged: 'bg-brand-purple',
};
