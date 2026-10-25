import { createHash } from 'node:crypto';
import type { FilterQuery, Model } from 'mongoose';
import type { ISubagentContentChunk } from '~/models/subagentContent';
import type { IConversation, IMessage } from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { activeExpirationFilter } from '~/utils/retention';

export type SubagentContentScope = {
  user: string;
  tenantId?: string;
  parentConversationId: string;
  conversationId: string;
  taskId: string;
};

export type SubagentContentHead = { revision: number; throughSequence: number };
export type SubagentContentBatch = SubagentContentHead & {
  fromSequence: number;
  eventsJson: string;
};

export type SubagentContentAppendResult =
  | { ok: true }
  | { ok: false; error: { code: 'SUBAGENT_CONTENT_GONE' } };

const tenantFilter = (tenantId?: string) =>
  tenantId == null ? { tenantId: { $exists: false } } : { tenantId };
const scopeFilter = (scope: SubagentContentScope) => ({
  ...scope,
  ...tenantFilter(scope.tenantId),
});

/** Preserve source/topology records when erasure fails, and fence admitted appends first. */
export async function prepareSubagentContentDeletion(
  mongoose: typeof import('mongoose'),
  filter: Pick<FilterQuery<IMessage>, 'user' | 'tenantId' | 'conversationId'>,
): Promise<void> {
  const Content = mongoose.models.SubagentContent as Model<ISubagentContentChunk> | undefined;
  if (Content == null) return;
  const Message = mongoose.models.Message as Model<IMessage>;
  await Message.updateMany(
    { ...filter, 'subagentContent.version': 1 },
    { $set: { 'subagentContent.deleted': true } },
  );
  await Content.deleteMany(filter);
}

/** Fragments keep even a single large tool body well below Mongo's BSON ceiling.
 * This is a storage encoding, not a content-retention limit. */
const FRAGMENT_CHARS = 128 * 1024;

/** BSON string fragments must not divide a supplementary Unicode character. */
export function fragmentSubagentContent(payload: string): string[] {
  const fragments: string[] = [];
  let start = 0;
  while (start < payload.length) {
    let end = Math.min(start + FRAGMENT_CHARS, payload.length);
    const previous = payload.charCodeAt(end - 1);
    const next = payload.charCodeAt(end);
    if (
      end < payload.length &&
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      end--;
    fragments.push(payload.slice(start, end));
    start = end;
  }
  return fragments;
}

export function createSubagentContentMethods(mongoose: typeof import('mongoose')): {
  appendSubagentContentBatch: (
    input: SubagentContentScope & SubagentContentBatch & { leaseToken?: string },
  ) => Promise<SubagentContentAppendResult>;
  reconcileSubagentContent: (scope: SubagentContentScope) => Promise<SubagentContentAppendResult>;
  getSubagentContentHead: (
    scope: SubagentContentScope,
    throughRevision?: number,
  ) => Promise<SubagentContentHead | null>;
  streamSubagentContentBatches: (
    scope: SubagentContentScope,
    throughRevision: number,
    afterSequence?: number,
  ) => AsyncIterable<SubagentContentBatch>;
} {
  const contentModel = () => mongoose.models.SubagentContent as Model<ISubagentContentChunk>;

  async function appendSubagentContentBatch(
    input: SubagentContentScope & SubagentContentBatch & { leaseToken?: string },
  ): Promise<SubagentContentAppendResult> {
    const { revision, fromSequence, throughSequence, eventsJson, leaseToken, ...scope } = input;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isSafeInteger(fromSequence) ||
      fromSequence < 0 ||
      !Number.isSafeInteger(throughSequence) ||
      throughSequence < fromSequence
    ) {
      throw new Error('Invalid subagent content batch');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const owner = { user: scope.user, ...tenantFilter(scope.tenantId) };
    const inputFilter = {
      ...owner,
      conversationId: scope.conversationId,
      messageId: `${scope.taskId}:user`,
      'subagentContent.deleted': { $ne: true },
      ...activeExpirationFilter<IMessage>(),
    };
    const [seed, parent, child] = await Promise.all([
      Message.findOne(inputFilter).select('expiredAt').lean<Pick<IMessage, 'expiredAt'>>(),
      Conversation.exists({
        ...owner,
        conversationId: scope.parentConversationId,
        ...activeExpirationFilter<IConversation>(),
      }),
      Conversation.exists({
        ...owner,
        conversationId: scope.conversationId,
        'subagentThread.parentConversationId': scope.parentConversationId,
        'subagentThreadLease.taskId': scope.taskId,
        'subagentThreadLease.expiresAt': { $gt: new Date() },
        ...(leaseToken == null ? {} : { 'subagentThreadLease.token': leaseToken }),
        ...activeExpirationFilter<IConversation>(),
      }),
    ]);
    if (seed == null || parent == null || child == null) {
      await reconcileSubagentContent(scope);
      return { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
    }
    const Model = contentModel();
    const digest = createHash('sha256').update(eventsJson).digest('hex');
    const payloads = fragmentSubagentContent(eventsJson);
    const fragments = payloads.length;
    const base = {
      ...scope,
      revision,
      fromSequence,
      throughSequence,
      digest,
      fragments,
      ...(seed.expiredAt == null ? {} : { expiredAt: seed.expiredAt }),
    };
    const recordId = (fragment: number) =>
      createHash('sha256')
        .update(
          JSON.stringify([
            scope.tenantId ?? null,
            scope.user,
            scope.conversationId,
            scope.taskId,
            revision,
            fragment,
          ]),
        )
        .digest('hex');
    const records = Array.from({ length: fragments }, (_, fragment) => ({
      updateOne: {
        filter: { _id: recordId(fragment), ...scopeFilter(scope), revision, fragment, digest },
        update: {
          $setOnInsert: {
            ...base,
            fragment,
            payload: payloads[fragment],
          },
        },
        upsert: true,
      },
    }));
    await tenantSafeBulkWrite(Model, records, { ordered: false });
    /** A retry can only commit identical bytes; conflicting retries hit the unique index. */
    await Model.updateOne(
      { _id: recordId(-1), ...scopeFilter(scope), revision, fragment: -1, digest },
      { $setOnInsert: { ...base, fragment: -1 } },
      { upsert: true },
    );
    return reconcileSubagentContent(scope);
  }

  /** Cleanup never replays payloads or requires a live execution lease. */
  async function reconcileSubagentContent(
    scope: SubagentContentScope,
  ): Promise<SubagentContentAppendResult> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const owner = { user: scope.user, ...tenantFilter(scope.tenantId) };
    const [seed, parent, child] = await Promise.all([
      Message.exists({
        ...owner,
        conversationId: scope.conversationId,
        messageId: `${scope.taskId}:user`,
        'subagentContent.deleted': { $ne: true },
        ...activeExpirationFilter<IMessage>(),
      }),
      Conversation.exists({
        ...owner,
        conversationId: scope.parentConversationId,
        ...activeExpirationFilter<IConversation>(),
      }),
      Conversation.exists({
        ...owner,
        conversationId: scope.conversationId,
        'subagentThread.parentConversationId': scope.parentConversationId,
        ...activeExpirationFilter<IConversation>(),
      }),
    ]);
    if (seed == null || parent == null || child == null) {
      await contentModel().deleteMany(scopeFilter(scope));
      return { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
    }
    return { ok: true };
  }

  async function getSubagentContentHead(
    scope: SubagentContentScope,
    throughRevision?: number,
  ): Promise<SubagentContentHead | null> {
    return contentModel()
      .findOne({
        ...scopeFilter(scope),
        fragment: -1,
        ...(throughRevision == null ? {} : { revision: { $lte: throughRevision } }),
        ...activeExpirationFilter(),
      })
      .sort({ revision: -1 })
      .select('revision throughSequence -_id')
      .lean<SubagentContentHead>();
  }

  async function* streamSubagentContentBatches(
    scope: SubagentContentScope,
    throughRevision: number,
    afterSequence = -1,
  ): AsyncGenerator<SubagentContentBatch> {
    if (throughRevision < 1) return;
    const Model = contentModel();
    let fromRevision = 1;
    if (afterSequence >= 0) {
      /** Commit sequences increase with revisions. Seek without a revision predicate so
       * an exhausted pin cannot scan later commits looking for an older revision. */
      const first = await Model.findOne({
        ...scopeFilter(scope),
        fragment: -1,
        throughSequence: { $gt: afterSequence },
        ...activeExpirationFilter(),
      })
        .sort({ throughSequence: 1 })
        .select('revision -_id')
        .lean<Pick<SubagentContentHead, 'revision'>>();
      if (first == null || first.revision > throughRevision) return;
      fromRevision = first.revision;
    }
    const cursor = Model.find({
      ...scopeFilter(scope),
      revision: { $gte: fromRevision, $lte: throughRevision },
      ...activeExpirationFilter(),
    })
      .sort({ revision: 1, fragment: 1 })
      .lean()
      .cursor();
    let commit: ISubagentContentChunk | undefined;
    let payloads: string[] = [];
    const decode = (): SubagentContentBatch => {
      if (commit == null || payloads.length !== commit.fragments) {
        throw new Error('Incomplete committed subagent content batch');
      }
      const eventsJson = payloads.join('');
      if (createHash('sha256').update(eventsJson).digest('hex') !== commit.digest) {
        throw new Error('Invalid committed subagent content digest');
      }
      return {
        revision: commit.revision,
        fromSequence: commit.fromSequence,
        throughSequence: commit.throughSequence,
        eventsJson,
      };
    };
    try {
      for await (const row of cursor) {
        if (row.fragment === -1) {
          if (commit != null) yield decode();
          commit = row;
          payloads = [];
          continue;
        }
        if (
          commit == null ||
          row.revision !== commit.revision ||
          row.fragment !== payloads.length ||
          row.digest !== commit.digest ||
          typeof row.payload !== 'string'
        ) {
          throw new Error('Invalid committed subagent content fragment');
        }
        payloads.push(row.payload);
      }
      if (commit != null) yield decode();
    } finally {
      await cursor.close();
    }
  }

  return {
    appendSubagentContentBatch,
    reconcileSubagentContent,
    getSubagentContentHead,
    streamSubagentContentBatches,
  };
}

export type SubagentContentMethods = ReturnType<typeof createSubagentContentMethods>;
