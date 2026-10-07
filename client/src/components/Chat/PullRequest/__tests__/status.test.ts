import type { TConversationPullRequest } from 'librechat-data-provider';
import { presentPullRequest } from '../status';

const base: TConversationPullRequest = {
  number: 1,
  title: 'Simplify single tool',
  url: 'https://github.com/o/r/pull/1',
  additions: 1234,
  deletions: 56,
  state: 'open',
  isDraft: false,
  mergeable: 'clean',
  checks: 'passing',
};
const make = (overrides: Partial<TConversationPullRequest>) => ({ ...base, ...overrides });

describe('presentPullRequest', () => {
  it('shows an open pull request with no conflicts as ready to merge', () => {
    expect(presentPullRequest(base)).toMatchObject({
      icon: 'open',
      iconTone: 'success',
      dotTone: 'success',
      stateKey: 'com_ui_pr_state_open',
      stateTone: 'success',
      checksKey: 'com_ui_pr_checks_passing',
      checksTone: 'success',
    });
  });

  it('shows merge conflicts as an error on the icon and the state badge', () => {
    expect(presentPullRequest(make({ mergeable: 'conflicting' }))).toMatchObject({
      icon: 'open',
      iconTone: 'error',
      stateKey: 'com_ui_pr_state_conflicts',
      stateTone: 'error',
    });
  });

  it('shows a draft with the draft icon and no signal color, whatever its conflicts', () => {
    for (const mergeable of ['clean', 'conflicting', 'unknown'] as const) {
      expect(presentPullRequest(make({ isDraft: true, mergeable }))).toMatchObject({
        icon: 'draft',
        iconTone: 'neutral',
        stateKey: 'com_ui_pr_state_draft',
      });
    }
  });

  it('does not claim readiness while GitHub is still computing mergeability', () => {
    expect(presentPullRequest(make({ mergeable: 'unknown' }))).toMatchObject({
      icon: 'open',
      iconTone: 'neutral',
      stateKey: 'com_ui_pr_state_open',
    });
  });

  it.each([
    ['merged', 'merged', 'com_ui_pr_state_merged'],
    ['closed', 'closed', 'com_ui_pr_state_closed'],
  ] as const)('shows a %s pull request with its own icon', (state, icon, stateKey) => {
    expect(presentPullRequest(make({ state, mergeable: 'unknown' }))).toMatchObject({
      icon,
      iconTone: 'neutral',
      stateKey,
      stateTone: 'neutral',
    });
  });

  it.each([
    ['passing', 'success', 'success'],
    ['failing', 'error', 'error'],
    ['running', 'warning', 'warning'],
  ] as const)('maps %s checks to the %s dot', (checks, dotTone, checksTone) => {
    expect(presentPullRequest(make({ checks }))).toMatchObject({ dotTone, checksTone });
  });

  it('shows no dot when the repository reports no checks', () => {
    expect(presentPullRequest(make({ checks: 'none' }))).toMatchObject({
      dotTone: null,
      checksKey: 'com_ui_pr_checks_none',
      checksTone: 'neutral',
    });
  });

  it('drops the CI dot once the pull request is no longer open', () => {
    expect(presentPullRequest(make({ state: 'merged', checks: 'passing' })).dotTone).toBeNull();
    expect(presentPullRequest(make({ state: 'closed', checks: 'failing' })).dotTone).toBeNull();
  });
});
