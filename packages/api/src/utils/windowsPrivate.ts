import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';

// Windows PowerShell is part of Windows. Paths are data; only this fixed script is executed.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trustedOwners = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544',
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
  if (!$sd.Owner.Equals($identity) -or !($sd.ControlFlags -band 0x1000) -or
      $null -eq $sd.DiscretionaryAcl -or $sd.DiscretionaryAcl.Count -ne 1) { return $false }
  $ace = $sd.DiscretionaryAcl[0]
  return $ace.AceType -eq 'AccessAllowed' -and $ace.AceFlags -eq $flags -and
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
  CheckPath $path
  $dirs = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  $dir = [IO.DirectoryInfo]::new($path).Parent
  while ($null -ne $dir) { $dirs.Push($dir); $dir = $dir.Parent }
  foreach ($dir in $dirs) {
    if (!$dir.Exists -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Invalid parent directory'
    }
    $sd = Descriptor ($dir.GetAccessControl('Access, Owner'))
    if ($sd.Owner.Value -notin $trustedOwners -or $null -eq $sd.DiscretionaryAcl) {
      throw 'Untrusted parent directory'
    }
    foreach ($ace in $sd.DiscretionaryAcl) {
      if ($ace.AceFlags -band 8) { continue } # InheritOnly
      if ($ace -isnot [Security.AccessControl.QualifiedAce]) { throw 'Unknown ACE' }
      # Granting creation alone is safe. Reject grants that can remove, replace or retarget entries.
      if ($ace.AceQualifier -eq 'AccessAllowed' -and ($ace.AccessMask -band 0x500d0140) -and
          $ace.SecurityIdentifier.Value -notin $trustedOwners) { throw 'Writable parent directory' }
    }
  }
}

function PrivateDirectory([string] $path) {
  CheckParent $path
  $dir = [IO.DirectoryInfo]::new($path)
  $dir.Create((PrivateAcl $true))
  $dir.Refresh()
  if (($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      !(IsPrivate ($dir.GetAccessControl('Access, Owner')) $true)) { throw 'Directory is not private' }
}

# Open an existing object without following a leaf reparse point. The same handle supplies
# link count, security descriptor and bytes, and denies concurrent opens for write or delete.
function NativeRead {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LibreChatPrivateFile {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
            WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll")]
    private static extern uint GetFileType(SafeFileHandle file);

    public static FileStream Open(string path) {
        // GENERIC_READ | WRITE_DAC; FILE_SHARE_READ; OPEN_EXISTING; FILE_FLAG_OPEN_REPARSE_POINT.
        var handle = CreateFileW(path, 0x80040000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (error == 2) return null;
            throw new Win32Exception(error);
        }
        try {
            FileInfo info;
            if (GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info) ||
                (info.Attributes & 0x410) != 0 || info.Links != 1) throw new IOException();
            return new FileStream(handle, FileAccess.Read);
        } catch {
            handle.Dispose();
            throw;
        }
    }
}
'@
}

try {
  $target = $env:LIBRECHAT_PRIVATE_TARGET
  switch ($env:LIBRECHAT_PRIVATE_OPERATION) {
    'directory' { PrivateDirectory $target }
    'read' {
      CheckParent $target
      # Windows PowerShell's compiler writes scratch files. Keep those in a verified private directory.
      $scratch = [IO.Path]::Combine($env:TEMP, 'librechat-acl-' + [Guid]::NewGuid().ToString('N'))
      PrivateDirectory $scratch
      $env:TEMP = $env:TMP = $scratch
      try {
        NativeRead
        $stream = [LibreChatPrivateFile]::Open($target)
        if ($null -eq $stream) { exit 2 }
        try {
          $acl = $stream.GetAccessControl()
          if (!($acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($identity))) { exit 1 }
          if (!(IsPrivate $acl $false)) {
            # Apply only the DACL. Do not take ownership or change auditing.
            $acl = PrivateAcl $false
            $dacl = [Security.AccessControl.FileSecurity]::new()
            $dacl.SetSecurityDescriptorBinaryForm($acl.GetSecurityDescriptorBinaryForm(), 'Access')
            $stream.SetAccessControl($dacl)
            if (!(IsPrivate ($stream.GetAccessControl()) $false)) { exit 1 }
          }
          $stream.CopyTo([Console]::OpenStandardOutput())
        } finally { $stream.Dispose() }
      } finally { [IO.Directory]::Delete($scratch, $true) }
    }
    'publish' {
      CheckParent $target
      $stage = $env:LIBRECHAT_PRIVATE_STAGE
      $stream = [IO.FileStream]::new($stage, 'CreateNew', 'FullControl', 'None', 4096, 'None', (PrivateAcl $false))
      try {
        try {
          if (!(IsPrivate ($stream.GetAccessControl()) $false)) { exit 1 }
          [Console]::OpenStandardInput().CopyTo($stream)
        } finally { $stream.Dispose() }
        try { [IO.File]::Move($stage, $target) } catch {
          if (($_.Exception.InnerException.HResult -band 0xffff) -in @(80, 183)) { exit 3 }
          throw
        }
      } finally { [IO.File]::Delete($stage) }
    }
    default { exit 1 }
  }
} catch { exit 1 }
exit 0
`;

const failure = (): Error => new Error('Unable to guarantee private access on Windows.');

function command(operation: 'directory' | 'read' | 'publish', target: string, stage?: string) {
  const root = process.env.SystemRoot ?? '';
  const temp = tmpdir();
  if (!/^[a-z]:\\[^/]+$/i.test(root) || win32.normalize(root) !== root) {
    throw failure();
  }
  return {
    executable: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    options: {
      cwd: root,
      env: {
        SystemRoot: root,
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

export function readWindowsPrivateFile(file: string): string | undefined {
  const { executable, args, options } = command('read', file);
  const result = spawnSync(executable, args, { ...options, encoding: 'utf8' });
  if (result.error) throw failure();
  if (result.status === 2) return undefined;
  if (result.status !== 0) throw failure();
  return result.stdout;
}

/** Stages a protected file and moves it into place without replacing the destination. */
export function publishWindowsPrivateFile(
  stage: string,
  destination: string,
  contents: string,
): 'written' | 'exists' {
  const { executable, args, options } = command('publish', destination, stage);
  const result = spawnSync(executable, args, { ...options, input: contents });
  if (result.error) throw failure();
  if (result.status === 3) return 'exists';
  if (result.status !== 0) throw failure();
  return 'written';
}

/** Every new child inherits the only grant, to the account running LibreChat. */
export async function makeWindowsPrivateDirectory(prefix: string): Promise<string> {
  const directory = `${prefix}${randomUUID()}`;
  const { executable, args, options } = command('directory', directory);
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error) => {
      if (error) reject(failure());
      else resolve(directory);
    });
  });
}
