import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { windowsPowerShell } from './windowsPrivate';

const control = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:LIBRECHAT_ACL_TEST_PATH
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = [IO.Directory]::Exists($path)
$acl = if ($directory) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
if ($env:LIBRECHAT_ACL_TEST_GRANT) {
  $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $acl.SetOwner($me)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,
    $env:LIBRECHAT_ACL_TEST_GRANT, $env:LIBRECHAT_ACL_TEST_INHERIT, 'None', 'Allow'))
  if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) }
  else { [IO.File]::SetAccessControl($path, $acl) }
} else {
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  [Console]::WriteLine(('{0} {1} {2}' -f $me.Value, $raw.Owner.Value, [int]$acl.AreAccessRulesProtected))
  foreach ($ace in $raw.DiscretionaryAcl) {
    [Console]::WriteLine(('{0} {1} {2} {3}' -f $ace.SecurityIdentifier.Value, [int]$ace.AceType,
      [int]$ace.AceFlags, $ace.AccessMask))
  }
}
`;

interface WindowsAcl {
  current: string;
  owner: string;
  protected: boolean;
  entries: Array<{ sid: string; flags: number; mask: number; type: number }>;
}

function aclCommand(file: string, rights?: string, inherit = 'None'): string {
  const { executable, cwd, env } = windowsPowerShell();
  const result = spawnSync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'Text',
      '-EncodedCommand',
      Buffer.from(control, 'utf16le').toString('base64'),
    ],
    {
      cwd,
      env: {
        ...env,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        LIBRECHAT_ACL_TEST_PATH: file,
        LIBRECHAT_ACL_TEST_GRANT: rights,
        LIBRECHAT_ACL_TEST_INHERIT: inherit,
      },
      encoding: 'utf8',
      input: '\n',
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows ACL test command failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.status}).`,
    );
  }
  return result.stdout;
}

export function inspectWindowsAcl(file: string): WindowsAcl {
  const [header, ...rows] = aclCommand(file).trim().split(/\r?\n/);
  const [current, owner, protectedFlag] = header.split(' ');
  if (!current || !owner || (protectedFlag !== '0' && protectedFlag !== '1')) {
    throw new Error('Invalid Windows ACL fixture output.');
  }
  const entries = rows.map((row) => {
    const [sid, type, flags, mask] = row.split(' ');
    return { sid, type: Number(type), flags: Number(flags), mask: Number(mask) };
  });
  return { current, owner, protected: protectedFlag === '1', entries };
}

export function grantWindowsEveryone(file: string, rights: string, inherit?: string): void {
  aclCommand(file, rights, inherit);
}

export function expectPrivateWindowsAcl(file: string, kind: 'file' | 'directory' | 'child'): void {
  const flags = { file: 0, directory: 3, child: 16 };
  const actual = inspectWindowsAcl(file);
  if (kind !== 'child') expect(actual.owner).toBe(actual.current);
  expect(actual.protected).toBe(kind !== 'child');
  expect(actual.entries).toEqual([
    {
      sid: actual.current,
      type: 0,
      flags: flags[kind],
      mask: 0x1f01ff,
    },
  ]);
}
