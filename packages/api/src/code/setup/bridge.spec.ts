import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  hashBrowserEnrollmentRequest,
  isBrowserEnrollmentApproval,
  isBrowserEnrollmentStatusRequest,
  isBrowserEnrollmentRedemption,
  signBrowserEnrollmentRedemption,
} from '@librechat/code/browser-enrollment';
import type { BrowserEnrollmentApproval } from '@librechat/code/browser-enrollment';
import { createSetupBridge, setupRedemptionContract } from './bridge';

function approval(): BrowserEnrollmentApproval {
  const publicKey = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
  const request = {
    version: 1 as const,
    instance: 'https://chat.example.test/base',
    attemptId: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
    publicKey,
    machineName: 'A machine',
    workspace: { type: 'private' as const },
    allowWorkspaceWrites: false,
    allowWorkspaceCommands: false,
  };
  return {
    protocolVersion: 1,
    operation: 'enrollment.redeem',
    serverId: 'https://code.example.test',
    instance: request.instance,
    attemptId: request.attemptId,
    requestHash: hashBrowserEnrollmentRequest(request),
    workerId: 'stable-worker',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    publicKey,
    binding: { tenantId: 'legacy', principal: { type: 'user', id: 'owner-one' } },
  };
}

test('the local server dependency is the unmodified merged protocol, not a mutable or unpublished reference', () => {
  const root = path.resolve(__dirname, '../../../../../vendor/code');
  const source = fs.readFileSync(path.join(root, 'browser-enrollment-protocol.ts'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(metadata.librechatUpstream.commit).toBe('a3207a75c8327ba1c9526eff8b06f3588f3739ed');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '1ecf23023f7cf482eb140dc327b2400331f18d1c50f04ba037afca6186b97a99',
  );
});

test('the administrator transport uses strict flat approval, status, and redemption projections', async () => {
  const approved = approval();
  const fetchImpl = jest.fn(
    async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(init?.headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer server-only' }),
      );
      expect(init?.redirect).toBe('error');
      const body: unknown = JSON.parse(String(init?.body));
      if (String(url).endsWith('/status')) {
        expect(isBrowserEnrollmentStatusRequest(body)).toBe(true);
        expect(body).toEqual({ protocolVersion: 1, ...setupRedemptionContract(approved) });
        return Response.json({
          protocolVersion: 1,
          status: 'completed',
          workerId: approved.workerId,
        });
      }
      if (String(url).endsWith('/redeem')) {
        expect(isBrowserEnrollmentRedemption(body)).toBe(true);
        return Response.json({}, { status: 409 });
      }
      expect(isBrowserEnrollmentApproval(body)).toBe(true);
      expect(body).toEqual(approved);
      return Response.json(approved);
    },
  );
  const bridge = createSetupBridge(fetchImpl);
  await bridge.issue('https://code.example.test/v1', 'server-only', approved);
  await expect(
    bridge.status('https://code.example.test/v1', 'server-only', approved),
  ).resolves.toBe('completed');
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const signature = signBrowserEnrollmentRedemption(key, approved);
  await expect(
    bridge.redeem('https://code.example.test/v1', 'server-only', approved, signature),
  ).rejects.toMatchObject({ status: 409 });
});

test('unsupported capabilities, changed server identities, and oversized provider responses fail closed', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(Response.json({ browserEnrollmentVersion: 2 }))
    .mockResolvedValueOnce(
      Response.json({ browserEnrollmentVersion: 1, serverId: 'https://other.example.test' }),
    )
    .mockResolvedValueOnce(new Response('x'.repeat(16 * 1024 + 1)));
  const bridge = createSetupBridge(fetchImpl);
  await expect(
    bridge.capabilities('https://code.example.test/v1', 'server-only'),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    bridge.capabilities('https://code.example.test/v1', 'server-only'),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    bridge.status('https://code.example.test/v1', 'server-only', approval()),
  ).rejects.toMatchObject({ status: 502 });
});
