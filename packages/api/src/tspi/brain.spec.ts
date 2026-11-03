import { generateKeyPairSync } from 'crypto';
import type { TspiBrainClient } from './brainClient';
import { mintTspiMcpToken, resetTspiMcpTokenCache } from '../auth/tspiMcpToken';
import { decideTspiConfirmation, openTspiPatient, tspiActionError } from './actions';
import { TspiBrainError, createTspiBrainClient } from './brainClient';

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CNV = '0b7f4c1e-5a8d-4f8e-9a51-2f0b6c3d1e77';
const SHA = 'ab'.repeat(32);
const user = { id: '66a1b2c3d4e5f60718293a4b', tspiRole: 'clinician' };

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(status: number, response: unknown) {
  const calls: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

beforeEach(() => {
  process.env.TSPI_MCP_JWT_PRIVATE_KEY_BASE64 = Buffer.from(PEM).toString('base64');
  delete process.env.TSPI_MCP_JWT_AUDIENCE;
  delete process.env.TSPI_BRAIN_JWT_AUDIENCE;
  resetTspiMcpTokenCache();
});

describe('M04 token claims', () => {
  it('adds the conversation as cnv and keeps tspi-mcp for tool calls', () => {
    const c = claims(mintTspiMcpToken(user, Date.now(), { conversationId: CNV }));
    expect(c.cnv).toBe(CNV);
    expect(c.aud).toBe('tspi-mcp');
  });

  it('mints aud=tspi-api for TspiChat routes', () => {
    expect(claims(mintTspiMcpToken(user, Date.now(), { audience: 'api' })).aud).toBe('tspi-api');
  });

  it('never reuses a token across conversations or audiences', () => {
    const now = Date.now();
    const a = mintTspiMcpToken(user, now, { conversationId: CNV });
    const b = mintTspiMcpToken(user, now, { conversationId: 'other-chat' });
    const api = mintTspiMcpToken(user, now, { conversationId: CNV, audience: 'api' });
    const none = mintTspiMcpToken(user, now);
    expect(new Set([a, b, api, none]).size).toBe(4);
    expect(claims(none).cnv).toBeUndefined();
    expect(mintTspiMcpToken(user, now, { conversationId: CNV })).toBe(a);
  });

  it('drops a conversation id that does not look like one', () => {
    const c = claims(mintTspiMcpToken(user, Date.now(), { conversationId: 'a b"}' }));
    expect(c.cnv).toBeUndefined();
  });
});

describe('createTspiBrainClient', () => {
  it('sends the Confirm click with an aud=tspi-api token for this chat', async () => {
    const { calls, impl } = fakeFetch(200, { confirmation_id: 'c1', status: 'confirmed' });
    const brain = createTspiBrainClient(user, {
      baseUrl: 'https://brain.test',
      conversationId: CNV,
      fetch: impl,
    });
    await brain.decideConfirmation('c1', 'confirm', SHA);
    expect(calls[0].url).toBe('https://brain.test/api/v2/confirmations/c1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ decision: 'confirm', payload_sha256: SHA });
    const token = calls[0].headers.Authorization.replace('Bearer ', '');
    expect(claims(token)).toMatchObject({ aud: 'tspi-api', cnv: CNV, sub: user.id });
    expect(calls[0].headers['X-TSPI-Service-Key']).toBeUndefined();
  });

  it('sends the Open click and reads the PDF data', async () => {
    const { calls, impl } = fakeFetch(200, { patient: { id: 'p1' } });
    const brain = createTspiBrainClient(user, { baseUrl: 'https://brain.test/', fetch: impl });
    await brain.openPatient('p1');
    await brain.getReport('r1');
    await brain.getMe();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT https://brain.test/api/v2/chat-contexts/current',
      'GET https://brain.test/reports/r1',
      'GET https://brain.test/api/v2/me',
    ]);
    expect(calls[0].body).toEqual({ patient_id: 'p1' });
  });

  it('keeps the Brain problem code on a refusal', async () => {
    const { impl } = fakeFetch(409, {
      code: 'CONFIRMATION_EXPIRED',
      detail: 'This change expired.',
    });
    const brain = createTspiBrainClient(user, { baseUrl: 'https://brain.test', fetch: impl });
    await expect(brain.decideConfirmation('c1', 'confirm', SHA)).rejects.toMatchObject({
      code: 'conflict',
      problem: 'CONFIRMATION_EXPIRED',
      status: 409,
    });
  });

  it('refuses malformed ids without calling the Brain', async () => {
    const { calls, impl } = fakeFetch(200, {});
    const brain = createTspiBrainClient(user, { baseUrl: 'https://brain.test', fetch: impl });
    await expect(brain.decideConfirmation('../x', 'confirm', SHA)).rejects.toBeInstanceOf(
      TspiBrainError,
    );
    await expect(brain.decideConfirmation('c1', 'confirm', 'nope')).rejects.toBeInstanceOf(
      TspiBrainError,
    );
    await expect(brain.openPatient('a/b')).rejects.toBeInstanceOf(TspiBrainError);
    expect(calls).toHaveLength(0);
  });

  it('says when TSPI_BRAIN_URL is missing', async () => {
    delete process.env.TSPI_BRAIN_URL;
    await expect(createTspiBrainClient(user).getMe()).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});

describe('click actions', () => {
  const brainStub = () => {
    const decideConfirmation = jest.fn(async () => ({
      confirmation_id: 'c1',
      status: 'confirmed',
      action_type: 'patient.archive',
      summary: 'Archive patient X.',
    }));
    const openPatient = jest.fn(async () => ({
      conversation_id: CNV,
      patient: { id: 'p1', patient_number: 'C-000001' },
      opened_at: null,
    }));
    const client = { decideConfirmation, openPatient } as unknown as TspiBrainClient;
    return { client, decideConfirmation, openPatient };
  };

  it('confirms only in a conversation the user owns', async () => {
    const stub = brainStub();
    const owns = jest.fn(async (userId: string, cnv: string) => userId === user.id && cnv === CNV);
    const brain = jest.fn(() => stub.client);
    const deps = { ownsConversation: owns, brain };
    const input = {
      conversationId: CNV,
      confirmationId: 'c1',
      decision: 'confirm',
      payloadSha256: SHA,
    };
    await expect(decideTspiConfirmation(user, input, deps)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(brain).toHaveBeenCalledWith(user, CNV);
    expect(stub.decideConfirmation).toHaveBeenCalledWith('c1', 'confirm', SHA);

    await expect(
      decideTspiConfirmation(user, { ...input, conversationId: 'someone-elses-chat' }, deps),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      decideTspiConfirmation(user, { ...input, decision: 'approve' }, deps),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      decideTspiConfirmation(user, { ...input, conversationId: undefined }, deps),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(stub.decideConfirmation).toHaveBeenCalledTimes(1);
  });

  it('opens a patient in the clicked conversation', async () => {
    const stub = brainStub();
    const deps = { ownsConversation: async () => true, brain: () => stub.client };
    const ctx = await openTspiPatient(user, { conversationId: CNV, patientId: 'p1' }, deps);
    expect(ctx.patient?.patient_number).toBe('C-000001');
    expect(stub.openPatient).toHaveBeenCalledWith('p1');
  });

  it('turns errors into a safe status and code', () => {
    expect(
      tspiActionError(new TspiBrainError('conflict', 409, 'x', 'CONFIRMATION_INVALID')),
    ).toEqual({
      status: 409,
      body: { error: 'CONFIRMATION_INVALID' },
    });
    expect(tspiActionError(new TspiBrainError('not_configured', 503, 'x')).status).toBe(502);
    expect(tspiActionError(new Error('boom'))).toEqual({
      status: 502,
      body: { error: 'unavailable' },
    });
  });
});
