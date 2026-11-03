/**
 * TSPI Brain provisioning (M02 task 10).
 *
 * After M02 the TSPI Brain decides every request from its own user records (users, clinics,
 * memberships, capabilities, licences). `npm run tspi-user` keeps those records in step with the
 * chat account: each `set`/`import` also creates or updates the Brain user, and `sync-brain` does
 * it for every account at the cutover. The call is server-to-server with a provisioning key; it
 * never runs from the browser or the model.
 *
 * Chat role -> Brain (the Brain owns the table: CHAT_ROLE_MAP in apps/ai-engine/app/api/v2/identity.py)
 *   clinician    -> doctor membership in the clinic
 *   clinic_staff -> clinic_staff membership
 *   reviewer     -> doctor membership + knowledge_reviewer
 *   auditor      -> auditor (platform)
 *   patient      -> patient (platform)
 */
import { resolveTspiRole } from '../auth/tspiMcpToken';

export interface BrainProvisioningConfig {
  /** e.g. https://api.tspipro.com — the Brain's public or internal base URL */
  baseUrl: string;
  /** One of the Brain's TSPI_PROVISIONING_KEYS */
  key: string;
  /** Injected for tests; defaults to the global fetch */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface BrainProvisioningUser {
  id?: string;
  _id?: { toString(): string } | string;
  email?: string | null;
  name?: string | null;
  openidId?: string | null;
  tspiRole?: string | null;
  tspiClinicId?: string | null;
}

export interface BrainProvisioningOptions {
  /** clinician: grant (true) or remove (false) approve_treatment_plans; undefined = unchanged */
  approver?: boolean;
  /** cutover: mark the licence verified with a "details pending" note */
  licencePending?: boolean;
  /** grant (true) or remove (false) platform_admin; undefined = unchanged */
  platformAdmin?: boolean;
  status?: 'active' | 'suspended' | 'revoked';
}

export interface BrainProvisioningResult {
  user_id: string;
  created: boolean;
  status: string;
  platform_roles: string[];
  membership: { clinic_code: string; role: string; capabilities: string[] } | null;
}

/** The Brain call needs both settings; without them provisioning is skipped (returns null). */
export function brainProvisioningConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrainProvisioningConfig | null {
  const baseUrl = (env.TSPI_BRAIN_URL || '').trim();
  const key = (env.TSPI_BRAIN_PROVISIONING_KEY || '').trim();
  return baseUrl && key ? { baseUrl, key } : null;
}

function idOf(user: BrainProvisioningUser): string {
  const raw = user.id ?? user._id;
  const id = raw == null ? '' : String(raw).trim();
  if (!id) {
    throw new Error('Brain provisioning needs the chat user id');
  }
  return id;
}

/** The request body for one user. Exported for tests. */
export function brainProvisioningBody(
  user: BrainProvisioningUser,
  opts: BrainProvisioningOptions = {},
): Record<string, unknown> {
  const role = resolveTspiRole(user.tspiRole);
  const body: Record<string, unknown> = {
    chat_user_id: idOf(user),
    tspi_role: role === 'unassigned' ? null : role,
  };
  const workos = user.openidId?.trim();
  if (workos) body.workos_user_id = workos;
  if (user.email) body.email = user.email;
  if (user.name) body.display_name = user.name;
  const clinic = user.tspiClinicId?.trim();
  if (clinic) body.clinic = clinic;
  if (opts.approver !== undefined) body.approver = opts.approver;
  if (opts.licencePending) body.licence_pending = true;
  if (opts.platformAdmin !== undefined) body.platform_admin = opts.platformAdmin;
  if (opts.status) body.status = opts.status;
  return body;
}

/** Create or update the Brain user for this chat account (idempotent). */
export async function provisionBrainUser(
  user: BrainProvisioningUser,
  opts: BrainProvisioningOptions,
  config: BrainProvisioningConfig,
): Promise<BrainProvisioningResult> {
  const doFetch = config.fetch ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/v2/provisioning/users`;
  const res = await doFetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-TSPI-Provisioning-Key': config.key,
    },
    body: JSON.stringify(brainProvisioningBody(user, opts)),
    signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { detail?: string; code?: string };
      detail = [data.code, data.detail].filter(Boolean).join(': ');
    } catch {
      detail = res.statusText;
    }
    // Never echo the key or the request.
    throw new Error(`TSPI Brain provisioning failed (HTTP ${res.status}) ${detail}`.trim());
  }
  return (await res.json()) as BrainProvisioningResult;
}
