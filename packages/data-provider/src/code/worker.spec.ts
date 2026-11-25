import { createCodeWorkerSetupCommand, isCodeWorkerShell } from './worker';

const pairing = {
  endpoint: 'https://code.example.com/v1',
  code: "one-time'code",
  workerId: "worker'one",
  expiresAt: '2026-09-04T15:00:00.000Z',
};

describe('createCodeWorkerSetupCommand', () => {
  it('creates a POSIX and WSL2 command for the native default workspace', () => {
    expect(
      createCodeWorkerSetupCommand(pairing, 'posix', {
        allowWorkspaceWrites: true,
        allowWorkspaceCommands: true,
      }),
    ).toBe(
      "librechat-code pair 'https://code.example.com/v1' 'one-time'\\''code' --worker-id 'worker'\\''one'\n" +
        "LIBRECHAT_CODE_WORKER_ID='worker'\\''one' librechat-code run --default-workspace --allow-workspace-writes --allow-workspace-commands",
    );
  });

  it('creates a PowerShell command without POSIX quoting', () => {
    expect(
      createCodeWorkerSetupCommand(pairing, 'powershell', {
        allowWorkspaceWrites: true,
        allowWorkspaceCommands: true,
      }),
    ).toBe(
      "librechat-code pair 'https://code.example.com/v1' 'one-time''code' --worker-id 'worker''one'\n" +
        "$env:LIBRECHAT_CODE_WORKER_ID = 'worker''one'\n" +
        'librechat-code run --default-workspace --allow-workspace-writes --allow-workspace-commands',
    );
  });

  it('defaults to a read-only default workspace command', () => {
    expect(createCodeWorkerSetupCommand(pairing, 'posix')).toContain(
      'librechat-code run --default-workspace',
    );
    expect(createCodeWorkerSetupCommand(pairing, 'posix')).not.toContain(
      '--allow-workspace-writes',
    );
    expect(createCodeWorkerSetupCommand(pairing, 'posix')).not.toContain(
      '--allow-workspace-commands',
    );
  });

  it('validates shell values at runtime', () => {
    expect(isCodeWorkerShell('posix')).toBe(true);
    expect(isCodeWorkerShell('powershell')).toBe(true);
    expect(isCodeWorkerShell('cmd')).toBe(false);
  });
});
