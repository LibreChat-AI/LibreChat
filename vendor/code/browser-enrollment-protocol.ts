import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export type BrowserSetupRequest = BrowserEnrollmentRequest;
export type EnrollmentRedemption = BrowserEnrollmentRedemptionContract;
export type EnrollmentApproval = BrowserEnrollmentApproval;

export const BROWSER_ENROLLMENT_PROTOCOL_VERSION = 1 as const;
export const BROWSER_ENROLLMENT_MAX_TTL_MS = 10 * 60_000;
export const BROWSER_SETUP_PROOF_DOMAIN = 'librechat-code:browser-setup:v1';
export const BROWSER_ENROLLMENT_REDEMPTION_DOMAIN = 'librechat-code:browser-enrollment-redeem:v1';

export interface BrowserEnrollmentRequest {
  version: 1;
  instance: string;
  attemptId: string;
  createdAt: string;
  publicKey: string;
  machineName: string;
  workspace: { type: 'private' | 'directory' };
  allowWorkspaceWrites: boolean;
  allowWorkspaceCommands: boolean;
}

export interface BrowserSetupProof {
  operation: 'setup.start' | 'setup.poll' | 'setup.cancel' | 'setup.complete';
  instance: string;
  attemptId: string;
  requestHash: string;
  timestamp: string;
  nonce: string;
}

export interface BrowserEnrollmentRedemptionContract {
  operation: 'enrollment.redeem';
  serverId: string;
  instance: string;
  attemptId: string;
  requestHash: string;
  workerId: string;
  expiresAt: string;
}

export interface BrowserEnrollmentStatusRequest extends BrowserEnrollmentRedemptionContract {
  protocolVersion: 1;
}

export interface BrowserEnrollmentRedemption extends BrowserEnrollmentRedemptionContract {
  protocolVersion: 1;
  signature: string;
}

export interface BrowserEnrollmentBinding {
  tenantId: string;
  principal: { type: 'deployment' | 'tenant' | 'user' | 'role' | 'group'; id: string };
}

export interface BrowserEnrollmentApproval extends BrowserEnrollmentRedemptionContract {
  protocolVersion: 1;
  publicKey: string;
  binding: BrowserEnrollmentBinding;
}

export interface BrowserEnrollmentCapabilities {
  browserEnrollmentVersion: 1;
  serverId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.prototype.hasOwnProperty.call(value, name));
}

export function isBrowserEnrollmentTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isBrowserEnrollmentToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function isBrowserEnrollmentSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function isBrowserEnrollmentPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('-----BEGIN PUBLIC KEY-----\n')) return false;
  try {
    const key = createPublicKey(value);
    return key.asymmetricKeyType === 'ed25519' && key.export({ type: 'spki', format: 'pem' }) === value;
  } catch {
    return false;
  }
}

export function normalizeBrowserEnrollmentInstance(value: string): string {
  if (value.length > 2048 || value !== value.trim()) throw new TypeError('Invalid LibreChat instance URL');
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
  ) {
    throw new TypeError('LibreChat instance requires HTTPS (or loopback HTTP), without credentials, query, or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function instance(value: unknown): value is string {
  try {
    return typeof value === 'string' && normalizeBrowserEnrollmentInstance(value) === value;
  } catch {
    return false;
  }
}

function serverOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && instance(value);
  } catch {
    return false;
  }
}

function requestHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isBrowserEnrollmentRequest(value: unknown): value is BrowserEnrollmentRequest {
  return record(value) && keys(value, [
    'version', 'instance', 'attemptId', 'createdAt', 'publicKey', 'machineName',
    'workspace', 'allowWorkspaceWrites', 'allowWorkspaceCommands',
  ]) && value.version === 1 && instance(value.instance) && isBrowserEnrollmentToken(value.attemptId) &&
    isBrowserEnrollmentTimestamp(value.createdAt) && isBrowserEnrollmentPublicKey(value.publicKey) &&
    typeof value.machineName === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/.test(value.machineName) &&
    value.machineName === value.machineName.trim() && record(value.workspace) && keys(value.workspace, ['type']) &&
    (value.workspace.type === 'private' || value.workspace.type === 'directory') &&
    typeof value.allowWorkspaceWrites === 'boolean' && typeof value.allowWorkspaceCommands === 'boolean';
}

export function canonicalBrowserEnrollmentRequest(input: BrowserEnrollmentRequest): string {
  if (!isBrowserEnrollmentRequest(input)) throw new TypeError('Invalid browser enrollment request');
  return JSON.stringify({
    version: input.version,
    instance: input.instance,
    attemptId: input.attemptId,
    createdAt: input.createdAt,
    publicKey: input.publicKey,
    machineName: input.machineName,
    workspace: { type: input.workspace.type },
    allowWorkspaceWrites: input.allowWorkspaceWrites,
    allowWorkspaceCommands: input.allowWorkspaceCommands,
  });
}

export function hashBrowserEnrollmentRequest(input: BrowserEnrollmentRequest): string {
  return createHash('sha256').update(canonicalBrowserEnrollmentRequest(input)).digest('hex');
}

export function isBrowserSetupProof(value: unknown): value is BrowserSetupProof {
  return record(value) && keys(value, ['operation', 'instance', 'attemptId', 'requestHash', 'timestamp', 'nonce']) &&
    typeof value.operation === 'string' && ['setup.start', 'setup.poll', 'setup.cancel', 'setup.complete'].includes(value.operation) &&
    instance(value.instance) && isBrowserEnrollmentToken(value.attemptId) && requestHash(value.requestHash) &&
    isBrowserEnrollmentTimestamp(value.timestamp) && isBrowserEnrollmentToken(value.nonce);
}

export function canonicalBrowserSetupProof(input: BrowserSetupProof): string {
  if (!isBrowserSetupProof(input)) throw new TypeError('Invalid browser setup proof');
  return [BROWSER_SETUP_PROOF_DOMAIN, input.operation, input.instance, input.attemptId,
    input.requestHash, input.timestamp, input.nonce].join('\n');
}

export function isBrowserEnrollmentRedemptionContract(value: unknown): value is BrowserEnrollmentRedemptionContract {
  return record(value) && value.operation === 'enrollment.redeem' && serverOrigin(value.serverId) &&
    instance(value.instance) && isBrowserEnrollmentToken(value.attemptId) && requestHash(value.requestHash) &&
    typeof value.workerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.workerId) &&
    isBrowserEnrollmentTimestamp(value.expiresAt);
}

export function isBrowserEnrollmentBinding(value: unknown): value is BrowserEnrollmentBinding {
  return record(value) && keys(value, ['tenantId', 'principal']) &&
    typeof value.tenantId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.tenantId) &&
    record(value.principal) && keys(value.principal, ['type', 'id']) &&
    typeof value.principal.type === 'string' && ['deployment', 'tenant', 'user', 'role', 'group'].includes(value.principal.type) &&
    typeof value.principal.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.principal.id);
}

const CONTRACT_KEYS = ['operation', 'serverId', 'instance', 'attemptId', 'requestHash', 'workerId', 'expiresAt'];

export function isBrowserEnrollmentApproval(value: unknown): value is BrowserEnrollmentApproval {
  return isBrowserEnrollmentRedemptionContract(value) && record(value) &&
    keys(value, [...CONTRACT_KEYS, 'protocolVersion', 'publicKey', 'binding']) &&
    value.protocolVersion === 1 && isBrowserEnrollmentPublicKey(value.publicKey) && isBrowserEnrollmentBinding(value.binding);
}

export function isBrowserEnrollmentStatusRequest(value: unknown): value is BrowserEnrollmentStatusRequest {
  return isBrowserEnrollmentRedemptionContract(value) && record(value) &&
    keys(value, [...CONTRACT_KEYS, 'protocolVersion']) && value.protocolVersion === 1;
}

export function isBrowserEnrollmentRedemption(value: unknown): value is BrowserEnrollmentRedemption {
  return isBrowserEnrollmentRedemptionContract(value) && record(value) &&
    keys(value, [...CONTRACT_KEYS, 'protocolVersion', 'signature']) &&
    value.protocolVersion === 1 && isBrowserEnrollmentSignature(value.signature);
}

export function canonicalBrowserEnrollmentRedemption(input: BrowserEnrollmentRedemptionContract): string {
  if (!isBrowserEnrollmentRedemptionContract(input)) throw new TypeError('Invalid browser enrollment redemption');
  return [BROWSER_ENROLLMENT_REDEMPTION_DOMAIN, input.operation, input.serverId, input.instance,
    input.attemptId, input.requestHash, input.workerId, input.expiresAt].join('\n');
}

export function signBrowserSetupProof(privateKey: string, input: BrowserSetupProof): string {
  return sign(null, Buffer.from(canonicalBrowserSetupProof(input)), privateKey).toString('base64url');
}

export function verifyBrowserSetupProof(publicKey: string, input: BrowserSetupProof, signature: string): boolean {
  try {
    return isBrowserEnrollmentPublicKey(publicKey) && isBrowserEnrollmentSignature(signature) &&
      verify(null, Buffer.from(canonicalBrowserSetupProof(input)), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export function signBrowserEnrollmentRedemption(privateKey: string, input: BrowserEnrollmentRedemptionContract): string {
  return sign(null, Buffer.from(canonicalBrowserEnrollmentRedemption(input)), privateKey).toString('base64url');
}

export function verifyBrowserEnrollmentRedemption(publicKey: string, input: BrowserEnrollmentRedemptionContract, signature: string): boolean {
  try {
    return isBrowserEnrollmentPublicKey(publicKey) && isBrowserEnrollmentSignature(signature) &&
      verify(null, Buffer.from(canonicalBrowserEnrollmentRedemption(input)), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export const browserSetupRequestHash = hashBrowserEnrollmentRequest;
export const canonicalBrowserSetupRequest = canonicalBrowserEnrollmentRequest;
export const canonicalEnrollmentRedemption = canonicalBrowserEnrollmentRedemption;
export const signEnrollmentRedemption = signBrowserEnrollmentRedemption;
export const verifyEnrollmentRedemption = verifyBrowserEnrollmentRedemption;
export const validateBrowserSetupRequest = isBrowserEnrollmentRequest;
export const validateBrowserSetupProof = isBrowserSetupProof;
export const validateEnrollmentRedemption = isBrowserEnrollmentRedemptionContract;
