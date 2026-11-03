import {
  brainProvisioningBody,
  brainProvisioningConfigFromEnv,
  provisionBrainUser,
} from './brainProvisioning';

const clinician = {
  _id: '66a1b2c3d4e5f60718293a4b',
  email: 'dr@example.com',
  name: 'Dr Example',
  openidId: 'user_01WORKOS',
  tspiRole: 'clinician',
  tspiClinicId: 'Inergis Health Clinic',
};

describe('brainProvisioning', () => {
  it('builds the body from the chat account', () => {
    expect(brainProvisioningBody(clinician, { approver: true, licencePending: true })).toEqual({
      chat_user_id: '66a1b2c3d4e5f60718293a4b',
      workos_user_id: 'user_01WORKOS',
      email: 'dr@example.com',
      display_name: 'Dr Example',
      tspi_role: 'clinician',
      clinic: 'Inergis Health Clinic',
      approver: true,
      licence_pending: true,
    });
  });

  it('sends no role for an account without a TSPI role, and leaves flags out unless set', () => {
    const body = brainProvisioningBody({ id: 'u1', tspiRole: 'admin' });
    expect(body).toEqual({ chat_user_id: 'u1', tspi_role: null });
  });

  it('needs the chat user id', () => {
    expect(() => brainProvisioningBody({ email: 'x@example.com' })).toThrow(/chat user id/);
  });

  it('reads its config from the environment, or skips without it', () => {
    expect(brainProvisioningConfigFromEnv({})).toBeNull();
    expect(
      brainProvisioningConfigFromEnv({ TSPI_BRAIN_URL: 'https://b', TSPI_BRAIN_PROVISIONING_KEY: 'k' }),
    ).toEqual({ baseUrl: 'https://b', key: 'k' });
  });

  it('PUTs to the Brain with the provisioning key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ user_id: 'b-1', created: true, status: 'active', platform_roles: [], membership: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const out = await provisionBrainUser(clinician, { platformAdmin: true }, {
      baseUrl: 'https://brain.example/',
      key: 'prov-key',
      fetch: fakeFetch,
    });
    expect(out.user_id).toBe('b-1');
    expect(calls[0].url).toBe('https://brain.example/api/v2/provisioning/users');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>)['X-TSPI-Provisioning-Key']).toBe('prov-key');
    expect(JSON.parse(calls[0].init.body as string).platform_admin).toBe(true);
  });

  it('reports the Brain error without echoing the key', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: 'UNAUTHENTICATED', detail: 'Provisioning key required.' }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(
      provisionBrainUser(clinician, {}, { baseUrl: 'https://b', key: 'secret-key', fetch: fakeFetch }),
    ).rejects.toThrow(/HTTP 401\) UNAUTHENTICATED: Provisioning key required\./);
    await expect(
      provisionBrainUser(clinician, {}, { baseUrl: 'https://b', key: 'secret-key', fetch: fakeFetch }),
    ).rejects.not.toThrow(/secret-key/);
  });
});
