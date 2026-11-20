import { ReasoningEffort } from 'librechat-data-provider';
import {
  persistedReasoningOverrideFields,
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
    { key: 'thinkingBudget', value: -2 },
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

describe('persistedReasoningOverrideFields', () => {
  it('carries a fresh turn override as a message field', () => {
    expect(
      persistedReasoningOverrideFields({
        rawReasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      }),
    ).toEqual({ reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high } });
  });

  it('adds no field for an edit, a compaction or an invalid payload', () => {
    const rawReasoningOverride = { key: 'reasoning_effort', value: ReasoningEffort.high };
    expect(persistedReasoningOverrideFields({ rawReasoningOverride, isEdited: true })).toEqual({});
    expect(persistedReasoningOverrideFields({ rawReasoningOverride, isCompaction: true })).toEqual(
      {},
    );
    expect(persistedReasoningOverrideFields({ rawReasoningOverride: { key: 'x' } })).toEqual({});
  });
});
