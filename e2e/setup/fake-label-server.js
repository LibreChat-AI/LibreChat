/**
 * OpenAI-compatible HTTP fixture for activity-label e2e tests.
 *
 * Activity labels are the one model call in a mock run that is NOT served by
 * `e2e/setup/fake-model.js`: that hook swaps the GRAPH's model via
 * `run.Graph.overrideTestModel(...)`, while the label call goes out through
 * `run.generateActivityLabel()` against client options resolved from the
 * endpoint config. Those options carry the template's `baseURL`
 * (http://127.0.0.1:8889/v1), so a real server on that port serves label
 * calls — and only label calls — with no production seam. Every mock endpoint
 * disables titles except the dedicated title-ownership endpoints.
 *
 * Beyond returning a label it RECORDS each request, which is what lets a spec
 * assert the prompt contract (that the register and the tool OUTPUTS actually
 * reached the model) rather than just that some text rendered.
 */
const http = require('http');

const PORT = Number(process.env.E2E_LABEL_PORT) || 8889;
const PHASE_PROMPT_MARKER = 'Summarize what this phase of an agent run accomplished';

/** Recorded label requests, newest last. */
const requests = [];
/** Test-controlled response behavior; `reset` restores these defaults. */
const DEFAULT_BEHAVIOR = {
  mode: 'ok',
  label: null,
  phaseLabel: null,
  labelsByPrompt: {},
  delayMs: 0,
  hold: false,
  holdModel: null,
};
let behavior = { ...DEFAULT_BEHAVIOR };
let labelCount = 0;
const heldResponses = new Set();

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function messageText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n');
}

/** Flattened prompt text so specs can assert on the register and tool outputs. */
function flattenPrompt(messages) {
  return (messages ?? []).map((message) => messageText(message?.content)).join('\n\n');
}

/** Non-streaming OpenAI chat completion. */
function completionPayload(model, label) {
  return {
    id: `chatcmpl-e2e-${labelCount}`,
    object: 'chat.completion',
    created: 0,
    model: model ?? 'mock-label-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: label },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
  };
}

/**
 * SSE form of the same completion. The label call inherits the endpoint's
 * client options, which may leave streaming on, so both shapes are served.
 */
function sendStream(res, model, label) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const base = {
    id: `chatcmpl-e2e-${labelCount}`,
    object: 'chat.completion.chunk',
    created: 0,
    model,
  };
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: label }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  /** Playwright's webServer readiness probe. */
  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, { ok: true, service: 'fake-label-server' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__e2e/requests') {
    sendJson(res, 200, { count: requests.length, requests });
    return;
  }

  /** Specs reset between cases so counts and prompts stay per-test. */
  if (req.method === 'POST' && url.pathname === '/__e2e/release') {
    behavior.hold = false;
    for (const release of heldResponses) release();
    heldResponses.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__e2e/reset') {
    for (const release of heldResponses) release();
    heldResponses.clear();
    requests.length = 0;
    labelCount = 0;
    behavior = { ...DEFAULT_BEHAVIOR };
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__e2e/behavior') {
    const body = await readBody(req);
    behavior = { ...DEFAULT_BEHAVIOR, ...body };
    sendJson(res, 200, { ok: true, behavior });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readBody(req);
    labelCount += 1;
    const prompt = flattenPrompt(body.messages);
    const recorded = {
      model: body.model,
      stream: body.stream === true,
      prompt,
      messages: body.messages ?? [],
      completed: false,
    };
    requests.push(recorded);
    if (behavior.hold && (!behavior.holdModel || behavior.holdModel === body.model)) {
      await new Promise((resolve) => heldResponses.add(resolve));
    }

    if (behavior.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
    }

    /** Generation failure: the run must finish cleanly with no header. */
    if (behavior.mode === 'error') {
      sendJson(res, 500, { error: { message: 'E2E forced label failure' } });
      return;
    }

    /** Whitespace-only output must fill null, leaving the block unlabeled. */
    const promptLabel = Object.entries(behavior.labelsByPrompt ?? {}).find(([needle]) =>
      prompt.includes(needle),
    )?.[1];
    const isPhase = prompt.includes(PHASE_PROMPT_MARKER);
    const label =
      behavior.mode === 'blank'
        ? '   '
        : ((isPhase ? behavior.phaseLabel : promptLabel) ??
          behavior.label ??
          `E2E activity label ${labelCount}`);

    recorded.completed = true;
    if (body.stream === true) {
      sendStream(res, body.model, label);
      return;
    }
    sendJson(res, 200, completionPayload(body.model, label));
    return;
  }

  sendJson(res, 404, { error: { message: `Unhandled ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] fake label server listening on http://127.0.0.1:${PORT}`);
});
