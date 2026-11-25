import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';
import { getMongoUri } from '../db';

/**
 * A retention purge that removes every entry of a tenant's audit chain leaves
 * its own `audit.purged` record behind. That record must continue the deleted
 * history rather than start a fresh chain at the genesis hash, so the chain
 * only verifies with the checkpoint the purge returned. The probe drives the
 * built @librechat/data-schemas methods against this run's database, on a
 * tenant chain of its own that it removes afterwards.
 */

type Verification = { ok: boolean; reason?: string; range?: { firstSeq: number; lastSeq: number } };

type Outcome = {
  tailHash: string;
  result: { deletedCount: number; checkpoint?: { throughSeq: number; prevHash: string } };
  remaining: { seq: number; action: string; prevHash: string }[];
  unverified: Verification;
  verified: Verification;
};

function probe(tenantId: string): Outcome {
  const body = `
const mongoose = require('mongoose');
const { createModels, createMethods } = require('@librechat/data-schemas');
const tenantId = ${JSON.stringify(tenantId)};
(async () => {
  await mongoose.connect(${JSON.stringify(getMongoUri())});
  createModels(mongoose);
  const methods = createMethods(mongoose);
  const AuditLog = mongoose.models.AuditLog;
  const entry = (i) => ({
    action: 'grant.assigned',
    actor: { type: 'user', name: 'E2E Admin' },
    target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
    metadata: { capability: 'cap:' + i },
    tenantId,
  });
  let chainKey;
  try {
    for (let i = 0; i < 3; i++) {
      await methods.recordAuditEntry(entry(i), { failClosed: true });
    }
    const tail = await AuditLog.findOne({ tenantId }).sort({ seq: -1 }).lean();
    chainKey = tail.chainKey;
    const result = await methods.purgeAuditLogEntries(tenantId, {
      before: new Date(Date.now() + 60000),
      confirm: true,
    });
    const remaining = await AuditLog.find({ chainKey })
      .sort({ seq: 1 })
      .select('seq action prevHash -_id')
      .lean();
    const unverified = await methods.verifyAuditChain(tenantId);
    const verified = await methods.verifyAuditChain(tenantId, {
      trustedCheckpoint: result.checkpoint,
    });
    process.stdout.write(
      'RESULT' + JSON.stringify({ tailHash: tail.hash, result, remaining, unverified, verified }),
    );
  } finally {
    if (chainKey) {
      await AuditLog.collection.deleteMany({ chainKey });
    }
    await mongoose.disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
`;
  const result = run('node', ['-e', body], { cwd: resolve(repoRoot, 'api') });
  expect(result.status, result.output).toBe(0);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('RESULT') + 'RESULT'.length));
}

test.describe('audit log retention purge', () => {
  test.beforeEach(() => inOneProject());

  test('a purge that empties a chain keeps its record tied to the deleted history @scenario:full-audit-purge-keeps-chain-continuity', () => {
    test.setTimeout(120_000);
    const outcome = probe(`e2e-audit-purge-${randomUUID()}`);

    expect(outcome.result.deletedCount).toBe(3);
    expect(outcome.result.checkpoint).toEqual({ throughSeq: 3, prevHash: outcome.tailHash });
    expect(outcome.remaining).toEqual([
      { seq: 4, action: 'audit.purged', prevHash: outcome.tailHash },
      { seq: 5, action: 'audit.purged', prevHash: expect.any(String) },
    ]);
    expect(outcome.unverified.ok).toBe(false);
    expect(outcome.unverified.reason).toMatch(/non-genesis/);
    expect(outcome.verified).toMatchObject({ ok: true, range: { firstSeq: 4, lastSeq: 5 } });
  });
});
