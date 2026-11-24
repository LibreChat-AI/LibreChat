import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync, promises as fs } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';

// Windows PowerShell is part of Windows. Paths are data; only this fixed script is executed.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:failureStage = 6
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') # SYSTEM, Administrators, TrustedInstaller

function Descriptor($security) {
  return [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
}

function PrivateAcl([bool] $directory) {
  if ($directory) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $identity, 'FullControl', $inherit, 'None', 'Allow'))
  return $acl
}

function IsPrivate($security, [bool] $directory) {
  $sd = Descriptor $security
  $flags = if ($directory) { 3 } else { 0 } # ObjectInherit | ContainerInherit
  if (!$sd.Owner.Equals($identity) -or !([int]$sd.ControlFlags -band 0x1000) -or
      $null -eq $sd.DiscretionaryAcl -or $sd.DiscretionaryAcl.Count -ne 1) { return $false }
  $ace = $sd.DiscretionaryAcl[0]
  return $ace.AceType -eq 'AccessAllowed' -and [int]$ace.AceFlags -eq $flags -and
    $ace.SecurityIdentifier.Equals($identity) -and $ace.AccessMask -eq 0x1f01ff
}

function CheckPath([string] $path) {
  if ($path -notmatch '^[A-Za-z]:\\' -or $path.Substring(2) -match '[/:*?"<>|]' -or
      $path -match '(?:[ .]\\|[ .]$|[\x00-\x1f])' -or
      $path -match '\\(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|\\|$)' -or
      ![IO.Path]::GetFullPath($path).Equals($path, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Not a local filesystem path'
  }
  $drive = [IO.DriveInfo]::new($path.Substring(0, 3))
  if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -notin @('NTFS', 'ReFS')) {
    throw 'Unsupported filesystem'
  }
}

function CheckParent([string] $path) {
  $script:failureStage = 7
  CheckPath $path
  $dirs = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  $dir = [IO.DirectoryInfo]::new($path).Parent
  while ($null -ne $dir) { $dirs.Push($dir); $dir = $dir.Parent }
  foreach ($dir in $dirs) {
    if (!$dir.Exists -or ([int]$dir.Attributes -band [int][IO.FileAttributes]::ReparsePoint)) {
      throw 'Invalid parent directory'
    }
    $sd = Descriptor ($dir.GetAccessControl('Access, Owner'))
    if ($sd.Owner.Value -notin $trusted) { throw 'Untrusted parent directory' }
    # FILE_WRITE_DATA (CreateFiles on directories) also permits reparse-point writes.
    CheckWriteAuthority $sd 0x500d0142
  }
}

function CheckWriteAuthority($sd, [int] $mask) {
  if ($null -eq $sd.DiscretionaryAcl) { throw 'Missing discretionary ACL' }
  foreach ($ace in $sd.DiscretionaryAcl) {
    if ([int]$ace.AceFlags -band 8) { continue } # InheritOnly
    if ($ace -isnot [Security.AccessControl.QualifiedAce]) { throw 'Unknown ACE' }
    if ($ace.AceQualifier -eq 'AccessAllowed' -and ($ace.AccessMask -band $mask) -and
        $ace.SecurityIdentifier.Value -notin $trusted) { throw 'Unrelated write authority' }
  }
}

function PrivateDirectory([string] $path) {
  CheckParent $path
  $dir = [IO.DirectoryInfo]::new($path)
  $script:failureStage = 8
  $dir.Create((PrivateAcl $true))
  $script:failureStage = 9
  $dir.Refresh()
  if (([int]$dir.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -or
      !(IsPrivate ($dir.GetAccessControl('Access, Owner')) $true)) { throw 'Directory is not private' }
}

# Bind the four kernel calls in memory. Add-Type invokes a compiler on Windows PowerShell.
function NativeFileApi {
  $name = [Reflection.AssemblyName]::new('LibreChat.PrivateFiles')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, 'Run')
  $type = $assembly.DefineDynamicModule($name.Name).DefineType($name.Name, 'Public, Abstract, Sealed')
  $attribute = [Runtime.InteropServices.DllImportAttribute]
  $constructor = $attribute.GetConstructor([type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@($attribute.GetField('SetLastError'),
    $attribute.GetField('ExactSpelling'), $attribute.GetField('CharSet'))
  $values = [object[]]@($true, $true, [Runtime.InteropServices.CharSet]::Unicode)
  $import = [Reflection.Emit.CustomAttributeBuilder]::new($constructor,
    [object[]]@('kernel32.dll'), $fields, $values)
  $handle = [Microsoft.Win32.SafeHandles.SafeFileHandle]
  $methods = @(
    @{ name = 'CreateFileW'; returns = $handle; parameters = [type[]]@(
      [string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]) },
    @{ name = 'GetFileInformationByHandle'; returns = [bool]; parameters = [type[]]@($handle, [IntPtr]) },
    @{ name = 'GetFileType'; returns = [uint32]; parameters = [type[]]@($handle) },
    @{ name = 'SetFileInformationByHandle'; returns = [bool]; parameters = [type[]]@(
      $handle, [int], [IntPtr], [uint32]) }
  )
  foreach ($method in $methods) {
    $binding = $type.DefineMethod($method.name, 'Public, Static, PinvokeImpl',
      $method.returns, $method.parameters)
    $binding.SetCustomAttribute($import)
    $binding.SetImplementationFlags('PreserveSig')
  }
  return $type.CreateType()
}

# Use one exclusive handle for link count, the security descriptor and file bytes.
function OpenPrivateFile($native, [string] $path, [bool] $mutate) {
  # GENERIC_READ | WRITE_DAC (| DELETE), no sharing, OPEN_EXISTING, OPEN_REPARSE_POINT.
  $access = [uint32]2147745792
  if ($mutate) { $access = $access -bor 0x10000 }
  for ($retry = 0; ; $retry++) {
    $handle = $native::CreateFileW($path, $access, 0, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
    if (!$handle.IsInvalid) { break }
    $winError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $handle.Dispose()
    if ($winError -eq 2) { return $null }
    if ($winError -ne 32 -or $retry -ge 10) { throw 'Could not open file handle' }
    [Threading.Thread]::Sleep(50)
  }
  try {
    # BY_HANDLE_FILE_INFORMATION: 13 DWORDs, with flags at 0 and link count at 40.
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
    try {
      if ($native::GetFileType($handle) -ne 1 -or !$native::GetFileInformationByHandle($handle, $info) -or
          ([Runtime.InteropServices.Marshal]::ReadInt32($info) -band 0x410) -or
          [Runtime.InteropServices.Marshal]::ReadInt32($info, 40) -ne 1) { throw 'Not a single-link disk file' }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
    return [IO.FileStream]::new($handle, 'Read')
  } catch {
    $handle.Dispose()
    throw
  }
}

function ChangeRepairFile($native, $handle, [string] $destination) {
  if ($destination) {
    # FILE_RENAME_INFO: allow replacement and use a full path with a null root handle.
    $name = [Text.Encoding]::Unicode.GetBytes($destination + [char]0)
    $offset = 2 * [IntPtr]::Size
    $buffer = [byte[]]::new($offset + 4 + $name.Length)
    $buffer[0] = 1
    [Array]::Copy([BitConverter]::GetBytes([int]($name.Length - 2)), 0, $buffer, $offset, 4)
    [Array]::Copy($name, 0, $buffer, ($offset + 4), $name.Length)
    $operation = 3
  } else {
    $buffer = [byte[]]@(1) # FILE_DISPOSITION_INFO.DeleteFile
    $operation = 4
  }
  $pin = [Runtime.InteropServices.GCHandle]::Alloc($buffer, 'Pinned')
  try {
    if (!$native::SetFileInformationByHandle($handle, $operation, $pin.AddrOfPinnedObject(), $buffer.Length)) {
      throw 'Could not update repair candidate'
    }
  } finally { $pin.Free() }
}

function ExistingFile([string] $path, [string] $operation, [string] $payload) {
  CheckParent $path
  $script:failureStage = 10
  $native = NativeFileApi
  $script:failureStage = 11
  $stream = OpenPrivateFile $native $path ($operation -ne 'read')
  if ($null -eq $stream) { exit 2 }
  try {
    $script:failureStage = 9
    $acl = $stream.GetAccessControl()
    if (!($acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($identity))) { exit 9 }
    if (!(IsPrivate $acl $false)) {
      # Do not adopt bytes that an unrelated account could have changed, or trust a DACL it could reset.
      CheckWriteAuthority (Descriptor $acl) 0x500d0116
      $acl = PrivateAcl $false
      $dacl = [Security.AccessControl.FileSecurity]::new()
      $dacl.SetSecurityDescriptorBinaryForm($acl.GetSecurityDescriptorBinaryForm(), 'Access')
      $stream.SetAccessControl($dacl)
      if (!(IsPrivate ($stream.GetAccessControl()) $false)) { exit 9 }
    }
    $script:failureStage = 12
    if ($operation -eq 'read') {
      $stream.CopyTo([Console]::OpenStandardOutput())
    } else {
      $sha256 = [Security.Cryptography.SHA256]::Create()
      try { $digest = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
      finally { $sha256.Dispose() }
      if ($digest -ne $payload) { exit 2 }
      $destination = $null
      if ($operation -eq 'promote') {
        $destination = $env:LIBRECHAT_PRIVATE_STAGE
        CheckPath $destination
        if ($path -ne ($destination + '.lock')) { exit 1 }
      }
      ChangeRepairFile $native $stream.SafeFileHandle $destination
    }
  } finally { $stream.Dispose() }
}

try {
  $target = $env:LIBRECHAT_PRIVATE_TARGET
  $operation = $env:LIBRECHAT_PRIVATE_OPERATION
  $payload = if ($operation -in 'publish', 'promote', 'remove') { @($input)[0] }
  switch ($operation) {
    'directory' { PrivateDirectory $target }
    { $_ -in 'read', 'promote', 'remove' } { ExistingFile $target $operation $payload }
    'publish' {
      CheckParent $target
      $stage = $env:LIBRECHAT_PRIVATE_STAGE
      CheckPath $stage
      if ([IO.Path]::GetDirectoryName($stage) -ne [IO.Path]::GetDirectoryName($target)) { exit 1 }
      $script:failureStage = 8
      $stream = [IO.FileStream]::new($stage, 'CreateNew', 'FullControl', 'None', 4096, 'None', (PrivateAcl $false))
      $staged = $true
      try {
        try {
          $script:failureStage = 9
          if (!(IsPrivate ($stream.GetAccessControl()) $false)) { exit 9 }
          $script:failureStage = 12
          if (!$payload) { exit 1 }
          $bytes = [Convert]::FromBase64String($payload)
          $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
        try {
          [IO.File]::Move($stage, $target)
          $staged = $false
        } catch {
          if (($_.Exception.InnerException.HResult -band 0xffff) -in @(80, 183)) { exit 3 }
          throw
        }
      } finally { if ($staged) { [IO.File]::Delete($stage) } }
    }
    default { exit 1 }
  }
} catch {
  # Only return fixed diagnostics, never exception messages or input data.
  if ($_.Exception.Message -in @('Not a local filesystem path', 'Unsupported filesystem',
      'Invalid parent directory', 'Untrusted parent directory', 'Unknown ACE',
      'Missing discretionary ACL', 'Unrelated write authority', 'Directory is not private')) { exit 5 }
  exit $script:failureStage
}
exit 0
`;

const failureReasons: Record<number, string> = {
  5: 'path policy',
  6: 'initialization',
  7: 'inspect parent',
  8: 'create object',
  9: 'verify descriptor',
  10: 'load native file API',
  11: 'open handle',
  12: 'transfer bytes',
};

function failure(status?: number | null, launch = false): Error {
  const message = 'Unable to guarantee private access on Windows.';
  const reason = launch ? 'launcher' : failureReasons[status ?? 0];
  return new Error(reason ? `${message} (${reason})` : message);
}

function checkCanonical(requested: string, resolved: string): void {
  // Reject alternate drive mappings, short names and reparse paths rather than blessing their targets.
  if (requested.toLowerCase() !== resolved.toLowerCase()) throw failure();
}

let encodedScript: string | undefined;

export function windowsPowerShell() {
  const root = process.env.SystemRoot ?? '';
  if (!/^[a-z]:\\[^/]+$/i.test(root) || win32.normalize(root) !== root) throw failure();
  const system = win32.join(root, 'System32');
  const home = win32.join(system, 'WindowsPowerShell', 'v1.0');
  const env: NodeJS.ProcessEnv = {
    SystemRoot: root,
    SystemDrive: win32.parse(root).root.slice(0, 2),
    windir: root,
    PATH: `${system};${root}`,
    PSModulePath: win32.join(home, 'Modules'),
  };
  for (const key of [
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'ProgramData',
    'HOMEDRIVE',
    'HOMEPATH',
  ]) {
    env[key] = process.env[key];
  }
  return { executable: win32.join(home, 'powershell.exe'), cwd: root, env };
}

function command(
  operation: 'directory' | 'read' | 'publish' | 'promote' | 'remove',
  target: string,
  stage?: string,
) {
  const { executable, cwd, env } = windowsPowerShell();
  const temp = realpathSync.native(tmpdir());
  return {
    executable,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'Text',
      '-EncodedCommand',
      (encodedScript ??= Buffer.from(script, 'utf16le').toString('base64')),
    ],
    options: {
      cwd,
      env: {
        ...env,
        TEMP: temp,
        TMP: temp,
        LIBRECHAT_PRIVATE_OPERATION: operation,
        LIBRECHAT_PRIVATE_TARGET: target,
        LIBRECHAT_PRIVATE_STAGE: stage,
      },
      timeout: 15_000,
      windowsHide: true,
    },
  };
}

export function readWindowsPrivateFile(file: string): Buffer | undefined {
  checkCanonical(file, realpathSync.native(file));
  const { executable, args, options } = command('read', file);
  const result = spawnSync(executable, args, { ...options, input: '\n' });
  if (result.error) throw failure(null, true);
  if (result.status === 2) return undefined;
  if (result.status !== 0) throw failure(result.status);
  return result.stdout;
}

/** Stages a protected file and moves it into place without replacing the destination. */
export function publishWindowsPrivateFile(
  stage: string,
  destination: string,
  contents: string,
): 'written' | 'exists' {
  const parent = win32.dirname(destination);
  checkCanonical(parent, realpathSync.native(parent));
  const { executable, args, options } = command('publish', destination, stage);
  const payload = Buffer.from(contents, 'utf8').toString('base64');
  const result = spawnSync(executable, args, { ...options, input: `${payload}\n` });
  if (result.error) throw failure(null, true);
  if (result.status === 3) return 'exists';
  if (result.status !== 0) throw failure(result.status);
  return 'written';
}

/** Mutate a repair candidate only if it still contains the bytes the caller checked. */
export function finishWindowsPrivateRepair(
  path: string,
  digest: string,
  destination?: string,
): boolean {
  const { executable, args, options } = command(
    destination ? 'promote' : 'remove',
    path,
    destination,
  );
  const result = spawnSync(executable, args, { ...options, input: `${digest}\n` });
  if (result.error) throw failure(null, true);
  if (result.status === 2) return false;
  if (result.status !== 0) throw failure(result.status);
  return true;
}

/** Every new child inherits the only grant, to the account running LibreChat. */
export async function makeWindowsPrivateDirectory(prefix: string): Promise<string> {
  // Windows temp paths can use 8.3 names. Use the resolved path and verify its actual parents.
  const parent = await fs.realpath(win32.dirname(prefix));
  const directory = win32.join(parent, `${win32.basename(prefix)}${randomUUID()}`);
  const { executable, args, options } = command('directory', directory);
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, options, (error) => {
      if (!error) resolve(directory);
      else reject(typeof error.code === 'number' ? failure(error.code) : failure(null, true));
    });
    child.stdin?.end();
  });
}
