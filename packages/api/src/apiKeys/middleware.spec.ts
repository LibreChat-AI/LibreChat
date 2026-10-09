import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { PermissionBits } from 'librechat-data-provider';
import { createCheckAgentTriggerAccess, createCheckRemoteAgentAccess } from './middleware';

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
