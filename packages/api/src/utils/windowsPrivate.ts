import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync, promises as fs } from 'node:fs';
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
# link count, security descriptor and bytes, and excludes outstanding reads, writes and deletes.
function LoadNativeFile {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class LibreChatPrivateFile {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
            WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll")]
    private static extern uint GetFileType(SafeFileHandle file);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind,
        IntPtr info, uint size);

    [StructLayout(LayoutKind.Sequential)]
    private struct RenameInfo {
        public uint ReplaceIfExists;
        public IntPtr RootDirectory;
        public uint FileNameLength;
        public ushort FileName;
    }

    public static FileStream Open(string path, bool mutate) {
        // GENERIC_READ | WRITE_DAC (| DELETE), no sharing, OPEN_EXISTING, OPEN_REPARSE_POINT.
        uint access = mutate ? 0x80050000 : 0x80040000;
        SafeFileHandle handle;
        for (int retry = 0; ; retry++) {
            handle = CreateFileW(path, access, 0, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (!handle.IsInvalid) break;
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (error == 2) return null;
            if (error != 32 || retry >= 10) throw new Win32Exception(error);
            Thread.Sleep(50);
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

    public static void Promote(SafeFileHandle handle, string destination) {
        // FILE_RENAME_INFO, with an absolute name and a null root handle.
        var name = Encoding.Unicode.GetBytes(destination + "\0");
        int offset = Marshal.OffsetOf(typeof(RenameInfo), "FileName").ToInt32();
        var payload = new byte[offset + name.Length];
        payload[0] = 1; // ReplaceIfExists
        Array.Copy(BitConverter.GetBytes(name.Length - 2), 0, payload,
            Marshal.OffsetOf(typeof(RenameInfo), "FileNameLength").ToInt32(), sizeof(uint));
        Array.Copy(name, 0, payload, offset, name.Length);
        Apply(handle, 3, payload);
    }

    public static void Remove(SafeFileHandle handle) {
        Apply(handle, 4, new byte[] { 1 }); // FILE_DISPOSITION_INFO.DeleteFile
    }

    private static void Apply(SafeFileHandle handle, int kind, byte[] payload) {
        var pinned = GCHandle.Alloc(payload, GCHandleType.Pinned);
        try {
            if (!SetFileInformationByHandle(handle, kind, pinned.AddrOfPinnedObject(), (uint)payload.Length))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { pinned.Free(); }
    }
}
'@
}

function ExistingFile([string] $path, [string] $operation) {
  CheckParent $path
  # Windows PowerShell's compiler writes scratch files. Keep those in a verified private directory.
  $scratch = [IO.Path]::Combine($env:TEMP, 'librechat-acl-' + [Guid]::NewGuid().ToString('N'))
  PrivateDirectory $scratch
  $env:TEMP = $env:TMP = $scratch
  try {
    LoadNativeFile
    $stream = [LibreChatPrivateFile]::Open($path, $operation -ne 'read')
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
      if ($operation -eq 'read') {
        $stream.CopyTo([Console]::OpenStandardOutput())
      } else {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
        finally { $sha256.Dispose() }
        if ($digest -ne [Console]::ReadLine()) { exit 2 }
        if ($operation -eq 'remove') {
          [LibreChatPrivateFile]::Remove($stream.SafeFileHandle)
        } else {
          $destination = $env:LIBRECHAT_PRIVATE_STAGE
          CheckPath $destination
          if ($path -ne ($destination + '.lock')) { exit 1 }
          [LibreChatPrivateFile]::Promote($stream.SafeFileHandle, $destination)
        }
      }
    } finally { $stream.Dispose() }
  } finally { [IO.Directory]::Delete($scratch, $true) }
}

try {
  $target = $env:LIBRECHAT_PRIVATE_TARGET
  $operation = $env:LIBRECHAT_PRIVATE_OPERATION
  switch ($operation) {
    'directory' { PrivateDirectory $target }
    { $_ -in 'read', 'promote', 'remove' } { ExistingFile $target $operation }
    'publish' {
      CheckParent $target
      $stage = $env:LIBRECHAT_PRIVATE_STAGE
      CheckPath $stage
      if ([IO.Path]::GetDirectoryName($stage) -ne [IO.Path]::GetDirectoryName($target)) { exit 1 }
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

function checkCanonical(requested: string, resolved: string): void {
  // Reject alternate drive mappings, short names and reparse paths rather than blessing their targets.
  if (requested.toLowerCase() !== resolved.toLowerCase()) throw failure();
}

let encodedScript: string | undefined;

function command(
  operation: 'directory' | 'read' | 'publish' | 'promote' | 'remove',
  target: string,
  stage?: string,
) {
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
      (encodedScript ??= Buffer.from(script, 'utf16le').toString('base64')),
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

export function readWindowsPrivateFile(file: string): Buffer | undefined {
  checkCanonical(file, realpathSync.native(file));
  const { executable, args, options } = command('read', file);
  const result = spawnSync(executable, args, options);
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
  const parent = win32.dirname(destination);
  checkCanonical(parent, realpathSync.native(parent));
  const { executable, args, options } = command('publish', destination, stage);
  const result = spawnSync(executable, args, { ...options, input: contents });
  if (result.error) throw failure();
  if (result.status === 3) return 'exists';
  if (result.status !== 0) throw failure();
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
  const result = spawnSync(executable, args, { ...options, input: digest });
  if (result.error) throw failure();
  if (result.status === 2) return false;
  if (result.status !== 0) throw failure();
  return true;
}

/** Every new child inherits the only grant, to the account running LibreChat. */
export async function makeWindowsPrivateDirectory(prefix: string): Promise<string> {
  const directory = `${prefix}${randomUUID()}`;
  const parent = win32.dirname(directory);
  checkCanonical(parent, await fs.realpath(parent));
  const { executable, args, options } = command('directory', directory);
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error) => {
      if (error) reject(failure());
      else resolve(directory);
    });
  });
}
