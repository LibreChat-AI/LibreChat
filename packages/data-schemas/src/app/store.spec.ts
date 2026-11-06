import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { ConfigDraft, ConfigRecord, ConfigMutationIO } from './store';
import {
  runConfigMutation,
  getConfigRevision,
  getConfigRetryDelay,
  CONFIG_WRITE_ATTEMPTS,
  ABSENT_CONFIG_REVISION,
  isConfigRevisionConflict,
  ConfigRevisionConflictError,
} from './store';

const draft: ConfigDraft = {
  principalModel: PrincipalModel.ROLE,
  priority: 10,
  overrides: {},
  tombstones: [],
  isActive: true,
};

function toRecord(next: ConfigDraft, configVersion: number): ConfigRecord {
  return {
    ...next,
    _id: 'doc',
    principalType: PrincipalType.ROLE,
    principalId: 'editor',
    configVersion,
  };
}

/**
 * One document behind the {@link ConfigMutationIO} contract. The first `losses` writes find
 * that another writer got there first (the stored version moves on), as a concurrent admin
 * would cause; every read and write is timestamped.
 */
function createContendedDocument(losses: number) {
  let stored: ConfigRecord | null = null;
  let remaining = losses;
  const reads: number[] = [];
  const conflicts: number[] = [];
  const io: ConfigMutationIO = {
    async read() {
      reads.push(performance.now());
      return stored;
    },
    async write(next, expected) {
      if (remaining > 0) {
        remaining -= 1;
        stored = toRecord(draft, (stored?.configVersion ?? 0) + 1);
        conflicts.push(performance.now());
        throw new ConfigRevisionConflictError(getConfigRevision(stored));
      }
      const current = stored ? getConfigRevision(stored) : ABSENT_CONFIG_REVISION;
      if (expected !== current) {
        throw new ConfigRevisionConflictError(stored ? current : null);
      }
      stored = toRecord(next, (stored?.configVersion ?? 0) + 1);
      return stored;
    },
  };
  return { io, reads, conflicts };
}

describe('getConfigRetryDelay', () => {
  it.each([
    [1, 10, 20],
    [2, 20, 40],
    [3, 40, 80],
    [4, 80, 160],
    [5, 100, 200],
    [12, 100, 200],
  ])('pauses retry %i between %i and %i ms', (attempt, low, high) => {
    expect(getConfigRetryDelay(attempt, () => 0)).toBe(low);
    expect(getConfigRetryDelay(attempt, () => 1)).toBe(high);
    const sampled = getConfigRetryDelay(attempt);
    expect(sampled).toBeGreaterThanOrEqual(low);
    expect(sampled).toBeLessThanOrEqual(high);
  });

  it('spreads writers that lost the same race', () => {
    const delays = new Set(Array.from({ length: 50 }, () => getConfigRetryDelay(1)));

    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('runConfigMutation retries', () => {
  it('pauses before re-reading after a lost race, then writes on the fresh revision', async () => {
    const { io, reads, conflicts } = createContendedDocument(1);

    const outcome = await runConfigMutation(io, () => ({ draft }));

    expect(outcome.written).toBe(true);
    expect(reads).toHaveLength(2);
    expect(reads[1] - conflicts[0]).toBeGreaterThanOrEqual(9);
    expect(outcome.written && outcome.record.configVersion).toBe(2);
  });

  it('gives up with a conflict once every attempt has lost', async () => {
    const { io, reads } = createContendedDocument(CONFIG_WRITE_ATTEMPTS);

    const error = await runConfigMutation(io, () => ({ draft })).catch((caught) => caught);

    expect(isConfigRevisionConflict(error)).toBe(true);
    expect(reads).toHaveLength(CONFIG_WRITE_ATTEMPTS);
  });

  it('does not retry a write conditioned on a client revision', async () => {
    const { io, reads } = createContendedDocument(1);

    const error = await runConfigMutation(io, () => ({ draft }), {
      expectedRevision: ABSENT_CONFIG_REVISION,
    }).catch((caught) => caught);

    expect(isConfigRevisionConflict(error)).toBe(true);
    expect(reads).toHaveLength(1);
  });
});
