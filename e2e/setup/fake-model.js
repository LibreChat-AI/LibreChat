/**
 * In-process fake LLM for credential-free e2e tests. Loaded by `@librechat/api`'s
 * `createRun` via the `LIBRECHAT_TEST_RUN_HOOK` env var (set by the mock
 * Playwright config and the `--profile=mock` recorder), it swaps the run's model
 * for the agents package's own `FakeChatModel` through
 * `run.Graph.overrideTestModel(...)`.
 *
 * This exercises the real `Run.create` -> graph -> tool-node pipeline end to end
 * without a live provider or a standalone HTTP mock server: responses are decided
 * from the conversation and the agents' advertised tools.
 */
const { FakeChatModel } = require('@librechat/agents');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { AIMessageChunk } = require('@langchain/core/messages');
const { tryBindReplay } = require('./model-replay');
const { runFileDeliveryResponses } = require('./run-files-model');
const { createRunFileLifecycleResponses } = require('./run-files-lifecycle-model');

const runFileLifecycle = createRunFileLifecycleResponses({
  findLastToolMessage,
  getContentText,
  messageType,
});

const MOCK_REPLY = process.env.MOCK_LLM_REPLY || 'E2E mock reply: pong';
const CHUNK_DELAY_MS = Number(process.env.MOCK_LLM_CHUNK_DELAY_MS) || 10;

const CREATE_SKILL_MARKER = 'E2E_CREATE_SKILL:';
const EDIT_SKILL_MARKER = 'E2E_EDIT_SKILL:';
const ASSERT_SKILLS_MARKER = 'E2E_ASSERT_SKILLS:';
const ASSERT_MANUAL_SKILL_MARKER = 'E2E_ASSERT_MANUAL_SKILL:';
const INVOKE_SKILL_MARKER = 'E2E_INVOKE_SKILL:';
const ASSERT_PROVIDER_FILE_MARKER = 'E2E_ASSERT_PROVIDER_FILE:';
const ASSERT_AGENT_CONTEXT_MARKER = 'E2E_ASSERT_AGENT_CONTEXT:';
const ASSERT_HISTORY_MARKER = 'E2E_ASSERT_HISTORY:';
const ASSERT_QUOTE_MARKER = 'E2E_ASSERT_QUOTE:';
const REPLY_MARKER = 'E2E_REPLY:';
const THINK_REPLY_MARKER = 'E2E_THINK_REPLY:';
const SLOW_THINK_REPLY_MARKER = 'E2E_SLOW_THINK_REPLY:';
const COUNTED_REPLY_MARKER = 'E2E_COUNTED_REPLY:';
const ORDERED_REPLY_MARKER = 'E2E_ORDERED_REPLY:';
const SLOW_REPLY_MARKER = 'E2E_SLOW_REPLY:';
const EMPTY_SLOW_REPLY_MARKER = 'E2E_EMPTY_SLOW_REPLY:';
/** A run that completes having produced no content at all: the shape a
 *  summarizer takes when it returns nothing for a manual compaction. */
const EMPTY_REPLY_MARKER = 'E2E_EMPTY_REPLY:';
const SLOW_COUNTED_REPLY_MARKER = 'E2E_SLOW_COUNTED_REPLY:';
const STEER_TOOL_REPLY_MARKER = 'E2E_STEER_TOOL_REPLY:';
const STEER_SPLIT_REPLY_MARKER = 'E2E_STEER_SPLIT_REPLY:';
const STEER_LATE_REPLY_MARKER = 'E2E_STEER_LATE_REPLY:';
const ACTIVITY_REPLY_MARKER = 'E2E_ACTIVITY_REPLY:';
const ACTIVITY_PHASE_REPLY_MARKER = 'E2E_ACTIVITY_PHASE_REPLY:';
const ACTIVITY_FAILED_REPLY_MARKER = 'E2E_ACTIVITY_FAILED_REPLY:';
const ASK_USER_QUESTION_MARKER = 'E2E_ASK_USER_QUESTION:';
const RESUME_ICON_REPLY_MARKER = 'E2E_RESUME_ICON_REPLY:';
const FORCED_ERROR_MARKER = 'E2E_FORCED_ERROR:';
const MARKDOWN_REPLY_MARKER = 'E2E_MARKDOWN_REPLY';
const STREAMING_MARKDOWN_REPLY_MARKER = 'E2E_STREAMING_MARKDOWN_REPLY';
const HIGHLIGHT_CODE_MARKER = 'E2E_HIGHLIGHT_CODE:';
const STATEFUL_CODE_MARKER = 'E2E_STATEFUL_CODE:';
/** Two prose paragraphs, so a spec can select the message's *closing* block. */
const PARAGRAPHS_REPLY_MARKER = 'E2E_PARAGRAPHS_REPLY';
const MERMAID_ARTIFACT_REPLY_MARKER = 'E2E_MERMAID_ARTIFACT_REPLY';
const LARGE_MERMAID_ARTIFACT_REPLY_MARKER = 'E2E_LARGE_MERMAID_ARTIFACT_REPLY';
const HTML_ARTIFACT_REPLY_MARKER = 'E2E_HTML_ARTIFACT_REPLY';
const BACKGROUND_DISPATCH_MARKER = 'E2E_BACKGROUND_DISPATCH:';
const BACKGROUND_COLLECT_MARKER = 'E2E_BACKGROUND_COLLECT:';
const TOOL_APPROVAL_MARKER = 'E2E_TOOL_APPROVAL:';
const TOOL_APPROVAL_BATCH_MARKER = 'E2E_TOOL_APPROVAL_BATCH:';
const TOOL_APPROVAL_RESTRICTED_MARKER = 'E2E_TOOL_APPROVAL_RESTRICTED:';
const TOOL_APPROVAL_REWRITE_MARKER = 'E2E_TOOL_APPROVAL_REWRITE:';
const DEFERRED_HITL_MARKER = 'E2E_DEFERRED_HITL:';
const HANDOFF_MARKER = 'E2E_HANDOFF:';
const SUBAGENT_RESULT_MARKER = 'E2E_SUBAGENT_RESULT:';
const SUBAGENT_CHILD_MARKER = 'E2E_SUBAGENT_CHILD:';
const SUBAGENT_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
const SUBAGENT_ACTIVITY_CHILD_MARKER = 'E2E_SUBAGENT_ACTIVITY_CHILD:';
const RUN_FILES_MARKER = 'E2E_RUN_FILES:';
const RUN_FILES_CHILD_MARKER = 'E2E_RUN_FILES_CHILD:';
const RUN_FILES_FOLLOWUP_MARKER = 'E2E_RUN_FILES_FOLLOWUP:';
const RUN_FILE_VERSIONS_MARKER = 'E2E_RUN_FILE_VERSIONS:';
const RUN_FILE_VERSIONS_CHILD_MARKER = 'E2E_RUN_FILE_VERSIONS_CHILD:';
const SUBAGENT_MODEL_OVERRIDE_ERROR =
  '[e2e] Streamed subagent result coverage requires an @librechat/agents release with ' +
  'StandardGraph.setSubagentModelOverride';
const HANDOFF_TOOL_PREFIX = 'lc_transfer_to_';
const CREATE_FILE_AUTHORING_FINAL_TEXT = 'E2E file authoring complete';
const EDIT_FILE_AUTHORING_FINAL_TEXT = 'E2E file edit complete';
const SKILL_ASSERTION_FINAL_TEXT = 'E2E skill assertion passed';
/** Summary for a run with no invocable skill yet, but the tool to invoke one it authors. */
const SKILL_ASSERTION_AUTHORING_ONLY_SUMMARY = 'authoring-only';
const MANUAL_SKILL_ASSERTION_FINAL_TEXT = 'E2E manual skill assertion passed';
const SKILL_TOOL_ASSERTION_FINAL_TEXT = 'E2E skill tool assertion passed';
const PROVIDER_FILE_ASSERTION_FINAL_TEXT = 'E2E provider file assertion passed';
const AGENT_CONTEXT_ASSERTION_FINAL_TEXT = 'E2E agent context assertion passed';
const HISTORY_ASSERTION_PRESENT_TEXT = 'E2E history assertion present';
const HISTORY_ASSERTION_ABSENT_TEXT = 'E2E history assertion absent';
const QUOTE_ASSERTION_FINAL_TEXT = 'E2E quote assertion passed';
const STEER_TOOL_FINAL_TEXT = 'E2E steer tool reply done';
const STEER_SPLIT_FINAL_TEXT = 'E2E steer split reply done';
const STEER_LATE_FINAL_TEXT = 'E2E steer late reply done';
const SLOW_REPLY_CONTINUATION_TEXT = 'E2E slow reply continued';
const ACTIVITY_FINAL_TEXT = 'E2E activity reply done';
const ACTIVITY_PHASE_FINAL_TEXT = 'E2E activity phase reply done';
const ACTIVITY_FAILED_FINAL_TEXT = 'E2E activity failed reply done';
const SLOW_ECHO_TOOL_NAME_PREFIX = 'slow_echo';
const STEER_TOOL_NAME_PREFIX = 'remember_fact';
const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';
const SLOW_CHUNK_DELAY_MS = Number(process.env.MOCK_LLM_SLOW_CHUNK_DELAY_MS) || 35;
/** The highlight cancellation scenario has to open the code card and stop the
 *  run while its arguments are still arriving. At the ordinary slow cadence
 *  those ~40 chunks are gone in under two seconds, which is not a window a
 *  loaded runner can be relied on to hit, so that one variant streams wider. */
const HIGHLIGHT_CANCEL_CHUNK_DELAY_MS = 200;
const ORDERED_CHUNK_DELAY_MS = 2;
const ORDERED_REPLY_PIECES = 64;
const SLOW_REPLY_CHUNKS = 160;
const EMPTY_SLOW_REPLY_CHUNKS = 600;
const RESUME_ICON_CHUNK_DELAY_MS = Number(process.env.MOCK_LLM_RESUME_ICON_CHUNK_DELAY_MS) || 60;
const RESUME_ICON_REPLY_CHUNKS = 240;
const CREATE_FILE_TOOL_NAME = 'create_file';
const EDIT_FILE_TOOL_NAME = 'edit_file';
const BASH_TOOL_NAME = 'bash_tool';
const STATEFUL_CODE_VALUE = 'librechat-bridge-persisted';
const SKILL_TOOL_NAME = 'skill';
const CREATE_SKILL_TOOL_CALL_ID = 'call_e2e_create_skill';
const EDIT_SKILL_TOOL_CALL_ID = 'call_e2e_edit_skill';
const BACKGROUND_TOOL_NAME = 'slow_echo_mcp_e2e-memory';
const DEFERRED_HITL_TOOL_NAME = BACKGROUND_TOOL_NAME;
const DEFERRED_HITL_CONTROL_TOOL_NAME = 'recall_fact_mcp_e2e-memory';
const TOOL_SEARCH_NAME = 'tool_search';
const ASK_USER_QUESTION_NAME = 'ask_user_question';
const CHECK_BACKGROUND_TASK_TOOL_NAME = 'check_background_task';
const APPROVAL_TOOL_NAME = 'approval_probe_mcp_e2e-memory';
const APPROVAL_TOOL_CALL_PREFIX = 'call_e2e_approval_';
const BACKGROUND_DISPATCH_TOOL_CALL_ID = 'call_e2e_background_dispatch';
const BACKGROUND_COLLECT_TOOL_CALL_ID = 'call_e2e_background_collect';
const EXECUTE_CODE_MARKER = 'E2E_EXECUTE_CODE:';
const EXEC_UPLOADED_MARKER = 'E2E_EXEC_UPLOADED:';
const EXEC_PERSIST_MARKER = 'E2E_EXEC_PERSIST:';
const FILE_SEARCH_MARKER = 'E2E_FILE_SEARCH:';
/** Code Interpreter advertises bash_tool/read_file at runtime (execute_code is legacy);
 *  emit whichever the agent actually exposes so the tool batch — and provisioning — fires. */
const CODE_EXEC_TOOLS = [
  { name: 'bash_tool', args: { command: 'echo e2e' } },
  { name: 'read_file', args: { path: '/mnt/data' } },
  { name: 'execute_code', args: { lang: 'py', code: 'print("e2e")' } },
];
const FILE_SEARCH_TOOL_NAME = 'file_search';
const EXECUTE_CODE_FINAL_TEXT = 'E2E execute_code complete';
const FILE_SEARCH_FINAL_TEXT = 'E2E file_search complete';
const EXECUTE_CODE_TOOL_CALL_ID = 'call_e2e_execute_code';
const EXEC_UPLOADED_TOOL_CALL_ID = 'call_e2e_exec_uploaded';
const EXEC_PERSIST_TOOL_CALL_ID = 'call_e2e_exec_persist';
const EXEC_UPLOADED_FINAL_TEXT = 'E2E code exec complete';
const EXEC_PERSIST_FINAL_TEXT = 'E2E code persistence complete';
const EXEC_TURN_MARKER_FILE = 'e2e-turn1-marker.txt';
const FILE_SEARCH_TOOL_CALL_ID = 'call_e2e_file_search';
const MODEL_SPEC_ACCESSIBLE_SKILL = 'e2e-model-spec-allowed';
const DEPLOYMENT_SKILL_NAME = 'e2e-deployment-skill';
const ALWAYS_APPLY_BODY_MARKER = 'E2E_ALWAYS_APPLY_BODY_MARKER';
const DEPLOYMENT_SKILL_BODY_MARKER = 'E2E deployment skill loaded through Playwright';
const SKILL_DESCRIPTION =
  'Use this skill to verify LibreChat skill file authoring in mock end-to-end tests.';
const EDITED_SKILL_DESCRIPTION =
  'Use this edited skill to verify LibreChat skill file authoring in mock end-to-end tests.';
const countedReplies = new Map();
const slowCountedReplies = new Map();

function messageType(message) {
  if (typeof message.getType === 'function') {
    return message.getType();
  }
  if (typeof message._getType === 'function') {
    return message._getType();
  }
  return message.role || message.type || '';
}

function getContentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('\n');
}

function getLatestUserText(messages) {
  const message = getLatestUserMessage(messages);
  return message ? getContentText(message.content) : '';
}

function getLatestUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const type = messageType(message);
    if (type === 'human' || type === 'user') {
      return message;
    }
  }
  return null;
}

function getRequestedSkillName(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return '';
  }
  const afterMarker = text.slice(markerIndex + marker.length);
  return afterMarker.match(/[a-z0-9][a-z0-9-]*/)?.[0] ?? '';
}

function getRequestedSandboxFilename(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return '';
  }
  const afterMarker = text.slice(markerIndex + marker.length);
  return afterMarker.match(/[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? '';
}

function getMarkerValue(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return '';
  }
  return (
    text
      .slice(markerIndex + marker.length)
      .trim()
      .split(/\s+/, 1)[0] ?? ''
  );
}

/**
 * Every tool name the run advertises, mapped to the definition the model sees
 * for it. `toolDefinitions` is the array handed to the provider, so it wins
 * over a same-named entry in `tools`; registry-only names keep whatever the
 * earlier sources carried, which may be nothing. Names alone drive most
 * assertions, but the `skill` tool ships two descriptions for one name, so the
 * definition has to survive collection.
 */
function collectToolDefinitions(agents) {
  const definitions = new Map();
  const add = (name, definition) => {
    if (typeof name !== 'string' || !name) {
      return;
    }
    definitions.set(name, definition ?? definitions.get(name));
  };
  for (const agent of agents ?? []) {
    if (!agent) {
      continue;
    }
    for (const tool of agent.tools ?? []) {
      add(tool?.name, tool);
    }
    for (const def of agent.toolDefinitions ?? []) {
      add(def?.name, def);
    }
    if (agent.toolRegistry && typeof agent.toolRegistry.keys === 'function') {
      for (const name of agent.toolRegistry.keys()) {
        add(name);
      }
    }
  }
  return definitions;
}

function collectToolNames(agents) {
  return new Set(collectToolDefinitions(agents).keys());
}

async function getStreamAgentView({ graph, messages, options, runManager }) {
  let agentId = runManager?.metadata?.agentId ?? options?.metadata?.agentId;
  let agentContext;
  if (typeof agentId === 'string') {
    agentContext = graph?.agentContexts?.get(agentId);
  } else if (graph?.agentContexts?.size === 1) {
    [agentId, agentContext] = graph.agentContexts.entries().next().value;
  }
  /**
   * Graph.attemptInvoke intentionally sends test override models the pruned
   * messages directly, bypassing the production model's systemRunnable pipe.
   * Apply that agent's runnable here so assertions inspect the same complete
   * prompt (system catalog plus messages) that a real provider receives.
   */
  const systemRunnable = agentContext?.systemRunnable;
  const promptMessages =
    systemRunnable && typeof systemRunnable.invoke === 'function'
      ? await systemRunnable.invoke(messages)
      : messages;
  const toolDefinitions = collectToolDefinitions(agentContext ? [agentContext] : []);
  return {
    agentId,
    messages: promptMessages,
    toolDefinitions,
    toolNames: new Set(toolDefinitions.keys()),
  };
}

function collectPromptText(value, parts = []) {
  if (value == null) {
    return parts;
  }

  if (typeof value === 'string') {
    parts.push(value);
    return parts;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPromptText(item, parts);
    }
    return parts;
  }

  if (typeof value === 'object') {
    for (const child of Object.values(value)) {
      collectPromptText(child, parts);
    }
  }

  return parts;
}

function collectSkillPrimeMessages(messages) {
  return (messages ?? [])
    .filter((message) => message?.additional_kwargs?.source === 'skill')
    .map((message) => ({
      name: message.additional_kwargs.skillName,
      trigger: message.additional_kwargs.trigger,
      content: getContentText(message.content),
    }));
}

function collectProviderFileNames(value, names = new Set()) {
  if (value == null) {
    return names;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectProviderFileNames(item, names);
    }
    return names;
  }

  if (typeof value !== 'object') {
    return names;
  }

  if (value.type === 'input_file' && typeof value.filename === 'string') {
    names.add(value.filename);
  }

  if (value.type === 'file' && typeof value.file?.filename === 'string') {
    names.add(value.file.filename);
  }

  if (value.type === 'document' && typeof value.context === 'string') {
    const match = value.context.match(/File:\s*"([^"]+)"/);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }

  for (const child of Object.values(value)) {
    collectProviderFileNames(child, names);
  }

  return names;
}

function providerFileAssertionResponses({ messages, text }) {
  const filename = getMarkerValue(text, ASSERT_PROVIDER_FILE_MARKER);
  if (!filename) {
    return null;
  }

  const latestUserMessage = getLatestUserMessage(messages);
  const providerFileNames = collectProviderFileNames(latestUserMessage?.content);
  if (providerFileNames.has(filename)) {
    return {
      responses: [`${PROVIDER_FILE_ASSERTION_FINAL_TEXT}: ${filename}`],
    };
  }

  return {
    responses: [
      `E2E provider file assertion failed: expected ${filename}; saw ${
        Array.from(providerFileNames).join(', ') || 'no provider files'
      }`,
    ],
  };
}

function agentContextAssertionResponses({ messages, text }) {
  const expected = getMarkerValue(text, ASSERT_AGENT_CONTEXT_MARKER);
  if (!expected) {
    return null;
  }

  const promptText = collectPromptText(messages).join('\n');
  if (promptText.includes(expected)) {
    return {
      responses: [`${AGENT_CONTEXT_ASSERTION_FINAL_TEXT}: ${expected}`],
    };
  }

  return {
    responses: [
      `E2E agent context assertion failed: expected ${expected}; saw ${
        promptText ? 'prompt context without marker' : 'no prompt context'
      }`,
    ],
  };
}

/**
 * Answers whether a token from an EARLIER turn still reaches the model. Scans
 * every prompt message except the current user turn: the marker line carries
 * the token itself, so counting that turn would make every history pass.
 * Presence and absence each get their own sentinel, so a spec asserts what the
 * model saw rather than matching a failure string — a conversation whose
 * history was replaced by a checkpoint is a correct absence.
 */
function historyAssertionResponses({ messages, text }) {
  const expected = getMarkerValue(text, ASSERT_HISTORY_MARKER);
  if (!expected) {
    return null;
  }

  const latestUserMessage = getLatestUserMessage(messages);
  const priorMessages = (messages ?? []).filter((message) => message !== latestUserMessage);
  const priorText = collectPromptText(priorMessages).join('\n');
  return {
    responses: [
      priorText.includes(expected)
        ? `${HISTORY_ASSERTION_PRESENT_TEXT}: ${expected}`
        : `${HISTORY_ASSERTION_ABSENT_TEXT}: ${expected}`,
    ],
  };
}

/**
 * Verifies the quote feature end to end: scans every user message in the prompt
 * the model actually received for a Markdown blockquote line containing the
 * expected token. Passing proves the excerpt was merged into the model-facing
 * turn — covering both the current turn and durable re-merge of a prior quoted
 * turn from history (the merge runs in `AgentClient.buildMessages`).
 */
function quoteAssertionResponses({ messages, text }) {
  const expected = getMarkerValue(text, ASSERT_QUOTE_MARKER);
  if (!expected) {
    return null;
  }

  const found = (messages ?? []).some((message) => {
    const type = messageType(message);
    if (type !== 'human' && type !== 'user') {
      return false;
    }
    return getContentText(message.content)
      .split('\n')
      .some((line) => line.startsWith('> ') && line.includes(expected));
  });

  if (found) {
    return { responses: [`${QUOTE_ASSERTION_FINAL_TEXT}: ${expected}`] };
  }
  return {
    responses: [`E2E quote assertion failed: no blockquote containing "${expected}" in the prompt`],
  };
}

function replyResponses(text) {
  if (text.includes(LARGE_MERMAID_ARTIFACT_REPLY_MARKER)) {
    const diagram = ['```mermaid', 'flowchart TB'];
    for (let index = 0; index < 180; index++) {
      diagram.push(`N${index}["Processing stage ${index} with representative content"]`);
      if (index > 0) {
        diagram.push(`N${index - 1} --> N${index}`);
      }
    }
    diagram.push('```');

    return { responses: [diagram.join('\n')], sleep: 0 };
  }

  if (text.includes(MERMAID_ARTIFACT_REPLY_MARKER)) {
    return {
      responses: [['```mermaid', 'flowchart LR', 'A[Start] --> B[Finish]', '```'].join('\n')],
    };
  }

  if (text.includes(HTML_ARTIFACT_REPLY_MARKER)) {
    return {
      responses: [
        [
          ':::artifact{identifier="e2e-html" type="text/html" title="E2E HTML Artifact"}',
          '<h1>HTML sandbox fixture</h1>',
          ':::',
        ].join('\n'),
      ],
    };
  }

  if (text.includes(MARKDOWN_REPLY_MARKER)) {
    return {
      responses: [
        [
          '## E2E markdown heading',
          '',
          '**E2E bold text**',
          '',
          '- E2E list item',
          '',
          '```javascript',
          'const e2eSyntaxHighlight = "ok";',
          '```',
        ].join('\n'),
      ],
    };
  }
  if (text.includes(STREAMING_MARKDOWN_REPLY_MARKER)) {
    return {
      responses: [
        [
          '## E2E streaming markdown heading',
          '',
          'E2E streaming opening paragraph with 日本語 content.',
          '',
          '```javascript',
          'const e2eIncrementalMarkdown = "complete";',
          '```',
          '',
          '| E2E column | E2E value |',
          '| --- | --- |',
          '| completed block | visible |',
          '',
          'E2E streaming markdown final paragraph.',
        ].join('\n'),
      ],
      sleep: SLOW_CHUNK_DELAY_MS,
    };
  }

  if (text.includes(PARAGRAPHS_REPLY_MARKER)) {
    /** The quoted cell sits in the first column, so scrolling the table to its
     *  right edge carries it out of view. */
    const wideColumns = [{ header: 'E2E first column header', cell: 'E2E table cell text' }];
    for (let index = 1; index < 8; index++) {
      wideColumns.push({
        header: `E2E column ${index} with a deliberately wide header`,
        cell: `E2E filler cell ${index} padding the row out`,
      });
    }
    const filler = [];
    for (let index = 0; index < 4; index++) {
      filler.push(
        `E2E filler paragraph ${index} keeps this reply tall enough to overflow a phone viewport so scrolling is exercised for real.`,
        '',
      );
    }
    return {
      responses: [
        [
          'E2E opening paragraph of the reply, ahead of the closing one.',
          '',
          /** Renders inside `.markdown-table-wrapper`, a nested scroll container:
           *  its `overflow-x: auto` also makes the computed `overflow-y` auto, so
           *  a selection here is clipped by the table AND by the message list.
           *  Wide enough to actually overflow sideways, which is what lets a
           *  spec scroll the selected cell out of view without moving the
           *  message at all. */
          `| ${wideColumns.map((column) => column.header).join(' | ')} |`,
          `| ${wideColumns.map(() => '---').join(' | ')} |`,
          `| ${wideColumns.map((column) => column.cell).join(' | ')} |`,
          '',
          ...filler,
          'E2E closing paragraph, the last block this message renders.',
        ].join('\n'),
      ],
    };
  }

  const errorName = getMarkerValue(text, FORCED_ERROR_MARKER);
  if (errorName) {
    return {
      responses: [`E2E forced error prelude ${errorName}`],
      thrownError: `E2E forced stream error ${errorName}`,
    };
  }

  const replyName = getMarkerValue(text, REPLY_MARKER);
  if (replyName) {
    return {
      responses: [`E2E reply ${replyName}`],
    };
  }

  const slowThinkName = getMarkerValue(text, SLOW_THINK_REPLY_MARKER);
  if (slowThinkName) {
    /** Three sentences of reasoning, word by word at a readable pace, so a
     *  spec can watch the live header and the thought peek while it streams. */
    return {
      responses: [
        '<think>First I read the request slowly. Then I gather the evidence with some care. ' +
          `Finally I decide how to answer it.</think>\n\nE2E slow think reply done ${slowThinkName}`,
      ],
      sleep: 120,
    };
  }

  const thinkName = getMarkerValue(text, THINK_REPLY_MARKER);
  if (thinkName) {
    /** The `<think>` tags are parsed downstream by the agents stream pipeline, so this
     *  yields a reasoning part followed by a text part: two separately editable parts. */
    return {
      responses: [`<think>E2E reasoning ${thinkName}</think>\n\nE2E reply ${thinkName}`],
    };
  }

  const countedName = getMarkerValue(text, COUNTED_REPLY_MARKER);
  if (countedName) {
    const count = (countedReplies.get(countedName) ?? 0) + 1;
    countedReplies.set(countedName, count);
    return {
      responses: [`E2E counted reply ${countedName} #${count}`],
    };
  }

  const orderedName = getMarkerValue(text, ORDERED_REPLY_MARKER);
  if (orderedName) {
    const pieces = Array.from(
      { length: ORDERED_REPLY_PIECES },
      (_, index) => `piece-${String(index).padStart(3, '0')}`,
    ).join(' ');
    return {
      responses: [`E2E ordered reply ${orderedName} ${pieces}`],
      sleep: ORDERED_CHUNK_DELAY_MS,
    };
  }

  const slowName = getMarkerValue(text, SLOW_REPLY_MARKER);
  if (slowName) {
    return slowReplyResponses(slowName);
  }

  /** Keep a generation live after `created` without producing any content
   * that the abort persistence filter accepts. The browser regression waits
   * for the user row, then interrupts this whitespace-only stream. */
  const emptySlowName = getMarkerValue(text, EMPTY_SLOW_REPLY_MARKER);
  if (emptySlowName) {
    return {
      responses: [' '.repeat(EMPTY_SLOW_REPLY_CHUNKS)],
      sleep: SLOW_CHUNK_DELAY_MS,
    };
  }

  const emptyName = getMarkerValue(text, EMPTY_REPLY_MARKER);
  if (emptyName) {
    return { responses: [''] };
  }

  const slowCountedName = getMarkerValue(text, SLOW_COUNTED_REPLY_MARKER);
  if (slowCountedName) {
    const count = (slowCountedReplies.get(slowCountedName) ?? 0) + 1;
    slowCountedReplies.set(slowCountedName, count);
    const chunks = Array.from(
      { length: SLOW_REPLY_CHUNKS },
      (_, index) => `chunk-${String(index).padStart(3, '0')}`,
    ).join(' ');
    return {
      responses: [`E2E slow counted reply ${slowCountedName} #${count} ${chunks}`],
      sleep: SLOW_CHUNK_DELAY_MS,
    };
  }

  const resumeIconName = getMarkerValue(text, RESUME_ICON_REPLY_MARKER);
  if (resumeIconName) {
    const chunks = Array.from(
      { length: RESUME_ICON_REPLY_CHUNKS },
      (_, index) => `chunk-${String(index).padStart(3, '0')}`,
    ).join(' ');
    return {
      responses: [`E2E resume icon reply ${resumeIconName} ${chunks}`],
      sleep: RESUME_ICON_CHUNK_DELAY_MS,
    };
  }

  return null;
}

/**
 * Attaches synthetic usage_metadata on a final empty chunk (the OpenAI
 * streaming pattern) so token-usage SSE events flow end to end in mock runs.
 * Input is counted over the complete prompt a real provider bills — system
 * instructions included — since the context snapshot calibrates against it.
 */
class UsageEmittingFakeChatModel extends FakeChatModel {
  constructor({ graph, resolveInvocation, resolveOnStream, sleep, ...options }) {
    super({ ...options, sleep });
    this.graph = graph;
    this.resolveInvocation = resolveInvocation;
    this.resolveOnStream = resolveOnStream;
    this.streamSleep = sleep ?? CHUNK_DELAY_MS;
  }

  async *streamScriptedResponseChunks({ response, toolCalls, textDeltaBlocks, runManager }) {
    if (this.emitCustomEvent) {
      await runManager?.handleCustomEvent('some_test_event', {
        someval: true,
      });
    }

    const chunks = response ? response.split(/(?<=\s+)|(?=\s+)/) : [];
    for await (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, this.streamSleep));
      const responseChunk = textDeltaBlocks
        ? new ChatGenerationChunk({
            text: chunk,
            message: new AIMessageChunk({
              content: [{ type: 'text_delta', index: 0, text: chunk }],
            }),
          })
        : this._createResponseChunk(chunk);
      yield responseChunk;
      void runManager?.handleLLMNewToken(chunk);
    }

    if (toolCalls?.length) {
      await new Promise((resolve) => setTimeout(resolve, this.streamSleep));
      if (!toolCalls.some((toolCall) => toolCall.streamArgs)) {
        const toolCallChunks = toolCalls.map((toolCall, index) => ({
          name: toolCall.name,
          args: JSON.stringify(toolCall.args),
          id: toolCall.id,
          index,
          type: 'tool_call_chunk',
        }));
        yield this._createResponseChunk('', toolCallChunks);
        void runManager?.handleLLMNewToken('');
        return;
      }

      for (const [index, toolCall] of toolCalls.entries()) {
        const serializedArgs = JSON.stringify(toolCall.args);
        const chunks = toolCall.streamArgs
          ? (serializedArgs.match(/.{1,64}/gs) ?? [''])
          : [serializedArgs];
        for (const [chunkIndex, args] of chunks.entries()) {
          const toolCallChunk = {
            name: chunkIndex === 0 ? toolCall.name : undefined,
            args,
            id: chunkIndex === 0 ? toolCall.id : undefined,
            index,
            type: 'tool_call_chunk',
          };
          yield this._createResponseChunk('', [toolCallChunk]);
          void runManager?.handleLLMNewToken('');
          if (chunkIndex < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, this.streamSleep));
          }
        }
      }
      return;
    }
  }

  async *streamDynamicResponseChunks({ responses, options, runManager }) {
    if (this.emitCustomEvent) {
      await runManager?.handleCustomEvent('some_test_event', {
        someval: true,
      });
    }

    const response = responses[0] ?? '';
    const chunks = response.split(/(?<=\s+)|(?=\s+)/);
    for await (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, this.streamSleep));

      if (options.thrownErrorString != null && options.thrownErrorString) {
        throw new Error(options.thrownErrorString);
      }

      const responseChunk = this._createResponseChunk(chunk);
      yield responseChunk;
      void runManager?.handleLLMNewToken(chunk);
    }
  }

  async *_streamResponseChunks(messages, options, runManager) {
    let outputChars = 0;
    const scriptedResponse = await this.resolveInvocation?.(messages, options, runManager);
    const dynamicResponse = scriptedResponse
      ? null
      : await this.resolveOnStream?.(messages, options, runManager);
    let chunkStream;
    if (scriptedResponse) {
      chunkStream = this.streamScriptedResponseChunks({
        response: scriptedResponse.response ?? '',
        toolCalls: scriptedResponse.toolCalls,
        textDeltaBlocks: scriptedResponse.textDeltaBlocks === true,
        runManager,
      });
    } else if (dynamicResponse) {
      chunkStream = this.streamDynamicResponseChunks({
        responses: dynamicResponse.responses,
        options,
        runManager,
      });
    } else {
      chunkStream = super._streamResponseChunks(messages, options, runManager);
    }

    for await (const chunk of chunkStream) {
      outputChars += typeof chunk.text === 'string' ? chunk.text.length : 0;
      yield chunk;
    }
    const { messages: promptMessages } = await getStreamAgentView({
      graph: this.graph,
      messages: messages ?? [],
      options,
      runManager,
    });
    const inputChars = promptMessages.reduce(
      (sum, message) => sum + getContentText(message?.content).length,
      0,
    );
    const input_tokens = Math.max(1, Math.ceil(inputChars / 4));
    const output_tokens = Math.max(1, Math.ceil(outputChars / 4));
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        usage_metadata: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens },
      }),
    });
  }
}

function overrideModel({
  graph,
  responses,
  sleep,
  toolCalls,
  thrownError,
  overrideSubagentModel,
  disableHumanInTheLoop,
  resolveInvocation,
  resolveOnStream,
  modelCallbacks,
}) {
  /** The shared mock profile enables approval HITL for its dedicated specs.
   * Detached subagents reject that run-level mode before executing, so the
   * credential-free activity scenario explicitly models a deployment with
   * approval HITL disabled without weakening the shared profile. */
  if (disableHumanInTheLoop) {
    graph.humanInTheLoop = undefined;
    for (const executor of graph._subagentExecutors ?? []) {
      executor.humanInTheLoop = undefined;
    }
  }
  if (overrideSubagentModel && typeof graph.setSubagentModelOverride !== 'function') {
    overrideModel({
      graph,
      responses: [''],
      sleep,
      thrownError: SUBAGENT_MODEL_OVERRIDE_ERROR,
      modelCallbacks,
    });
    return;
  }

  if (!thrownError) {
    const model = new UsageEmittingFakeChatModel({
      graph,
      responses,
      sleep: sleep ?? CHUNK_DELAY_MS,
      emitCustomEvent: true,
      toolCalls,
      resolveInvocation,
      resolveOnStream,
    });
    model.callbacks = modelCallbacks;
    graph.overrideModel = model;
    if (overrideSubagentModel) {
      graph.setSubagentModelOverride(model);
    }
    return;
  }

  class ThrowingFakeChatModel extends FakeChatModel {
    async *_streamResponseChunks(messages, options, runManager) {
      yield* super._streamResponseChunks(
        messages,
        { ...options, thrownErrorString: thrownError },
        runManager,
      );
    }
  }

  const model = new ThrowingFakeChatModel({
    responses,
    sleep: sleep ?? CHUNK_DELAY_MS,
    emitCustomEvent: true,
    toolCalls,
  });
  model.callbacks = modelCallbacks;
  graph.overrideModel = model;
}

function parseSkillAssertion(text, agentId) {
  const markerValue = getMarkerValue(text, ASSERT_SKILLS_MARKER);
  const sections = markerValue
    .split(';')
    .map((section) => section.trim())
    .filter(Boolean);
  const isAgentScoped = sections.some((section) => section.includes('='));
  let entriesValue = markerValue;
  if (isAgentScoped) {
    // Parallel agents receive a per-run `____N` suffix while the request and
    // persisted Agent Builder state retain the stable agent id.
    const persistedAgentId =
      typeof agentId === 'string' ? agentId.replace(/____\d+$/, '') : agentId;
    const prefixes = [`${agentId}=`, `${persistedAgentId}=`];
    const scopedSection = sections.find((section) =>
      prefixes.some((prefix) => section.startsWith(prefix)),
    );
    if (!scopedSection) {
      return {
        required: [],
        requiredBodies: [],
        forbidden: [],
        error: `no skill assertion was configured for agent ${agentId ?? 'unknown'}`,
      };
    }
    const prefix = prefixes.find((candidate) => scopedSection.startsWith(candidate));
    entriesValue = scopedSection.slice(prefix.length);
  }

  const entries = entriesValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.reduce(
    (assertion, entry) => {
      if (entry.startsWith('!')) {
        const name = entry.slice(1);
        if (name) {
          assertion.forbidden.push(name);
        }
        return assertion;
      }
      if (entry.startsWith('*')) {
        const name = entry.slice(1);
        if (name) {
          assertion.required.push(name);
          assertion.requiredBodies.push(name);
        }
        return assertion;
      }
      assertion.required.push(entry);
      return assertion;
    },
    { required: [], requiredBodies: [], forbidden: [], error: undefined },
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptHasSkillCatalogEntry(promptText, skillName) {
  if (!promptText.includes('## Available Skills')) {
    return false;
  }
  return new RegExp(`(?:^|\\n)- ${escapeRegExp(skillName)}(?::|\\s*(?:\\n|$))`, 'm').test(
    promptText,
  );
}

function expectedSkillBodyMarker(skillName) {
  if (skillName === MODEL_SPEC_ACCESSIBLE_SKILL) {
    return ALWAYS_APPLY_BODY_MARKER;
  }
  if (skillName === DEPLOYMENT_SKILL_NAME) {
    return DEPLOYMENT_SKILL_BODY_MARKER;
  }
  return `# ${skillName}`;
}

/**
 * The `skill` tool's authoring-only wording, from `AUTHORED_SKILL_CONSTRAINTS`
 * in `packages/api/src/agents/tools.ts`. A run that may write
 * `skills/{skillName}/SKILL.md` gets that variant instead of the SDK's
 * catalog-only text, which is what makes the two cases below separable from
 * the prompt alone.
 */
const AUTHORED_SKILL_GUIDANCE = 'a skill you created in this conversation';

function isAuthoringSkillTool(definition) {
  return typeof definition?.description === 'string'
    ? definition.description.includes(AUTHORED_SKILL_GUIDANCE)
    : false;
}

function skillAssertionResponses({ messages, assertion, toolNames, toolDefinitions }) {
  const failures = [];
  if (assertion.error) {
    failures.push(assertion.error);
  }
  const promptText = collectPromptText(messages).join('\n');
  const skillPrimeMessages = collectSkillPrimeMessages(messages);

  const skillToolAdvertised = toolNames.has(SKILL_TOOL_NAME);
  /**
   * An empty catalog no longer implies an absent `skill` tool: a run that can
   * author skills keeps the tool bound so the model can invoke one it writes
   * mid-run, and it gets the authoring variant's description to say so. Both
   * states still have to be told apart, so the pass text names which one
   * happened — `none` for no tool at all, `authoring-only` for a tool with
   * nothing yet to invoke — and neither string contains the other, so a spec
   * asserting one cannot pass on the other.
   */
  const authoringSkillTool =
    skillToolAdvertised && isAuthoringSkillTool(toolDefinitions?.get(SKILL_TOOL_NAME));

  if (assertion.required.length > 0 && !skillToolAdvertised) {
    failures.push(`${SKILL_TOOL_NAME} tool was not advertised`);
  }
  if (assertion.required.length === 0 && skillToolAdvertised && !authoringSkillTool) {
    failures.push(`${SKILL_TOOL_NAME} tool was unexpectedly advertised`);
  }
  for (const name of assertion.required) {
    if (!promptHasSkillCatalogEntry(promptText, name)) {
      failures.push(`${name} was not present in the model-visible catalog`);
    }
  }
  for (const name of assertion.requiredBodies) {
    const expectedMarker = expectedSkillBodyMarker(name);
    const taggedBody = skillPrimeMessages.find((message) => message.name === name);
    if (!taggedBody?.content.includes(expectedMarker)) {
      failures.push(`${name} body was missing its expected marker "${expectedMarker}"`);
    }
  }
  for (const name of assertion.forbidden) {
    if (promptHasSkillCatalogEntry(promptText, name)) {
      failures.push(`${name} leaked into the model-visible catalog`);
    }
    if (skillPrimeMessages.some((message) => message.name === name)) {
      failures.push(`${name} was unexpectedly primed`);
    }
    if (name === MODEL_SPEC_ACCESSIBLE_SKILL && promptText.includes(ALWAYS_APPLY_BODY_MARKER)) {
      failures.push(`${name} always-apply body marker leaked into the model prompt`);
    }
    if (name === DEPLOYMENT_SKILL_NAME && promptText.includes(DEPLOYMENT_SKILL_BODY_MARKER)) {
      failures.push(`${name} always-apply body marker leaked into the model prompt`);
    }
  }
  if (failures.length > 0) {
    return {
      responses: [`E2E skill assertion failed: ${failures.join('; ')}`],
    };
  }
  return {
    responses: [
      `${SKILL_ASSERTION_FINAL_TEXT}: ${resolveSkillAssertionSummary(assertion, authoringSkillTool)}`,
    ],
  };
}

function resolveSkillAssertionSummary(assertion, authoringSkillTool) {
  if (assertion.required.length > 0) {
    return assertion.required.join(', ');
  }
  return authoringSkillTool ? SKILL_ASSERTION_AUTHORING_ONLY_SUMMARY : 'none';
}

function manualSkillAssertionResponses({ messages, skillName }) {
  const taggedPrime = collectSkillPrimeMessages(messages).find(
    (message) => message.name === skillName && message.trigger === 'manual',
  );
  if (!taggedPrime) {
    return {
      responses: [`E2E manual skill assertion failed: ${skillName} was not manually primed`],
    };
  }
  if (!taggedPrime.content.includes(`# ${skillName}`)) {
    return {
      responses: [`E2E manual skill assertion failed: ${skillName} body was missing`],
    };
  }
  return {
    responses: [`${MANUAL_SKILL_ASSERTION_FINAL_TEXT}: ${skillName}`],
  };
}

/**
 * Exercises the real event-driven `skill` handler. The first model call emits
 * the tool request; the second verifies both the visible tool result and the
 * body-bearing meta HumanMessage that ToolNode reinjected for the model.
 */
function skillToolInvocationResponses({ skillName, toolNames }) {
  if (!toolNames.has(SKILL_TOOL_NAME)) {
    return {
      responses: [`E2E skill tool assertion failed: ${SKILL_TOOL_NAME} was not advertised`],
    };
  }

  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: `call_e2e_skill_${skillName}`,
        name: SKILL_TOOL_NAME,
        args: { skillName },
        type: 'tool_call',
      },
    ],
    resolveOnStream: (streamMessages) => {
      const toolResult = findLastToolMessageText(
        streamMessages,
        `Skill "${skillName}" loaded. Follow the instructions below.`,
      );
      if (!toolResult) {
        return null;
      }

      const expectedMarker = expectedSkillBodyMarker(skillName);
      const modelInvokedPrime = collectSkillPrimeMessages(streamMessages).find(
        (message) =>
          message.name === skillName &&
          message.trigger == null &&
          message.content.includes(expectedMarker),
      );
      if (!modelInvokedPrime) {
        return {
          responses: [
            `E2E skill tool assertion failed: ${skillName} body was not reinjected with marker "${expectedMarker}"`,
          ],
        };
      }
      return {
        responses: [`${SKILL_TOOL_ASSERTION_FINAL_TEXT}: ${skillName}`],
      };
    },
  };
}

function buildSkillBody(skillName) {
  return `---
name: ${skillName}
description: ${SKILL_DESCRIPTION}
---

# ${skillName}

Created by the Playwright mock e2e suite to verify host file authoring without code execution.`;
}

function buildCreateSkillArgs(skillName) {
  return {
    path: `skills/${skillName}/SKILL.md`,
    content: buildSkillBody(skillName),
    overwrite: false,
  };
}

function buildEditSkillArgs(skillName) {
  return {
    path: `skills/${skillName}/SKILL.md`,
    old_text: `description: ${SKILL_DESCRIPTION}`,
    new_text: `description: ${EDITED_SKILL_DESCRIPTION}`,
  };
}

/**
 * Pick the fake-model script for a skill file-authoring turn. The graph runs two
 * model turns: turn 1 streams the (empty) preamble and emits the tool call, the
 * tool node writes the SKILL.md, then turn 2 streams the final text. The guards
 * assert the feature advertised the host file-authoring tool and did NOT enable
 * code execution.
 */
function fileAuthoringResponses(operation, toolNames) {
  if (!toolNames.has(operation.toolName)) {
    return {
      responses: [`E2E file authoring unavailable: ${operation.toolName} was not advertised.`],
    };
  }
  if (toolNames.has(BASH_TOOL_NAME)) {
    return {
      responses: [`E2E file authoring unavailable: ${BASH_TOOL_NAME} was unexpectedly advertised.`],
    };
  }
  return {
    responses: ['', `${operation.finalText}: ${operation.skillName}`],
    toolCalls: [
      {
        id: operation.toolCallId,
        name: operation.toolName,
        args: operation.args,
        type: 'tool_call',
      },
    ],
  };
}

/**
 * Slow two-turn run with a real MCP tool boundary for the steering e2e: turn 1
 * streams a slow preamble then calls the advertised `remember_fact` MCP tool
 * (steers drain at the PostToolBatch boundary), turn 2 streams the final text.
 */
function steerToolReplyResponses(label, toolNames) {
  const toolName = Array.from(toolNames).find((name) => name.startsWith(STEER_TOOL_NAME_PREFIX));
  if (!toolName) {
    return {
      responses: [
        `E2E steer tool reply unavailable: no ${STEER_TOOL_NAME_PREFIX} tool advertised.`,
      ],
    };
  }
  let invocation = 0;
  return {
    responses: [''],
    sleep: SLOW_CHUNK_DELAY_MS,
    resolveInvocation: async (messages) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          response: `E2E steer tool preamble ${label} ${slowChunkPayload()}`,
          toolCalls: [
            {
              id: `call_e2e_steer_${label}`,
              name: toolName,
              args: { fact: `steer boundary ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      return { response: `${STEER_TOOL_FINAL_TEXT} ${label} ${steerEchoSuffix(messages)}` };
    },
  };
}

/**
 * Model-visible injection proof: echoes every steer-injected user message the
 * model actually received (`additional_kwargs.source === 'steer'`, stamped by
 * the SDK's `convertInjectedMessages`), so specs can assert the words reached
 * the model rather than only that the UI rendered a part.
 */
function steerEchoSuffix(messages) {
  const steerTexts = (messages ?? [])
    .filter((message) => message?.additional_kwargs?.source === 'steer')
    .map((message) => getContentText(message.content));
  return `[steers-seen=${steerTexts.length}] ${steerTexts.join(' | ')}`.trim();
}

/**
 * Pure-text stream used by the no-tool preemption specs. A cooperative seal
 * self-loops through the same model instance, so a distinct second response
 * proves both that generation resumed and that the injected steer reached the
 * model. Without a seal, only the slow first response is ever requested.
 */
function slowReplyResponses(label) {
  let invocation = 0;
  return {
    responses: [''],
    sleep: SLOW_CHUNK_DELAY_MS,
    resolveInvocation: async (messages) => {
      invocation += 1;
      if (invocation === 1) {
        return { response: `E2E slow reply ${label} ${slowChunkPayload()}` };
      }
      return {
        response: `${SLOW_REPLY_CONTINUATION_TEXT} ${label} ${steerEchoSuffix(messages)}`,
      };
    },
  };
}

/** Slow word-chunk payload shared by the steer scenarios. */
function slowChunkPayload() {
  return Array.from(
    { length: SLOW_REPLY_CHUNKS },
    (_, index) => `chunk-${String(index).padStart(3, '0')}`,
  ).join(' ');
}

/**
 * Three-turn run with TWO tool boundaries for the split-steer e2e: turn 1
 * streams a slow preamble then calls the MCP tool (boundary A), turn 2 streams
 * a slow middle segment then calls it again (boundary B), turn 3 streams the
 * final text. Lets a test land one steer before each boundary.
 */
function steerSplitReplyResponses(label, toolNames) {
  const toolName = Array.from(toolNames).find((name) => name.startsWith(STEER_TOOL_NAME_PREFIX));
  if (!toolName) {
    return {
      responses: [
        `E2E steer split reply unavailable: no ${STEER_TOOL_NAME_PREFIX} tool advertised.`,
      ],
    };
  }
  let invocation = 0;
  return {
    responses: [''],
    sleep: SLOW_CHUNK_DELAY_MS,
    resolveInvocation: async (messages) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          response: `E2E steer split preamble ${label} ${slowChunkPayload()}`,
          toolCalls: [
            {
              id: `call_e2e_steer_split_a_${label}`,
              name: toolName,
              args: { fact: `steer split boundary A ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      if (invocation === 2) {
        return {
          response: `E2E steer split middle ${label} ${slowChunkPayload()}`,
          toolCalls: [
            {
              id: `call_e2e_steer_split_b_${label}`,
              name: toolName,
              args: { fact: `steer split boundary B ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      return { response: `${STEER_SPLIT_FINAL_TEXT} ${label} ${steerEchoSuffix(messages)}` };
    },
  };
}

/**
 * Two-turn run whose FINAL segment streams slowly: turn 1 streams a slow
 * preamble then calls the MCP tool (the only boundary), turn 2 streams a slow
 * final text. Lets a test submit a steer AFTER the last boundary — no drain
 * point remains, so the terminal path must convert it to a queued follow-up.
 */
function steerLateReplyResponses(label, toolNames) {
  const toolName = Array.from(toolNames).find((name) => name.startsWith(STEER_TOOL_NAME_PREFIX));
  if (!toolName) {
    return {
      responses: [
        `E2E steer late reply unavailable: no ${STEER_TOOL_NAME_PREFIX} tool advertised.`,
      ],
    };
  }
  let invocation = 0;
  return {
    responses: [''],
    sleep: SLOW_CHUNK_DELAY_MS,
    resolveInvocation: async () => {
      invocation += 1;
      if (invocation === 1) {
        return {
          response: `E2E steer late preamble ${label} ${slowChunkPayload()}`,
          toolCalls: [
            {
              id: `call_e2e_steer_late_${label}`,
              name: toolName,
              args: { fact: `steer late boundary ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      return { response: `${STEER_LATE_FINAL_TEXT} ${label} ${slowChunkPayload()}` };
    },
  };
}

/**
 * Two-turn run with a real tool boundary for the activity-label e2e: turn 1
 * emits TWO parallel `remember_fact` calls (one `PostToolBatch` -> one label),
 * turn 2 streams the final text. The args are distinct and the MCP fixture
 * echoes them back prefixed, so a spec can tell an OUTPUT ("E2E MCP memory
 * noted: ...") from an INPUT in the recorded label prompt — which is the whole
 * point of labeling after the batch rather than before it.
 */
function activityReplyResponses(label, toolNames) {
  const toolName = Array.from(toolNames).find((name) => name.startsWith(STEER_TOOL_NAME_PREFIX));
  if (!toolName) {
    return {
      responses: [`E2E activity reply unavailable: no ${STEER_TOOL_NAME_PREFIX} tool advertised.`],
    };
  }
  return {
    responses: ['', `${ACTIVITY_FINAL_TEXT} ${label}`],
    toolCalls: [
      {
        id: `call_e2e_activity_alpha_${label}`,
        name: toolName,
        args: { fact: `activity alpha ${label}` },
        type: 'tool_call',
      },
      {
        id: `call_e2e_activity_beta_${label}`,
        name: toolName,
        args: { fact: `activity beta ${label}` },
        type: 'tool_call',
      },
    ],
  };
}

/**
 * Three-turn run with two sequential tool batches for the parent activity-phase
 * e2e. Each tool invocation produces its own `PostToolBatch`; the final model
 * turn then closes a phase containing both logical activities. Keeping the
 * batches sequential is essential because two parallel calls are one activity.
 */
function activityPhaseReplyResponses(label, toolNames) {
  const toolName = Array.from(toolNames).find((name) => name.startsWith(STEER_TOOL_NAME_PREFIX));
  if (!toolName) {
    return {
      responses: [
        `E2E activity phase reply unavailable: no ${STEER_TOOL_NAME_PREFIX} tool advertised.`,
      ],
    };
  }
  let invocation = 0;
  return {
    responses: [''],
    resolveInvocation: async () => {
      invocation += 1;
      if (invocation === 1) {
        return {
          response: '',
          toolCalls: [
            {
              id: `call_e2e_activity_phase_alpha_${label}`,
              name: toolName,
              args: { fact: `activity phase alpha ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      if (invocation === 2) {
        return {
          response: '',
          toolCalls: [
            {
              id: `call_e2e_activity_phase_beta_${label}`,
              name: toolName,
              args: { fact: `activity phase beta ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      return { response: `${ACTIVITY_PHASE_FINAL_TEXT} ${label}` };
    },
  };
}

/**
 * A phase whose middle batch holds a failed call beside a slow one: `slow_echo`
 * called without its required `text` fails schema validation before the tool
 * runs, and a second `slow_echo` keeps the batch live for `delay` ms so a spec
 * can watch the fold while it streams.
 */
function activityFailedReplyResponses(label, toolNames) {
  const rememberTool = Array.from(toolNames).find((name) =>
    name.startsWith(STEER_TOOL_NAME_PREFIX),
  );
  const slowTool = Array.from(toolNames).find((name) =>
    name.startsWith(SLOW_ECHO_TOOL_NAME_PREFIX),
  );
  if (!rememberTool || !slowTool) {
    return {
      responses: [
        `E2E activity failed reply unavailable: ${STEER_TOOL_NAME_PREFIX} and ${SLOW_ECHO_TOOL_NAME_PREFIX} tools required.`,
      ],
    };
  }
  let invocation = 0;
  return {
    responses: [''],
    resolveInvocation: async () => {
      invocation += 1;
      if (invocation === 1) {
        return {
          response: '',
          toolCalls: [
            {
              id: `call_e2e_activity_failed_alpha_${label}`,
              name: rememberTool,
              args: { fact: `activity failed alpha ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      if (invocation === 2) {
        return {
          response: '',
          toolCalls: [
            {
              id: `call_e2e_activity_failed_broken_${label}`,
              name: slowTool,
              args: { delay_ms: 10 },
              type: 'tool_call',
            },
            {
              id: `call_e2e_activity_failed_slow_${label}`,
              name: slowTool,
              args: { text: `activity failed slow ${label}`, delay_ms: 4000 },
              type: 'tool_call',
            },
          ],
        };
      }
      if (invocation === 3) {
        return {
          response: '',
          toolCalls: [
            {
              id: `call_e2e_activity_failed_beta_${label}`,
              name: rememberTool,
              args: { fact: `activity failed beta ${label}` },
              type: 'tool_call',
            },
          ],
        };
      }
      return { response: `${ACTIVITY_FAILED_FINAL_TEXT} ${label}` };
    },
  };
}

/**
 * Pause a real agent run at the ask_user_question tool. The resume controller
 * rebuilds the graph with an empty input-message list, so the test hook selects
 * its ordinary mock reply for the resumed model turn. This deliberately tests
 * the production checkpoint/resume seam rather than simulating a pause in the
 * browser fixture.
 */
function askUserQuestionResponses(label, toolNames) {
  if (!toolNames.has(ASK_USER_QUESTION_TOOL_NAME)) {
    return {
      responses: [
        `E2E ask user question unavailable: ${ASK_USER_QUESTION_TOOL_NAME} was not advertised.`,
      ],
    };
  }
  return {
    responses: [''],
    toolCalls: [
      {
        id: `call_e2e_ask_user_question_${label}`,
        name: ASK_USER_QUESTION_TOOL_NAME,
        args: {
          questions: [
            {
              id: 'environment',
              question: `Which environment should Bombadil use for ${label}?`,
              description:
                'This deterministic pause exercises the HITL answer and resume lifecycle.',
              options: [
                { label: 'Staging', value: 'staging' },
                { label: 'Production', value: 'production' },
              ],
            },
          ],
        },
        type: 'tool_call',
      },
    ],
  };
}

function findLastToolMessageText(messages, requiredToken) {
  for (let index = (messages ?? []).length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || messageType(message) !== 'tool') {
      continue;
    }
    const content = getContentText(message.content);
    if (content.includes(requiredToken)) {
      return content;
    }
  }
  return '';
}

function parseSubagentResultMarker(text) {
  const value = getMarkerValue(text, SUBAGENT_RESULT_MARKER);
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  return {
    childId: value.slice(0, separator),
    label: value.slice(separator + 1),
  };
}

function subagentResultResponses(text) {
  const marker = parseSubagentResultMarker(text);
  if (!marker) {
    return null;
  }

  const childPrompt = `${SUBAGENT_CHILD_MARKER}${marker.label}`;
  const expectedResult = `E2E subagent streamed result ${marker.label}`;
  return {
    responses: [''],
    overrideSubagentModel: true,
    resolveInvocation: (messages) => {
      const toolResult = findLastToolMessageText(messages, expectedResult);
      if (toolResult) {
        return { response: toolResult };
      }

      if (getLatestUserText(messages).includes(childPrompt)) {
        return { response: expectedResult, textDeltaBlocks: true };
      }

      return {
        response: '',
        toolCalls: [
          {
            id: `call_e2e_subagent_${marker.label}`,
            name: 'subagent',
            args: {
              description: childPrompt,
              subagent_type: marker.childId,
            },
            type: 'tool_call',
          },
        ],
      };
    },
  };
}

function findRunFile(value, filename) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if ((value.filename ?? value.name) === filename) {
    const id = value.artifact_id ?? value.file_id ?? value.id;
    if (typeof id === 'string' && id.length > 0) {
      return { ...value, id };
    }
  }
  for (const child of Object.values(value)) {
    const match = findRunFile(child, filename);
    if (match) {
      return match;
    }
  }
  return null;
}

function parseRunFileResult(message) {
  try {
    return JSON.parse(getContentText(message?.content));
  } catch {
    return null;
  }
}

function runFilesResponses(text) {
  const followup = getMarkerValue(text, RUN_FILES_FOLLOWUP_MARKER);
  if (followup) {
    const [label, fileId] = followup.split(':');
    const callId = `call_e2e_run_files_followup_${label}`;
    return {
      responses: [''],
      resolveInvocation: (messages) => {
        const result = findLastToolMessage(messages, callId);
        if (!result) {
          return {
            response: '',
            toolCalls: [{ id: callId, name: 'list_run_files', args: {}, type: 'tool_call' }],
          };
        }
        const file = findRunFile(parseRunFileResult(result), `e2e-run-files-${label}.csv`);
        return {
          response:
            file?.id === fileId
              ? `E2E run file followup ${fileId}`
              : `E2E run files failed: followup missing ${fileId}: ${getContentText(result.content)}`,
        };
      },
    };
  }

  const marker = getMarkerValue(text, RUN_FILES_MARKER);
  if (!marker) {
    return null;
  }
  const [childId, label] = marker.split(':');
  if (!childId || !/^[A-Za-z0-9-]+$/.test(label ?? '')) {
    return { responses: ['E2E run files failed: malformed scenario marker'] };
  }
  const childPrompt = `${RUN_FILES_CHILD_MARKER}${label}`;
  const inputName = `e2e-run-files-${label}.pdf`;
  const outputName = `e2e-run-files-${label}.csv`;
  const call = (phase, name, args = {}) => ({
    response: '',
    toolCalls: [{ id: `call_e2e_run_files_${label}_${phase}`, name, args, type: 'tool_call' }],
  });
  const resultFor = (messages, phase) =>
    findLastToolMessage(messages, `call_e2e_run_files_${label}_${phase}`);
  const failure = (reason, message) => ({
    response: `E2E run files failed: ${reason}: ${getContentText(message?.content)}`,
  });

  return {
    responses: [''],
    overrideSubagentModel: true,
    resolveInvocation: (messages) => {
      const isChild = messages.some(
        (message) =>
          ['human', 'user'].includes(messageType(message)) &&
          getContentText(message.content).includes(childPrompt),
      );
      if (isChild) {
        const inputs = resultFor(messages, 'inputs');
        if (!inputs) return call('inputs', 'list_run_files');
        if (!findRunFile(parseRunFileResult(inputs), inputName)) {
          return failure('child cannot see current PDF', inputs);
        }
        const search = resultFor(messages, 'search');
        if (!search) return call('search', 'file_search', { query: `e2e ${label}` });
        const code = resultFor(messages, 'code');
        if (!code) {
          return call('code', 'bash_tool', {
            command: `printf 'source,count\\npdf,1\\n' > /mnt/data/${outputName}\n# E2E_RUN_FILE_ARTIFACT:${label}`,
          });
        }
        const catalog = resultFor(messages, 'artifacts');
        if (!catalog) return call('artifacts', 'list_run_files');
        const artifact = findRunFile(parseRunFileResult(catalog), outputName);
        if (!artifact) return failure('child output was not staged', catalog);
        const publication = resultFor(messages, 'publish');
        if (!publication) return call('publish', 'publish_artifact', { artifact_id: artifact.id });
        const published = findRunFile(parseRunFileResult(publication), outputName);
        if (!published) return failure('publication returned no durable file', publication);
        return { response: `E2E run file published ${published.id}` };
      }

      const child = resultFor(messages, 'delegate');
      if (!child) {
        return call('delegate', 'subagent', {
          description: childPrompt,
          subagent_type: childId,
        });
      }
      const fileId = getContentText(child.content).match(/E2E run file published ([\w.:-]+)/)?.[1];
      if (!fileId) return failure('child returned no published reference', child);
      const catalog = resultFor(messages, 'parent');
      if (!catalog) return call('parent', 'list_run_files');
      const file = findRunFile(parseRunFileResult(catalog), outputName);
      if (file?.id !== fileId) return failure('parent cannot see the published reference', catalog);
      return { response: `E2E run files complete ${label} file=${fileId}` };
    },
  };
}

function runFileVersionsResponses(text) {
  const marker = getMarkerValue(text, RUN_FILE_VERSIONS_MARKER);
  if (!marker) return null;
  const [childId, label] = marker.split(':');
  if (!childId || !/^[A-Za-z0-9-]+$/.test(label ?? '')) {
    return { responses: ['E2E run file versions failed: malformed scenario marker'] };
  }
  const childPrompt = `${RUN_FILE_VERSIONS_CHILD_MARKER}${label}`;
  const outputName = 'analysis.csv';
  const call = (phase, name, args = {}) => ({
    response: '',
    toolCalls: [
      { id: `call_e2e_run_file_versions_${label}_${phase}`, name, args, type: 'tool_call' },
    ],
  });
  const resultFor = (messages, phase) =>
    findLastToolMessage(messages, `call_e2e_run_file_versions_${label}_${phase}`);
  const artifactsFor = (message) =>
    (parseRunFileResult(message)?.artifacts ?? []).filter(
      (artifact) => artifact.filename === outputName && typeof artifact.artifact_id === 'string',
    );
  const failure = (reason, message) => ({
    response: `E2E run file versions failed: ${reason}: ${getContentText(message?.content)}`,
  });

  return {
    responses: [''],
    overrideSubagentModel: true,
    resolveInvocation: (messages) => {
      const isChild = messages.some(
        (message) =>
          ['human', 'user'].includes(messageType(message)) &&
          getContentText(message.content).includes(childPrompt),
      );
      if (isChild) {
        const inputs = resultFor(messages, 'inputs');
        if (!inputs) return call('inputs', 'list_run_files');
        const inputCatalog = parseRunFileResult(inputs);
        if (
          !findRunFile(inputCatalog?.files, `e2e-run-file-versions-${label}.pdf`) ||
          !findRunFile(inputCatalog?.files, `e2e-run-file-versions-${label}.csv`)
        ) {
          return failure('child cannot see both current inputs', inputs);
        }
        const search = resultFor(messages, 'search');
        if (!search) return call('search', 'file_search', { query: `e2e ${label}` });
        const firstWrite = resultFor(messages, 'write_v1');
        if (!firstWrite) {
          return call('write_v1', 'bash_tool', {
            command: `printf 'version,total\\n1,30\\n' > /mnt/data/${outputName}\n# E2E_RUN_FILE_VERSION:${label}:write-v1`,
          });
        }
        const firstCatalog = resultFor(messages, 'after_v1');
        if (!firstCatalog) return call('after_v1', 'list_run_files');
        const initialIds = new Set(artifactsFor(inputs).map((artifact) => artifact.artifact_id));
        const firstArtifact = artifactsFor(firstCatalog).find(
          (artifact) => !initialIds.has(artifact.artifact_id),
        );
        if (!firstArtifact) return failure('first write has no private artifact', firstCatalog);
        const inspection = resultFor(messages, 'inspect');
        if (!inspection) {
          return call('inspect', 'bash_tool', {
            command: `cat /mnt/data/${outputName}\n# E2E_RUN_FILE_VERSION:${label}:inspect`,
          });
        }
        if (!getContentText(inspection.content).includes('version,total\n1,30')) {
          return failure('later Bash call cannot read version one', inspection);
        }
        const inspectionCatalog = resultFor(messages, 'after_inspect');
        if (!inspectionCatalog) return call('after_inspect', 'list_run_files');
        const inspectedIds = new Set(
          artifactsFor(inspectionCatalog).map((artifact) => artifact.artifact_id),
        );
        if (!inspectedIds.has(firstArtifact.artifact_id)) {
          return failure('inspection retired the original artifact ID', inspectionCatalog);
        }
        const secondWrite = resultFor(messages, 'write_v2');
        if (!secondWrite) {
          return call('write_v2', 'bash_tool', {
            command: `printf 'version,total\\n2,35\\n' > /mnt/data/${outputName}\n# E2E_RUN_FILE_VERSION:${label}:write-v2`,
          });
        }
        const secondCatalog = resultFor(messages, 'after_v2');
        if (!secondCatalog) return call('after_v2', 'list_run_files');
        const secondArtifacts = artifactsFor(secondCatalog);
        if (
          !secondArtifacts.some((artifact) => artifact.artifact_id === firstArtifact.artifact_id)
        ) {
          return failure('overwrite retired the original artifact ID', secondCatalog);
        }
        const secondArtifact = secondArtifacts.find(
          (artifact) => !inspectedIds.has(artifact.artifact_id),
        );
        if (!secondArtifact) return failure('changed write has no new artifact ID', secondCatalog);
        const firstPublication = resultFor(messages, 'publish_v1');
        if (!firstPublication) {
          return call('publish_v1', 'publish_artifact', { artifact_id: firstArtifact.artifact_id });
        }
        const firstPublished = findRunFile(parseRunFileResult(firstPublication), outputName);
        if (!firstPublished) return failure('version one publication failed', firstPublication);
        const remainingCatalog = resultFor(messages, 'after_publish_v1');
        if (!remainingCatalog) return call('after_publish_v1', 'list_run_files');
        if (
          !artifactsFor(remainingCatalog).some(
            (artifact) => artifact.artifact_id === secondArtifact.artifact_id,
          )
        ) {
          return failure('publishing version one retired version two', remainingCatalog);
        }
        const secondPublication = resultFor(messages, 'publish_v2');
        if (!secondPublication) {
          return call('publish_v2', 'publish_artifact', {
            artifact_id: secondArtifact.artifact_id,
          });
        }
        const secondPublished = findRunFile(parseRunFileResult(secondPublication), outputName);
        if (!secondPublished || secondPublished.id === firstPublished.id) {
          return failure('version two has no distinct durable file', secondPublication);
        }
        return {
          response:
            `E2E run file versions published v1=${firstPublished.id} v2=${secondPublished.id} ` +
            `artifact_v1=${firstArtifact.artifact_id} artifact_v2=${secondArtifact.artifact_id}`,
        };
      }

      const child = resultFor(messages, 'delegate');
      if (!child) {
        return call('delegate', 'subagent', {
          description: childPrompt,
          subagent_type: childId,
        });
      }
      const proof = getContentText(child.content).match(
        /E2E run file versions published v1=([\w.:-]+) v2=([\w.:-]+) artifact_v1=([\w.:-]+) artifact_v2=([\w.:-]+)/,
      );
      if (!proof) return failure('child returned no version publications', child);
      const catalog = resultFor(messages, 'parent');
      if (!catalog) return call('parent', 'list_run_files');
      const parentFiles = parseRunFileResult(catalog)?.files ?? [];
      if (
        ![proof[1], proof[2]].every((fileId) =>
          parentFiles.some((file) => file.file_id === fileId && file.filename === outputName),
        )
      ) {
        return failure('parent cannot see both published versions', catalog);
      }
      return {
        response:
          `E2E run file versions complete ${label} v1=${proof[1]} v2=${proof[2]} ` +
          `artifact_v1=${proof[3]} artifact_v2=${proof[4]}`,
      };
    },
  };
}

function parseSubagentActivityMarker(text) {
  const value = getMarkerValue(text, SUBAGENT_ACTIVITY_MARKER);
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }

  const childIds = value.slice(0, separator).split(',').filter(Boolean);
  if (childIds.length !== 2) {
    return null;
  }

  return {
    childIds,
    label: value.slice(separator + 1),
  };
}

function subagentActivityResponses(text) {
  const marker = parseSubagentActivityMarker(text);
  if (!marker) {
    return null;
  }

  return {
    responses: [''],
    sleep: 50,
    overrideSubagentModel: true,
    disableHumanInTheLoop: true,
    resolveInvocation: (messages) => {
      const latestUserText = getLatestUserText(messages);
      for (const [index] of marker.childIds.entries()) {
        const childPrompt = `${SUBAGENT_ACTIVITY_CHILD_MARKER}${marker.label}:${index + 1}`;
        if (!latestUserText.includes(childPrompt)) {
          continue;
        }

        const progress = Array.from(
          { length: 100 },
          (_, phase) => `child-${index + 1}-phase-${phase + 1}`,
        ).join(' ');
        return {
          response: `E2E detached child ${index + 1} activity ${marker.label} ${progress} E2E detached child ${index + 1} complete ${marker.label}`,
        };
      }

      const backgroundTaskResults = (messages ?? []).filter(
        (message) =>
          messageType(message) === 'tool' &&
          typeof message?.tool_call_id === 'string' &&
          message.tool_call_id.startsWith('call_e2e_subagent_activity_'),
      );
      if (backgroundTaskResults.length >= marker.childIds.length) {
        return { response: `E2E detached subagents dispatched ${marker.label}` };
      }

      return {
        response: '',
        toolCalls: marker.childIds.map((childId, index) => ({
          id: `call_e2e_subagent_activity_${marker.label}_${index + 1}`,
          name: 'subagent',
          args: {
            description: `${SUBAGENT_ACTIVITY_CHILD_MARKER}${marker.label}:${index + 1}`,
            subagent_type: childId,
            run_in_background: true,
          },
          type: 'tool_call',
        })),
      };
    },
  };
}

function approvalToolResponses(label, toolNames, review) {
  if (!toolNames.has(APPROVAL_TOOL_NAME)) {
    return {
      responses: [`E2E approval unavailable: ${APPROVAL_TOOL_NAME} was not advertised.`],
    };
  }
  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: `${APPROVAL_TOOL_CALL_PREFIX}${label}`,
        name: APPROVAL_TOOL_NAME,
        args: {
          value: `original-${label}`,
          ...(review ? { review } : {}),
        },
        type: 'tool_call',
      },
    ],
  };
}

function batchApprovalToolResponses(label, toolNames) {
  if (!toolNames.has(APPROVAL_TOOL_NAME)) {
    return {
      responses: [`E2E approval unavailable: ${APPROVAL_TOOL_NAME} was not advertised.`],
    };
  }
  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: `${APPROVAL_TOOL_CALL_PREFIX}${label}_first`,
        name: APPROVAL_TOOL_NAME,
        args: { value: `first-${label}` },
        type: 'tool_call',
      },
      {
        id: `${APPROVAL_TOOL_CALL_PREFIX}${label}_second`,
        name: APPROVAL_TOOL_NAME,
        args: { value: `second-${label}` },
        type: 'tool_call',
      },
    ],
  };
}

/**
 * Resume rebuilds the fake model without the original prompt in `context.messages`.
 * Detect the checkpoint-restored approval tool messages on every model instance
 * so the continuation can report the real approve/reject/edit/respond outcome.
 */
function approvalOutcomeResponses(messages) {
  let latestHumanIndex = -1;
  for (let index = 0; index < (messages ?? []).length; index++) {
    const type = messageType(messages[index]);
    if (type === 'human' || type === 'user') {
      latestHumanIndex = index;
    }
  }

  const outcomeMessages = (messages ?? [])
    .slice(latestHumanIndex + 1)
    .filter(
      (message) =>
        messageType(message) === 'tool' &&
        typeof message?.tool_call_id === 'string' &&
        message.tool_call_id.startsWith(APPROVAL_TOOL_CALL_PREFIX),
    );

  const isBatch = outcomeMessages.some(
    (message) =>
      message.tool_call_id.endsWith('_first') || message.tool_call_id.endsWith('_second'),
  );
  if (isBatch && outcomeMessages.length < 2) {
    return null;
  }

  const outcomes = outcomeMessages.map((message) => getContentText(message.content));

  if (outcomes.length === 0) {
    return null;
  }
  return { responses: [`E2E approval outcomes: ${outcomes.join(' | ')}`] };
}

/**
 * Turn 1 of the background e2e: emit the MCP tool call with the injected
 * `run_in_background: true` arg, then (second model invocation, after the
 * executor returned the synthetic handle) acknowledge the handle. Streaming
 * `status=running` from the handle proves the dispatch returned before the
 * tool finished — the non-blocking contract — without timing assertions.
 */
function backgroundDispatchResponses(name, toolNames) {
  if (!toolNames.has(BACKGROUND_TOOL_NAME)) {
    return {
      responses: [`E2E background unavailable: ${BACKGROUND_TOOL_NAME} was not advertised.`],
    };
  }
  if (!toolNames.has(CHECK_BACKGROUND_TASK_TOOL_NAME)) {
    return {
      responses: [
        `E2E background unavailable: ${CHECK_BACKGROUND_TASK_TOOL_NAME} was not advertised.`,
      ],
    };
  }
  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: BACKGROUND_DISPATCH_TOOL_CALL_ID,
        name: BACKGROUND_TOOL_NAME,
        args: { text: `bg-${name}`, delay_ms: 1500, run_in_background: true },
        type: 'tool_call',
      },
    ],
    resolveOnStream: (streamMessages) => {
      const handleText = findLastToolMessageText(streamMessages, 'background_task_id');
      if (!handleText) {
        return null;
      }
      const taskId = handleText.match(/"background_task_id":"([^"]+)"/)?.[1] ?? 'missing';
      const status = handleText.match(/"status":"(\w+)"/)?.[1] ?? 'missing';
      return { responses: [`E2E background dispatched id=${taskId} status=${status}`] };
    },
  };
}

/**
 * Turn 2 of the background e2e: recover the task id from the replayed turn-1
 * handle in history, poll `check_background_task` with it, and stream the
 * collected status + echoed text — proving the detached result survived turn
 * end and was retrieved cross-turn.
 */
function backgroundCollectResponses(messages, toolNames) {
  if (!toolNames.has(CHECK_BACKGROUND_TASK_TOOL_NAME)) {
    return {
      responses: [
        `E2E background unavailable: ${CHECK_BACKGROUND_TASK_TOOL_NAME} was not advertised.`,
      ],
    };
  }
  const historyText = collectPromptText((messages ?? []).map((message) => message?.content)).join(
    '\n',
  );
  const taskIds = [...historyText.matchAll(/"background_task_id":"([^"]+)"/g)].map(
    (match) => match[1],
  );
  const taskId = taskIds[taskIds.length - 1];
  if (!taskId) {
    return {
      responses: ['E2E background collect failed: no background_task_id found in history.'],
    };
  }
  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: BACKGROUND_COLLECT_TOOL_CALL_ID,
        name: CHECK_BACKGROUND_TASK_TOOL_NAME,
        args: { background_task_id: taskId },
        type: 'tool_call',
      },
    ],
    resolveOnStream: (streamMessages) => {
      /** Only the poll result (`serializeTask`) carries a `progress` key — the
       *  replayed dispatch handle in history does not. */
      const pollText = findLastToolMessageText(streamMessages, '"progress"');
      if (!pollText) {
        return null;
      }
      const status = pollText.match(/"status":"(\w+)"/)?.[1] ?? 'missing';
      const echo = pollText.match(/E2E slow echo: (bg-[\w-]+)/)?.[1] ?? 'missing';
      return { responses: [`E2E background collected status=${status} echo=${echo}`] };
    },
  };
}

/** Fresh host-owned run started when the detached result becomes durable. */
function backgroundCompletionResponses(text) {
  if (!text.includes('background tool task has finished') || !text.includes('durable result')) {
    return null;
  }
  const status = text.match(/"status":"(\w+)"/)?.[1] ?? 'missing';
  const echo = text.match(/E2E slow echo: (bg-[\w-]+)/)?.[1] ?? 'missing';
  return {
    responses: [''],
    resolveInvocation: async (_messages, options, runManager) => {
      const agentId = getAgentIdFromInvocationOptions(options, runManager) ?? 'missing';
      return {
        response: `E2E background notified status=${status} echo=${echo} agent=${agentId}`,
      };
    },
  };
}

function statefulCodeResponses(operation, toolNames) {
  if (!toolNames.has(BASH_TOOL_NAME)) {
    return {
      responses: [`E2E stateful code unavailable: ${BASH_TOOL_NAME} was not advertised.`],
    };
  }

  const commands = {
    write: `printf ${STATEFUL_CODE_VALUE} > librechat-bridge-state.txt && cat librechat-bridge-state.txt`,
    read: 'cat librechat-bridge-state.txt',
  };
  const command = commands[operation];
  if (!command) {
    return { responses: [`E2E stateful code failed: unsupported operation ${operation}`] };
  }

  const toolCallId = `call_e2e_stateful_code_${operation}`;
  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: toolCallId,
        name: BASH_TOOL_NAME,
        args: { command },
        type: 'tool_call',
      },
    ],
    resolveOnStream: (streamMessages) => {
      const toolMessage = findLastToolMessage(streamMessages, toolCallId);
      if (!getContentText(toolMessage?.content).includes(STATEFUL_CODE_VALUE)) {
        return null;
      }
      return { responses: [`E2E stateful code ${operation} observed ${STATEFUL_CODE_VALUE}`] };
    },
  };
}

function parseHandoffScript(text) {
  const encodedScript = getMarkerValue(text, HANDOFF_MARKER);
  if (!encodedScript) {
    return null;
  }

  let value;
  try {
    value = JSON.parse(Buffer.from(encodedScript, 'base64url').toString('utf8'));
  } catch (error) {
    return {
      error: `could not decode marker (${error instanceof Error ? error.message : 'unknown error'})`,
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'script must be an object' };
  }
  if (typeof value.label !== 'string' || value.label.trim() === '') {
    return { error: 'script.label must be a non-empty string' };
  }
  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    return { error: 'script.routes must be a non-empty array' };
  }

  const routes = [];
  for (const [index, route] of value.routes.entries()) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      return { error: `script.routes[${index}] must be an object` };
    }
    if (typeof route.from !== 'string' || route.from === '') {
      return { error: `script.routes[${index}].from must be a non-empty string` };
    }
    if (typeof route.to !== 'string' || route.to === '') {
      return { error: `script.routes[${index}].to must be a non-empty string` };
    }
    if (route.args != null && (typeof route.args !== 'object' || Array.isArray(route.args))) {
      return { error: `script.routes[${index}].args must be an object` };
    }
    if (route.description != null && typeof route.description !== 'string') {
      return { error: `script.routes[${index}].description must be a string` };
    }
    if (route.prompt != null && typeof route.prompt !== 'string') {
      return { error: `script.routes[${index}].prompt must be a string` };
    }
    if (route.promptKey != null && typeof route.promptKey !== 'string') {
      return { error: `script.routes[${index}].promptKey must be a string` };
    }
    if (route.receipt != null && typeof route.receipt !== 'string') {
      return { error: `script.routes[${index}].receipt must be a string` };
    }
    if (route.targetInstructions != null && typeof route.targetInstructions !== 'string') {
      return { error: `script.routes[${index}].targetInstructions must be a string` };
    }
    if (
      route.targetTools != null &&
      (!Array.isArray(route.targetTools) ||
        route.targetTools.some((toolName) => typeof toolName !== 'string' || toolName === ''))
    ) {
      return {
        error: `script.routes[${index}].targetTools must be an array of non-empty strings`,
      };
    }
    if (route.targetToolCall != null) {
      const targetToolCall = route.targetToolCall;
      if (
        typeof targetToolCall !== 'object' ||
        Array.isArray(targetToolCall) ||
        typeof targetToolCall.id !== 'string' ||
        targetToolCall.id === '' ||
        typeof targetToolCall.name !== 'string' ||
        targetToolCall.name === '' ||
        typeof targetToolCall.args !== 'object' ||
        targetToolCall.args == null ||
        Array.isArray(targetToolCall.args) ||
        typeof targetToolCall.outputIncludes !== 'string'
      ) {
        return {
          error: `script.routes[${index}].targetToolCall must contain an id, name, args object, and outputIncludes`,
        };
      }
    }

    const args = route.args ?? {};
    let inferredReceipt = null;
    if (typeof args.instructions === 'string') {
      inferredReceipt = args.instructions;
    } else if (typeof args.context === 'string') {
      inferredReceipt = args.context;
    }
    routes.push({
      from: route.from,
      to: route.to,
      description: route.description,
      prompt: route.prompt,
      promptKey: route.promptKey,
      args,
      receipt: route.receipt ?? inferredReceipt,
      targetInstructions: route.targetInstructions,
      targetTools: route.targetTools ?? [],
      targetToolCall: route.targetToolCall,
    });
  }

  return {
    script: {
      label: value.label.trim(),
      routes,
    },
  };
}

function getGraphTools(agentContext) {
  const result = new Map();
  const tools =
    typeof agentContext?.getToolsForBinding === 'function'
      ? agentContext.getToolsForBinding()
      : agentContext?.graphTools;
  for (const tool of tools ?? []) {
    if (typeof tool?.name === 'string') {
      result.set(tool.name, tool);
    }
  }
  return result;
}

function getInvocationAgentContext(graph, options, runManager) {
  const directAgentId = runManager?.metadata?.agentId ?? options?.metadata?.agentId;
  const agentId =
    typeof directAgentId === 'string'
      ? directAgentId
      : getAgentIdFromInvocationOptions(options, runManager);
  if (typeof agentId === 'string') {
    const context = graph?.agentContexts?.get(agentId);
    if (context) {
      return context;
    }
  }
  if (graph?.agentContexts?.size === 1) {
    return graph.agentContexts.values().next().value;
  }
  return null;
}

function findToolMessage(messages, toolCallId) {
  return (messages ?? []).find(
    (message) => messageType(message) === 'tool' && message?.tool_call_id === toolCallId,
  );
}

function findLastToolMessage(messages, toolCallId) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages[index];
    if (messageType(message) === 'tool' && message?.tool_call_id === toolCallId) {
      return message;
    }
  }
  return undefined;
}

function deferredHitlCallId(label, phase) {
  return `call_e2e_deferred_hitl_${phase}_${label}`;
}

function validateDeferredHitlSchema(agentContext, { expectBound }) {
  const tools = getGraphTools(agentContext);
  const tool = tools.get(DEFERRED_HITL_TOOL_NAME);
  const failures = [];
  if (tools.has(DEFERRED_HITL_CONTROL_TOOL_NAME)) {
    failures.push(
      `${DEFERRED_HITL_CONTROL_TOOL_NAME} negative control was provider-bound without discovery`,
    );
  }
  if (!expectBound) {
    if (tool != null) {
      failures.push(`${DEFERRED_HITL_TOOL_NAME} was bound before tool_search discovered it`);
    }
    return failures;
  }
  if (!tool) {
    failures.push(`${DEFERRED_HITL_TOOL_NAME} was not provider-bound`);
    return failures;
  }

  const schema = tool.schema;
  if (schema?.type !== 'object') {
    failures.push(`${DEFERRED_HITL_TOOL_NAME} schema was not typed as object`);
  }
  const properties =
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : null;
  if (!properties) {
    failures.push(`${DEFERRED_HITL_TOOL_NAME} did not expose an object properties schema`);
    return failures;
  }

  const propertyNames = Object.keys(properties).sort();
  if (JSON.stringify(propertyNames) !== JSON.stringify(['delay_ms', 'text'])) {
    failures.push(
      `${DEFERRED_HITL_TOOL_NAME} properties differed from delay_ms,text (${propertyNames.join(',')})`,
    );
  }
  if (properties.text?.type !== 'string') {
    failures.push(`${DEFERRED_HITL_TOOL_NAME}.text was not typed as string`);
  }
  if (properties.delay_ms?.type !== 'number') {
    failures.push(`${DEFERRED_HITL_TOOL_NAME}.delay_ms was not typed as number`);
  }
  const required = Array.isArray(schema.required) ? [...schema.required].sort() : null;
  if (JSON.stringify(required) !== JSON.stringify(['text'])) {
    failures.push(
      `${DEFERRED_HITL_TOOL_NAME} required fields differed from text (${required?.join(',') ?? 'invalid'})`,
    );
  }
  return failures;
}

/**
 * Public-flow deferred-tool/HITL tracer. Every phase is inferred from message
 * history because `/resume` rebuilds both the graph and this fake-model hook.
 * Inspecting `getToolsForBinding()` mirrors the schemas a real provider sees;
 * the registry alone would give a false positive for still-deferred tools.
 */
function deferredHitlInvocationResponse({ graph, messages, options, runManager }) {
  const label = getMarkerValue(getLatestUserText(messages), DEFERRED_HITL_MARKER);
  if (!label) {
    return null;
  }

  const searchCallId = deferredHitlCallId(label, 'search');
  const askCallId = deferredHitlCallId(label, 'ask');
  const probeCallId = deferredHitlCallId(label, 'probe');
  const searchResult = findToolMessage(messages, searchCallId);
  const askResult = findToolMessage(messages, askCallId);
  const probeResult = findToolMessage(messages, probeCallId);
  const agentContext = getInvocationAgentContext(graph, options, runManager);
  if (!agentContext) {
    return { response: `E2E deferred HITL failed ${label}: active agent context was unavailable` };
  }

  if (probeResult) {
    const expectedOutput = `E2E slow echo: resume-${label}`;
    const output = getContentText(probeResult.content);
    if (!output.includes(expectedOutput)) {
      return {
        response: `E2E deferred HITL failed ${label}: unexpected probe output ${output || '(empty)'}`,
      };
    }
    return { response: `E2E deferred HITL passed ${label}: ${expectedOutput}` };
  }

  if (askResult) {
    const failures = validateDeferredHitlSchema(agentContext, { expectBound: true });
    const expectedAnswer = `continue-${label}`;
    const answer = getContentText(askResult.content);
    if (!answer.includes(expectedAnswer)) {
      failures.push(
        `ask answer mismatch (expected ${expectedAnswer}, received ${answer || '(empty)'})`,
      );
    }
    if (failures.length > 0) {
      return { response: `E2E deferred HITL failed ${label}: ${failures.join('; ')}` };
    }
    return {
      response: '',
      toolCalls: [
        {
          id: probeCallId,
          name: DEFERRED_HITL_TOOL_NAME,
          args: { text: `resume-${label}` },
          type: 'tool_call',
        },
      ],
    };
  }

  if (searchResult) {
    const failures = validateDeferredHitlSchema(agentContext, { expectBound: true });
    const searchOutput = getContentText(searchResult.content);
    if (!searchOutput.includes(DEFERRED_HITL_TOOL_NAME)) {
      failures.push(`${TOOL_SEARCH_NAME} output did not include ${DEFERRED_HITL_TOOL_NAME}`);
    }
    if (failures.length > 0) {
      return { response: `E2E deferred HITL failed ${label}: ${failures.join('; ')}` };
    }
    return {
      response: '',
      toolCalls: [
        {
          id: askCallId,
          name: ASK_USER_QUESTION_NAME,
          args: {
            questions: [
              {
                id: 'confirmation',
                question: `Continue deferred schema check ${label}?`,
                options: [{ label: `Continue ${label}`, value: `continue-${label}` }],
              },
            ],
          },
          type: 'tool_call',
        },
      ],
    };
  }

  const failures = validateDeferredHitlSchema(agentContext, { expectBound: false });
  const boundTools = getGraphTools(agentContext);
  if (!boundTools.has(TOOL_SEARCH_NAME)) {
    failures.push(`${TOOL_SEARCH_NAME} was not provider-bound`);
  }
  if (!boundTools.has(ASK_USER_QUESTION_NAME)) {
    failures.push(`${ASK_USER_QUESTION_NAME} was not provider-bound`);
  }
  if (failures.length > 0) {
    return { response: `E2E deferred HITL failed ${label}: ${failures.join('; ')}` };
  }
  return {
    response: '',
    toolCalls: [
      {
        id: searchCallId,
        name: TOOL_SEARCH_NAME,
        args: { query: DEFERRED_HITL_TOOL_NAME, max_results: 1 },
        type: 'tool_call',
      },
    ],
  };
}

function validateHandoffTool(route, tool, toolName) {
  const failures = [];
  const expectedDescription = route.description ?? `Transfer control to agent '${route.to}'`;
  if (tool.description !== expectedDescription) {
    failures.push(
      `${toolName} description mismatch (expected "${expectedDescription}", received "${tool.description ?? ''}")`,
    );
  }

  const schema = tool.schema;
  const properties =
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : null;
  if (!properties) {
    failures.push(`${toolName} did not expose an object properties schema`);
    return failures;
  }

  const propertyNames = Object.keys(properties);
  if (route.prompt == null) {
    if (propertyNames.length > 0) {
      failures.push(
        `${toolName} unexpectedly advertised input properties: ${propertyNames.join(', ')}`,
      );
    }
    return failures;
  }

  const expectedPromptKey = route.promptKey ?? 'instructions';
  const promptProperty = properties[expectedPromptKey];
  if (!promptProperty || typeof promptProperty !== 'object' || Array.isArray(promptProperty)) {
    failures.push(`${toolName} did not advertise the "${expectedPromptKey}" input property`);
    return failures;
  }
  if (propertyNames.length !== 1) {
    failures.push(
      `${toolName} advertised unexpected input properties: ${propertyNames.join(', ')}`,
    );
  }
  if (promptProperty.type !== 'string') {
    failures.push(`${toolName}.${expectedPromptKey} was not a string input`);
  }
  if (promptProperty.description !== route.prompt) {
    failures.push(
      `${toolName}.${expectedPromptKey} description mismatch (expected "${route.prompt}", received "${promptProperty.description ?? ''}")`,
    );
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    failures.push(`${toolName} unexpectedly required optional handoff input`);
  }
  return failures;
}

function validateHandoffScript(graph, script) {
  const failures = [];
  for (const route of script.routes) {
    const agentContext = graph.agentContexts?.get(route.from);
    if (!agentContext) {
      failures.push(`source agent ${route.from} was not loaded`);
      continue;
    }
    const toolName = `${HANDOFF_TOOL_PREFIX}${route.to}`;
    const tool = getGraphTools(agentContext).get(toolName);
    if (!tool) {
      failures.push(`${toolName} was not advertised by source agent ${route.from}`);
      continue;
    }
    failures.push(...validateHandoffTool(route, tool, toolName));
  }
  return failures;
}

function getAgentIdFromInvocationOptions(options, runManager) {
  const metadataCandidates = [
    options?.metadata,
    options?.configurable,
    runManager?.metadata,
    runManager?.inheritableMetadata,
  ];
  for (const metadata of metadataCandidates) {
    const node = metadata?.langgraph_node;
    if (typeof node === 'string' && node.startsWith('agent=')) {
      return node.slice('agent='.length);
    }
  }
  return null;
}

async function validateHandoffReception(graph, script, route, messages) {
  const sourceContext = graph.agentContexts?.get(route.from);
  const targetContext = graph.agentContexts?.get(route.to);
  const sourceName = sourceContext?.name ?? route.from;
  const targetName = targetContext?.name ?? route.to;
  const promptMessages = targetContext?.systemRunnable
    ? await targetContext.systemRunnable.invoke(messages ?? [])
    : (messages ?? []);
  const promptText = promptMessages
    .map((message) => getContentText(message?.content))
    .filter(Boolean)
    .join('\n');
  const failures = [];

  const identityPreamble = `You are "${targetName}", transferred from "${sourceName}".`;
  if (!promptText.includes(identityPreamble)) {
    failures.push(`missing identity preamble: ${identityPreamble}`);
  }

  const siblingNames = Array.from(
    new Set(
      script.routes
        .filter((candidate) => candidate !== route && candidate.from === route.from)
        .map((candidate) => graph.agentContexts?.get(candidate.to)?.name ?? candidate.to),
    ),
  );
  const parallelPreamble = 'Running in parallel with:';
  if (siblingNames.length === 0 && promptText.includes(parallelPreamble)) {
    failures.push('unexpected parallel sibling preamble');
  }
  if (
    siblingNames.length > 0 &&
    !promptText.includes(`${parallelPreamble} ${siblingNames.join(', ')}.`)
  ) {
    failures.push(`missing parallel sibling preamble for ${siblingNames.join(', ')}`);
  }

  if (route.targetInstructions && !promptText.includes(route.targetInstructions)) {
    failures.push(`missing target instructions: ${route.targetInstructions}`);
  }

  const sourceTools = getGraphTools(sourceContext);
  const targetTools = getGraphTools(targetContext);
  for (const toolName of route.targetTools) {
    if (!targetTools.has(toolName)) {
      failures.push(`target agent ${route.to} did not receive its configured tool ${toolName}`);
    }
    if (route.from !== route.to && sourceTools.has(toolName)) {
      failures.push(`target-only tool ${toolName} leaked to source agent ${route.from}`);
    }
  }

  return failures;
}

function buildHandoffResponses(graph, parsed) {
  if (parsed.error) {
    return {
      responses: [`E2E handoff script invalid: ${parsed.error}`],
    };
  }

  const { script } = parsed;
  const failures = validateHandoffScript(graph, script);
  if (failures.length > 0) {
    return {
      responses: [`E2E handoff unavailable: ${failures.join('; ')}`],
    };
  }

  let invocationCount = 0;
  return {
    responses: [''],
    resolveInvocation: async (messages, options, runManager) => {
      const latestUserText = getLatestUserText(messages).trim();
      const agentId = getAgentIdFromInvocationOptions(options, runManager);
      let incomingRoute = script.routes.find(
        (route) => route.receipt != null && latestUserText === route.receipt.trim(),
      );

      if (!agentId) {
        return {
          response: `E2E handoff routing failed ${script.label}: missing SDK langgraph_node metadata`,
        };
      }
      invocationCount += 1;

      const incomingRoutes = script.routes.filter((route) => route.to === agentId);
      if (!incomingRoute && incomingRoutes.length === 1) {
        incomingRoute = incomingRoutes[0];
      }
      if (incomingRoute?.receipt != null && latestUserText !== incomingRoute.receipt.trim()) {
        return {
          response:
            `E2E handoff receipt failed ${script.label}: agent=${agentId}; ` +
            `expected=${incomingRoute.receipt}; received=${latestUserText || '(empty)'}`,
        };
      }
      if (incomingRoute) {
        const receptionFailures = await validateHandoffReception(
          graph,
          script,
          incomingRoute,
          messages,
        );
        if (receptionFailures.length > 0) {
          return {
            response:
              `E2E handoff reception failed ${script.label}: agent=${agentId}; ` +
              receptionFailures.join('; '),
          };
        }

        const targetToolCall = incomingRoute.targetToolCall;
        if (targetToolCall) {
          const toolResult = findToolMessage(messages, targetToolCall.id);
          if (!toolResult) {
            return {
              response: '',
              toolCalls: [
                {
                  id: targetToolCall.id,
                  name: targetToolCall.name,
                  args: targetToolCall.args,
                  type: 'tool_call',
                },
              ],
            };
          }

          const output = getContentText(toolResult.content);
          if (!output.includes(targetToolCall.outputIncludes)) {
            return {
              response:
                `E2E handoff target tool failed ${script.label}: agent=${agentId}; ` +
                `expected=${targetToolCall.outputIncludes}; received=${output || '(empty)'}`,
            };
          }
          return {
            response: `E2E handoff tool complete ${script.label}: agent=${agentId}`,
          };
        }
      }

      const outgoingRoutes = script.routes.filter((route) => route.from === agentId);
      if (outgoingRoutes.length === 0) {
        const received =
          incomingRoute?.receipt == null ? '(no injected handoff content)' : latestUserText;
        return {
          response: `E2E handoff complete ${script.label}: agent=${agentId}; received=${received}`,
        };
      }

      return {
        response: `E2E handoff continuing ${script.label}: agent=${agentId}`,
        toolCalls: outgoingRoutes.map((route, index) => ({
          id: `call_e2e_handoff_${invocationCount}_${index}_${route.to}`,
          name: `${HANDOFF_TOOL_PREFIX}${route.to}`,
          args: route.args,
          type: 'tool_call',
        })),
      };
    },
  };
}

/**
 * Emit an `execute_code` / `file_search` tool call so the run reaches
 * ON_TOOL_EXECUTE, where `provisionFiles` lazily uploads message attachments to
 * the code env / vector DB. The tool's own result is irrelevant to the
 * provisioning assertion (which inspects the fake servers) — we just need the
 * batch to fire. Guards assert the resource tool was actually advertised.
 */
function provisioningToolResponses({ text, toolNames }) {
  const uploadedFilename = getRequestedSandboxFilename(text, EXEC_UPLOADED_MARKER);
  if (uploadedFilename) {
    return codeExecResponses(
      {
        filename: uploadedFilename,
        toolCallId: EXEC_UPLOADED_TOOL_CALL_ID,
        finalText: EXEC_UPLOADED_FINAL_TEXT,
        code: `cat "/mnt/data/${uploadedFilename}" && printf 'turn1-proof-%s\\n' "$((40 + 2))" > "/mnt/data/${EXEC_TURN_MARKER_FILE}"`,
      },
      toolNames,
    );
  }

  const persistedFilename = getRequestedSandboxFilename(text, EXEC_PERSIST_MARKER);
  if (persistedFilename) {
    return codeExecResponses(
      {
        filename: persistedFilename,
        toolCallId: EXEC_PERSIST_TOOL_CALL_ID,
        finalText: EXEC_PERSIST_FINAL_TEXT,
        code: `printf 'LINES=%s\\n' "$(wc -l < "/mnt/data/${persistedFilename}")" && cat "/mnt/data/${EXEC_TURN_MARKER_FILE}"`,
      },
      toolNames,
    );
  }
  const highlightLabel = getMarkerValue(text, HIGHLIGHT_CODE_MARKER);
  if (highlightLabel) {
    const codeTool = CODE_EXEC_TOOLS.find((tool) => toolNames.has(tool.name));
    if (!codeTool) {
      return {
        responses: [`E2E highlight code unavailable: ${JSON.stringify([...toolNames])}`],
      };
    }
    const command = Array.from({ length: 120 }, (_, index) => `printf 'line-${index}-☃\\n'`).join(
      '\n',
    );
    let args = codeTool.args;
    if (codeTool.name === 'bash_tool') {
      args = { command };
    } else if (codeTool.name === 'execute_code') {
      args = { lang: 'bash', code: command };
    }
    return {
      responses: ['', `E2E highlighted code complete: ${highlightLabel}`],
      sleep: highlightLabel === 'cancel' ? HIGHLIGHT_CANCEL_CHUNK_DELAY_MS : SLOW_CHUNK_DELAY_MS,
      toolCalls: [
        {
          id: EXECUTE_CODE_TOOL_CALL_ID,
          name: codeTool.name,
          args,
          streamArgs: true,
          type: 'tool_call',
        },
      ],
    };
  }

  const codeLabel = getMarkerValue(text, EXECUTE_CODE_MARKER);
  if (codeLabel) {
    const codeTool = CODE_EXEC_TOOLS.find((tool) => toolNames.has(tool.name));
    if (!codeTool) {
      return {
        responses: [
          `E2E execute_code unavailable: no code-execution tool advertised (saw ${
            JSON.stringify([...toolNames]) || 'none'
          }).`,
        ],
      };
    }
    return {
      responses: ['', `${EXECUTE_CODE_FINAL_TEXT}: ${codeLabel}`],
      toolCalls: [
        {
          id: EXECUTE_CODE_TOOL_CALL_ID,
          name: codeTool.name,
          args: codeTool.args,
          type: 'tool_call',
        },
      ],
    };
  }
  const searchLabel = getMarkerValue(text, FILE_SEARCH_MARKER);
  if (searchLabel) {
    if (!toolNames.has(FILE_SEARCH_TOOL_NAME)) {
      return {
        responses: [`E2E file_search unavailable: ${FILE_SEARCH_TOOL_NAME} was not advertised.`],
      };
    }
    return {
      responses: ['', `${FILE_SEARCH_FINAL_TEXT}: ${searchLabel}`],
      toolCalls: [
        {
          id: FILE_SEARCH_TOOL_CALL_ID,
          name: FILE_SEARCH_TOOL_NAME,
          args: { query: `e2e ${searchLabel}` },
          type: 'tool_call',
        },
      ],
    };
  }

  return null;
}

function codeExecResponses({ filename, toolCallId, finalText, code }, toolNames) {
  if (!toolNames.has(BASH_TOOL_NAME)) {
    return {
      responses: [`E2E code exec unavailable: ${BASH_TOOL_NAME} was not advertised.`],
    };
  }
  return {
    responses: ['', `${finalText}: ${filename}`],
    toolCalls: [
      {
        id: toolCallId,
        name: BASH_TOOL_NAME,
        args: { command: code },
        type: 'tool_call',
      },
    ],
  };
}

function resolveResponses({ graph, messages, text, toolNames }) {
  const lifecycle = runFileLifecycle.responsesForText(text);
  if (lifecycle) return lifecycle;

  const runFileDelivery = runFileDeliveryResponses(text);
  if (runFileDelivery) return runFileDelivery;

  const backgroundCompletion = backgroundCompletionResponses(text);
  if (backgroundCompletion) {
    return backgroundCompletion;
  }

  const runFileVersions = runFileVersionsResponses(text);
  if (runFileVersions) {
    return runFileVersions;
  }

  const runFiles = runFilesResponses(text);
  if (runFiles) {
    return runFiles;
  }

  const subagentActivity = subagentActivityResponses(text);
  if (subagentActivity) {
    return subagentActivity;
  }

  const subagentResult = subagentResultResponses(text);
  if (subagentResult) {
    return subagentResult;
  }

  const batchApprovalLabel = getMarkerValue(text, TOOL_APPROVAL_BATCH_MARKER);
  if (batchApprovalLabel) {
    return batchApprovalToolResponses(batchApprovalLabel, toolNames);
  }

  const restrictedApprovalLabel = getMarkerValue(text, TOOL_APPROVAL_RESTRICTED_MARKER);
  if (restrictedApprovalLabel) {
    return approvalToolResponses(restrictedApprovalLabel, toolNames, 'restricted');
  }

  const rewrittenApprovalLabel = getMarkerValue(text, TOOL_APPROVAL_REWRITE_MARKER);
  if (rewrittenApprovalLabel) {
    return approvalToolResponses(rewrittenApprovalLabel, toolNames, 'rewrite');
  }

  const approvalLabel = getMarkerValue(text, TOOL_APPROVAL_MARKER);
  if (approvalLabel) {
    return approvalToolResponses(approvalLabel, toolNames);
  }

  const reply = replyResponses(text);
  if (reply) {
    return reply;
  }

  const statefulCodeOperation = getMarkerValue(text, STATEFUL_CODE_MARKER);
  if (statefulCodeOperation) {
    return statefulCodeResponses(statefulCodeOperation, toolNames);
  }

  const steerToolLabel = getMarkerValue(text, STEER_TOOL_REPLY_MARKER);
  if (steerToolLabel) {
    return steerToolReplyResponses(steerToolLabel, toolNames);
  }

  const provisioningTool = provisioningToolResponses({ text, toolNames });
  if (provisioningTool) {
    return provisioningTool;
  }

  const steerSplitLabel = getMarkerValue(text, STEER_SPLIT_REPLY_MARKER);
  if (steerSplitLabel) {
    return steerSplitReplyResponses(steerSplitLabel, toolNames);
  }

  const steerLateLabel = getMarkerValue(text, STEER_LATE_REPLY_MARKER);
  if (steerLateLabel) {
    return steerLateReplyResponses(steerLateLabel, toolNames);
  }

  const activityLabel = getMarkerValue(text, ACTIVITY_REPLY_MARKER);
  if (activityLabel) {
    return activityReplyResponses(activityLabel, toolNames);
  }

  const activityPhaseLabel = getMarkerValue(text, ACTIVITY_PHASE_REPLY_MARKER);
  if (activityPhaseLabel) {
    return activityPhaseReplyResponses(activityPhaseLabel, toolNames);
  }

  const activityFailedLabel = getMarkerValue(text, ACTIVITY_FAILED_REPLY_MARKER);
  if (activityFailedLabel) {
    return activityFailedReplyResponses(activityFailedLabel, toolNames);
  }

  const askUserQuestionLabel = getMarkerValue(text, ASK_USER_QUESTION_MARKER);
  if (askUserQuestionLabel) {
    return askUserQuestionResponses(askUserQuestionLabel, toolNames);
  }

  if (text.includes(ASSERT_AGENT_CONTEXT_MARKER)) {
    return {
      responses: [MOCK_REPLY],
      resolveOnStream: (streamMessages) =>
        agentContextAssertionResponses({ messages: streamMessages, text }),
    };
  }

  if (text.includes(ASSERT_HISTORY_MARKER)) {
    return {
      responses: [MOCK_REPLY],
      resolveOnStream: (streamMessages) =>
        historyAssertionResponses({ messages: streamMessages, text }),
    };
  }

  const providerFileAssertion = providerFileAssertionResponses({ messages, text });
  if (providerFileAssertion) {
    return providerFileAssertion;
  }

  const quoteAssertion = quoteAssertionResponses({ messages, text });
  if (quoteAssertion) {
    return quoteAssertion;
  }

  if (text.includes(ASSERT_SKILLS_MARKER)) {
    return {
      responses: [MOCK_REPLY],
      resolveOnStream: async (streamMessages, streamOptions, runManager) => {
        const agentView = await getStreamAgentView({
          graph,
          messages: streamMessages,
          options: streamOptions,
          runManager,
        });
        return skillAssertionResponses({
          messages: agentView.messages,
          assertion: parseSkillAssertion(text, agentView.agentId),
          toolNames: agentView.toolNames,
          toolDefinitions: agentView.toolDefinitions,
        });
      },
    };
  }

  if (text.includes(ASSERT_MANUAL_SKILL_MARKER)) {
    const skillName = getMarkerValue(text, ASSERT_MANUAL_SKILL_MARKER);
    return {
      responses: [MOCK_REPLY],
      resolveOnStream: async (streamMessages, streamOptions, runManager) => {
        const agentView = await getStreamAgentView({
          graph,
          messages: streamMessages,
          options: streamOptions,
          runManager,
        });
        return manualSkillAssertionResponses({
          messages: agentView.messages,
          skillName,
        });
      },
    };
  }

  const invokedSkillName = getMarkerValue(text, INVOKE_SKILL_MARKER);
  if (invokedSkillName) {
    return skillToolInvocationResponses({
      skillName: invokedSkillName,
      toolNames,
    });
  }

  const createSkillName = getRequestedSkillName(text, CREATE_SKILL_MARKER);
  if (createSkillName) {
    return fileAuthoringResponses(
      {
        skillName: createSkillName,
        toolName: CREATE_FILE_TOOL_NAME,
        toolCallId: CREATE_SKILL_TOOL_CALL_ID,
        finalText: CREATE_FILE_AUTHORING_FINAL_TEXT,
        args: buildCreateSkillArgs(createSkillName),
      },
      toolNames,
    );
  }

  const backgroundDispatchName = getMarkerValue(text, BACKGROUND_DISPATCH_MARKER);
  if (backgroundDispatchName) {
    return backgroundDispatchResponses(backgroundDispatchName, toolNames);
  }

  if (text.includes(BACKGROUND_COLLECT_MARKER)) {
    return backgroundCollectResponses(messages, toolNames);
  }

  const editSkillName = getRequestedSkillName(text, EDIT_SKILL_MARKER);
  if (editSkillName) {
    return fileAuthoringResponses(
      {
        skillName: editSkillName,
        toolName: EDIT_FILE_TOOL_NAME,
        toolCallId: EDIT_SKILL_TOOL_CALL_ID,
        finalText: EDIT_FILE_AUTHORING_FINAL_TEXT,
        args: buildEditSkillArgs(editSkillName),
      },
      toolNames,
    );
  }

  return { responses: [MOCK_REPLY] };
}

/** @type {import('@librechat/api').TestRunHook} */
module.exports = function fakeModelHook(run, context) {
  const graph = run?.Graph;
  if (!graph || typeof graph.overrideTestModel !== 'function') {
    console.warn('[e2e] fake-model hook: run.Graph.overrideTestModel unavailable');
    return;
  }

  const text = getLatestUserText(context?.messages);
  /** Recorded-session replay outranks marker routing: a conversation whose
   * prompt matches a fixture's next recorded invocation streams that recording
   * through the real pipeline instead of a scripted mock response. */
  if (
    tryBindReplay({
      graph,
      text,
      agents: context?.agents,
      messages: context?.messages,
      conversationId: context?.conversationId,
      modelCallbacks: context?.modelCallbacks,
    })
  ) {
    return;
  }
  const toolNames = collectToolNames(context?.agents);
  const handoffScript = parseHandoffScript(text);
  const {
    responses,
    sleep,
    toolCalls,
    thrownError,
    overrideSubagentModel,
    disableHumanInTheLoop,
    resolveInvocation,
    resolveOnStream,
  } = handoffScript
    ? buildHandoffResponses(graph, handoffScript)
    : resolveResponses({
        graph,
        messages: context?.messages,
        text,
        toolNames,
      });
  overrideModel({
    graph,
    responses,
    sleep,
    toolCalls,
    thrownError,
    overrideSubagentModel:
      overrideSubagentModel || runFileLifecycle.isFixtureAgents(context?.agents),
    disableHumanInTheLoop,
    resolveInvocation: async (streamMessages, streamOptions, runManager) =>
      runFileLifecycle.resolveInvocation(streamMessages) ??
      deferredHitlInvocationResponse({
        graph,
        messages: streamMessages,
        options: streamOptions,
        runManager,
      }) ??
      resolveInvocation?.(streamMessages, streamOptions, runManager) ??
      null,
    resolveOnStream: (streamMessages, streamOptions, runManager) =>
      approvalOutcomeResponses(streamMessages) ??
      resolveOnStream?.(streamMessages, streamOptions, runManager) ??
      null,
    modelCallbacks: context?.modelCallbacks,
  });
};
