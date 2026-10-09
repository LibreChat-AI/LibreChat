/**
 * Stateful OpenAI Assistants API fixture for credential-free mock e2e tests.
 *
 * This deliberately implements only the provider operations LibreChat uses for
 * Assistant CRUD and a text-only streamed run. It is a provider-boundary fake:
 * LibreChat's real routes, OpenAI SDK client, persistence, content preflights,
 * and SSE handling all remain in the request path.
 */
const http = require('http');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.E2E_ASSISTANTS_PORT) || 8890;
const DEFAULT_REPLY = process.env.E2E_ASSISTANTS_REPLY || 'E2E mock assistant reply: pong';
const MAX_BODY_BYTES = 1024 * 1024;

const assistants = new Map();
const threads = new Map();
const runs = new Map();
const requests = [];

function now() {
  return Math.floor(Date.now() / 1000);
}

function createId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds fixture limit'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
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

function sendError(res, status, message) {
  sendJson(res, status, {
    error: {
      message,
      type: status === 404 ? 'invalid_request_error' : 'e2e_fixture_error',
      param: null,
      code: null,
    },
  });
}

function asTextContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: { value: content, annotations: [] } }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part) => {
    if (part?.type !== 'text') {
      return part;
    }
    if (typeof part.text === 'string') {
      return { ...part, text: { value: part.text, annotations: [] } };
    }
    return {
      ...part,
      text: {
        value: part.text?.value ?? '',
        annotations: part.text?.annotations ?? [],
      },
    };
  });
}

function createMessage({
  threadId,
  role,
  content,
  assistantId = null,
  runId = null,
  metadata = {},
}) {
  return {
    id: createId('msg'),
    object: 'thread.message',
    created_at: now(),
    assistant_id: assistantId,
    thread_id: threadId,
    run_id: runId,
    role,
    content: asTextContent(content),
    attachments: [],
    metadata,
    status: 'completed',
    incomplete_details: null,
    completed_at: now(),
    incomplete_at: null,
  };
}

function createAssistant(body) {
  const createdAt = now();
  return {
    ...body,
    id: createId('asst'),
    object: 'assistant',
    created_at: createdAt,
    name: body.name ?? null,
    description: body.description ?? null,
    instructions: body.instructions ?? null,
    model: body.model,
    tools: body.tools ?? [],
    tool_resources: body.tool_resources ?? {},
    metadata: body.metadata ?? {},
    response_format: body.response_format ?? 'auto',
    temperature: body.temperature ?? 1,
    top_p: body.top_p ?? 1,
  };
}

function listResponse(data) {
  return {
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false,
  };
}

function assistantReply(thread) {
  const latestUserMessage = [...thread.messages]
    .reverse()
    .find((message) => message.role === 'user');
  const text = latestUserMessage?.content
    ?.filter((part) => part?.type === 'text')
    .map((part) => part.text?.value ?? '')
    .join('\n');
  const marker = text?.match(/E2E_REPLY:([A-Za-z0-9._-]+)/)?.[1];
  return marker ? `E2E assistant reply ${marker}` : DEFAULT_REPLY;
}

function runObject({ id, threadId, assistant, status, usage = null }) {
  const timestamp = now();
  return {
    id,
    object: 'thread.run',
    created_at: timestamp,
    assistant_id: assistant.id,
    thread_id: threadId,
    status,
    started_at: timestamp,
    expires_at: timestamp + 600,
    cancelled_at: null,
    failed_at: null,
    completed_at: status === 'completed' ? timestamp : null,
    required_action: null,
    last_error: null,
    model: assistant.model,
    instructions: assistant.instructions ?? '',
    tools: assistant.tools ?? [],
    tool_resources: assistant.tool_resources ?? {},
    metadata: {},
    incomplete_details: null,
    usage,
    temperature: assistant.temperature ?? 1,
    top_p: assistant.top_p ?? 1,
    max_prompt_tokens: null,
    max_completion_tokens: null,
    truncation_strategy: { type: 'auto', last_messages: null },
    response_format: assistant.response_format ?? 'auto',
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
}

function runStep({ id, runId, threadId, assistantId, messageId, status }) {
  const timestamp = now();
  return {
    id,
    object: 'thread.run.step',
    created_at: timestamp,
    assistant_id: assistantId,
    thread_id: threadId,
    run_id: runId,
    type: 'message_creation',
    status,
    step_details: {
      type: 'message_creation',
      message_creation: { message_id: messageId },
    },
    last_error: null,
    expired_at: null,
    cancelled_at: null,
    failed_at: null,
    completed_at: status === 'completed' ? timestamp : null,
    metadata: null,
    usage:
      status === 'completed' ? { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } : null,
  };
}

function sendAssistantStream(res, { assistant, thread }) {
  const runId = createId('run');
  const stepId = createId('step');
  const reply = assistantReply(thread);
  const message = createMessage({
    threadId: thread.id,
    role: 'assistant',
    content: reply,
    assistantId: assistant.id,
    runId,
  });
  const createdRun = runObject({
    id: runId,
    threadId: thread.id,
    assistant,
    status: 'queued',
  });
  const completedRun = runObject({
    id: runId,
    threadId: thread.id,
    assistant,
    status: 'completed',
    usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
  });
  const createdStep = runStep({
    id: stepId,
    runId,
    threadId: thread.id,
    assistantId: assistant.id,
    messageId: message.id,
    status: 'in_progress',
  });
  const completedStep = runStep({
    id: stepId,
    runId,
    threadId: thread.id,
    assistantId: assistant.id,
    messageId: message.id,
    status: 'completed',
  });
  const createdMessage = { ...message, content: [], status: 'in_progress', completed_at: null };
  const messageDelta = {
    id: message.id,
    object: 'thread.message.delta',
    delta: {
      content: [
        {
          index: 0,
          type: 'text',
          text: { value: reply, annotations: [] },
        },
      ],
    },
  };

  runs.set(runId, completedRun);
  thread.messages.push(message);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  sendEvent('thread.run.created', createdRun);
  sendEvent('thread.run.step.created', createdStep);
  sendEvent('thread.message.created', createdMessage);
  sendEvent('thread.message.delta', messageDelta);
  sendEvent('thread.message.completed', message);
  sendEvent('thread.run.step.completed', completedStep);
  sendEvent('thread.run.completed', completedRun);
  res.write('data: [DONE]\n\n');
  res.end();
}

function recordRequest(req, url, body) {
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body,
  });
}

function pathMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match?.slice(1).map(decodeURIComponent) ?? null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, { ok: true, service: 'fake-assistants-server' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__e2e/requests') {
    sendJson(res, 200, { count: requests.length, requests });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__e2e/reset') {
    assistants.clear();
    threads.clear();
    runs.clear();
    requests.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  try {
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    recordRequest(req, url, body);

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(res, 200, { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] });
      return;
    }

    if (url.pathname === '/v1/assistants') {
      if (req.method === 'POST') {
        if (typeof body.model !== 'string' || body.model.length === 0) {
          sendError(res, 400, 'model is required');
          return;
        }
        const assistant = createAssistant(body);
        assistants.set(assistant.id, assistant);
        sendJson(res, 200, assistant);
        return;
      }
      if (req.method === 'GET') {
        const order = url.searchParams.get('order') ?? 'desc';
        const data = [...assistants.values()].sort((a, b) =>
          order === 'asc' ? a.created_at - b.created_at : b.created_at - a.created_at,
        );
        sendJson(res, 200, listResponse(data));
        return;
      }
    }

    const assistantPath = pathMatch(url.pathname, /^\/v1\/assistants\/([^/]+)$/);
    if (assistantPath) {
      const [assistantId] = assistantPath;
      const assistant = assistants.get(assistantId);
      if (!assistant) {
        sendError(res, 404, `No assistant found with id '${assistantId}'`);
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, assistant);
        return;
      }
      if (req.method === 'POST') {
        const updated = {
          ...assistant,
          ...body,
          id: assistant.id,
          object: assistant.object,
          created_at: assistant.created_at,
        };
        assistants.set(assistantId, updated);
        sendJson(res, 200, updated);
        return;
      }
      if (req.method === 'DELETE') {
        assistants.delete(assistantId);
        sendJson(res, 200, { id: assistantId, object: 'assistant.deleted', deleted: true });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/threads') {
      const threadId = createId('thread');
      const thread = {
        id: threadId,
        object: 'thread',
        created_at: now(),
        metadata: body.metadata ?? {},
        tool_resources: body.tool_resources ?? {},
        messages: (body.messages ?? []).map((message) =>
          createMessage({
            threadId,
            role: message.role,
            content: message.content,
            metadata: message.metadata ?? {},
          }),
        ),
      };
      threads.set(threadId, thread);
      const { messages: _messages, ...response } = thread;
      sendJson(res, 200, response);
      return;
    }

    const messagesPath = pathMatch(url.pathname, /^\/v1\/threads\/([^/]+)\/messages$/);
    if (messagesPath) {
      const [threadId] = messagesPath;
      const thread = threads.get(threadId);
      if (!thread) {
        sendError(res, 404, `No thread found with id '${threadId}'`);
        return;
      }
      if (req.method === 'POST') {
        const message = createMessage({
          threadId,
          role: body.role,
          content: body.content,
          metadata: body.metadata ?? {},
        });
        thread.messages.push(message);
        sendJson(res, 200, message);
        return;
      }
      if (req.method === 'GET') {
        const order = url.searchParams.get('order') ?? 'desc';
        const data = [...thread.messages].sort((a, b) =>
          order === 'asc' ? a.created_at - b.created_at : b.created_at - a.created_at,
        );
        sendJson(res, 200, listResponse(data));
        return;
      }
    }

    const messagePath = pathMatch(url.pathname, /^\/v1\/threads\/([^/]+)\/messages\/([^/]+)$/);
    if (messagePath) {
      const [threadId, messageId] = messagePath;
      const thread = threads.get(threadId);
      const message = thread?.messages.find((candidate) => candidate.id === messageId);
      if (!message) {
        sendError(res, 404, `No message found with id '${messageId}'`);
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, message);
        return;
      }
      if (req.method === 'POST') {
        Object.assign(message, body);
        sendJson(res, 200, message);
        return;
      }
    }

    const createRunPath = pathMatch(url.pathname, /^\/v1\/threads\/([^/]+)\/runs$/);
    if (createRunPath && req.method === 'POST') {
      const [threadId] = createRunPath;
      const thread = threads.get(threadId);
      const assistant = assistants.get(body.assistant_id);
      if (!thread) {
        sendError(res, 404, `No thread found with id '${threadId}'`);
        return;
      }
      if (!assistant) {
        sendError(res, 404, `No assistant found with id '${body.assistant_id}'`);
        return;
      }
      if (body.stream !== true) {
        sendError(res, 400, 'Only streamed runs are supported by the e2e fixture');
        return;
      }
      sendAssistantStream(res, { assistant, thread });
      return;
    }

    const runPath = pathMatch(url.pathname, /^\/v1\/threads\/([^/]+)\/runs\/([^/]+)$/);
    if (runPath && req.method === 'GET') {
      const [threadId, runId] = runPath;
      const run = runs.get(runId);
      if (!run || run.thread_id !== threadId) {
        sendError(res, 404, `No run found with id '${runId}'`);
        return;
      }
      sendJson(res, 200, run);
      return;
    }

    sendError(res, 404, `Unhandled ${req.method} ${url.pathname}`);
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 400, error.message);
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] fake assistants server listening on http://127.0.0.1:${PORT}`);
});
