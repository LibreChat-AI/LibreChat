import express from 'express';
import request from 'supertest';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createChatResumeContext } from './context';

let jobs: GenerationJobManagerClass;
beforeEach(() => {
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
});
afterEach(async () => jobs.destroy());

function fixture() {
  const errors: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use(createChatResumeContext({ jobs, onError: (error) => errors.push(error) }));
  app.post(['/resume', '/'], (req, res) => {
    res.json(req.body);
  });
  return { app, errors };
}

it.each(['/resume', '/resume/', '/RESUME'])(
  'cannot restore or claim a Responses job through %s',
  async (path) => {
    await jobs.createJob('response', 'owner', 'conversation', {
      initialMetadata: { endpoint: 'responses', agent_id: 'agent' },
    });
    const original = await jobs.getJob('response');
    const getJob = jest.spyOn(jobs, 'getJob');
    const { app } = fixture();
    await request(app)
      .post(path)
      .send({ conversationId: 'response', endpoint: 'agents', actionId: 'action' })
      .expect(404, { error: 'No paused generation for this conversation' });
    expect(getJob).toHaveBeenCalledTimes(1);
    const after = await jobs.getJob('response');
    expect(after?.createdAt).toBe(original?.createdAt);
    expect(after?.status).toBe(original?.status);
    expect(after?.metadata).toEqual(original?.metadata);
  },
);

it('restores a chat context without changing request or action identity', async () => {
  await jobs.createJob('conversation', 'owner', 'conversation', {
    initialMetadata: { endpoint: 'agents' },
  });
  await jobs.getJobStore().updateJob('conversation', {
    pendingAction: {
      actionId: 'action',
      streamId: 'conversation',
      createdAt: Date.now(),
      payload: { type: 'ask_user_question', question: { question: 'Choose' } },
      resumeContext: { endpoint: 'agents', model_parameters: { temperature: 0.3 } },
    },
  });
  const { app } = fixture();
  const result = await request(app)
    .post('/resume')
    .send({ conversationId: 'conversation', actionId: 'action', temperature: 1 })
    .expect(200);
  expect(result.body).toEqual({
    conversationId: 'conversation',
    actionId: 'action',
    endpoint: 'agents',
    temperature: 0.3,
  });
});

it('does not read jobs for ordinary turns or absent identity', async () => {
  const getJob = jest.spyOn(jobs, 'getJob');
  const { app } = fixture();
  await request(app).post('/').send({ conversationId: 'conversation' }).expect(200);
  await request(app).post('/resume').send({}).expect(200);
  expect(getJob).not.toHaveBeenCalled();
});

it('stops before reconstruction on an operational read failure without leaking diagnostics', async () => {
  jest.spyOn(jobs, 'getJob').mockRejectedValue(new Error('private storage diagnostic'));
  const { app, errors } = fixture();
  const result = await request(app)
    .post('/resume')
    .send({ conversationId: 'conversation' })
    .expect(503, { error: 'resume_context_unavailable' });
  expect(JSON.stringify(result.body)).not.toContain('private');
  expect(errors).toHaveLength(1);
});
