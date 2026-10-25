const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const MARKER = 'E2E_SUBAGENT_HISTORY:';
const CHILD_MARKER = 'E2E_SUBAGENT_HISTORY_CHILD:';
const TOOL_NAME = 'slow_echo_mcp_e2e-memory';
const CALL_COUNT = 112;
const BATCH_SIZE = 16;
const GATE_TIMEOUT_MS = 90_000;
const STATE_ROOT = path.resolve(__dirname, '../.generated/subagent-history');

function control(label) {
  if (!/^[a-z0-9-]{1,96}$/.test(label)) {
    throw new Error('Invalid subagent history fixture label');
  }
  const directory = path.join(STATE_ROOT, label);
  const signalPath = (name) => {
    if (!['ready', 'advance', 'live', 'complete', 'done'].includes(name)) {
      throw new Error('Invalid subagent history fixture signal');
    }
    return path.join(directory, name);
  };
  return {
    directory,
    async signal(name) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(signalPath(name), '1');
    },
    async has(name) {
      try {
        await fs.access(signalPath(name));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    async wait(name, { signal, timeoutMs = GATE_TIMEOUT_MS } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!(await this.has(name))) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) {
          throw new Error(`Subagent history fixture timed out waiting for ${name}: ${label}`);
        }
        await delay(50, undefined, { signal });
      }
      signal?.throwIfAborted();
    },
    async release() {
      await Promise.all([this.signal('advance'), this.signal('complete')]);
    },
  };
}

const callId = (label, index) => `call_e2e_history_${label}_${String(index).padStart(3, '0')}`;
const dispatchId = (label) => `call_e2e_history_dispatch_${label}`;
const openingText = (label) => `E2E history opening ${label}`;
const liveText = (label) => `E2E history live continuation ${label}`;
const completionText = (label) => `E2E history complete ${label}`;
const stepText = (label, batch) => `E2E history batch ${label} ${batch}`;
const payload = (label, index) =>
  `history-input-${label}-${index}-begin|` +
  'x'.repeat(index === 0 ? 24 * 1024 : 1024) +
  `|history-input-${label}-${index}-end`;
const output = (label, index) => `E2E slow echo: ${payload(label, index)}`;
const prompt = (label, childId = 'main') => `${MARKER}${childId}:${label}`;

/** Only the model is scripted. Every output must come back through the real MCP tool node. */
function responsesForText(text, { messageType, getContentText }) {
  const match = text.match(/E2E_SUBAGENT_HISTORY:([\w-]+):([a-z0-9-]{1,96})(?:\s|$)/);
  if (!match) return null;
  const [, childId, label] = match;
  const gates = control(label);
  const childPrompt = `${CHILD_MARKER}${label}`;
  const verifiedBatches = new Set();
  const toolCall = (index) => ({
    id: callId(label, index),
    name: TOOL_NAME,
    args: { text: payload(label, index), delay_ms: 0 },
    type: 'tool_call',
  });

  return {
    responses: [''],
    sleep: 1,
    overrideSubagentModel: childId !== 'main',
    disableHumanInTheLoop: true,
    resolveInvocation: async (messages, options) => {
      const results = new Map(
        (messages ?? [])
          .filter((message) => messageType(message) === 'tool')
          .map((message) => [message.tool_call_id, getContentText(message.content)]),
      );
      const isChild = (messages ?? []).some(
        (message) =>
          ['human', 'user'].includes(messageType(message)) &&
          getContentText(message.content).includes(childPrompt),
      );
      if (childId !== 'main' && !isChild) {
        if (results.has(dispatchId(label))) {
          return { response: `E2E history child dispatched ${label}` };
        }
        return {
          response: '',
          toolCalls: [
            {
              id: dispatchId(label),
              name: 'subagent',
              args: {
                description: childPrompt,
                subagent_type: childId,
                run_in_background: true,
              },
              type: 'tool_call',
            },
          ],
        };
      }

      for (let start = 0; start < CALL_COUNT; start += BATCH_SIZE) {
        if (verifiedBatches.has(start)) continue;
        const indices = Array.from({ length: BATCH_SIZE }, (_, index) => start + index);
        const returned = indices.filter((index) => results.has(callId(label, index)));
        if (returned.length === 0) {
          return {
            response: start === 0 ? openingText(label) : stepText(label, start / BATCH_SIZE),
            toolCalls: indices.map(toolCall),
          };
        }
        if (
          returned.length !== BATCH_SIZE ||
          indices.some((index) => !results.get(callId(label, index)).includes(output(label, index)))
        ) {
          throw new Error(`Subagent history fixture lost MCP results: ${label} batch ${start}`);
        }
        // Old provider context can be pruned after the actual tool result was verified.
        verifiedBatches.add(start);
      }

      await gates.signal('ready');
      await gates.wait('advance', { signal: options?.signal });
      if (!results.has(callId(label, CALL_COUNT))) {
        return { response: liveText(label), toolCalls: [toolCall(CALL_COUNT)] };
      }
      if (!results.get(callId(label, CALL_COUNT)).includes(output(label, CALL_COUNT))) {
        throw new Error(`Subagent history fixture lost the live MCP result: ${label}`);
      }
      await gates.signal('live');
      await gates.wait('complete', { signal: options?.signal });
      await gates.signal('done');
      return { response: completionText(label) };
    },
  };
}

module.exports = {
  TOOL_NAME,
  CALL_COUNT,
  BATCH_SIZE,
  control,
  callId,
  dispatchId,
  openingText,
  liveText,
  completionText,
  stepText,
  payload,
  output,
  prompt,
  responsesForText,
};
