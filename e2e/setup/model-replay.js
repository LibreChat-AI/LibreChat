/**
 * Record-once/replay-forever model fixtures for the mock e2e harness.
 *
 * Record mode (`E2E_MODEL_FIXTURES=record` + `E2E_MODEL_FIXTURE_NAME=<name>`):
 * `record-model.js` replaces the fake-model run hook; instead of overriding the
 * graph's model it appends a LangChain callback handler to every agent
 * context's `clientOptions.callbacks`, so the REAL provider model carries the
 * recorder. Each model invocation's streamed `ChatGenerationChunk`s are
 * serialized to `e2e/fixtures/model-replay/<name>.jsonl` exactly as the
 * provider emitted them (text deltas, tool_call_chunks, reasoning
 * additional_kwargs, usage_metadata). Only the invocation's latest human text
 * is recorded for binding — system prompts and tool schemas never enter the
 * fixture.
 *
 * Replay mode (default, keyless): `fake-model.js` consults `tryBindReplay`
 * before its marker routing. A conversation binds to a fixture when its latest
 * user text equals the fixture's next unconsumed invocation's recorded user
 * text. The replaying model is not hand-assigned: `ReplayChatModel` is
 * registered as the SDK provider `librechat-e2e-replay` via the agents
 * package's `registerProvider`, and the bound instance is constructed through
 * the SDK's own `initializeModel` — registry lookup, constructor
 * `clientOptions` (carrying the model-bound callbacks the way
 * `withModelCallbacks` does), and real `bindTools` over the run's tools — so
 * the recorded chunks stream through the same SDK machinery a live provider
 * uses: createRun → registered provider model → graph → SSE → persistence.
 * Every invocation re-checks its prompt against the recording, an invocation
 * past the end of the script throws (over-consumption fails loud in the
 * turn), and a per-fixture consumption ledger under
 * `e2e/specs/.test-results/model-replay/` lets specs assert at teardown that
 * every recorded invocation and chunk was drained (under-consumption fails the
 * spec, not silently).
 *
 * Constraint carried over from the recording model: one live binding per
 * fixture per server process — scenarios replaying the same fixture must not
 * run concurrently.
 */
const fs = require('fs');
const path = require('path');
const { FakeChatModel, registerProvider, initializeModel } = require('@librechat/agents');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { AIMessageChunk } = require('@langchain/core/messages');

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/model-replay');
const LEDGER_DIR = path.resolve(__dirname, '../specs/.test-results/model-replay');
const RECORDER_HANDLER_NAME = 'librechat-e2e-model-recorder';
const SUMMARIZATION_GUARD_NAME = 'librechat-e2e-summarization-guard';
const REPLAY_CHUNK_DELAY_MS = Number(process.env.MOCK_LLM_CHUNK_DELAY_MS) || 10;

function extractText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (part && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function messageType(message) {
  if (typeof message?.getType === 'function') {
    return message.getType();
  }
  if (typeof message?._getType === 'function') {
    return message._getType();
  }
  return message?.role;
}

/** Every human message's text, oldest first. */
function humanTexts(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const texts = [];
  for (const message of messages) {
    const type = messageType(message);
    if (type === 'human' || type === 'user') {
      texts.push(extractText(message.content));
    }
  }
  return texts;
}

/** The latest human message's text — the binding and prompt-check key. */
function latestHumanText(messages) {
  const texts = humanTexts(messages);
  return texts.length > 0 ? texts[texts.length - 1] : '';
}

/**
 * The distinct user turns a fixture records, in order. A turn that calls a
 * tool spans several model invocations under one prompt, so the invocation
 * sequence is not the turn sequence and only this collapsed view can be
 * compared against a conversation's human messages.
 */
function fixtureTurnTexts(invocations) {
  const turns = [];
  for (const invocation of invocations) {
    if (turns[turns.length - 1] !== invocation.userText) {
      turns.push(invocation.userText);
    }
  }
  return turns;
}

/**
 * Whether this conversation is the one that already drove the fixture: its
 * human turns open with exactly the fixture's recorded turns, in order. A
 * consumed binding has to be retained for such a conversation, or an extra
 * user turn would find no next invocation, fall through to ordinary
 * fake-model routing, and be answered with a mock reply — leaving the
 * over-consumption guard unreached and the drained ledger still passing.
 */
function conversationDroveFixture(messages, fixture) {
  const texts = humanTexts(messages);
  const turns = fixture.turns;
  if (texts.length <= turns.length) {
    return false;
  }
  return turns.every((turn, index) => turn === texts[index]);
}

function jsonClone(value) {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** Minimal AIMessageChunk projection that reconstructs the streamed message. */
function serializeChunk(chunk, token) {
  const message = chunk?.message;
  const serialized = { text: chunk?.text ?? token ?? '' };
  if (message) {
    serialized.message = {
      content: jsonClone(message.content) ?? '',
      additional_kwargs: jsonClone(message.additional_kwargs),
      response_metadata: jsonClone(message.response_metadata),
      tool_call_chunks: jsonClone(message.tool_call_chunks),
      usage_metadata: jsonClone(message.usage_metadata),
      id: typeof message.id === 'string' ? message.id : undefined,
    };
  }
  return serialized;
}

function deserializeChunk(serialized) {
  const recorded = serialized.message;
  const message = new AIMessageChunk({
    content: recorded?.content ?? serialized.text ?? '',
    additional_kwargs: recorded?.additional_kwargs ?? {},
    response_metadata: recorded?.response_metadata ?? {},
    tool_call_chunks: recorded?.tool_call_chunks ?? [],
    usage_metadata: recorded?.usage_metadata,
    id: recorded?.id,
  });
  return new ChatGenerationChunk({ text: serialized.text ?? '', message });
}

/* ------------------------------- recording ------------------------------- */

const recordingState = {
  initialized: false,
  fixturePath: undefined,
  invocationCounter: 0,
  conversationId: undefined,
  /** Bumped on every (re)start so handlers left on a superseded graph can be
   *  told apart from the current attempt's. */
  generation: 0,
  runIdToInvocation: new Map(),
};

function appendFixtureLine(entry) {
  fs.appendFileSync(recordingState.fixturePath, `${JSON.stringify(entry)}\n`);
}

function initializeRecording(fixtureName) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  recordingState.fixturePath = path.join(FIXTURES_DIR, `${fixtureName}.jsonl`);
  fs.writeFileSync(recordingState.fixturePath, '');
  appendFixtureLine({
    type: 'meta',
    name: fixtureName,
    recordedAt: new Date().toISOString(),
  });
  recordingState.initialized = true;
  recordingState.invocationCounter = 0;
  recordingState.conversationId = undefined;
  recordingState.generation += 1;
  recordingState.runIdToInvocation.clear();
  console.log(`[e2e model-replay] recording fixture ${recordingState.fixturePath}`);
}

/**
 * The recorder's state is process-global and the web server outlives a
 * Playwright retry, so a failed attempt that already recorded invocations
 * would otherwise leave the counter advanced: the retry appends 2/3 after
 * 0/1 (or keeps a previous attempt's `error` line) and the fixture is
 * unusable for replay.
 *
 * A new attempt is a new conversation. Identity comes from `conversationId`
 * rather than from the prompt or the history: a turn that calls a tool
 * invokes the model again under the same latest human message, and a resumed
 * run after a tool-approval pause rebuilds `createRun` with no messages at
 * all because state is rehydrated from the checkpoint. Both would look like
 * fresh attempts to any text- or history-based rule, and truncate the fixture
 * mid-turn.
 */
function isConversationStart(messages) {
  return humanTexts(messages).length <= 1;
}

function startsNewRecording(conversationId, messages) {
  if (recordingState.invocationCounter === 0) {
    return false;
  }
  if (conversationId != null && recordingState.conversationId != null) {
    return recordingState.conversationId !== conversationId;
  }
  return isConversationStart(messages);
}

/**
 * Handlers are stamped with the recording generation they were installed for.
 * A failed attempt can still have a provider call in flight when the retry
 * resets the recording, and its graph keeps this handler: without the stamp
 * that stale call would allocate an invocation index from the new attempt's
 * counter, or append an `error` entry whose mapping was cleared, corrupting
 * the freshly reset fixture.
 */
function createRecorderHandler() {
  const generation = recordingState.generation;
  const superseded = () => generation !== recordingState.generation;
  return {
    name: RECORDER_HANDLER_NAME,
    generation,
    /** Callbacks must settle before the model call resolves, or the `end`
     * line races the durable-completion barrier the recording spec waits on
     * (the same contract ModelBoundChatModelCallback declares). */
    awaitHandlers: true,
    raiseError: true,
    handleChatModelStart(_llm, messageBatches, runId) {
      if (superseded()) {
        return;
      }
      const index = recordingState.invocationCounter++;
      recordingState.runIdToInvocation.set(runId, index);
      appendFixtureLine({
        type: 'invocation',
        index,
        userText: latestHumanText(messageBatches?.[0]),
      });
    },
    handleLLMNewToken(token, _idx, runId, _parentRunId, _tags, fields) {
      const invocation = recordingState.runIdToInvocation.get(runId);
      if (superseded() || invocation == null) {
        return;
      }
      appendFixtureLine({
        type: 'chunk',
        invocation,
        ...serializeChunk(fields?.chunk, token),
      });
    },
    handleLLMEnd(output, runId) {
      const invocation = recordingState.runIdToInvocation.get(runId);
      if (superseded() || invocation == null) {
        return;
      }
      recordingState.runIdToInvocation.delete(runId);
      const generation = output?.generations?.[0]?.[0];
      appendFixtureLine({
        type: 'end',
        invocation,
        text: generation?.text ?? extractText(generation?.message?.content),
      });
    },
    handleLLMError(error, runId) {
      const invocation = recordingState.runIdToInvocation.get(runId);
      recordingState.runIdToInvocation.delete(runId);
      if (superseded()) {
        return;
      }
      appendFixtureLine({
        type: 'error',
        invocation: invocation ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

/**
 * Attach the recorder to every agent context's model client options. The model
 * is created per-invocation from `agentContext.clientOptions`, so appending a
 * callback here puts the recorder on the real provider stream without
 * replacing the model.
 */
function installRecorder({ graph, messages, conversationId }) {
  const fixtureName = process.env.E2E_MODEL_FIXTURE_NAME;
  if (!fixtureName) {
    console.warn('[e2e model-replay] E2E_MODEL_FIXTURE_NAME unset; not recording');
    return;
  }
  if (!recordingState.initialized || startsNewRecording(conversationId, messages)) {
    initializeRecording(fixtureName);
  }
  if (conversationId != null) {
    recordingState.conversationId = conversationId;
  }
  const contexts = graph?.agentContexts;
  if (!contexts || typeof contexts.values !== 'function') {
    console.warn('[e2e model-replay] graph.agentContexts unavailable; not recording');
    return;
  }
  for (const context of contexts.values()) {
    if (!context.clientOptions) {
      context.clientOptions = {};
    }
    attachRecorder(context.clientOptions);
    /** Summarization runs on its own model with its own callback list.
     * Recording those invocations without replaying them is worse than
     * ignoring them: they would take slots in the fixture sequence that
     * replay never consumes, so the next primary call would read the
     * summariser's chunks. Replay routes only the agent model
     * (`graph.overrideModel`) and subagents, so the honest boundary is to
     * refuse a recording the lane could not reproduce. */
    const summarizationParameters =
      context.summarizationConfig?.parameters ?? context.summarizationConfig?.config?.parameters;
    if (summarizationParameters) {
      attachSummarizationGuard(summarizationParameters);
    }
  }
}

/**
 * Fails a recording the moment the summarization model runs. Its invocations
 * would otherwise enter the fixture sequence unreplayable — see
 * `installRecorder`. Summarization fixtures need replay routing for that model
 * before they can be supported.
 */
function attachSummarizationGuard(options) {
  const handler = {
    name: SUMMARIZATION_GUARD_NAME,
    raiseError: true,
    awaitHandlers: true,
    handleChatModelStart() {
      throw new Error(
        '[e2e model-replay] summarization ran during recording, and replay cannot route the ' +
          'summarization model — its invocations would desynchronise the fixture. Record a ' +
          'scenario that stays under the context-pruning threshold.',
      );
    },
  };
  const existing = options.callbacks;
  if (Array.isArray(existing)) {
    if (!existing.some((entry) => entry?.name === SUMMARIZATION_GUARD_NAME)) {
      options.callbacks = [...existing, handler];
    }
    return;
  }
  if (existing == null) {
    options.callbacks = [handler];
    return;
  }
  if (
    typeof existing.addHandler === 'function' &&
    !existing.handlers?.some((entry) => entry?.name === SUMMARIZATION_GUARD_NAME)
  ) {
    existing.addHandler(handler);
  }
}

/** Append the recorder to a client-options object's callbacks, once. */
function attachRecorder(options) {
  /** Dedupe against the CURRENT generation only: a graph carried across a
   * recording restart still holds a superseded handler, which is inert, so
   * matching on name alone would leave that options object recording
   * nothing. */
  const isCurrent = (handler) =>
    handler?.name === RECORDER_HANDLER_NAME && handler.generation === recordingState.generation;
  const existing = options.callbacks;
  if (Array.isArray(existing)) {
    if (!existing.some(isCurrent)) {
      options.callbacks = [
        ...existing.filter((handler) => handler?.name !== RECORDER_HANDLER_NAME),
        createRecorderHandler(),
      ];
    }
    return;
  }
  if (existing == null) {
    options.callbacks = [createRecorderHandler()];
    return;
  }
  if (typeof existing.addHandler === 'function') {
    if (!existing.handlers?.some(isCurrent)) {
      existing.addHandler(createRecorderHandler());
    }
  }
}

/* -------------------------------- replay --------------------------------- */

/** name -> { meta, invocations: [{ userText, chunks: [], finalText }] } */
let fixtureRegistry;
/** name -> { cursor, chunksConsumed, ledger } */
const replayState = new Map();

function parseFixtureFile(filePath) {
  const name = path.basename(filePath, '.jsonl');
  const invocations = [];
  let meta = { name };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === 'meta') {
      meta = entry;
    } else if (entry.type === 'invocation') {
      invocations[entry.index] = { userText: entry.userText, chunks: [], finalText: '' };
    } else if (entry.type === 'chunk') {
      invocations[entry.invocation]?.chunks.push(entry);
    } else if (entry.type === 'end') {
      const invocation = invocations[entry.invocation];
      if (invocation) {
        invocation.finalText = entry.text ?? '';
      }
    } else if (entry.type === 'error') {
      throw new Error(
        `[e2e model-replay] fixture ${name} recorded a provider error (${entry.message}); ` +
          're-record it before replaying',
      );
    }
  }
  const missing = invocations.findIndex((invocation) => invocation == null);
  if (missing !== -1) {
    throw new Error(`[e2e model-replay] fixture ${name} is missing invocation ${missing}`);
  }
  /** The file name is the fixture's identity — it is what `E2E_MODEL_FIXTURE_NAME`
   * selects, what the spec names, and what the ledger is written under. A
   * recorded `meta.name` is descriptive only: trusting it would let a renamed
   * or copied fixture collapse onto another's registry key and ledger. */
  return { meta: { ...meta, name }, invocations, turns: fixtureTurnTexts(invocations) };
}

function loadFixtureRegistry() {
  if (fixtureRegistry) {
    return fixtureRegistry;
  }
  fixtureRegistry = new Map();
  if (!fs.existsSync(FIXTURES_DIR)) {
    return fixtureRegistry;
  }
  for (const file of fs.readdirSync(FIXTURES_DIR)) {
    if (file.endsWith('.jsonl')) {
      const fixture = parseFixtureFile(path.join(FIXTURES_DIR, file));
      fixtureRegistry.set(fixture.meta.name, fixture);
    }
  }
  return fixtureRegistry;
}

function writeLedger(name) {
  const state = replayState.get(name);
  if (!state) {
    return;
  }
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LEDGER_DIR, `${name}.json`),
    `${JSON.stringify({ fixture: name, ...state.ledger }, null, 2)}\n`,
  );
}

function freshReplayState(fixture) {
  return {
    cursor: 0,
    ledger: {
      invocationsTotal: fixture.invocations.length,
      chunksTotal: fixture.invocations.reduce(
        (total, invocation) => total + invocation.chunks.length,
        0,
      ),
      invocationsConsumed: 0,
      chunksConsumed: 0,
      overruns: [],
      promptMismatches: [],
    },
  };
}

function getReplayState(fixture) {
  let state = replayState.get(fixture.meta.name);
  if (!state) {
    state = freshReplayState(fixture);
    replayState.set(fixture.meta.name, state);
  }
  return state;
}

/**
 * Start the fixture over for a new conversation. The web server outlives a
 * Playwright retry, so without this a consumed cursor would leave the retry
 * unable to bind its first prompt — it would fall through to marker routing
 * and fail deterministically, burning every configured retry. The ledger
 * resets with the cursor so the new attempt is judged on its own consumption
 * rather than accumulating the previous one's counts.
 */
function restartReplayState(fixture) {
  const state = freshReplayState(fixture);
  replayState.set(fixture.meta.name, state);
  return state;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPLAY_PROVIDER = 'librechat-e2e-replay';

/**
 * Constructed by the SDK's `initializeModel` through the provider registry, so
 * `clientOptions` is the full constructor contract: the fixture binding, the
 * shared cursor state, and the run's model-bound callbacks.
 */
class ReplayChatModel extends FakeChatModel {
  constructor(clientOptions = {}) {
    super({ responses: [''], sleep: 0, emitCustomEvent: false });
    this.fixture = clientOptions.fixture;
    this.state = clientOptions.state;
    this.boundToolNames = clientOptions.boundToolNames ?? [];
    if (clientOptions.callbacks) {
      this.callbacks = clientOptions.callbacks;
    }
  }

  /** Real SDK tool binding: returns a bound copy sharing the replay cursor. */
  bindTools(tools) {
    return new ReplayChatModel({
      fixture: this.fixture,
      state: this.state,
      callbacks: this.callbacks,
      boundToolNames: (tools ?? []).map((tool) => tool?.name ?? tool?.function?.name ?? 'unknown'),
    });
  }

  async *_streamResponseChunks(messages, _options, runManager) {
    const { fixture, state } = this;
    const invocation = fixture.invocations[state.cursor];
    if (!invocation) {
      state.ledger.overruns.push({
        at: new Date().toISOString(),
        userText: latestHumanText(messages),
      });
      writeLedger(fixture.meta.name);
      throw new Error(
        `[e2e model-replay] fixture ${fixture.meta.name} over-consumed: model invoked ` +
          `after all ${fixture.invocations.length} recorded invocations were drained`,
      );
    }
    /** A resumed run carries no human message — state is rehydrated from the
     * checkpoint — so there is no prompt to check against. Ownership already
     * established which conversation this is; enforcing the recorded prompt
     * here would reject every resume. Every real turn still gets checked. */
    const promptText = latestHumanText(messages);
    const carriesHumanTurn = humanTexts(messages).length > 0;
    if (carriesHumanTurn && promptText !== invocation.userText) {
      state.ledger.promptMismatches.push({
        invocation: state.cursor,
        expected: invocation.userText,
        received: promptText,
      });
      writeLedger(fixture.meta.name);
      throw new Error(
        `[e2e model-replay] fixture ${fixture.meta.name} invocation ${state.cursor} ` +
          `prompt mismatch: recorded ${JSON.stringify(invocation.userText)}, ` +
          `received ${JSON.stringify(promptText)}`,
      );
    }
    state.cursor += 1;
    for (const chunk of invocation.chunks) {
      await sleep(REPLAY_CHUNK_DELAY_MS);
      yield deserializeChunk(chunk);
      void runManager?.handleLLMNewToken(chunk.text ?? '');
      state.ledger.chunksConsumed += 1;
    }
    state.ledger.invocationsConsumed += 1;
    writeLedger(fixture.meta.name);
  }
}

let replayProviderRegistered = false;

function ensureReplayProviderRegistered() {
  if (replayProviderRegistered) {
    return;
  }
  try {
    registerProvider({ provider: REPLAY_PROVIDER, model: ReplayChatModel });
  } catch (error) {
    /** The SDK registry is globalThis-scoped while this guard is
     * module-scoped: a reloaded copy of this module finds the provider
     * already registered. The registered class is stateless (fixture and
     * cursor ride `clientOptions`), so any copy's registration serves all. */
    if (!String(error instanceof Error ? error.message : error).includes('already registered')) {
      throw error;
    }
  }
  replayProviderRegistered = true;
}

/**
 * Bind a conversation to a recorded fixture when its latest user text matches
 * the fixture's next unconsumed invocation. The replay model is built through
 * the SDK's registered-provider path (`registerProvider` +
 * `initializeModel`), including real `bindTools` over the run's tools.
 * Returns true when the graph's model was overridden with the replaying
 * model; false lets the fake-model marker routing proceed unchanged.
 */
/**
 * Decide how this run relates to a fixture.
 *
 * `own` — the conversation that claimed the fixture is back. Its cursor is
 * authoritative wherever it stands, including past the end, so an extra turn
 * reaches the over-consumption guard instead of falling through to the
 * scripted fake model, and a resumed run after a tool-approval pause keeps
 * replaying even though it arrives with no messages and no prompt text.
 *
 * `claim` — a different (or first) conversation opening the fixture: rewind
 * and take ownership. This is what a Playwright retry looks like.
 *
 * Anything else is refused, so an unrelated conversation can never continue
 * someone else's partly consumed script by happening to repeat a later prompt.
 */
function classifyBinding({ fixture, state, text, messages, conversationId }) {
  if (conversationId != null && state.conversationId != null) {
    if (state.conversationId === conversationId) {
      return 'own';
    }
    return fixture.turns[0] === text ? 'claim' : 'refuse';
  }
  /** Identity unavailable (an older `@librechat/api` does not supply it):
   *  fall back to the text and history rules this lane used before. */
  if (state.cursor !== 0 && isConversationStart(messages)) {
    return fixture.turns[0] === text ? 'claim' : 'refuse';
  }
  if (fixture.invocations[state.cursor]?.userText === text) {
    return 'own';
  }
  if (state.cursor !== 0 && fixture.turns[0] === text) {
    return 'claim';
  }
  if (state.cursor >= fixture.invocations.length && conversationDroveFixture(messages, fixture)) {
    return 'own';
  }
  return 'refuse';
}

function tryBindReplay({ graph, agents, text, messages, conversationId, modelCallbacks }) {
  const registry = loadFixtureRegistry();
  const matches = [];
  for (const fixture of registry.values()) {
    let state = getReplayState(fixture);
    const binding = classifyBinding({ fixture, state, text, messages, conversationId });
    if (binding === 'refuse') {
      continue;
    }
    if (binding === 'claim') {
      state = restartReplayState(fixture);
    }
    if (conversationId != null) {
      state.conversationId = conversationId;
    }
    matches.push({ fixture, state });
  }

  if (matches.length === 0) {
    return false;
  }
  /** Binding order would otherwise follow filesystem enumeration, so a second
   * fixture sharing this prompt could silently redirect a scenario to the
   * wrong chunks and ledger. The spec's fixture choice never reaches this
   * server-side loop, so ambiguity has to fail rather than pick a winner. */
  if (matches.length > 1) {
    throw new Error(
      `[e2e model-replay] prompt matches ${matches.length} fixtures ` +
        `(${matches.map(({ fixture }) => fixture.meta.name).join(', ')}); ` +
        'fixtures must not share a bindable prompt',
    );
  }

  const { fixture, state } = matches[0];
  ensureReplayProviderRegistered();
  const model = initializeModel({
    provider: REPLAY_PROVIDER,
    clientOptions: { fixture, state, callbacks: modelCallbacks },
    tools: agents?.[0]?.tools ?? [],
  });
  state.ledger.toolsBound = model.boundToolNames ?? [];
  graph.overrideModel = model;
  /** `graph.overrideModel` is not inherited by child executors, so a fixture
   * recording a subagent call — record mode captures child invocations, since
   * the recorder attaches to every agent context — would otherwise leave the
   * child on its configured provider: an underrun here, and a real provider
   * request in a lane that must stay keyless. */
  if (typeof graph.setSubagentModelOverride === 'function') {
    graph.setSubagentModelOverride(model);
  }
  writeLedger(fixture.meta.name);
  return true;
}

module.exports = {
  FIXTURES_DIR,
  LEDGER_DIR,
  installRecorder,
  tryBindReplay,
  latestHumanText,
  serializeChunk,
  deserializeChunk,
  parseFixtureFile,
};
