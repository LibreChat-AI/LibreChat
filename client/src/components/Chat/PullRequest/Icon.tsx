import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import type { PullRequestIcon as IconName, PullRequestTone } from './status';
import { TONE_ICON_CLASS } from './status';
import { cn } from '~/utils';

const ICONS = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const;

/** Decorative: the surrounding label already says what state the pull request is in. */
export default function PullRequestIcon({
  icon,
  tone,
  className,
}: {
  icon: IconName;
  tone: PullRequestTone;
  className?: string;
}) {
  const Icon = ICONS[icon];
  return <Icon aria-hidden="true" className={cn(TONE_ICON_CLASS[tone], className)} />;
}
