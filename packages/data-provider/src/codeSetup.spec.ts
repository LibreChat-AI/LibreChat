import {
  codeSetupAttemptSchema,
  codeSetupApprovalRequestSchema,
  codeSetupDenyRequestSchema,
} from './codeSetup';
import { approveCodeSetupAttempt, denyCodeSetupAttempt, getCodeSetupAttempt } from './data-service';
import * as endpoints from './api-endpoints';
import request from './request';

const attempt = {
  version: 1,
  attemptId: 'attempt-1',
  status: 'pending',
  expiresAt: '2030-01-01T00:00:00.000Z',
  verificationCode: '123456',
  machineName: 'My machine',
  workspace: { type: 'directory' },
  allowWorkspaceWrites: false,
  allowWorkspaceCommands: true,
  keyFingerprint: 'a'.repeat(64),
  controlPlanes: [{ id: 'plane-1', name: 'Control plane' }],
};

describe('browser setup contracts', () => {
  it('projects only serializable browser fields, including no path or credentials', () => {
    const parsed = codeSetupAttemptSchema.parse({
      ...attempt,
      privateKey: 'secret',
      pairingCode: 'secret',
      workerCredential: 'secret',
      workspace: { type: 'directory', path: '/private/directory' },
      controlPlanes: [{ id: 'plane-1', name: 'Control plane', endpoint: 'https://internal' }],
      failure: { code: 'provisioning_failed', retryable: true, message: 'sensitive details' },
    });
    expect(parsed).toEqual({
      ...attempt,
      failure: { code: 'provisioning_failed', retryable: true },
    });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it.each(['a'.repeat(63), 'A'.repeat(64), 'SHA256:base64', 'not-a-fingerprint'])(
    'rejects a fingerprint outside the server SHA-256 DER SPKI hex contract: %s',
    (keyFingerprint) => {
      expect(codeSetupAttemptSchema.safeParse({ ...attempt, keyFingerprint }).success).toBe(false);
    },
  );

  it('rejects unknown versions, states, expiry and workspace kinds', () => {
    for (const override of [
      { version: 2 },
      { status: 'ready' },
      { expiresAt: 'tomorrow' },
      { workspace: { type: 'remote', path: '/local' } },
    ]) {
      expect(codeSetupAttemptSchema.safeParse({ ...attempt, ...override }).success).toBe(false);
    }
  });

  it('only accepts a control-plane approval and an empty denial', () => {
    expect(codeSetupApprovalRequestSchema.parse({ controlPlaneId: 'plane-1' })).toEqual({
      controlPlaneId: 'plane-1',
    });
    expect(
      codeSetupApprovalRequestSchema.safeParse({ controlPlaneId: 'plane-1', approve: true })
        .success,
    ).toBe(false);
    expect(codeSetupApprovalRequestSchema.safeParse({ controlPlaneId: '' }).success).toBe(false);
    expect(codeSetupDenyRequestSchema.parse({})).toEqual({});
    expect(codeSetupDenyRequestSchema.safeParse({ controlPlaneId: 'plane-1' }).success).toBe(false);
  });
});

describe('browser setup transport', () => {
  it('encodes every attempt ID as one URL segment', () => {
    expect(endpoints.codeSetupAttempt('a/b?c#d')).toBe(
      '/api/code-environments/setup/a%2Fb%3Fc%23d',
    );
    expect(endpoints.codeSetupApprove('a/b')).toBe('/api/code-environments/setup/a%2Fb/approve');
    expect(endpoints.codeSetupDeny('a/b')).toBe('/api/code-environments/setup/a%2Fb/deny');
  });

  it('reads and validates the browser projection', async () => {
    const get = jest.spyOn(request, 'get').mockResolvedValue({ ...attempt, credential: 'secret' });
    await expect(getCodeSetupAttempt('attempt-1')).resolves.toEqual(attempt);
    expect(get).toHaveBeenCalledWith('/api/code-environments/setup/attempt-1');
  });

  it('rejects a response belonging to a different setup attempt', async () => {
    jest.spyOn(request, 'get').mockResolvedValue({ ...attempt, attemptId: 'other-attempt' });
    await expect(getCodeSetupAttempt('attempt-1')).rejects.toThrow('does not match');
  });

  it('sends only the explicit approval body and empty denial body', async () => {
    const post = jest.spyOn(request, 'post').mockResolvedValue(attempt);
    await approveCodeSetupAttempt('attempt-1', { controlPlaneId: 'plane-1' });
    expect(post).toHaveBeenCalledWith('/api/code-environments/setup/attempt-1/approve', {
      controlPlaneId: 'plane-1',
    });
    await denyCodeSetupAttempt('attempt-1');
    expect(post).toHaveBeenCalledWith('/api/code-environments/setup/attempt-1/deny', {});
  });
});
