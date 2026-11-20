/**
 * Seeds a mock conversation that renders every client-facing error shape.
 *
 * The chat client decides how to render a failure from the persisted row alone:
 * `error: true` sends `text` through `Messages/Content/Error`, `unfinished`
 * renders the incomplete/step-budget cards, and a `ContentTypes.ERROR` part
 * renders inline between ordinary parts. This script writes one user turn plus
 * one response turn for every one of those shapes, so the whole error surface
 * can be reviewed in a single conversation instead of being provoked one
 * failure at a time.
 *
 * Every `ErrorTypes` and `ViolationTypes` member must appear in the catalogue
 * below; the script refuses to write anything while one is missing, so a new
 * error type cannot be added upstream without also being reviewable here.
 *
 * Upload-time failures (`com_error_files_*`) are deliberately absent: they are
 * transient toasts raised by the composer and never persist on a message.
 *
 * Usage: npm run create-error-convo -- user@example.com [--endpoint=openAI] [--model=gpt-4o] [--title="..."]
 */
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const { Constants, ContentTypes, ErrorTypes, ViolationTypes } = require('librechat-data-provider');
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

/** The exact tail LangChain appends to a classified provider error. */
const troubleshooting = (code) =>
  `\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/${code}/\n`;

/** Boilerplate the SDK puts in front of the real pruning detail. */
const emptyMessagesInfo =
  'Message pruning removed all messages as none fit in the context window. ' +
  'Please increase the context window size or make your message shorter. ' +
  'Token budget: 128000 total, 127480 reserved for instructions and tools, 520 available.';

/** `MessageContent` matches this text exactly to render the delayed connection card. */
const connectionErrorText = 'Error connecting to server, try refreshing the page.';

/**
 * A payload case persists `JSON.stringify(payload)` as the message text, which
 * is what `sendError`/`denyRequest` do on the server. `covers` records which
 * enum member the case exercises so the completeness check can see it.
 */
const payloadCase = (label, payload, options = {}) => ({
  label,
  text: JSON.stringify(payload),
  covers: payload.type ?? payload.code,
  ...options,
});

/** A raw-text case: provider text the client never classified. */
const textCase = (label, text, options = {}) => ({ label, text, ...options });

/** A structural case: the row itself (not its text) selects the rendering. */
const shapeCase = (label, message) => ({ label, error: false, ...message });

const ERROR_CASES = [
  /* ---------- user-key and endpoint configuration ---------- */
  payloadCase('No user-provided key', { type: ErrorTypes.NO_USER_KEY }),
  payloadCase('Expired user-provided key', {
    type: ErrorTypes.EXPIRED_USER_KEY,
    expiredAt: '2026-08-01T09:30:00.000Z',
    endpoint: 'openAI',
  }),
  /**
   * The same two failures on an endpoint whose key comes from the user rather than the
   * deployment: that is the branch which offers the key dialog, and `endpoint` on the row is what
   * the client reads to decide.
   */
  payloadCase(
    'No key on a user-provided endpoint',
    { type: ErrorTypes.NO_USER_KEY },
    { endpoint: 'google', model: 'gemini-2.5-pro' },
  ),
  payloadCase(
    'Expired key on a user-provided endpoint',
    {
      type: ErrorTypes.EXPIRED_USER_KEY,
      expiredAt: '2026-08-01T09:30:00.000Z',
      endpoint: 'google',
    },
    { endpoint: 'google', model: 'gemini-2.5-pro' },
  ),
  /** Rows persisted before the server stamped ISO timestamps carry its own locale format. */
  payloadCase('Expired key stamped in a server locale (shown as written)', {
    type: ErrorTypes.EXPIRED_USER_KEY,
    expiredAt: '01/08/2026, 09:30:00',
    endpoint: 'openAI',
  }),
  payloadCase('Invalid user-provided key', { type: ErrorTypes.INVALID_USER_KEY }),
  payloadCase(
    'Unreadable key on a user-provided endpoint',
    { type: ErrorTypes.INVALID_USER_KEY },
    { endpoint: 'google', model: 'gemini-2.5-pro' },
  ),
  payloadCase('No base URL provided', { type: ErrorTypes.NO_BASE_URL }),
  payloadCase('Base URL targets a restricted address', { type: ErrorTypes.INVALID_BASE_URL }),
  payloadCase('No model selected', { type: ErrorTypes.MISSING_MODEL, info: 'openAI' }),
  payloadCase('Models configuration not loaded', { type: ErrorTypes.MODELS_NOT_LOADED }),
  payloadCase('Endpoint models not loaded', {
    type: ErrorTypes.ENDPOINT_MODELS_NOT_LOADED,
    info: 'anthropic',
  }),
  payloadCase('Provider excluded from agents', {
    type: ErrorTypes.INVALID_AGENT_PROVIDER,
    info: 'bedrock',
  }),

  /* ---------- request rejected before or during invocation ---------- */
  payloadCase('Moderation flagged the input', { type: ErrorTypes.MODERATION }),
  payloadCase('Prompt exceeds the token limit', {
    type: ErrorTypes.INPUT_LENGTH,
    info: '234856 / 172627',
  }),
  payloadCase('Provider rejected the request', { type: ErrorTypes.INVALID_REQUEST }),
  payloadCase('Action domain not allowed', { type: ErrorTypes.INVALID_ACTION }),
  payloadCase('Provider forbids system messages', { type: ErrorTypes.NO_SYSTEM_MESSAGES }),
  /** `ModelEndHandler` persists the provider's stop metadata object itself as `info`. */
  payloadCase('Model refused to answer (Anthropic stop details)', {
    type: ErrorTypes.REFUSAL,
    info: {
      stop_reason: 'refusal',
      stop_sequence: null,
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'The request could enable malware development.',
      },
    },
  }),
  payloadCase('Model refused to answer (Bedrock content filter)', {
    type: ErrorTypes.REFUSAL,
    info: { stop_reason: 'content_filtered' },
  }),

  /* ---------- Google-specific ---------- */
  payloadCase('Google provider error (verbatim text)', {
    type: ErrorTypes.GOOGLE_ERROR,
    info: '400 Bad Request\nRequest contains an invalid argument: contents[3].parts is empty.',
  }),
  payloadCase('Google built-in tools conflict', { type: ErrorTypes.GOOGLE_TOOL_CONFLICT }),
  payloadCase('Google could not process the video', {
    type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE,
  }),

  /* ---------- code execution and workspaces ---------- */
  payloadCase('Attached resources could not be restored', {
    type: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
  }),
  payloadCase('Stateful code environment disallowed', {
    code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
    status: 403,
  }),
  payloadCase('Code workspace unavailable (no reason)', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
  }),
  payloadCase('Code workspace required', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'required',
  }),
  payloadCase('Code workspace invalid', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'invalid',
  }),
  payloadCase('Code workspace worker unavailable', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'worker_unavailable',
  }),
  payloadCase('Code workspace unsupported', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'unsupported',
  }),
  payloadCase('Code workspace missing', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'missing',
  }),
  payloadCase('Code workspace locked to another environment', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'locked',
  }),
  payloadCase('Code workspace with an unknown reason', {
    code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
    reason: 'not_a_known_reason',
  }),

  /* ---------- streaming and upstream model failures ---------- */
  payloadCase('Stream expired before the client attached', { type: ErrorTypes.STREAM_EXPIRED }),
  payloadCase('Model not served by this provider', { type: ErrorTypes.MODEL_NOT_FOUND }),
  payloadCase('Provider rate or spend limit', { type: ErrorTypes.MODEL_RATE_LIMIT }),
  {
    label: 'Provider closed the stream mid-response',
    text: `The model provider closed the connection before the response finished. Try again.\n${JSON.stringify({ type: ErrorTypes.MODEL_STREAM_CLOSED })}`,
    covers: ErrorTypes.MODEL_STREAM_CLOSED,
  },
  {
    label: 'Provider stream stalled past the response timeout',
    text: `The model provider stopped sending the response, and the request timed out. Try again.\n${JSON.stringify({ type: ErrorTypes.MODEL_STREAM_STALLED })}`,
    covers: ErrorTypes.MODEL_STREAM_STALLED,
  },
  {
    label: 'Upstream model error with status (server prefix + JSON)',
    text: `The model provider failed and the run could not recover.\n${JSON.stringify({
      type: ErrorTypes.UPSTREAM_MODEL_ERROR,
      status: 503,
    })}`,
    covers: ErrorTypes.UPSTREAM_MODEL_ERROR,
  },
  payloadCase('Upstream model error without status', {
    type: ErrorTypes.UPSTREAM_MODEL_ERROR,
  }),

  /* ---------- context window and compaction ---------- */
  payloadCase('Context pruning removed every message', {
    type: ErrorTypes.EMPTY_MESSAGES,
    info: emptyMessagesInfo,
  }),
  payloadCase('Final context overflow with token detail', {
    type: ErrorTypes.FINAL_CONTEXT_OVERFLOW,
    provider: 'openAI',
    projectedMessageTokens: 214_500,
    availableMessageTokens: 128_000,
  }),
  payloadCase('Final context overflow without token detail', {
    type: ErrorTypes.FINAL_CONTEXT_OVERFLOW,
  }),
  payloadCase('Compaction skipped: summarization disabled', {
    type: ErrorTypes.COMPACTION_SKIPPED,
    reason: 'disabled',
  }),
  payloadCase('Compaction skipped: instructions exceed budget', {
    type: ErrorTypes.COMPACTION_SKIPPED,
    reason: 'instructions_exceed_budget',
  }),
  payloadCase('Compaction skipped: nothing to summarize', {
    type: ErrorTypes.COMPACTION_SKIPPED,
    reason: 'nothing_to_summarize',
  }),
  payloadCase('Compaction skipped with an unknown reason', {
    type: ErrorTypes.COMPACTION_SKIPPED,
    reason: 'not_a_known_reason',
  }),
  payloadCase('Compaction produced no summary', { type: ErrorTypes.COMPACTION_FAILED }),

  /* ---------- authentication ---------- */
  payloadCase('Authentication failed', {
    code: ErrorTypes.AUTH_FAILED,
    provider: 'local',
  }),
  payloadCase('Authentication rate limited', {
    code: ErrorTypes.AUTH_RATE_LIMITED,
  }),
  payloadCase('Authentication banned', { code: ErrorTypes.AUTH_BANNED }),
  payloadCase('Authentication rejected from another site', {
    code: ErrorTypes.AUTH_CROSS_ORIGIN,
  }),

  /* ---------- violations ---------- */
  payloadCase('Account banned', { type: ViolationTypes.BAN }),
  payloadCase('Illegal model request', {
    type: ViolationTypes.ILLEGAL_MODEL_REQUEST,
    info: 'openAI|gpt-4.5-preview',
  }),
  payloadCase('Token balance exhausted with generations', {
    type: ViolationTypes.TOKEN_BALANCE,
    balance: 1250,
    tokenCost: 8400,
    promptTokens: 6300,
    prev_count: 1,
    violation_count: 2,
    date: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    generations: [
      { model: 'gpt-4o', promptTokens: 6300, completionTokens: 2100 },
      { model: 'gpt-4o-mini', promptTokens: 820, completionTokens: 240 },
    ],
  }),
  payloadCase('Token balance exhausted without generations', {
    type: ViolationTypes.TOKEN_BALANCE,
    balance: 0,
    tokenCost: 4000,
    promptTokens: 3200,
  }),
  payloadCase('Concurrent message limit', {
    type: ViolationTypes.CONCURRENT,
    limit: 1,
    pendingRequests: 2,
    score: 1,
  }),
  payloadCase('Message rate limit counting down within the hour', {
    type: ViolationTypes.MESSAGE_LIMIT,
    max: 40,
    limiter: 'user',
    windowInMinutes: 60,
    /**
     * What the limiter now persists. Seeded 55 minutes out so the countdown is still running
     * whenever the gallery is opened, rather than having already elapsed.
     */
    resetAt: Date.now() + 55 * 60 * 1000,
    retryAfterSeconds: 55 * 60,
  }),
  payloadCase('Message rate limit whose window already reset', {
    type: ViolationTypes.MESSAGE_LIMIT,
    max: 40,
    limiter: 'user',
    windowInMinutes: 60,
    resetAt: Date.now() - 2 * 60 * 1000,
    retryAfterSeconds: 60,
  }),
  payloadCase('Message rate limit without reset data', {
    type: ViolationTypes.MESSAGE_LIMIT,
    max: 1,
    limiter: 'ip',
    windowInMinutes: 1,
  }),
  payloadCase('File upload limit', {
    type: ViolationTypes.FILE_UPLOAD_LIMIT,
    max: 10,
    limiter: 'user',
    windowInMinutes: 60,
  }),
  payloadCase('Tool call limit violation', {
    type: ViolationTypes.TOOL_CALL_LIMIT,
    max: 1,
    limiter: 'user',
    windowInMinutes: 1,
  }),
  payloadCase('Conversation access denied', {
    type: ViolationTypes.CONVO_ACCESS,
    error: 'User not authorized for this conversation',
  }),
  payloadCase('TTS limit', {
    type: ViolationTypes.TTS_LIMIT,
    max: 50,
    limiter: 'user',
    windowInMinutes: 60,
  }),
  payloadCase('STT limit', {
    type: ViolationTypes.STT_LIMIT,
    max: 50,
    limiter: 'user',
    windowInMinutes: 60,
  }),
  payloadCase('Shared link retrieval limit', {
    type: ViolationTypes.SHARE_LIMIT,
    max: 20,
    limiter: 'ip',
    windowInMinutes: 60,
  }),
  payloadCase('Login attempt limit', {
    type: ViolationTypes.LOGINS,
    max: 7,
    limiter: 'ip',
    windowInMinutes: 20,
  }),
  payloadCase('Registration limit', {
    type: ViolationTypes.REGISTRATIONS,
    max: 5,
    limiter: 'ip',
    windowInMinutes: 60,
  }),
  payloadCase('Password reset limit', {
    type: ViolationTypes.RESET_PASSWORD_LIMIT,
    max: 3,
    limiter: 'ip',
    windowInMinutes: 10,
  }),
  payloadCase('Email verification limit', {
    type: ViolationTypes.VERIFY_EMAIL_LIMIT,
    max: 3,
    limiter: 'ip',
    windowInMinutes: 10,
  }),
  payloadCase('Non-browser access', { type: ViolationTypes.NON_BROWSER }),
  payloadCase('General violation', {
    type: ViolationTypes.GENERAL,
    error: 'Request blocked',
  }),

  /* ---------- provider error codes the client special-cases ---------- */
  payloadCase('Provider reports an invalid API key', {
    code: 'invalid_api_key',
    message: 'Incorrect API key provided: sk-****.',
  }),
  payloadCase('Provider reports an exhausted quota', {
    code: 'insufficient_quota',
    message: 'You exceeded your current quota, please check your plan and billing details.',
  }),
  payloadCase('Provider body nesting its message under error', {
    error: {
      message: 'Rate limit reached for gpt-4o in organization org-123 on tokens per min.',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    },
  }),
  payloadCase('Unrecognized provider code (default fallback)', {
    code: 'im_a_teapot',
    message: 'The provider returned a code the client does not classify.',
  }),

  /* ---------- unclassified text ---------- */
  textCase(
    'LangChain-classified rate limit (code read from the docs URL)',
    `429 You exceeded your current quota${troubleshooting('MODEL_RATE_LIMIT')}`,
  ),
  textCase(
    'LangChain-classified missing model (code read from the docs URL)',
    `404 The model \`gpt-4.5-preview\` does not exist${troubleshooting('MODEL_NOT_FOUND')}`,
  ),
  textCase(
    'LangChain code without copy (URL stripped, provider text kept)',
    `Failed to parse the model output${troubleshooting('OUTPUT_PARSING_FAILURE')}`,
  ),
  /** A failed run persists `<base message>: <SDK message>`, and Anthropic's SDK message embeds the body. */
  textCase(
    'Provider body embedded after the failed-run prefix',
    `An error occurred while processing the request: 400 ${JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 250000 tokens > 200000 maximum',
      },
      request_id: 'req_011',
    })}`,
  ),
  textCase('Plain provider text (default fallback)', 'Error: connect ETIMEDOUT 104.18.7.192:443'),
  textCase(
    'Provider text long enough to be collapsed into a detail',
    `The upstream gateway rejected the request. ${'Retry advice and a stack frame repeated to exceed the client truncation cap. '.repeat(
      8,
    )}`,
  ),
  textCase('Connection error (delayed alert card)', connectionErrorText),

  /* ---------- row shapes, not text ---------- */
  shapeCase('Unfinished response (incomplete card)', {
    text: 'The migration plan has three phases. The first phase',
    unfinished: true,
  }),
  shapeCase('Step budget exhausted (tool call limit card)', {
    text: '',
    unfinished: true,
    finish_reason: Constants.TOOL_CALL_LIMIT_FINISH_REASON,
    content: [{ type: ContentTypes.TEXT, text: 'Checking the remaining files before I continue.' }],
  }),
  shapeCase('Error content part after partial output', {
    text: '',
    content: [
      {
        type: ContentTypes.TEXT,
        text: 'I read the deployment manifest and started the rollout, then the provider dropped the run:',
      },
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.UPSTREAM_MODEL_ERROR, status: 503 }),
      },
    ],
  }),
  shapeCase('Error content part carrying plain text', {
    text: '',
    content: [
      {
        type: ContentTypes.ERROR,
        text: 'Tool `execute_code` exited with status 137 (out of memory).',
      },
    ],
  }),
  shapeCase('Error flagged on a user turn', {
    text: JSON.stringify({ type: ErrorTypes.MODERATION }),
    error: true,
    isCreatedByUser: true,
  }),
];

const COVERED = new Set(ERROR_CASES.map((errorCase) => errorCase.covers).filter(Boolean));

/** Refuses to seed a gallery that no longer shows every error type. */
function assertCatalogueIsComplete() {
  const missing = [...Object.values(ErrorTypes), ...Object.values(ViolationTypes)].filter(
    (type) => !COVERED.has(type),
  );
  if (missing.length === 0) {
    return;
  }
  console.red('The error catalogue is missing cases for:');
  missing.forEach((type) => console.red(`  - ${type}`));
  console.orange('Add a case to ERROR_CASES in config/create-error-convo.js, then re-run.');
  silentExit(1);
}

function parseArgs(argv) {
  const options = {
    email: '',
    endpoint: 'openAI',
    model: 'gpt-4o',
    title: 'Error handling gallery',
  };
  for (const arg of argv) {
    const flag = /^--(endpoint|model|title)=(.+)$/.exec(arg);
    if (flag) {
      options[flag[1]] = flag[2];
    } else if (!options.email) {
      options.email = arg;
    }
  }
  return options;
}

/**
 * One user turn per case, so each response has a visible trigger, then the
 * response row that carries the failure. The chain is linear: every row's
 * parent is the row before it.
 */
function buildMessages({ conversationId, user, endpoint, model, startedAt }) {
  const messages = [];
  let parentMessageId = Constants.NO_PARENT;
  let createdAt = startedAt;

  ERROR_CASES.forEach((errorCase, index) => {
    const { label, covers: _covers, isCreatedByUser = false, ...response } = errorCase;
    const prompt = {
      messageId: crypto.randomUUID(),
      conversationId,
      user,
      parentMessageId,
      endpoint,
      model,
      sender: 'User',
      isCreatedByUser: true,
      text: `Case ${index + 1} — ${label}`,
      error: false,
      unfinished: false,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    };
    createdAt += 1000;
    messages.push(prompt);

    const row = {
      messageId: crypto.randomUUID(),
      conversationId,
      user,
      parentMessageId: prompt.messageId,
      endpoint,
      model,
      sender: isCreatedByUser ? 'User' : model,
      isCreatedByUser,
      error: true,
      unfinished: false,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      ...response,
    };
    createdAt += 1000;
    messages.push(row);
    parentMessageId = row.messageId;
  });

  return messages;
}

(async () => {
  assertCatalogueIsComplete();
  await connect();

  console.purple('---------------------------------------');
  console.purple('Create a mock conversation of every error');
  console.purple('---------------------------------------');

  const options = parseArgs(process.argv.slice(2));
  if (!options.email) {
    options.email = await askQuestion('Email of the account that should own the conversation:');
  }
  if (!options.email.includes('@')) {
    console.red(`Error: Invalid email address: ${options.email}`);
    silentExit(1);
  }

  const { User, Conversation, Message } = createModels(mongoose);
  const user = await User.findOne({ email: options.email }).select('_id').lean();
  if (!user) {
    console.red(`Error: No user found with email ${options.email}`);
    silentExit(1);
  }

  const conversationId = crypto.randomUUID();
  const messages = buildMessages({
    conversationId,
    user: user._id.toString(),
    endpoint: options.endpoint,
    model: options.model,
    startedAt: Date.now() - ERROR_CASES.length * 2000,
  });

  try {
    await Message.insertMany(messages, { timestamps: false });
    await Conversation.create({
      conversationId,
      user: user._id.toString(),
      title: options.title,
      endpoint: options.endpoint,
      model: options.model,
      isArchived: false,
    });
  } catch (error) {
    console.red(`Error: ${error.message}`);
    /** Without its conversation, every inserted row is unreachable debris that a rerun would add to. */
    await Promise.allSettled([
      Message.deleteMany({ conversationId }),
      Conversation.deleteMany({ conversationId }),
    ]);
    silentExit(1);
  }

  console.green(`Created "${options.title}" with ${ERROR_CASES.length} error cases`);
  console.purple(`conversationId: ${conversationId}`);
  console.purple(`open: /c/${conversationId}`);
  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  }
  process.exit(1);
});
