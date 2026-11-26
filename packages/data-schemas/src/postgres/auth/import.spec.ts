import type { AuthenticationSnapshotSource } from './import';
import { fingerprintAuthentication } from './import';

const source = (metadata: Record<string, unknown>): AuthenticationSnapshotSource =>
  async function* () {
    yield {
      kind: 'tokens',
      values: {
        id: '0123456789abcdef01234567',
        user_id: '0123456789abcdef01234567',
        tenant_id: null,
        email: null,
        type: null,
        scope: null,
        identifier: null,
        token: 'token',
        metadata,
        revision: 0,
        created_at: new Date('2026-01-01'),
        expires_at: new Date('2026-02-01'),
      },
    };
  };

it('fingerprints nested metadata by code unit order, including canonically equivalent keys', async () => {
  const original = await fingerprintAuthentication(source({ nested: { é: 1, 'e\u0301': 2 } }));
  await expect(
    fingerprintAuthentication(source({ nested: { 'e\u0301': 2, é: 1 } })),
  ).resolves.toEqual(original);
  await expect(
    fingerprintAuthentication(source({ nested: { 'e\u0301': 1, é: 2 } })),
  ).resolves.not.toEqual(original);
});
