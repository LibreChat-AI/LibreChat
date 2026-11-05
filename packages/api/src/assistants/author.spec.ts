import { SystemCapabilities } from '@librechat/data-schemas';
import {
  AssistantIdValidationError,
  getAssistantErrorStatus,
  createAssistantAuthorValidator,
  resolveAssistantAvatarIdentity,
} from './author';
import {
  ResourcePermissionsBusyError,
  ResourcePermissionsUnavailableError,
} from '../acl/accessControlService';

const makeRequest = () => ({
  params: {} as { id?: unknown; assistant_id?: unknown },
  body: { endpoint: 'assistants' } as { endpoint: string; assistant_id?: unknown },
  query: {} as { assistant_id?: unknown },
  user: { id: 'user-attacker', role: 'USER', tenantId: 'tenant-a' },
  config: { endpoints: { assistants: { privateAssistants: true } } },
});

describe('assistant author validation', () => {
  const getAssistant = jest.fn();
  const hasCapability = jest.fn();
  const retrieve = jest.fn();
  const openai = { beta: { assistants: { retrieve } } };
  const validateAuthor = createAssistantAuthorValidator({ getAssistant, hasCapability });

  beforeEach(() => {
    getAssistant.mockReset().mockResolvedValue(null);
    hasCapability.mockReset().mockResolvedValue(false);
    retrieve.mockReset().mockResolvedValue({ metadata: { author: 'user-victim' } });
  });

  it('rejects an omitted ID before any capability, database, or provider lookup', async () => {
    await expect(validateAuthor({ req: makeRequest(), openai })).rejects.toThrow(
      'Assistant ID is required',
    );
    expect(hasCapability).not.toHaveBeenCalled();
    expect(getAssistant).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('classifies only typed selector errors as client failures', () => {
    const error = new AssistantIdValidationError('Invalid Assistant ID');
    expect(error.code).toBe('invalid_assistant_id');
    expect(getAssistantErrorStatus(error)).toBe(400);
    expect(getAssistantErrorStatus(new ResourcePermissionsBusyError())).toBe(409);
    expect(getAssistantErrorStatus(new ResourcePermissionsUnavailableError())).toBe(503);
    expect(getAssistantErrorStatus(new Error('database unavailable'))).toBe(500);
    expect(getAssistantErrorStatus({ code: 'invalid_assistant_id' })).toBe(500);
  });

  it.each(['', ' ', 'asst victim', ['asst-victim'], { $ne: null }, 42, null])(
    'rejects a malformed ID: %p',
    async (assistantId) => {
      const req = makeRequest();
      req.body.assistant_id = assistantId;
      await expect(validateAuthor({ req, openai })).rejects.toThrow('Invalid Assistant ID');
      expect(getAssistant).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it.each(['body', 'query'] as const)('rejects a conflicting %s selector', async (source) => {
    const req = makeRequest();
    req.params.assistant_id = 'asst-victim';
    req[source].assistant_id = 'asst-attacker';
    await expect(
      validateAuthor({ req, openai, overrideAssistantId: 'asst-victim' }),
    ).rejects.toThrow('Conflicting Assistant IDs');
    expect(hasCapability).not.toHaveBeenCalled();
    expect(getAssistant).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('uses the avatar route target rather than an unrelated owned assistant', async () => {
    const req = makeRequest();
    req.params.assistant_id = 'asst-victim';
    getAssistant.mockImplementation(async ({ assistantId }) =>
      assistantId === 'asst-attacker' ? {} : null,
    );
    await expect(validateAuthor({ req, openai })).rejects.toThrow(
      'Assistant is not authored by the user',
    );
    expect(getAssistant).toHaveBeenCalledWith({
      assistantId: 'asst-victim',
      user: 'user-attacker',
    });
    expect(retrieve).toHaveBeenCalledWith('asst-victim');
  });

  it.each(['route', 'body', 'query'])('supports the existing %s selector', async (source) => {
    const req = makeRequest();
    if (source === 'route') {
      req.params.id = 'asst-attacker';
    } else if (source === 'body') {
      req.body.assistant_id = 'asst-attacker';
    } else {
      req.query.assistant_id = 'asst-attacker';
    }
    getAssistant.mockResolvedValue({});
    await expect(validateAuthor({ req, openai })).resolves.toEqual({
      assistantId: 'asst-attacker',
      user: 'user-attacker',
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('accepts matching selectors and returns the owner-scoped mutation query', async () => {
    const req = makeRequest();
    req.params.assistant_id = 'asst-attacker';
    req.body.assistant_id = 'asst-attacker';
    req.query.assistant_id = 'asst-attacker';
    getAssistant.mockResolvedValue({});
    await expect(
      validateAuthor({ req, openai, overrideAssistantId: 'asst-attacker' }),
    ).resolves.toEqual({ assistantId: 'asst-attacker', user: 'user-attacker' });
  });

  it('preserves the provider author fallback for an exact resource', async () => {
    const req = makeRequest();
    req.params.id = 'asst-attacker';
    retrieve.mockResolvedValue({ metadata: { author: 'user-attacker' } });
    await expect(validateAuthor({ req, openai })).resolves.toEqual({
      assistantId: 'asst-attacker',
      user: 'user-attacker',
    });
  });

  it('preserves the explicit management capability bypass', async () => {
    const req = makeRequest();
    req.params.assistant_id = 'asst-victim';
    hasCapability.mockResolvedValue(true);
    await expect(validateAuthor({ req, openai })).resolves.toEqual({
      assistantId: 'asst-victim',
    });
    expect(hasCapability).toHaveBeenCalledWith(req.user, SystemCapabilities.MANAGE_ASSISTANTS);
    expect(getAssistant).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('does not grant a bypass when the capability service fails', async () => {
    const req = makeRequest();
    req.params.id = 'asst-victim';
    hasCapability.mockRejectedValue(new Error('capability service unavailable'));
    await expect(validateAuthor({ req, openai })).rejects.toThrow(
      'Assistant is not authored by the user',
    );
    expect(getAssistant).toHaveBeenCalledWith({ assistantId: 'asst-victim', user: req.user.id });
  });

  it('propagates database failures rather than falling back to provider authority', async () => {
    const req = makeRequest();
    req.params.id = 'asst-victim';
    getAssistant.mockRejectedValue(new Error('database unavailable'));
    await expect(validateAuthor({ req, openai })).rejects.toThrow('database unavailable');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('preserves shared-assistant policy without widening the resource selector', async () => {
    const req = makeRequest();
    req.params.assistant_id = 'asst-shared';
    req.config.endpoints.assistants.privateAssistants = false;
    await expect(validateAuthor({ req, openai })).resolves.toEqual({
      assistantId: 'asst-shared',
    });
    expect(hasCapability).not.toHaveBeenCalled();
    expect(getAssistant).not.toHaveBeenCalled();
  });
});

describe('assistant avatar identity', () => {
  const author = '65cfb246f7ecadb8b1e8036c';
  const user = { id: '65cfb246f7ecadb8b1e8036b', tenantId: 'tenant-a' };
  const getUserById = jest.fn();
  const getAssistant = jest.fn();
  const resolveIdentity = (
    query: { user?: string },
    providerAuthor: unknown = author,
    privateAssistants = true,
  ) =>
    resolveAssistantAvatarIdentity({
      query: { assistantId: 'asst-target', ...query },
      user,
      endpoint: 'assistants',
      author: providerAuthor,
      privateAssistants,
      getAssistant,
      getUserById,
    });

  beforeEach(() => {
    getUserById.mockReset().mockResolvedValue({ tenantId: 'tenant-a' });
    getAssistant.mockReset().mockResolvedValue(null);
  });

  it('initializes a managed reference with the same-tenant provider author', async () => {
    await expect(resolveIdentity({})).resolves.toEqual({ user: author, endpoint: 'assistants' });
    expect(getUserById).toHaveBeenCalledWith(author, 'tenantId');
    expect(getAssistant).not.toHaveBeenCalled();
  });

  it.each([null, { tenantId: 'tenant-b' }, {}])(
    'rejects private initialization for an unavailable or foreign-tenant author: %p',
    async (account) => {
      getUserById.mockResolvedValue(account);
      await expect(resolveIdentity({})).rejects.toThrow('Assistant owner could not be verified');
      expect(getAssistant).toHaveBeenCalledWith({ assistantId: 'asst-target' }, { user: 1 });
    },
  );

  it('retains the authorized owner scope without a redundant lookup', async () => {
    await expect(resolveIdentity({ user: user.id })).resolves.toEqual({
      user: user.id,
      endpoint: 'assistants',
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(getAssistant).not.toHaveBeenCalled();
  });

  it.each([null, '', 'external-author', ['65cfb246f7ecadb8b1e8036c'], { $ne: null }])(
    'does not initialize a private reference from an invalid provider author: %p',
    async (providerAuthor) => {
      await expect(resolveIdentity({}, providerAuthor)).rejects.toThrow(
        'Assistant owner could not be verified',
      );
      expect(getUserById).not.toHaveBeenCalled();
      expect(getAssistant).toHaveBeenCalledWith({ assistantId: 'asst-target' }, { user: 1 });
    },
  );

  it('uses the authenticated provider author without another user read', async () => {
    await expect(resolveIdentity({}, user.id)).resolves.toEqual({
      user: user.id,
      endpoint: 'assistants',
    });
    expect(getAssistant).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('preserves a known local owner when provider metadata is absent', async () => {
    getAssistant.mockResolvedValue({ user: author });
    await expect(resolveIdentity({}, null)).resolves.toEqual({
      user: author,
      endpoint: 'assistants',
    });
  });

  it.each([{}, { user: null }, { user: '' }])(
    'does not initialize an ownerless private reference: %p',
    async (reference) => {
      getAssistant.mockResolvedValue(reference);
      await expect(resolveIdentity({}, null)).rejects.toThrow(
        'Assistant owner could not be verified',
      );
    },
  );

  it.each([null, '', 'external-author', ['65cfb246f7ecadb8b1e8036c'], { $ne: null }])(
    'preserves shared-assistant policy without adopting an invalid author: %p',
    async (providerAuthor) => {
      await expect(resolveIdentity({}, providerAuthor, false)).resolves.toEqual({
        user: user.id,
        endpoint: 'assistants',
      });
      expect(getAssistant).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
    },
  );

  it('propagates a user lookup failure instead of adopting an unverified author', async () => {
    getUserById.mockRejectedValue(new Error('user database unavailable'));
    await expect(resolveIdentity({})).rejects.toThrow('user database unavailable');
  });

  it('propagates a reference lookup failure instead of adopting the manager', async () => {
    getAssistant.mockRejectedValue(new Error('assistant database unavailable'));
    await expect(resolveIdentity({}, null)).rejects.toThrow('assistant database unavailable');
  });
});
