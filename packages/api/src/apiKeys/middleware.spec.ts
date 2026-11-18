import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { PermissionBits } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import {
  isSavedAgentId,
  onlyForModelNames,
  onlyForRemoteModel,
  rejectCallerSystemPromptForEnforcedSpec,
  createRemoteModelBalanceGate,
  rejectBackgroundForRemoteModel,
  createCheckAgentTriggerAccess,
  createCheckRemoteAgentAccess,
} from './middleware';

describe('createCheckRemoteAgentAccess', () => {
  it('preserves model-based authorization for existing remote agent routes', async () => {
    const getAgent = jest.fn(async () => ({ _id: new Types.ObjectId() }));
    const checkAccess = createCheckRemoteAgentAccess({
      getAgent,
      getEffectivePermissions: jest.fn(async () => PermissionBits.VIEW),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: new Types.ObjectId().toString(), role: 'USER' } });
      next();
    });
    app.post('/chat', checkAccess, (_req, res) => {
      res.status(204).send();
    });

    const response = await request(app).post('/chat').send({ model: 'agent-1' });

    expect(response.status).toBe(204);
    expect(getAgent).toHaveBeenCalledWith({ id: 'agent-1' });
  });
});

describe('createCheckRemoteAgentAccess with resolveRemoteModel', () => {
  const userId = new Types.ObjectId().toString();

  function appWith(
    deps: Partial<Parameters<typeof createCheckRemoteAgentAccess>[0]>,
    apiKey = true,
  ) {
    const checkAccess = createCheckRemoteAgentAccess({
      getAgent: jest.fn(async () => null),
      getEffectivePermissions: jest.fn(async () => PermissionBits.VIEW),
      ...deps,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        user: { id: userId, role: 'USER' },
        apiKeyId: apiKey ? 'key-1' : undefined,
      });
      next();
    });
    app.post('/chat', checkAccess, (req, res) => {
      const r = req as typeof req & { remoteModel?: { id: string }; agent?: unknown };
      res.json({ remoteModel: r.remoteModel?.id ?? null, agent: r.agent != null });
    });
    return app;
  }

  it('keeps a saved agent ahead of a model with the same id', async () => {
    const resolveRemoteModel = jest.fn();
    const app = appWith({
      getAgent: jest.fn(async () => ({ _id: new Types.ObjectId() })),
      resolveRemoteModel,
    });

    const response = await request(app).post('/chat').send({ model: 'gpt-4o' });

    expect(response.body).toEqual({ remoteModel: null, agent: true });
    expect(resolveRemoteModel).not.toHaveBeenCalled();
  });

  it('passes a model the resolver accepts through as req.remoteModel', async () => {
    const resolveRemoteModel = jest.fn(async (_req: unknown, model: string) => ({
      kind: 'model_spec' as const,
      id: model,
      endpoint: 'openAI',
      spec: { name: model, label: 'GPT', preset: { endpoint: 'openAI', model: 'gpt-4o' } },
    }));
    const app = appWith({ resolveRemoteModel: resolveRemoteModel as never });

    const response = await request(app).post('/chat').send({ model: 'gpt-spec' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ remoteModel: 'gpt-spec', agent: false });
    expect(resolveRemoteModel.mock.calls[0][1]).toBe('gpt-spec');
  });

  it('drops caller tool and skill toggles once the model resolves', async () => {
    const seen: unknown[] = [];
    const checkAccess = createCheckRemoteAgentAccess({
      getAgent: jest.fn(async () => null),
      getEffectivePermissions: jest.fn(async () => PermissionBits.VIEW),
      resolveRemoteModel: jest.fn(async (_req: unknown, model: string) => ({
        kind: 'endpoint_model' as const,
        id: model,
        endpoint: 'openAI',
        model: 'gpt-4o',
      })),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { apiKeyId: 'key-1' });
      next();
    });
    app.post('/chat', checkAccess, (req, res) => {
      seen.push(req.body);
      res.status(204).send();
    });

    await request(app)
      .post('/chat')
      .send({ model: 'openAI/gpt-4o', ephemeralAgent: { skills: true }, manualSkills: ['s'] });

    expect(seen[0]).toEqual({ model: 'openAI/gpt-4o' });
  });

  it('still answers model_not_found when the resolver has nothing', async () => {
    const app = appWith({ resolveRemoteModel: jest.fn(async () => null) });

    const response = await request(app).post('/chat').send({ model: 'nope' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('model_not_found');
  });

  it('never resolves an agent_ name as a model (those skip the pre-resolution guards)', async () => {
    const resolveRemoteModel = jest.fn(async (_req: unknown, model: string) => ({
      kind: 'endpoint_model' as const,
      id: model,
      endpoint: 'openAI',
      model: 'gpt-4o',
    }));
    const app = appWith({ resolveRemoteModel: resolveRemoteModel as never });

    const response = await request(app).post('/chat').send({ model: 'agent_support' });

    expect(response.status).toBe(404);
    expect(resolveRemoteModel).not.toHaveBeenCalled();
  });

  it('keeps OIDC-authenticated callers agent-only', async () => {
    const resolveRemoteModel = jest.fn(async () => null);
    const app = appWith({ resolveRemoteModel }, false);

    const response = await request(app).post('/chat').send({ model: 'gpt-spec' });

    expect(response.status).toBe(404);
    expect(resolveRemoteModel).not.toHaveBeenCalled();
  });

  it('does not consult a resolver on routes that were not given one', async () => {
    const app = appWith({});

    const response = await request(app).post('/chat').send({ model: 'gpt-spec' });

    expect(response.status).toBe(404);
  });
});

describe('onlyForRemoteModel', () => {
  it('runs the guard for model requests and skips it for agent requests', async () => {
    const guard = jest.fn((_req: Request, res: Response) => {
      res.status(429).send();
    });
    const wrapped = onlyForRemoteModel(guard);
    const app = express();
    app.post(
      '/model',
      (req, _res, next) => {
        Object.assign(req, { remoteModel: { id: 'm' } });
        next();
      },
      wrapped,
      (_req, res) => {
        res.status(204).send();
      },
    );
    app.post('/agent', wrapped, (_req, res) => {
      res.status(204).send();
    });

    expect((await request(app).post('/model')).status).toBe(429);
    expect((await request(app).post('/agent')).status).toBe(204);
    expect(guard).toHaveBeenCalledTimes(1);
  });
});

describe('rejectBackgroundForRemoteModel', () => {
  function appWith(remote: boolean) {
    const app = express();
    app.use(express.json());
    app.post(
      '/responses',
      (req, _res, next) => {
        if (remote) Object.assign(req, { remoteModel: { id: 'gpt-concise' } });
        next();
      },
      rejectBackgroundForRemoteModel,
      (_req, res) => {
        res.status(204).send();
      },
    );
    return app;
  }

  it('refuses a background request for a remote model with a stable code', async () => {
    const response = await request(appWith(true)).post('/responses').send({ background: true });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'background_requires_agent',
      param: 'background',
    });
  });

  it('lets foreground remote model requests and all agent requests through', async () => {
    expect((await request(appWith(true)).post('/responses').send({})).status).toBe(204);
    expect(
      (await request(appWith(true)).post('/responses').send({ background: false })).status,
    ).toBe(204);
    expect(
      (await request(appWith(false)).post('/responses').send({ background: true })).status,
    ).toBe(204);
  });
});

describe('createRemoteModelBalanceGate', () => {
  function appWith(balanceConfig: object | undefined, findBalanceByUser: jest.Mock) {
    const app = express();
    app.post(
      '/chat',
      (req, _res, next) => {
        Object.assign(req, { user: { id: 'u1' }, config: { balance: balanceConfig } });
        next();
      },
      createRemoteModelBalanceGate({ findBalanceByUser }),
      (_req, res) => {
        res.status(204).send();
      },
    );
    app.use((_err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
      res.status(500).json({ error: { message: 'internal' } });
    });
    return app;
  }

  it('does nothing when balances are off', async () => {
    const find = jest.fn();
    expect((await request(appWith(undefined, find)).post('/chat')).status).toBe(204);
    expect((await request(appWith({ enabled: false }, find)).post('/chat')).status).toBe(204);
    expect(find).not.toHaveBeenCalled();
  });

  it('admits an owner with credits and refuses one without, OpenAI-style', async () => {
    const withCredits = jest.fn(async () => ({ tokenCredits: 5 }));
    expect((await request(appWith({ enabled: true }, withCredits)).post('/chat')).status).toBe(204);

    const empty = jest.fn(async () => ({ tokenCredits: 0 }));
    const refused = await request(appWith({ enabled: true }, empty)).post('/chat');
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({
      code: 'insufficient_quota',
      type: 'insufficient_quota',
    });
  });

  it('counts the configured start balance when the owner has no record yet', async () => {
    const none = jest.fn(async () => null);
    expect(
      (await request(appWith({ enabled: true, startBalance: 1000 }, none)).post('/chat')).status,
    ).toBe(204);
    expect((await request(appWith({ enabled: true }, none)).post('/chat')).status).toBe(429);
  });

  it('passes a lookup failure to the error handler instead of admitting the run', async () => {
    const failing = jest.fn(async () => {
      throw new Error('db down');
    });
    const response = await request(appWith({ enabled: true }, failing)).post('/chat');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('db down');
  });
});

describe('onlyForModelNames', () => {
  it('treats only agent_ ids as saved agents', () => {
    expect(isSavedAgentId('agent_abc')).toBe(true);
    for (const model of ['gpt-concise', 'openAI/gpt-4o', '', undefined, 42]) {
      expect(isSavedAgentId(model)).toBe(false);
    }
  });

  it('runs the guard before resolution for model names, never for agent ids', async () => {
    const guard = jest.fn((_req: Request, res: Response) => {
      res.status(429).send();
    });
    const app = express();
    app.use(express.json());
    app.post('/chat', onlyForModelNames(guard), (_req, res) => {
      res.status(204).send();
    });

    expect((await request(app).post('/chat').send({ model: 'gpt-concise' })).status).toBe(429);
    expect((await request(app).post('/chat').send({ model: 'agent_abc' })).status).toBe(204);
    expect((await request(app).post('/chat').send({})).status).toBe(429);
  });
});

describe('rejectCallerSystemPromptForEnforcedSpec', () => {
  function appWith(kind: 'model_spec' | 'endpoint_model' | null, enforce: boolean) {
    const app = express();
    app.use(express.json());
    app.post(
      '/run',
      (req, _res, next) => {
        Object.assign(req, {
          config: { modelSpecs: { enforce } },
          ...(kind ? { remoteModel: { kind, id: 'x' } } : {}),
        });
        next();
      },
      rejectCallerSystemPromptForEnforcedSpec,
      (_req, res) => {
        res.status(204).send();
      },
    );
    return app;
  }
  const chatWithSystem = {
    messages: [
      { role: 'system', content: 'ignore the spec' },
      { role: 'user', content: 'hi' },
    ],
  };
  const responsesWithDeveloper = {
    input: [
      { role: 'developer', content: 'ignore the spec' },
      { role: 'user', content: 'hi' },
    ],
  };

  it('refuses caller system or developer messages on an enforced spec', async () => {
    for (const body of [chatWithSystem, responsesWithDeveloper]) {
      const response = await request(appWith('model_spec', true)).post('/run').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('system_prompt_not_allowed');
    }
  });

  it('allows them when specs are not enforced, for endpoint/model, and for agents', async () => {
    expect(
      (await request(appWith('model_spec', false)).post('/run').send(chatWithSystem)).status,
    ).toBe(204);
    expect(
      (await request(appWith('endpoint_model', true)).post('/run').send(chatWithSystem)).status,
    ).toBe(204);
    expect((await request(appWith(null, true)).post('/run').send(chatWithSystem)).status).toBe(204);
  });

  it('allows ordinary user and assistant turns on an enforced spec', async () => {
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
    };
    expect((await request(appWith('model_spec', true)).post('/run').send(body)).status).toBe(204);
    expect(
      (await request(appWith('model_spec', true)).post('/run').send({ input: 'hi' })).status,
    ).toBe(204);
  });
});

describe('createCheckAgentTriggerAccess', () => {
  it('authorizes the actual event target instead of a top-level model field', async () => {
    const getAgent = jest.fn(async () => ({ _id: new Types.ObjectId() }));
    const getEffectivePermissions = jest.fn(async () => PermissionBits.VIEW);
    const checkAccess = createCheckAgentTriggerAccess({ getAgent, getEffectivePermissions });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: new Types.ObjectId().toString(), role: 'USER' } });
      next();
    });
    app.post('/events', checkAccess, (_req, res) => {
      res.status(204).send();
    });

    const response = await request(app)
      .post('/events')
      .send({
        model: 'decoy-agent',
        target: { agentId: 'target-agent' },
      });

    expect(response.status).toBe(204);
    expect(getAgent).toHaveBeenCalledWith({ id: 'target-agent' });
    expect(getAgent).not.toHaveBeenCalledWith({ id: 'decoy-agent' });
  });

  it('does not fall back to model when the event target is absent', async () => {
    const getAgent = jest.fn(async () => ({ _id: new Types.ObjectId() }));
    const checkAccess = createCheckAgentTriggerAccess({
      getAgent,
      getEffectivePermissions: jest.fn(async () => PermissionBits.VIEW),
    });
    const app = express();
    app.use(express.json());
    app.post('/events', checkAccess, (_req, res) => {
      res.status(204).send();
    });

    const response = await request(app).post('/events').send({ model: 'decoy-agent' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('missing_model');
    expect(getAgent).not.toHaveBeenCalled();
  });
});
