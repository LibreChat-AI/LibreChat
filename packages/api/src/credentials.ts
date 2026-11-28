import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  finishWindowsPrivateRepair,
  publishWindowsPrivateFile,
  readWindowsPrivateFile,
} from './utils/windowsPrivate';

export const credentialNames = [
  'CREDS_KEY',
  'CREDS_IV',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

export type CredentialName = (typeof credentialNames)[number];

export type CredentialSource = 'environment' | 'temporary';

export interface CredentialRuntimeState {
  filePath: string;
  sources: Record<CredentialName, CredentialSource>;
  generated: CredentialName[];
  loadedFromFile: CredentialName[];
  missingFromEnvironment: CredentialName[];
  persistenceFailed: boolean;
}

export interface CredentialFingerprintRecord {
  CREDS_KEY: string;
  CREDS_IV: string;
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
}

interface CredentialFileResult {
  values: Partial<Record<CredentialName, string>>;
  exists: boolean;
  readable: boolean;
  digest?: string;
}

type CredentialFileWriteResult = 'written' | 'exists' | 'failed';

export const credentialMetadataId = 'primary';
export const credentialMetadataCollection = 'librechatCredentialMetadata';

const credentialRuntimeKey = Symbol.for('librechat.credentials.runtime');
const tempCredentialPathEnvironment = 'LIBRECHAT_TEMP_CREDENTIALS_PATH';

const legacyCredentialFingerprints: Partial<Record<CredentialName, string[]>> = {
  CREDS_KEY: [
    '7c1154b5152983978147ea87e4a2066d4768673e9d85d6a792cddc2f784efd2f',
    '6aa4b14dcf6d5094e8f3ed7ac00ba5f0a4d36af50940e870c987a101149a06b3',
  ],
  CREDS_IV: [
    '06d2e911edb4d45985b9d6338ec3d4c6b4bde69f8143437797c187ab07085531',
    'be066640b0c70fcf71e9181eca99768f87da3e4e3764282dfc8063da2f4010ca',
  ],
  JWT_SECRET: ['69024f21e9ad17594dcccd93e87399af24a5426ccfe6108d1787f0335966abc4'],
  JWT_REFRESH_SECRET: ['282ad5f60261639fefed381976b4d0dde52eab5527a1ab2ec75d5be1efa1165b'],
};

const legacyJwtCredentialNames = new Set<CredentialName>(['JWT_SECRET', 'JWT_REFRESH_SECRET']);

function rejectLegacyJwtCredential(name: CredentialName, value: string): void {
  if (!legacyJwtCredentialNames.has(name) || !isLegacyCredential(name, value)) {
    return;
  }

  throw new Error(
    `[credentials] ${name} uses a retired default value. Configure a unique replacement before starting LibreChat.`,
  );
}

function getRuntimeState(): CredentialRuntimeState | undefined {
  const runtime = globalThis as typeof globalThis &
    Record<symbol, CredentialRuntimeState | undefined>;
  return runtime[credentialRuntimeKey];
}

function setRuntimeState(state: CredentialRuntimeState): void {
  const runtime = globalThis as typeof globalThis &
    Record<symbol, CredentialRuntimeState | undefined>;
  runtime[credentialRuntimeKey] = state;
}

function getCredentialPath(): string {
  const configuredPath = process.env[tempCredentialPathEnvironment]?.trim();
  const file = path.resolve(configuredPath || path.join(process.cwd(), '.env.temp'));
  if (process.platform !== 'win32') return file;
  try {
    return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
  } catch {
    // A new path may not have a parent yet. Canonicalize it after mkdir before publishing.
    return file;
  }
}

function parseCredentialFile(contents: string): Partial<Record<CredentialName, string>> {
  return contents.split(/\r?\n/).reduce<Partial<Record<CredentialName, string>>>((values, line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !credentialNames.includes(match[1] as CredentialName)) {
      return values;
    }

    const value = match[2].trim();
    values[match[1] as CredentialName] =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
    return values;
  }, {});
}

function readCredentialFile(filePath: string): CredentialFileResult {
  try {
    let contents: string;
    let digest: string | undefined;
    if (process.platform === 'win32') {
      if (isProtectedEnvironmentPath(filePath))
        return { values: {}, exists: true, readable: false };
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Not a single-link credential file.');
      const bytes = readWindowsPrivateFile(filePath);
      if (!bytes) return { values: {}, exists: false, readable: true };
      contents = bytes.toString('utf8');
      if (filePath.endsWith('.lock')) digest = sha256(bytes);
    } else {
      contents = fs.readFileSync(filePath, 'utf8');
    }
    return {
      values: parseCredentialFile(contents),
      exists: true,
      readable: true,
      digest,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { values: {}, exists: false, readable: true };
    }

    console.warn(`[credentials] Unable to read temporary credentials file at ${filePath}.`);
    return { values: {}, exists: true, readable: false };
  }
}

function isConfiguredCredential(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function isUsableTemporaryCredential(
  name: CredentialName,
  value: string | undefined,
): value is string {
  if (!value?.trim()) {
    return false;
  }

  if (name === 'CREDS_KEY') {
    return /^[0-9a-f]{64}$/i.test(value);
  }

  if (name === 'CREDS_IV') {
    return /^[0-9a-f]{32}$/i.test(value);
  }

  return value.length >= 32;
}

function generateCredential(name: CredentialName): string {
  return crypto.randomBytes(name === 'CREDS_IV' ? 16 : 32).toString('hex');
}

function isProtectedEnvironmentPath(filePath: string): boolean {
  const filename = path.basename(path.resolve(filePath));
  const basename = process.platform === 'win32' ? filename.toLowerCase() : filename;
  return basename === '.env' || basename === '.env.example';
}

function serializeCredentialFile(values: Partial<Record<CredentialName, string>>): string {
  return [
    '# Automatically generated by LibreChat. Keep this file private and persistent.',
    ...credentialNames.filter((name) => values[name]).map((name) => `${name}=${values[name]}`),
    '',
  ].join('\n');
}

function hasUsableValues(file: CredentialFileResult, names: CredentialName[]): boolean {
  return (
    file.readable && names.every((name) => isUsableTemporaryCredential(name, file.values[name]))
  );
}

function sha256(contents: string | Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function writeWindowsCredentialFile(
  filePath: string,
  temporaryPath: string,
  contents: string,
  overwrite: boolean,
  generatedNames: CredentialName[],
): CredentialFileWriteResult {
  if (!overwrite) return publishWindowsPrivateFile(temporaryPath, filePath, contents);

  // Use a no-replace move instead of creating a second link to a credential inode.
  const lockPath = `${filePath}.lock`;
  const ownsLock = publishWindowsPrivateFile(temporaryPath, lockPath, contents) === 'written';
  let ownDigest = ownsLock ? sha256(contents) : undefined;
  try {
    const candidate = ownsLock ? undefined : readCredentialFile(lockPath);
    const final = readCredentialFile(filePath);
    if (!final.readable) return 'failed';
    if (hasUsableValues(final, generatedNames)) return 'exists';

    const digest =
      ownDigest ??
      (candidate && hasUsableValues(candidate, generatedNames) ? candidate.digest : undefined);
    if (digest) {
      try {
        if (finishWindowsPrivateRepair(lockPath, digest, filePath) && ownsLock) {
          ownDigest = undefined;
          return 'written';
        }
      } catch {
        // Another process may have read or promoted the same candidate first.
      }
    }
    return hasUsableValues(readCredentialFile(filePath), generatedNames) ? 'exists' : 'failed';
  } finally {
    if (ownDigest) {
      try {
        finishWindowsPrivateRepair(lockPath, ownDigest);
      } catch {
        // A protected repair candidate can be adopted on a later startup.
      }
    }
  }
}

function writeCredentialFile(
  filePath: string,
  values: Partial<Record<CredentialName, string>>,
  overwrite: boolean,
  generatedNames: CredentialName[],
): CredentialFileWriteResult {
  if (isProtectedEnvironmentPath(filePath)) {
    return 'failed';
  }

  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const lockPath = `${filePath}.lock`;
  let ownsLock = false;
  try {
    const contents = serializeCredentialFile(values);
    const parent = path.dirname(filePath);
    fs.mkdirSync(parent, { recursive: true });
    if (process.platform === 'win32') {
      const canonicalParent = fs.realpathSync.native(parent);
      return writeWindowsCredentialFile(
        path.join(canonicalParent, path.basename(filePath)),
        path.join(canonicalParent, path.basename(temporaryPath)),
        contents,
        overwrite,
        generatedNames,
      );
    }
    fs.writeFileSync(temporaryPath, contents, { mode: 0o600 });

    if (overwrite) {
      try {
        fs.linkSync(temporaryPath, lockPath);
        ownsLock = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }

        if (hasUsableValues(readCredentialFile(lockPath), generatedNames)) {
          try {
            fs.renameSync(lockPath, filePath);
          } catch {
            // The lock owner may have already promoted the same credential values.
          }
        }
        return hasUsableValues(readCredentialFile(filePath), generatedNames) ? 'exists' : 'failed';
      }

      if (hasUsableValues(readCredentialFile(filePath), generatedNames)) {
        return 'exists';
      }
      fs.renameSync(temporaryPath, filePath);
    } else {
      try {
        fs.linkSync(temporaryPath, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return 'exists';
        }
        throw error;
      }
    }

    fs.chmodSync(filePath, 0o600);
    return 'written';
  } catch {
    return 'failed';
  } finally {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary path is absent after a successful rename.
      }
    }
    if (ownsLock) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A contender may have promoted the lock while adopting its values.
      }
    }
  }
}

function hardenCredentialFile(filePath: string): void {
  // Windows hardens and verifies the open file before reading it.
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    console.warn(`[credentials] Unable to restrict permissions on ${filePath}.`);
  }
}

function adoptCredentialFile(
  filePath: string,
  names: CredentialName[],
  sources: Record<CredentialName, CredentialSource>,
  loadedFromFile: CredentialName[],
): boolean {
  const file = readCredentialFile(filePath);
  if (!file.readable) {
    return false;
  }

  for (const name of names) {
    const value = file.values[name];
    if (!isUsableTemporaryCredential(name, value)) {
      return false;
    }

    rejectLegacyJwtCredential(name, value);
  }

  for (const name of names) {
    process.env[name] = file.values[name];
    sources[name] = 'temporary';
    loadedFromFile.push(name);
  }
  hardenCredentialFile(filePath);
  return true;
}

export function bootstrapCredentials(): CredentialRuntimeState {
  const existingState = getRuntimeState();
  if (existingState) {
    return existingState;
  }

  // Validate explicit credentials before generating or adopting any missing values.
  for (const name of ['CREDS_KEY', 'CREDS_IV'] as const) {
    const value = process.env[name];
    if (isConfiguredCredential(value) && !isUsableTemporaryCredential(name, value)) {
      const bytes = name === 'CREDS_KEY' ? 32 : 16;
      throw new Error(
        `[credentials] ${name} must be exactly ${bytes * 2} hexadecimal characters (${bytes} bytes). ` +
          'Refusing startup to prevent weak encryption or late crypto failures. ' +
          'Restore the original credential if it protects existing data; plan a controlled migration before rotating it.',
      );
    }
  }

  const filePath = getCredentialPath();
  const file: CredentialFileResult =
    process.platform === 'win32' &&
    credentialNames.every((name) => isConfiguredCredential(process.env[name]))
      ? { values: {}, exists: false, readable: true }
      : readCredentialFile(filePath);
  const sources = {} as Record<CredentialName, CredentialSource>;
  const generated: CredentialName[] = [];
  const loadedFromFile: CredentialName[] = [];
  const missingFromEnvironment: CredentialName[] = [];
  const temporaryValues: Partial<Record<CredentialName, string>> = {};

  for (const name of credentialNames) {
    const environmentValue = process.env[name];
    if (isConfiguredCredential(environmentValue)) {
      rejectLegacyJwtCredential(name, environmentValue);
      sources[name] = 'environment';
      continue;
    }

    missingFromEnvironment.push(name);
    const fileValue = file.values[name];
    if (isUsableTemporaryCredential(name, fileValue)) {
      rejectLegacyJwtCredential(name, fileValue);
      process.env[name] = fileValue;
      sources[name] = 'temporary';
      loadedFromFile.push(name);
      temporaryValues[name] = fileValue;
      continue;
    }

    const generatedValue = generateCredential(name);
    process.env[name] = generatedValue;
    sources[name] = 'temporary';
    generated.push(name);
    temporaryValues[name] = generatedValue;
  }

  let persistenceFailed = false;
  if (generated.length > 0 && file.readable) {
    const writeResult = writeCredentialFile(filePath, temporaryValues, file.exists, generated);
    if (writeResult === 'exists') {
      const adopted = adoptCredentialFile(filePath, generated, sources, loadedFromFile);
      if (adopted) {
        generated.length = 0;
      } else {
        persistenceFailed = true;
      }
    } else {
      persistenceFailed = writeResult === 'failed';
    }
  } else if (generated.length > 0) {
    persistenceFailed = true;
  } else if (loadedFromFile.length > 0) {
    hardenCredentialFile(filePath);
  }

  const state: CredentialRuntimeState = {
    filePath,
    sources,
    generated,
    loadedFromFile,
    missingFromEnvironment,
    persistenceFailed,
  };
  setRuntimeState(state);

  if (generated.length > 0 && !persistenceFailed) {
    console.warn(
      `[credentials] Generated temporary credentials for ${generated.join(', ')}. ` +
        `They are stored in ${filePath}; configure permanent values before production use.`,
    );
  } else if (generated.length > 0) {
    console.warn(
      `[credentials] Generated process-local credentials for ${generated.join(', ')}. ` +
        'Configure permanent values before production use.',
    );
  } else if (loadedFromFile.length > 0) {
    console.warn(
      `[credentials] Using temporary credentials from ${filePath} for ${loadedFromFile.join(', ')}. ` +
        'Configure permanent values before production use.',
    );
  }

  if (persistenceFailed) {
    console.warn(
      `[credentials] Could not persist temporary credentials to ${filePath}. ` +
        'The generated values will only remain valid for this process.',
    );
  }

  return state;
}

export function getCredentialRuntimeState(): CredentialRuntimeState | undefined {
  return getRuntimeState();
}

function fingerprintCredential(value: string | undefined): string {
  return sha256(value ?? '');
}

export function getCredentialFingerprints(
  env: NodeJS.ProcessEnv = process.env,
): CredentialFingerprintRecord {
  return credentialNames.reduce<CredentialFingerprintRecord>((fingerprints, name) => {
    fingerprints[name] = fingerprintCredential(env[name]);
    return fingerprints;
  }, {} as CredentialFingerprintRecord);
}

export function isLegacyCredential(name: CredentialName, value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return legacyCredentialFingerprints[name]?.includes(fingerprintCredential(value)) ?? false;
}

export function getLegacyCredentialNames(env: NodeJS.ProcessEnv = process.env): CredentialName[] {
  return credentialNames.filter((name) => isLegacyCredential(name, env[name]));
}
