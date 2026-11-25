import type { TCodeEnvironmentPairingResponse } from '../types';

export type CodeWorkerShell = 'posix' | 'powershell';
export type CodeWorkerPairing = TCodeEnvironmentPairingResponse['pairing'];

export interface CodeWorkerRunOptions {
  defaultWorkspace?: boolean;
  allowWorkspaceWrites?: boolean;
  allowWorkspaceCommands?: boolean;
}

export function isCodeWorkerShell(value: string): value is CodeWorkerShell {
  return value === 'posix' || value === 'powershell';
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function createCodeWorkerSetupCommand(
  pairing: CodeWorkerPairing,
  shell: CodeWorkerShell,
  options: CodeWorkerRunOptions = {},
): string {
  const quote = shell === 'powershell' ? quotePowerShell : quotePosix;
  const pair = `librechat-code pair ${quote(pairing.endpoint)} ${quote(pairing.code)} --worker-id ${quote(pairing.workerId)}`;
  const runArgs = [
    options.defaultWorkspace === false ? null : '--default-workspace',
    options.allowWorkspaceWrites === true ? '--allow-workspace-writes' : null,
    options.allowWorkspaceCommands === true ? '--allow-workspace-commands' : null,
  ].filter((value): value is string => value != null);
  const run = ['librechat-code run', ...runArgs].join(' ');

  if (shell === 'powershell') {
    return `${pair}\n$env:LIBRECHAT_CODE_WORKER_ID = ${quote(pairing.workerId)}\n${run}`;
  }

  return `${pair}\nLIBRECHAT_CODE_WORKER_ID=${quote(pairing.workerId)} ${run}`;
}
