import { win32 } from 'node:path';
import { execFileSync } from 'node:child_process';

const control = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:LIBRECHAT_ACL_TEST_PATH
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
if ($env:LIBRECHAT_ACL_TEST_GRANT) {
  $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $acl.SetOwner($me)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,
    $env:LIBRECHAT_ACL_TEST_GRANT, $env:LIBRECHAT_ACL_TEST_INHERIT, 'None', 'Allow'))
  Set-Acl -LiteralPath $path -AclObject $acl
} else {
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $entries = @($raw.DiscretionaryAcl | ForEach-Object {
    @{ sid = $_.SecurityIdentifier.Value; flags = [int]$_.AceFlags; mask = $_.AccessMask; type = [int]$_.AceType }
  })
  @{ current = $me.Value; owner = $raw.Owner.Value; protected = $acl.AreAccessRulesProtected; entries = $entries } |
    ConvertTo-Json -Depth 4 -Compress
}
`;

interface WindowsAcl {
  current: string;
  owner: string;
  protected: boolean;
  entries: Array<{ sid: string; flags: number; mask: number; type: number }>;
}

function aclCommand(file: string, rights?: string, inherit = 'None'): string {
  return execFileSync(
    win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(control, 'utf16le').toString('base64'),
    ],
    {
      env: {
        SystemRoot: process.env.SystemRoot,
        LIBRECHAT_ACL_TEST_PATH: file,
        LIBRECHAT_ACL_TEST_GRANT: rights,
        LIBRECHAT_ACL_TEST_INHERIT: inherit,
      },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

export function inspectWindowsAcl(file: string): WindowsAcl {
  return JSON.parse(aclCommand(file)) as WindowsAcl;
}

export function grantWindowsEveryone(file: string, rights: string, inherit?: string): void {
  aclCommand(file, rights, inherit);
}

export function expectPrivateWindowsAcl(file: string, kind: 'file' | 'directory' | 'child'): void {
  const actual = inspectWindowsAcl(file);
  if (kind !== 'child') expect(actual.owner).toBe(actual.current);
  expect(actual.protected).toBe(kind !== 'child');
  expect(actual.entries).toEqual([
    {
      sid: actual.current,
      type: 0,
      flags: kind === 'directory' ? 3 : kind === 'child' ? 16 : 0,
      mask: 0x1f01ff,
    },
  ]);
}
