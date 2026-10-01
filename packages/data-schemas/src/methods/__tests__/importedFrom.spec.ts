import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import type { IConversation } from '~/types';

import convoSchema from '~/schema/convo';

const getTestConversationModel = (): mongoose.Model<IConversation> =>
  (mongoose.models.TestConvo as mongoose.Model<IConversation> | undefined) ??
  mongoose.model<IConversation>('TestConvo', convoSchema);

interface ExplainWinningPlan {
  stage?: string;
  indexName?: string;
  isPartial?: boolean;
  isSparse?: boolean;
  inputStage?: ExplainWinningPlan;
}

interface ExplainQueryPlannerResult {
  queryPlanner: {
    winningPlan: ExplainWinningPlan;
  };
}

/**
 * Mongoose's `Query.explain()` typing declares a return of `this` (the typed
 * document result), but at runtime it resolves to the raw MongoDB explain
 * document instead. The `unknown` bridge below reconciles that mismatch.
 */
const explainQueryPlanner = async (query: Promise<unknown>): Promise<ExplainQueryPlannerResult> =>
  (await query) as unknown as ExplainQueryPlannerResult;

describe('conversation importedFrom', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('persists importedFrom through strict mode', async () => {
    const Conversation = getTestConversationModel();

    await Conversation.create({
      conversationId: 'c1',
      user: 'u1',
      title: 'Imported',
      endpoint: 'openAI',
      importedFrom: { source: 'chatgpt', externalId: 'ext-1' },
    });

    const found = await Conversation.findOne({
      user: 'u1',
      'importedFrom.source': 'chatgpt',
      'importedFrom.externalId': 'ext-1',
    }).lean();

    expect(found).not.toBeNull();
    expect(found?.importedFrom?.externalId).toBe('ext-1');
  });

  it('leaves importedFrom undefined for normal conversations', async () => {
    const Conversation = getTestConversationModel();

    await Conversation.create({
      conversationId: 'c2',
      user: 'u1',
      title: 'Normal',
      endpoint: 'openAI',
    });
    const found = await Conversation.findOne({ conversationId: 'c2' }).lean();

    expect(found?.importedFrom).toBeUndefined();
  });

  it('builds the importedFrom index as partial, not sparse, on the compound key', async () => {
    const Conversation = getTestConversationModel();
    await Conversation.createIndexes();

    const indexes = await Conversation.collection.indexes();
    const importedFromIndex = indexes.find(
      (index) => index.key.user === 1 && index.key['importedFrom.source'] === 1,
    );

    expect(importedFromIndex).toBeDefined();
    expect(importedFromIndex?.sparse).toBeUndefined();
    expect(importedFromIndex?.partialFilterExpression).toEqual({
      'importedFrom.source': { $exists: true },
    });
  });

  it('uses the importedFrom index for a user + source lookup query', async () => {
    const Conversation = getTestConversationModel();
    await Conversation.createIndexes();

    const explanation = await explainQueryPlanner(
      Conversation.find({
        user: 'u1',
        'importedFrom.source': 'chatgpt',
      }).explain('queryPlanner'),
    );

    const winningPlan = JSON.stringify(explanation.queryPlanner.winningPlan);
    expect(winningPlan).toContain('importedFrom.source');
    expect(winningPlan).not.toContain('COLLSCAN');
  });
});
