import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import {
  createResponseStorage,
  createModels,
  createMethods,
  createManagedMessageId,
  responseReference,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import {
  createResponseCompletion,
  createResponseExecutionConfirmation,
  createResponseExecutionRelease,
} from './completion';
import {
  getAgentCheckpointer,
  __resetCheckpointerForTests,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
} from '../checkpointer';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createCheckpointWriteWitness } from '../checkpoints/witness';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { createResponseResumeTransport } from './transport';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponseResumeAdmission } from './resume';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseRetirement } from './retirement';
import { createAgentRunEnvelope } from '../envelope';
import { GenerationJobManagerClass } from '~/stream';
import { buildPendingAction } from '../hitl/policy';
import { executeAgentRun } from '../remote/host';

describe.each(['replica', 'standalone', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])])(
  'durable resume lifecycle on %s',
  (engine) => {
    let mongo: MongoMemoryReplSet | MongoMemoryServer | undefined;
    let storage: ResponseStorage;
    let manager: GenerationJobManagerClass;
    const owner = { userId: 'resume-owner', tenantId: 'resume-tenant' };
    const responseId = createManagedMessageId();
    const conversationId = 'resume-conversation';
    const checkpointSettings = {
      type: 'mongo' as const,
      checkpointCollectionName: 'resume_fixture_cp',
      checkpointWritesCollectionName: 'resume_fixture_writes',
    };
    const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);

    beforeAll(async () => {
      if (engine === 'replica')
        mongo = await MongoMemoryReplSet.create({
          replSet: { count: 1 },
          instanceOpts: [{ args: ['--nounixsocket'] }],
        });
      else if (engine === 'standalone') mongo = await MongoMemoryServer.create();
      await mongoose.connect(mongo?.getUri() ?? process.env.FERRETDB_URI!, {
        autoIndex: false,
        dbName: `resume_${randomUUID().replace(/-/g, '')}`,
      });
      createModels(mongoose);
      storage = createResponseStorage(mongoose);
    });
    afterAll(async () => {
      await mongoose.connection.db?.dropDatabase();
      await mongoose.disconnect();
      await mongo?.stop();
    });
    beforeEach(async () => {
      __resetCheckpointerForTests();
      await runAsSystem(async () => {
        await mongoose.models.StoredResponse.deleteMany({});
        await mongoose.models.ResponseScope?.deleteMany({});
      });
      manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      manager.initialize();
    });
    afterEach(async () => {
      await manager.destroy();
      jest.restoreAllMocks();
    });

    async function pausedDecision(
      options: {
        reserveIntent?: boolean;
        metadata?: Record<string, string>;
        deferProviderSettlement?: (settle: () => Promise<void>) => void;
        deferCheckpoint?: (close: () => Promise<void>) => void;
      } = {},
    ): Promise<StoredResponseRecord> {
      const root = await storage.reserve({
        ...owner,
        responseId,
        requestKey: 'request',
        fingerprint: 'request',
        agentId: 'agent',
        sourceKeyId: 'key',
        requestJSON: JSON.stringify({
          model: 'agent',
          input: 'Original input',
          background: true,
          ...(options.metadata ? { metadata: options.metadata } : {}),
        }),
        conversationId,
        parentMessageId: 'root',
      });
      if (!root.ok) throw new Error('Reservation failed');
      const execution = await enrollAgentExecution(
        {
          responseRoot: root.record.storageTarget,
          retainTerminalPersistence: true,
          captureTerminalOutcome: true,
          runId: responseId,
          userId: owner.userId,
          conversationId,
          agentId: 'agent',
          protocol: 'responses',
          isPrincipalActive: async () => true,
        },
        { manager },
      );
      const enrolled = await storage.enrollExecution(
        root.record,
        execution.getEnrollmentIdentity(),
        options.metadata ? JSON.stringify({ metadata: options.metadata }) : '{}',
      );
      if (!enrolled.ok) throw new Error('Root enrollment failed');
      await execution.beginProviderExecution();
      const binding = execution.getPersistenceIdentity();
      if (!(await storage.bindExecution(enrolled.record, binding)))
        throw new Error('Provider binding failed');
      const action = buildPendingAction(
        { type: 'ask_user_question', question: { question: 'Which environment?' } },
        {
          streamId: responseId,
          responseMessageId: responseId,
          conversationId,
          runId: responseId,
          ttlMs: 60_000,
        },
      );
      const job = (await manager.getJob(responseId))!;
      const namespace = job.metadata.checkpointNamespace!;
      await manager.updateMetadata(
        responseId,
        { responseCheckpointConfigJSON: JSON.stringify(checkpointSettings) },
        execution.createdAt,
      );
      const writer = storage.createCheckpointWriter(responseReference(enrolled.record), {
        ...binding,
        writerId: randomUUID(),
        namespace,
        configJSON: JSON.stringify(checkpointSettings),
      });
      const witness = createCheckpointWriteWitness({
        async open() {
          if (!(await writer.open())) throw new Error('Saver admission failed');
        },
        async settle() {
          if (!(await writer.settle())) throw new Error('Saver settlement failed');
        },
      });
      const saver = await getAgentCheckpointer(checkpointSettings, { writeWitness: witness });
      if (!saver) throw new Error('Saver missing');
      const checkpoint = emptyCheckpoint();
      await saver.putWrites(
        {
          configurable: {
            thread_id: conversationId,
            checkpoint_ns: '',
            checkpoint_id: checkpoint.id,
            [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
          },
        },
        [[INTERRUPT, { id: 'interrupt', value: action.payload }]],
        'task',
      );
      await saver.put(
        {
          configurable: {
            thread_id: conversationId,
            checkpoint_ns: '',
            [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
          },
        },
        checkpoint,
        { source: 'input', step: -1, parents: {} },
      );
      const close = async () => {
        if ((await witness.close()) !== 'settled') throw new Error('Saver closure failed');
      };
      if (options.deferCheckpoint) options.deferCheckpoint(close);
      else await close();
      expect(
        await execution.pauseForReview(action, async () => {
          const result = await storage.publishReview(
            owner,
            responseId,
            { execution: (await storage.read(owner, responseId))! },
            execution.createdAt,
            {
              actionId: action.actionId,
              providerExecutionId: job.metadata.providerExecutionId!,
              expiresAt: action.expiresAt!,
              partialResponseJSON: JSON.stringify({
                output: [],
                ...(options.metadata ? { metadata: options.metadata } : {}),
              }),
              checkpointConfigJSON: JSON.stringify(checkpointSettings),
              checkpointId: checkpoint.id,
              checkpointNs: '',
              pendingActionJSON: JSON.stringify(action),
            },
            JSON.stringify({
              status: 'requires_action',
              required_action: { type: 'librechat_review' },
              ...(options.metadata ? { metadata: options.metadata } : {}),
            }),
          );
          if (!result.ok) throw new Error('Pause journal publication failed');
        }),
      ).toBe(true);
      await execution.settle();
      const settleProvider = async () => {
        if (!(await storage.settleExecution(responseReference(enrolled.record), binding)))
          throw new Error('Provider settlement failed');
      };
      if (options.deferProviderSettlement) options.deferProviderSettlement(settleProvider);
      else await settleProvider();
      const paused = (await storage.read(owner, responseId))!;
      const proof = await storage.readExecutionProof(paused);
      if (options.deferCheckpoint || options.deferProviderSettlement) expect(proof).toBeNull();
      else
        expect(proof).toMatchObject({
          checkpointWriterId: expect.any(String),
          checkpointNamespace: namespace,
        });
      if (options.reserveIntent === false) return paused;
      const reserved = await storage.reserveResume(
        owner,
        responseId,
        {
          generationCreatedAt: execution.createdAt,
          intentId: 'intent',
          actionId: action.actionId,
          previousProviderExecutionId: job.metadata.providerExecutionId!,
          providerExecutionId: 'next-provider',
          fingerprint: 'answer',
          resolutionJSON: '{"answer":"staging"}',
        },
        Date.now(),
      );
      if (!reserved.ok) throw new Error('Resume reservation failed');
      return reserved.record;
    }

    function admission(options: { authorized?: () => boolean; valid?: () => boolean } = {}) {
      return createResponseResumeAdmission({
        storage,
        jobs: manager,
        authorize: async () => options.authorized?.() ?? true,
        validate: async (record) => {
          const action = JSON.parse(record.review!.pendingActionJSON!);
          return (options.valid?.() ?? true) && action.actionId === record.resume?.actionId
            ? { ok: true, provenance: { userSubmittedPaths: ['0.text'] } }
            : { ok: false };
        },
      });
    }

    function resumeAck() {
      return {
        id: responseId,
        object: 'response',
        model: 'agent',
        status: 'in_progress',
        background: true,
        store: true,
      };
    }

    it.each(['accepted', 'duplicate', 'lost'] as const)(
      'reconciles a %s resume acknowledgement only against the exact owned provider start',
      (mode) =>
        scoped(async () => {
          const record = await pausedDecision();
          let calls = 0;
          const send = createResponseResumeTransport({
            storage,
            jobs: manager,
            getOrigin: () => 'http://127.0.0.1:3089',
            signingSecret: () => 'resume-transport-secret',
            acknowledgementTimeoutMs: async () => 1000,
            fetch: async (url, init) => {
              calls++;
              expect(String(url)).toBe('http://127.0.0.1:3089/api/agents/v1/responses');
              expect(init?.body).toBe('{}');
              const bearer = new Headers(init?.headers).get('Authorization')!;
              expect(jwt.verify(bearer.slice(7), 'resume-transport-secret')).toMatchObject({
                purpose: 'responses_resume',
                responseId,
                intentId: record.resume!.intentId,
                generationCreatedAt: record.generationCreatedAt,
                providerExecutionId: 'next-provider',
              });
              expect(await admission()(owner, responseId, 'intent')).toMatchObject({ ok: true });
              expect(
                await manager.beginProviderExecution(
                  responseId,
                  record.generationCreatedAt!,
                  'next-provider',
                  'owning-attempt',
                ),
              ).toBe(true);
              if (mode === 'lost') throw new Error('PRIVATE lost acknowledgement');
              if (mode === 'duplicate') return new Response('', { status: 409 });
              return Response.json(resumeAck(), { status: 202 });
            },
          });
          expect(await send(record)).toEqual({
            status: 'resumed',
            generationCreatedAt: record.generationCreatedAt,
          });
          expect(calls).toBe(1);
          await manager.completeJob(responseId, undefined, record.generationCreatedAt);
          await manager.markProviderExecutionDrained(
            responseId,
            record.generationCreatedAt!,
            'next-provider',
          );
        }),
    );

    it.each(['reserved', 'admitted', 'unowned'] as const)(
      'does not treat a %s resume decision or the prior generation as proof of provider startup',
      (mode) =>
        scoped(async () => {
          const record = await pausedDecision();
          const send = createResponseResumeTransport({
            storage,
            jobs: manager,
            getOrigin: () => 'http://127.0.0.1:3089',
            signingSecret: () => 'resume-transport-secret',
            acknowledgementTimeoutMs: async () => 1000,
            fetch: async () => {
              if (mode !== 'reserved') await admission()(owner, responseId, 'intent');
              if (mode === 'unowned')
                await manager.beginProviderExecution(
                  responseId,
                  record.generationCreatedAt!,
                  'next-provider',
                );
              throw new Error('PRIVATE lost acknowledgement');
            },
          });
          await expect(send(record)).rejects.toMatchObject({
            code: 'response_acknowledgement_unavailable',
            certainty: 'ambiguous',
            retryable: true,
          });
          if (mode === 'unowned') {
            await manager.completeJob(responseId, undefined, record.generationCreatedAt);
            await manager.markProviderExecutionDrained(
              responseId,
              record.generationCreatedAt!,
              'next-provider',
            );
          }
        }),
    );

    it('keeps a premature resume HTTP acknowledgement retryable until provider ownership is confirmed', () =>
      scoped(async () => {
        const record = await pausedDecision();
        const send = createResponseResumeTransport({
          storage,
          jobs: manager,
          getOrigin: () => 'http://127.0.0.1:3089',
          signingSecret: () => 'resume-transport-secret',
          acknowledgementTimeoutMs: async () => 1000,
          fetch: async () => {
            await admission()(owner, responseId, 'intent');
            return Response.json(resumeAck(), { status: 202 });
          },
        });
        await expect(send(record)).rejects.toMatchObject({
          code: 'response_acknowledgement_invalid',
          certainty: 'ambiguous',
          retryable: true,
        });
        expect(
          (await manager.getJob(responseId))?.metadata.providerExecutionStartedId,
        ).toBeUndefined();
      }));

    it.each(['intent', 'provider', 'epoch'] as const)(
      'rejects a lost resume acknowledgement for a changed %s instead of attaching to another execution',
      (field) =>
        scoped(async () => {
          const record = await pausedDecision();
          await admission()(owner, responseId, 'intent');
          await manager.beginProviderExecution(
            responseId,
            record.generationCreatedAt!,
            'next-provider',
            'owner',
          );
          const changed = { ...record, resume: { ...record.resume! } };
          if (field === 'intent') changed.resume.intentId = 'other-intent';
          else if (field === 'provider') changed.resume.providerExecutionId = 'other-provider';
          else changed.generationCreatedAt = record.generationCreatedAt! + 1;
          const send = createResponseResumeTransport({
            storage,
            jobs: manager,
            getOrigin: () => 'http://127.0.0.1:3089',
            signingSecret: () => 'resume-transport-secret',
            acknowledgementTimeoutMs: async () => 1000,
            fetch: async () => {
              throw new Error('lost acknowledgement');
            },
          });
          await expect(send(changed)).rejects.toMatchObject({
            code: 'response_acknowledgement_unavailable',
            retryable: true,
          });
          await manager.completeJob(responseId, undefined, record.generationCreatedAt);
          await manager.markProviderExecutionDrained(
            responseId,
            record.generationCreatedAt!,
            'next-provider',
          );
        }),
    );

    it('accepts canonical cancellation after the transient resumed job has expired', () =>
      scoped(async () => {
        const record = await pausedDecision();
        const admitted = await admission()(owner, responseId, 'intent');
        if (!admitted.ok) throw new Error('Admission failed');
        const enrolled = await storage.enrollExecution(
          admitted.record,
          {
            generationCreatedAt: record.generationCreatedAt!,
            providerExecutionId: 'next-provider',
          },
          admitted.record.responseJSON!,
        );
        if (!enrolled.ok) throw new Error('Resumed enrollment failed');
        await manager.beginProviderExecution(
          responseId,
          record.generationCreatedAt!,
          'next-provider',
          'owner',
        );
        const started = (await manager.getJob(responseId))!;
        if (
          !(await storage.bindExecution(admitted.record, {
            generationCreatedAt: started.createdAt,
            providerExecutionId: started.metadata.providerExecutionId!,
            ownerId: started.metadata.providerExecutionOwnerId,
          }))
        )
          throw new Error('Resumed binding failed');
        await manager.completeJob(responseId, undefined, record.generationCreatedAt);
        await manager.markProviderExecutionDrained(
          responseId,
          record.generationCreatedAt!,
          'next-provider',
        );
        const job = (await manager.getJob(responseId))!;
        const current = (await storage.read(owner, responseId))!;
        const binding = {
          generationCreatedAt: job.createdAt,
          providerExecutionId: job.metadata.providerExecutionId!,
          ownerId: job.metadata.providerExecutionOwnerId,
        };
        const completion = createResponseCompletion({
          storage,
          confirmExecution: createResponseExecutionConfirmation(storage, manager),
          releaseExecution: createResponseExecutionRelease(manager, storage),
          cleanupCheckpoint: cleanupResponseCheckpoint,
        });
        expect(
          (
            await completion.stageAndFinish(current, {
              ...binding,
              status: 'cancelled',
              responseJSON: JSON.stringify({ ...resumeAck(), output: [], status: 'cancelled' }),
            })
          ).status,
        ).toBe('cancelled');
        await manager.getJobStore().deleteJob(responseId, record.generationCreatedAt);
        const lookup = jest.spyOn(manager, 'getJob');
        const send = createResponseResumeTransport({
          storage,
          jobs: manager,
          getOrigin: () => 'http://127.0.0.1:3089',
          signingSecret: () => 'resume-transport-secret',
          acknowledgementTimeoutMs: async () => 1000,
          fetch: async () => {
            throw new Error('lost acknowledgement');
          },
        });
        expect(await send(record)).toEqual({
          status: 'settled',
          generationCreatedAt: record.generationCreatedAt,
        });
        expect(lookup).not.toHaveBeenCalled();
      }));

    it('reconciles concurrent admission into one selected same-epoch segment without starting providers', () =>
      scoped(async () => {
        const original = await pausedDecision();
        const create = jest.spyOn(manager, 'createJob');
        const start = jest.spyOn(manager, 'beginProviderExecution');
        const admit = admission();
        const results = await Promise.all(
          Array.from({ length: 12 }, () => admit(owner, responseId, 'intent')),
        );
        expect(results.every((result) => result.ok && result.status === 'ready')).toBe(true);
        expect(create).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'running',
          createdAt: original.generationCreatedAt,
          metadata: {
            providerExecutionId: 'next-provider',
            providerDrained: true,
            userSubmittedPaths: ['0.text'],
          },
        });
        const current = (await storage.read(owner, responseId))!;
        expect(current).toMatchObject({
          status: 'in_progress',
          generationCreatedAt: original.generationCreatedAt,
          resume: { state: 'admitted' },
        });
        expect(JSON.parse(current.responseJSON!)).not.toHaveProperty('required_action');
        expect(current.review?.pendingActionJSON).toBe(original.review?.pendingActionJSON);
        expect(
          await manager.beginProviderExecution(
            responseId,
            original.generationCreatedAt!,
            'next-provider',
          ),
        ).toBe(true);
        expect(await admit(owner, responseId, 'intent')).toMatchObject({
          ok: true,
          status: 'attached',
        });
        expect(start).toHaveBeenCalledTimes(1);
        await manager.completeJob(responseId, undefined, original.generationCreatedAt);
        await manager.markProviderExecutionDrained(
          responseId,
          original.generationCreatedAt!,
          'next-provider',
        );
      }));

    it('recovers a lost approval-CAS acknowledgement by the exact selected provider identity', () =>
      scoped(async () => {
        await pausedDecision();
        const resolve = manager.approvals.resolve.bind(manager.approvals);
        jest.spyOn(manager.approvals, 'resolve').mockImplementationOnce(async (...args) => {
          expect(await resolve(...args)).toBe(true);
          throw new Error('lost acknowledgement');
        });
        expect(await admission()(owner, responseId, 'intent')).toMatchObject({
          ok: true,
          status: 'ready',
        });
      }));

    it('recovers a lost Mongo admission acknowledgement without resolving a second time', () =>
      scoped(async () => {
        await pausedDecision();
        const persist = storage.admitResume.bind(storage);
        const resolve = jest.spyOn(manager.approvals, 'resolve');
        jest.spyOn(storage, 'admitResume').mockImplementationOnce(async (...args) => {
          await persist(...args);
          throw new Error('lost Mongo acknowledgement');
        });
        const admit = admission();
        await expect(admit(owner, responseId, 'intent')).rejects.toThrow(
          'lost Mongo acknowledgement',
        );
        expect(await admit(owner, responseId, 'intent')).toMatchObject({
          ok: true,
          status: 'ready',
        });
        expect(resolve).toHaveBeenCalledTimes(1);
      }));

    it('does not resolve invalid, foreign, changed-intent, cancelled or revoked requests', () =>
      scoped(async () => {
        await pausedDecision();
        const resolve = jest.spyOn(manager.approvals, 'resolve');
        const unavailable = { ok: false, code: 'response_resume_unavailable' };
        expect(await admission({ valid: () => false })(owner, responseId, 'intent')).toEqual(
          unavailable,
        );
        expect(await admission({ authorized: () => false })(owner, responseId, 'intent')).toEqual(
          unavailable,
        );
        expect(await admission()({ ...owner, userId: 'other' }, responseId, 'intent')).toEqual(
          unavailable,
        );
        expect(await admission()(owner, responseId, 'other-intent')).toEqual(unavailable);
        await storage.requestCancellation(owner, responseId, Date.now());
        expect(await admission()(owner, responseId, 'intent')).toEqual(unavailable);
        expect(resolve).not.toHaveBeenCalled();
        expect((await manager.getJob(responseId))?.status).toBe('requires_action');
      }));

    it('cannot consume a pause after its provider identity changes', () =>
      scoped(async () => {
        await pausedDecision();
        const transition = manager.getJobStore().transitionStatus.bind(manager.getJobStore());
        jest
          .spyOn(manager.getJobStore(), 'transitionStatus')
          .mockImplementationOnce(async (id, input) => {
            // Simulate a concurrent provider replacement after the lifecycle read, before its CAS.
            await manager
              .getJobStore()
              .updateJob(id, { providerExecutionId: 'replacement-provider' });
            return transition(id, input);
          });
        expect(await admission()(owner, responseId, 'intent')).toEqual({
          ok: false,
          code: 'response_resume_unavailable',
        });
        expect((await manager.getJob(responseId))?.status).toBe('requires_action');
      }));

    it('rechecks authority after the approval CAS and never admits a revoked grant', () =>
      scoped(async () => {
        await pausedDecision();
        let authorized = true;
        const resolve = manager.approvals.resolve.bind(manager.approvals);
        jest.spyOn(manager.approvals, 'resolve').mockImplementationOnce(async (...args) => {
          const result = await resolve(...args);
          authorized = false;
          return result;
        });
        const begin = jest.spyOn(manager, 'beginProviderExecution');
        expect(
          await admission({ authorized: () => authorized })(owner, responseId, 'intent'),
        ).toEqual({
          ok: false,
          code: 'response_resume_unavailable',
        });
        expect((await storage.read(owner, responseId))?.resume?.state).toBe('reserved');
        expect(begin).not.toHaveBeenCalled();
      }));

    it('requires checkpoint validation again after the original pending action was consumed', () =>
      scoped(async () => {
        await pausedDecision();
        expect(await admission()(owner, responseId, 'intent')).toMatchObject({ ok: true });
        expect((await manager.getJob(responseId))?.metadata.pendingAction).toBeUndefined();
        const resolve = jest.spyOn(manager.approvals, 'resolve');
        expect(await admission({ valid: () => false })(owner, responseId, 'intent')).toEqual({
          ok: false,
          code: 'response_resume_unavailable',
        });
        expect(resolve).not.toHaveBeenCalled();
      }));

    it('does not attach to a missing or replacement generation', () =>
      scoped(async () => {
        await pausedDecision();
        await manager.getJobStore().deleteJob(responseId);
        expect(await admission()(owner, responseId, 'intent')).toEqual({
          ok: false,
          code: 'response_resume_unavailable',
        });
        await manager.createJob(responseId, owner.userId, conversationId, {
          admissionCheck: async () => true,
          initialMetadata: {
            agent_id: 'agent',
            endpoint: 'responses',
            responseMessageId: responseId,
          },
        });
        expect(await admission()(owner, responseId, 'intent')).toEqual({
          ok: false,
          code: 'response_resume_unavailable',
        });
        expect((await storage.read(owner, responseId))?.resume?.state).toBe('reserved');
      }));

    it('retries paused checkpoint cleanup before publishing canonical cancellation', () =>
      scoped(async () => {
        await pausedDecision();
        const checkpointNamespace = (await manager.getJob(responseId))!.metadata
          .checkpointNamespace!;
        const cleanup = jest.fn(async () => {});
        cleanup.mockRejectedValueOnce(new Error('checkpoint storage unavailable'));
        const retire = createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
        });
        await expect(retire(owner, responseId)).rejects.toThrow('checkpoint storage unavailable');
        expect(await storage.read(owner, responseId)).toMatchObject({
          status: 'requires_action',
          cancellationRequestedAt: expect.any(Number),
          resume: { state: 'reserved' },
        });
        expect((await manager.getJob(responseId))?.status).toBe('aborted');
        expect(await retire(owner, responseId)).toBe('stopped');
        expect((await storage.read(owner, responseId))?.status).toBe('cancelled');
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ...owner,
            conversationId,
            pendingTerminal: {
              checkpointNamespace,
              checkpointConfigJSON: JSON.stringify(checkpointSettings),
            },
          }),
          checkpointNamespace,
        );
      }));

    it('cleans an expired paused checkpoint without admitting another provider segment', () =>
      scoped(async () => {
        const record = await pausedDecision();
        const checkpointNamespace = (await manager.getJob(responseId))!.metadata
          .checkpointNamespace!;
        const checkpointConfigJSON = JSON.stringify(checkpointSettings);
        await manager.getJobStore().updateJob(responseId, {
          checkpointNamespace,
          responseCheckpointConfigJSON: checkpointConfigJSON,
        });
        await mongoose.models.StoredResponse.updateOne(
          { responseId },
          {
            $set: {
              expiredAt: new Date(Date.now() - 1),
              'review.checkpointConfigJSON': checkpointConfigJSON,
            },
          },
        );
        expect(await storage.reserve({ ...record, expiredAt: new Date(Date.now() - 1) })).toEqual({
          ok: false,
          code: 'response_unavailable',
        });
        const cleanup = jest.fn(async () => {});
        const start = jest.spyOn(manager, 'beginProviderExecution');
        const retire = createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
        });
        expect(await retire(owner, responseId)).toBe('stopped');
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(start).not.toHaveBeenCalled();
        expect(await storage.read(owner, responseId)).toBeNull();
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'aborted',
          metadata: {
            providerDrained: true,
            terminalPersistencePending: false,
          },
        });
      }));

    it.each([
      { phase: 'admitted', operation: 'expiry' },
      { phase: 'approval_only', operation: 'expiry' },
      { phase: 'admitted', operation: 'Stop' },
      { phase: 'approval_only', operation: 'Stop' },
      { phase: 'admitted', operation: 'conversation' },
      { phase: 'approval_only', operation: 'conversation' },
      { phase: 'admitted', operation: 'owner' },
      { phase: 'approval_only', operation: 'owner' },
    ] as const)(
      'cleans $operation after $phase resume before the next provider starts',
      ({ phase, operation }) =>
        scoped(async () => {
          const original = await pausedDecision();
          if (phase === 'approval_only') {
            jest
              .spyOn(storage, 'admitResume')
              .mockRejectedValueOnce(new Error('admission unavailable'));
            await expect(admission()(owner, responseId, 'intent')).rejects.toThrow(
              'admission unavailable',
            );
          } else {
            expect(await admission()(owner, responseId, 'intent')).toMatchObject({
              ok: true,
              status: 'ready',
            });
          }
          expect((await manager.getJob(responseId))?.metadata).toMatchObject({
            providerExecutionId: 'next-provider',
          });
          if (operation === 'expiry')
            await mongoose.models.StoredResponse.updateOne(
              { responseId },
              { $set: { expiredAt: new Date(Date.now() - 1) } },
            );
          const db = createMethods(mongoose);
          if (operation === 'owner') {
            await db.prepareUserResponseErasure(owner);
            await expect(db.eraseUserResponses(owner)).rejects.toMatchObject({
              code: 'response_erasure_pending',
            });
          }
          if (operation === 'conversation')
            await expect(
              db.deleteConvos(owner.userId, { conversationId }, { allowEmpty: true }),
            ).rejects.toMatchObject({ code: 'response_erasure_pending' });
          if (operation === 'owner' || operation === 'conversation') {
            const retained = await mongoose.models.StoredResponse.collection.findOne({
              responseId,
            });
            expect(retained?.review).toEqual({
              actionId: original.review!.actionId,
              providerExecutionId: original.review!.providerExecutionId,
            });
            const selection = original.resume!;
            expect(retained?.resume).toEqual({
              intentId: selection.intentId,
              actionId: selection.actionId,
              previousProviderExecutionId: selection.previousProviderExecutionId,
              providerExecutionId: selection.providerExecutionId,
              state: phase === 'admitted' ? 'admitted' : 'reserved',
            });
            expect(retained).not.toHaveProperty('requestJSON');
            expect(retained).not.toHaveProperty('responseJSON');
            expect(JSON.stringify(retained)).not.toContain('Original input');
            expect(JSON.stringify(retained)).not.toContain('staging');
          }
          const cleanup = jest.fn(cleanupResponseCheckpoint);
          const start = jest.spyOn(manager, 'beginProviderExecution');
          const retire = createResponseRetirement({
            storage,
            jobs: manager,
            cleanupCheckpoint: cleanup,
          });
          expect(await retire(owner, responseId)).toBe('stopped');
          expect(cleanup).toHaveBeenCalledTimes(1);
          expect(start).not.toHaveBeenCalled();
          const saved = await storage.read(owner, responseId);
          if (operation !== 'Stop') expect(saved).toBeNull();
          else expect(saved).toMatchObject({ status: 'cancelled', releaseAcknowledged: true });
          if (saved) {
            const proof = await storage.readExecutionProof(saved);
            expect(proof).toMatchObject({
              providerExecutionId: original.review!.providerExecutionId,
              releaseAcknowledged: true,
            });
            expect(proof).not.toHaveProperty('outcome');
          }
          expect(await manager.getJob(responseId)).toMatchObject({
            status: 'aborted',
            metadata: { providerDrained: true, terminalPersistencePending: false },
          });
        }),
    );

    it.each([
      { selected: false, missing: false },
      { selected: false, missing: true },
      { selected: true, missing: false },
      { selected: true, missing: true },
    ])(
      'waits for the real checkpoint writer with selected=$selected and missingJob=$missing',
      ({ selected, missing }) =>
        scoped(async () => {
          let settle!: () => Promise<void>;
          const record = await pausedDecision({
            reserveIntent: selected,
            deferCheckpoint: (close) => {
              settle = close;
            },
          });
          if (selected)
            expect(await admission()(owner, responseId, 'intent')).toMatchObject({
              ok: false,
              code: 'response_resume_unavailable',
            });
          if (missing) await manager.getJobStore().deleteJob(responseId);
          const cleanup = jest.fn(cleanupResponseCheckpoint);
          const retire = createResponseRetirement({
            storage,
            jobs: manager,
            cleanupCheckpoint: cleanup,
          });
          expect(await retire(owner, responseId)).toBe('pending');
          expect(cleanup).not.toHaveBeenCalled();
          expect(await storage.readExecutionProof(record)).toBeNull();
          await settle();
          expect(await retire(owner, responseId)).toBe('stopped');
          expect(cleanup).toHaveBeenCalledTimes(1);
          expect((await storage.read(owner, responseId))?.status).toBe('cancelled');
        }),
    );

    it.each([false, true])(
      'requires real predecessor drain with successorSelected=%s',
      (selected) =>
        scoped(async () => {
          let settle!: () => Promise<void>;
          await pausedDecision({
            reserveIntent: selected,
            deferProviderSettlement: (close) => {
              settle = close;
            },
          });
          if (selected)
            expect(await admission()(owner, responseId, 'intent')).toMatchObject({ ok: true });
          await manager.getJobStore().deleteJob(responseId);
          const cleanup = jest.fn(cleanupResponseCheckpoint);
          const retire = createResponseRetirement({
            storage,
            jobs: manager,
            cleanupCheckpoint: cleanup,
          });
          if (selected) {
            // Admission must have persisted old drain before replacing the only job proof.
            expect(
              await storage.readExecutionProof((await storage.read(owner, responseId))!),
            ).not.toBeNull();
            expect(await retire(owner, responseId)).toBe('stopped');
            return;
          }
          expect(await retire(owner, responseId)).toBe('pending');
          expect(cleanup).not.toHaveBeenCalled();
          await settle();
          expect(await retire(owner, responseId)).toBe('stopped');
        }),
    );

    it('imports a lost canonical drain acknowledgement only from the actual predecessor job', () =>
      scoped(async () => {
        await pausedDecision({ reserveIntent: false, deferProviderSettlement: () => {} });
        const cleanup = jest.fn(cleanupResponseCheckpoint);
        const retire = createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
        });
        expect(await retire(owner, responseId)).toBe('stopped');
        expect(cleanup).toHaveBeenCalledTimes(1);
      }));

    it.each(['checkpoint_ack', 'cancel_ack', 'release_ack', 'released_ack_lost'] as const)(
      'recovers unused resume cancellation after losing %s without replaying the provider',
      (fault) =>
        scoped(async () => {
          await pausedDecision();
          expect(await admission()(owner, responseId, 'intent')).toMatchObject({ ok: true });
          const cleanup = jest.fn(cleanupResponseCheckpoint);
          if (fault === 'checkpoint_ack') {
            jest
              .spyOn(storage, 'acknowledgeCheckpointErasure')
              .mockRejectedValueOnce(new Error('lost ack'));
          } else if (fault === 'cancel_ack') {
            const finish = storage.finishPausedCancellation.bind(storage);
            jest
              .spyOn(storage, 'finishPausedCancellation')
              .mockImplementationOnce(async (...args) => {
                await finish(...args);
                throw new Error('lost ack');
              });
          } else if (fault === 'release_ack') {
            jest
              .spyOn(storage, 'acknowledgeExecutionRelease')
              .mockRejectedValueOnce(new Error('lost ack'));
          } else {
            const ack = storage.acknowledgeExecutionRelease.bind(storage);
            jest
              .spyOn(storage, 'acknowledgeExecutionRelease')
              .mockImplementationOnce(async (...args) => {
                await ack(...args);
                throw new Error('lost ack');
              });
          }
          const start = jest.spyOn(manager, 'beginProviderExecution');
          const retire = createResponseRetirement({
            storage,
            jobs: manager,
            cleanupCheckpoint: cleanup,
          });
          await expect(retire(owner, responseId)).rejects.toThrow('lost ack');
          if (fault === 'release_ack' || fault === 'released_ack_lost') {
            expect((await manager.getJob(responseId))?.metadata.terminalPersistencePending).toBe(
              false,
            );
            await manager.getJobStore().deleteJob(responseId);
          }
          const recovered = createResponseStorage(mongoose);
          const retry = createResponseRetirement({
            storage: recovered,
            jobs: manager,
            cleanupCheckpoint: cleanup,
          });
          expect(await retry(owner, responseId)).toBe('stopped');
          expect(await recovered.read(owner, responseId)).toMatchObject({
            status: 'cancelled',
            releaseAcknowledged: true,
          });
          expect(start).not.toHaveBeenCalled();
        }),
    );

    it.each(['before_enrollment', 'enrolled_readback'] as const)(
      'does not return resumed startup authority after cancellation at %s',
      (phase) =>
        scoped(async () => {
          await pausedDecision();
          const admitted = await admission()(owner, responseId, 'intent');
          if (!admitted.ok) throw new Error('Resume admission failed');
          const binding = {
            generationCreatedAt: admitted.record.generationCreatedAt!,
            providerExecutionId: 'next-provider',
          };
          let record = admitted.record;
          if (phase === 'enrolled_readback') {
            const enrolled = await storage.enrollExecution(record, binding, '{}');
            if (!enrolled.ok) throw new Error('Enrollment failed');
            record = enrolled.record;
          }
          await storage.requestCancellation(owner, responseId, Date.now());
          expect(await storage.enrollExecution(record, binding, '{}')).toMatchObject({
            ok: false,
            code: 'response_conflict',
          });
        }),
    );

    it('rejects a late predecessor failure after the successor was selected', () =>
      scoped(async () => {
        const record = await pausedDecision();
        expect(await admission()(owner, responseId, 'intent')).toMatchObject({ ok: true });
        const proof = await storage.readExecutionProof(record);
        if (!proof) throw new Error('Predecessor proof missing');
        const current = (await storage.read(owner, responseId))!;
        expect(
          await storage.recordPersistenceFailure(current, {
            generationCreatedAt: proof.generationCreatedAt,
            providerExecutionId: proof.providerExecutionId,
            ownerId: proof.ownerId,
            code: 'target_retired',
          }),
        ).toMatchObject({ ok: false, code: 'response_conflict' });
        expect(await storage.read(owner, responseId)).toMatchObject({
          resume: { intentId: 'intent', providerExecutionId: 'next-provider' },
        });
      }));

    it.each(['reserve', 'admit', 'enroll', 'enrolled_readback'] as const)(
      'withholds payload when closure wins the %s acknowledgement',
      (phase) =>
        scoped(async () => {
          const record = await pausedDecision({ reserveIntent: phase !== 'reserve' });
          let current = record;
          const binding = {
            generationCreatedAt: record.generationCreatedAt!,
            providerExecutionId: 'next-provider',
          };
          if (phase === 'enroll' || phase === 'enrolled_readback') {
            const admitted = await admission()(owner, responseId, 'intent');
            if (!admitted.ok) throw new Error('Admission failed');
            current = admitted.record;
            if (phase === 'enrolled_readback') {
              const enrolled = await storage.enrollExecution(current, binding, '{}');
              if (!enrolled.ok) throw new Error('Enrollment failed');
              current = enrolled.record;
            }
          }
          const collection = mongoose.models.StoredResponse.collection;
          const close = () => createMethods(mongoose).prepareUserResponseErasure(owner);
          if (phase === 'enrolled_readback') {
            const find = collection.findOne.bind(collection);
            jest.spyOn(collection, 'findOne').mockImplementationOnce(async (...args) => {
              const result = await find(...args);
              await close();
              return result;
            });
          } else {
            const update = collection.findOneAndUpdate.bind(collection);
            jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
              const result = await update(...args);
              await close();
              return result;
            });
          }
          const start = jest.spyOn(manager, 'beginProviderExecution');
          let result;
          if (phase === 'reserve')
            result = await storage.reserveResume(
              owner,
              responseId,
              {
                generationCreatedAt: record.generationCreatedAt!,
                intentId: 'intent',
                actionId: record.review!.actionId,
                previousProviderExecutionId: record.review!.providerExecutionId,
                providerExecutionId: 'next-provider',
                fingerprint: 'answer',
                resolutionJSON: '{"answer":"staging"}',
              },
              Date.now(),
            );
          else if (phase === 'admit') result = await admission()(owner, responseId, 'intent');
          else result = await storage.enrollExecution(current, binding, '{}');
          expect(result).toMatchObject({ ok: false });
          expect(result).not.toHaveProperty('record');
          expect(await storage.read(owner, responseId)).toBeNull();
          expect(start).not.toHaveBeenCalled();
        }),
    );

    it('rejects a job provider changed without a durable successor selection', () =>
      scoped(async () => {
        const record = await pausedDecision({ reserveIntent: false });
        await manager.approvals.resolve(
          responseId,
          record.review!.actionId,
          { providerExecutionId: 'unselected-provider', providerDrained: true },
          record.generationCreatedAt,
          record.review!.providerExecutionId,
        );
        const cleanup = jest.fn(cleanupResponseCheckpoint);
        const retire = createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
        });
        await expect(retire(owner, responseId)).rejects.toThrow(
          'Response paused cancellation identity changed',
        );
        expect(cleanup).not.toHaveBeenCalled();
        expect(await storage.read(owner, responseId)).not.toMatchObject({
          releaseAcknowledged: true,
        });
      }));

    it('cancels a valid large paused response without duplicating request and review metadata', () =>
      scoped(async () => {
        const padding = 'x'.repeat(4 * 1024 * 1024);
        await pausedDecision({ reserveIntent: false, metadata: { padding } });
        const cleanup = jest.fn(cleanupResponseCheckpoint);
        const retire = createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
        });
        expect(await retire(owner, responseId)).toBe('stopped');
        const record = await storage.read(owner, responseId);
        expect(record).toMatchObject({
          status: 'cancelled',
          requestJSON: '{}',
          releaseAcknowledged: true,
        });
        expect(JSON.parse(record!.responseJSON!).metadata.padding).toBe(padding);
        expect(cleanup).toHaveBeenCalledTimes(1);
      }));

    it('cleans a paused response after its job disappears using retained canonical proof', () =>
      scoped(async () => {
        await pausedDecision({ reserveIntent: false });
        await manager.getJobStore().deleteJob(responseId);
        const cleanup = jest.fn(cleanupResponseCheckpoint);
        const retire = createResponseRetirement({
          storage,
          jobs: manager,
          cleanupCheckpoint: cleanup,
        });
        expect(await retire(owner, responseId)).toBe('stopped');
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect((await storage.read(owner, responseId))?.status).toBe('cancelled');
      }));

    it('rejects checkpoint cleanup without captured storage settings or with a foreign owner scope', () =>
      scoped(async () => {
        const record = await pausedDecision();
        const ownScope = createCheckpointNamespace(owner.userId, owner.tenantId);
        const incomplete = {
          ...record,
          review: { ...record.review!, checkpointConfigJSON: '{"type":"mongo"}' },
        };
        await expect(cleanupResponseCheckpoint(incomplete, ownScope)).rejects.toThrow(
          'Response checkpoint must retain its durable storage settings',
        );
        const complete = {
          ...record,
          review: {
            ...record.review!,
            checkpointConfigJSON: JSON.stringify({
              type: 'mongo',
              checkpointCollectionName: 'paused_checkpoints',
              checkpointWritesCollectionName: 'paused_writes',
            }),
          },
        };
        await expect(
          cleanupResponseCheckpoint(
            complete,
            createCheckpointNamespace('other-owner', owner.tenantId),
          ),
        ).rejects.toThrow('Response checkpoint owner changed');
      }));

    function resumedRunParams(record: StoredResponseRecord) {
      return {
        envelope: createAgentRunEnvelope({
          protocol: 'responses',
          requestId: 'resume-http',
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: { model: 'agent', input: 'Original input' },
        }),
        runId: responseId,
        conversationId,
        responseRoot: record.storageTarget,
        retainTerminalPersistence: true as const,
        captureTerminalOutcome: true as const,
        onEnrolled: async (segment: AgentExecutionEnrollment) => {
          const current = (await storage.read(owner, responseId))!;
          const enrolled = await storage.enrollExecution(
            current,
            segment.getEnrollmentIdentity(),
            current.responseJSON!,
          );
          if (!enrolled.ok) throw new Error('Resume Root enrollment failed');
        },
        onProviderStarted: async (segment: AgentExecutionEnrollment) => {
          const current = (await storage.read(owner, responseId))!;
          if (!(await storage.bindExecution(current, segment.getPersistenceIdentity())))
            throw new Error('Resume provider binding failed');
        },
        isPrincipalActive: async () => true,
        resume: {
          generationCreatedAt: record.generationCreatedAt!,
          providerExecutionId: record.resume!.providerExecutionId,
        },
      };
    }

    it('runs the selected resumed segment through the shared host exactly once without replacing its epoch', () =>
      scoped(async () => {
        const record = await pausedDecision();
        expect((await admission()(owner, responseId, 'intent')).ok).toBe(true);
        const create = jest.spyOn(manager, 'createJob');
        let started!: () => void;
        let finish!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const run = executeAgentRun(
          {
            ...resumedRunParams(record),
            execute: async () => {
              started();
              await gate;
              return 'resumed output';
            },
          },
          { manager },
        );
        await ready;
        const duplicateExecute = jest.fn();
        const publish = jest.fn();
        await expect(
          executeAgentRun(
            { ...resumedRunParams(record), execute: duplicateExecute, afterSettle: publish },
            { manager },
          ),
        ).rejects.toMatchObject({ code: 'RUN_REPLACED' });
        expect(duplicateExecute).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        await expect(
          executeAgentRun(
            {
              ...resumedRunParams(record),
              execute: duplicateExecute,
              onEnrolled: async () => {
                throw new Error('duplicate acknowledgement failed');
              },
              afterSettle: publish,
            },
            { manager },
          ),
        ).rejects.toThrow('duplicate acknowledgement failed');
        expect(publish).not.toHaveBeenCalled();
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'running',
          createdAt: record.generationCreatedAt,
          metadata: { providerExecutionOwnerId: expect.any(String), providerDrained: false },
        });
        finish();
        expect(await run).toBe('resumed output');
        expect(create).not.toHaveBeenCalled();
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'complete',
          createdAt: record.generationCreatedAt,
          metadata: { providerDrained: true },
        });
      }));

    it('recovers its own lost provider-start acknowledgement and executes once', () =>
      scoped(async () => {
        const record = await pausedDecision();
        await admission()(owner, responseId, 'intent');
        const store = manager.getJobStore();
        const start = store.beginProviderExecution.bind(store);
        jest.spyOn(store, 'beginProviderExecution').mockImplementationOnce(async (...args) => {
          expect(await start(...args)).toBe(true);
          throw new Error('lost start acknowledgement');
        });
        const execute = jest.fn(async () => 'done');
        expect(await executeAgentRun({ ...resumedRunParams(record), execute }, { manager })).toBe(
          'done',
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'complete',
          metadata: { providerDrained: true },
        });
      }));

    it('does not drive or terminalize another attempt after an ambiguous provider-start failure', () =>
      scoped(async () => {
        const record = await pausedDecision();
        await admission()(owner, responseId, 'intent');
        const store = manager.getJobStore();
        const start = store.beginProviderExecution.bind(store);
        jest
          .spyOn(store, 'beginProviderExecution')
          .mockImplementationOnce(async (id, epoch, provider) => {
            await start(id, epoch, provider, 'other-worker');
            throw new Error('ambiguous competing start');
          });
        const execute = jest.fn();
        const publish = jest.fn();
        await expect(
          executeAgentRun(
            { ...resumedRunParams(record), execute, afterSettle: publish },
            { manager },
          ),
        ).rejects.toThrow('ambiguous competing start');
        expect(execute).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(await manager.getJob(responseId)).toMatchObject({
          status: 'running',
          metadata: { providerExecutionOwnerId: 'other-worker', providerDrained: false },
        });
        // Finish the synthetic competing owner in this isolated fixture, not from the rejected request.
        await manager.completeJob(responseId, undefined, record.generationCreatedAt);
        await manager.markProviderExecutionDrained(
          responseId,
          record.generationCreatedAt!,
          record.resume!.providerExecutionId,
        );
      }));
  },
);
