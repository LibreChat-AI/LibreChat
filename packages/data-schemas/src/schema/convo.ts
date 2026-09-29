import { Schema } from 'mongoose';
import {
  MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES,
  MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH,
  MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX,
  MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH,
  isCompactionSemanticIndexProjection,
} from '~/types/compaction';
import {
  MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS,
  MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH,
  MAX_AGENT_EVENT_ACTOR_SKILLS,
  MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH,
  MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH,
} from '~/types/convo';
import { agentFadingContextDefinition } from './fading';
import { conversationPreset } from './defaults';
import { IConversation } from '~/types';

const convoSchema: Schema<IConversation> = new Schema(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
      meiliIndex: true,
    },
    title: {
      type: String,
      default: 'New Chat',
      meiliIndex: true,
    },
    user: {
      type: String,
      index: true,
      meiliIndex: true,
    },
    messages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    isTemporary: {
      type: Boolean,
      default: false,
    },
    ...conversationPreset,
    codeEnvironmentRevision: { type: Number, select: false },
    agent_id: {
      type: String,
    },
    initial_agent_id: {
      type: String,
      default: undefined,
      select: false,
    },
    subagentThread: {
      type: {
        rootConversationId: { type: String, required: true },
        parentConversationId: { type: String, required: true },
        parentMessageId: { type: String, required: true },
        parentToolCallId: { type: String, required: true },
        parentAgentId: { type: String },
        subagentType: { type: String, required: true },
        subagentKind: { type: String, enum: ['agent', 'graph'], required: true },
        depth: { type: Number, min: 1, required: true },
      },
      _id: false,
      default: undefined,
    },
    /** Mongo-backed continuation lease shared by every API replica. */
    subagentThreadLease: {
      type: {
        token: { type: String, required: true },
        taskId: { type: String, required: true },
        expiresAt: { type: Date, required: true },
      },
      _id: false,
      default: undefined,
      select: false,
    },
    /** Authenticated event sources address child actors through this opaque binding.
     * The source never supplies the stored agent/thread target during delivery. */
    agentEventBinding: {
      type: {
        bindingId: { type: String, required: true },
        sourceKeyId: { type: String, required: true },
        actorId: { type: String, required: true },
      },
      _id: false,
      default: undefined,
      select: false,
    },
    /** Committed event-actor state. Invocation forks live in the checkpointer;
     * only the current and previous committed identities live with the binding. */
    agentEventActor: {
      type: {
        generation: { type: Number, min: 1, required: true },
        checkpoint: {
          type: {
            threadId: { type: String, required: true },
            checkpointId: { type: String, required: true },
            checkpointNs: { type: String, required: true },
          },
          _id: false,
          required: true,
        },
        contextFingerprint: {
          type: {
            algorithm: { type: String, enum: ['sha256'], required: true },
            version: { type: Number, min: 1, required: true },
            digest: { type: String, required: true },
          },
          _id: false,
          default: undefined,
        },
        skillManifest: {
          type: [
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              version: { type: Number, min: 1, required: true },
              contentDigest: { type: String, default: undefined },
              _id: false,
            },
          ],
          default: undefined,
          validate: {
            validator: (skills: unknown[]) => skills.length <= MAX_AGENT_EVENT_ACTOR_SKILLS,
            message: `Event actor Skill manifest exceeds ${MAX_AGENT_EVENT_ACTOR_SKILLS}`,
          },
        },
        discoveredToolNames: {
          type: [{ type: String, maxlength: MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH }],
          default: undefined,
          validate: {
            validator: (names: unknown[]) => names.length <= MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS,
            message: `Event actor discovered-tool state exceeds ${MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS}`,
          },
        },
        summary: {
          type: {
            text: {
              type: String,
              required: true,
              maxlength: MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH,
            },
            tokenCount: { type: Number, min: 0, required: true },
            version: { type: Number, min: 1 },
          },
          _id: false,
          default: undefined,
        },
        contextMeta: {
          type: {
            calibrationRatio: { type: Number, min: 0.5, max: 5, required: true },
            encoding: {
              type: String,
              maxlength: MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH,
              default: undefined,
            },
            ...agentFadingContextDefinition,
          },
          _id: false,
          default: undefined,
        },
        compactionSemanticIndex: {
          type: {
            version: { type: Number, enum: [1], required: true },
            entries: {
              type: [
                {
                  type: {
                    type: String,
                    enum: ['tool_intent', 'tool_outcome', 'activity_phase', 'reasoning_label'],
                    required: true,
                  },
                  sourceMessageId: {
                    type: String,
                    minlength: 1,
                    maxlength: MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH,
                    required: true,
                  },
                  sourceContentIndex: {
                    type: Number,
                    min: 0,
                    max: MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX,
                    required: true,
                  },
                  revision: { type: Number, min: 0, required: true },
                  status: { type: String, enum: ['committed', 'pending'], required: true },
                  text: {
                    type: String,
                    maxlength: MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH,
                  },
                  redacted: { type: Boolean, default: undefined },
                  toolCallId: {
                    type: String,
                    minlength: 1,
                    maxlength: MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH,
                    default: undefined,
                  },
                  reasoningStepId: {
                    type: String,
                    minlength: 1,
                    maxlength: MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH,
                    default: undefined,
                  },
                  _id: false,
                },
              ],
              validate: {
                validator: (entries: unknown[]) =>
                  entries.length <= MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES,
                message: `Compaction semantic index exceeds ${MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES} entries`,
              },
            },
            providedEntryCount: { type: Number, min: 0, default: undefined },
          },
          _id: false,
          default: undefined,
          validate: {
            validator: isCompactionSemanticIndexProjection,
            message: 'Compaction semantic index projection is invalid',
          },
        },
        previousCheckpoint: {
          type: {
            threadId: { type: String, required: true },
            checkpointId: { type: String, required: true },
            checkpointNs: { type: String, required: true },
          },
          _id: false,
          default: undefined,
        },
        requiresColdStart: { type: Boolean, default: undefined },
      },
      _id: false,
      default: undefined,
      select: false,
    },
    /** Fail-closed invocation proof. Active records block later turns through checkpoint,
     * history, and outcome settlement; settled receipts no longer block new IDs but keep
     * delayed owners from reacquiring an invocation that already applied its action. */
    agentEventActorCleanup: {
      type: [
        {
          threadId: { type: String, required: true },
          checkpointId: { type: String, required: true },
          checkpointNs: { type: String, required: true },
          _id: false,
        },
      ],
      default: undefined,
      select: false,
    },
    agentEventActorReconciliations: {
      type: [
        {
          invocationId: { type: String, required: true },
          actionAdmitted: { type: Boolean, default: undefined },
          status: {
            type: String,
            enum: [
              'invocation_pending',
              'persistence_pending',
              'history_persisted',
              'commit_conflict',
              'commit_indeterminate',
              'persistence_failed',
              'settled',
            ],
            required: true,
          },
          checkpoint: {
            type: {
              threadId: { type: String, required: true },
              checkpointId: { type: String, default: undefined },
              checkpointNs: { type: String, required: true },
            },
            _id: false,
            required: true,
          },
          action: {
            type: {
              toolName: { type: String, required: true },
              toolCallId: { type: String, default: undefined },
            },
            _id: false,
            required: true,
          },
          error: { type: String, default: undefined },
          resolution: {
            type: String,
            enum: ['checkpoint_verified', 'action_compensated', 'history_repaired'],
            default: undefined,
          },
          observedAt: { type: Date, required: true },
          _id: false,
        },
      ],
      default: undefined,
      select: false,
    },
    /** Bumped by every legacy-path event so a concurrently prepared fork can
     * never commit past an invalidation the head fields alone cannot show. */
    agentEventActorEpoch: {
      type: Number,
      default: undefined,
      select: false,
    },
    /** In-flight legacy turn. Blocks fork execution and commit until the
     * turn's history is durable; a crash leaves it set, failing closed. */
    agentEventActorLegacyTurn: {
      type: {
        token: { type: String, required: true },
        startedAt: { type: Date, required: true },
      },
      _id: false,
      default: undefined,
      select: false,
    },
    /** Current SDK-issued suspended invocation. The signed evidence remains
     * opaque/Mixed so its exact versioned JSON shape survives round trips;
     * mirrored host fields provide bounded CAS predicates. */
    agentEventActorSuspension: {
      type: {
        suspension: { type: Schema.Types.Mixed, required: true },
        kind: {
          type: String,
          enum: ['human_decision', 'internal_completion'],
          default: 'human_decision',
        },
        appliedAction: {
          type: {
            toolName: { type: String, required: true },
            toolCallId: { type: String, default: undefined },
          },
          _id: false,
          default: undefined,
        },
        handlingGenerationCreatedAt: { type: Number, min: 0, default: undefined },
        actionId: { type: String, required: true },
        jobCreatedAt: { type: Number, required: true },
        status: {
          type: String,
          enum: ['pending', 'claimed', 'pending_owned', 'claimed_owned', 'closed'],
          required: true,
        },
        resumeAttemptId: { type: String, default: undefined },
        outcome: {
          type: String,
          enum: ['committed', 'stale', 'settled', 'cancelled'],
          default: undefined,
        },
        closedAt: { type: Date, default: undefined },
        observedAt: { type: Date, required: true },
      },
      _id: false,
      default: undefined,
      select: false,
    },
    tags: {
      type: [String],
      default: [],
      meiliIndex: true,
    },
    chatProjectId: {
      type: String,
      default: null,
      index: true,
    },
    files: {
      type: [String],
    },
    expiredAt: {
      type: Date,
    },
    tenantId: {
      type: String,
      index: true,
    },
    pinned: {
      type: Boolean,
    },
    /**
     * When the chat was filed away. Absent on conversations archived before this field
     * existed, and on every unarchived one, so readers fall back to `createdAt`.
     */
    archivedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

convoSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
convoSchema.index({ createdAt: 1, updatedAt: 1 });
convoSchema.index({ conversationId: 1, user: 1, tenantId: 1 }, { unique: true });
convoSchema.index({ tenantId: 1, isTemporary: 1, createdAt: -1, _id: -1 });
/** Insights attributes new conversations by an immutable primary agent and falls back
 * to the mutable agent field only for legacy rows where the primary field is absent. */
convoSchema.index({ tenantId: 1, isTemporary: 1, initial_agent_id: 1, createdAt: -1, _id: -1 });
convoSchema.index({ tenantId: 1, isTemporary: 1, agent_id: 1, createdAt: -1, _id: -1 });
convoSchema.index({ user: 1, _id: 1 });
convoSchema.index({ user: 1, chatProjectId: 1, updatedAt: -1, _id: -1 });
convoSchema.index({ user: 1, chatProjectId: 1, createdAt: -1, _id: -1 });
/** The archive view pages by `archivedAt`, then `createdAt`, then `_id`; the middle key
 * carries the legacy group, whose rows all share a missing `archivedAt`. */
convoSchema.index({ user: 1, isArchived: 1, archivedAt: -1, createdAt: -1, _id: -1 });

/** Sidebar list indexes for the active/archive filters: each sort carries its secondary
 * key and `_id` tie-breaker so MongoDB can serve the cursor order without an in-memory sort. */
convoSchema.index({ user: 1, isArchived: 1, updatedAt: -1, _id: -1 });
convoSchema.index({ user: 1, isArchived: 1, createdAt: -1, updatedAt: -1, _id: -1 });
convoSchema.index({ user: 1, isArchived: 1, title: 1, updatedAt: 1, _id: 1 });

/** The sidebar's pinned section filters on user + pinned and pages by `updatedAt`. */
convoSchema.index({ user: 1, pinned: 1, updatedAt: -1, _id: -1 });

convoSchema.index({ user: 1, isTemporary: 1, expiredAt: 1 });
/** Owner-scoped child-thread cascade lookup used when a parent is deleted. */
convoSchema.index({ user: 1, 'subagentThread.parentConversationId': 1 });
convoSchema.index({ user: 1, 'subagentThreadLease.expiresAt': 1 });
convoSchema.index(
  { 'agentEventBinding.bindingId': 1 },
  { unique: true, sparse: true, name: 'agent_event_binding_unique' },
);
convoSchema.index(
  {
    'agentEventActorReconciliations.status': 1,
    'agentEventActorReconciliations.observedAt': 1,
  },
  { sparse: true, name: 'agent_event_actor_reconciliation_metrics' },
);
// index for MeiliSearch sync operations
convoSchema.index({ _meiliIndex: 1, isTemporary: 1, expiredAt: 1 });

export default convoSchema;
