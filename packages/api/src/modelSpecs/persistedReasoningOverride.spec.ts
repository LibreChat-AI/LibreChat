import { ReasoningEffort } from 'librechat-data-provider';
import {
  resolvePersistedReasoningOverride,
  type PersistedReasoningOverride,
  type PersistedReasoningOverrideInput,
} from './persistedReasoningOverride';

const resolve = (
  overrides: Partial<PersistedReasoningOverrideInput> = {},
): PersistedReasoningOverride =>
  resolvePersistedReasoningOverride({
    rawReasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
    ...overrides,
  });

describe('resolvePersistedReasoningOverride', () => {
  it('returns the schema-normalized override for a fresh turn', () => {
    expect(resolve()).toEqual({ key: 'reasoning_effort', value: ReasoningEffort.high });
  });

  it.each([
    undefined,
    null,
    { key: 'model', value: 'secret-model' },
    { key: 'thinkingBudget', value: 200001 },
  ])('omits an invalid request override: %o', (rawReasoningOverride) => {
    expect(resolve({ rawReasoningOverride })).toBeUndefined();
  });

  it.each([
    ['edited', { isEdited: true }],
    ['compaction', { isCompaction: true }],
  ])('omits the override on a %s turn', (_name, flags) => {
    expect(resolve(flags)).toBeUndefined();
  });
});
