/**
 * Dynamic approval-policy fixture for the mock Playwright suite.
 *
 * The `review` argument selects behavior that cannot be expressed by the static
 * ask list: a restricted decision set, or an authoritative argument rewrite.
 */
module.exports = () => () => async (input) => {
  if (input.toolInput.review === 'restricted') {
    return {
      decision: 'ask',
      reason: 'E2E approval offers approve or reject only.',
      allowedDecisions: ['approve', 'reject'],
    };
  }

  if (input.toolInput.review === 'rewrite') {
    const originalValue =
      typeof input.toolInput.value === 'string' ? input.toolInput.value : 'original-missing';
    return {
      decision: 'ask',
      reason: 'E2E approval reviews rewritten arguments.',
      updatedInput: {
        value: originalValue.replace(/^original-/, 'rewritten-'),
      },
    };
  }

  return {};
};
