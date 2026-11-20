import http from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Turns a settled assistant message back into the frames a live run would
 * have delivered, so a real transcript can be streamed into the client again
 * and each kind of event timed on its own.
 */

export type Part = Record<string, unknown> & { type?: string };

export type ReplayFrame = {
  /** What the frame is, for grouping: `tool.done:bash_tool`, `think.delta`, `label.fill`. */
  kind: string;
  /** Position of the content part the frame belongs to. */
  index: number;
  payload: Record<string, unknown>;
};

type ToolCall = {
  id?: string;
  name?: string;
  args?: unknown;
  output?: string;
  runStepStatus?: string;
  runStepClosedAt?: number;
  runStepDurationMs?: number;
};

/** Deltas per text or reasoning part; the remainder rides the last one. */
const MAX_DELTAS = 8;
const DELTA_CHARS = 80;

function chunk(value: string, size: number, max: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    if (chunks.length === max - 1) {
      chunks.push(value.slice(offset));
      return chunks;
    }
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const nested = (value as { value?: unknown } | null)?.value;
  return typeof nested === 'string' ? nested : '';
}

function messageStep(runId: string, index: number): Record<string, unknown> {
  const id = `step_${index}`;
  return {
    event: 'on_run_step',
    data: {
      id,
      runId,
      index,
      type: 'message_creation',
      stepDetails: { type: 'message_creation', message_creation: { message_id: id } },
      usage: null,
    },
  };
}

function toolFrames(runId: string, index: number, toolCall: ToolCall): ReplayFrame[] {
  const id = `step_${index}`;
  const name = toolCall.name ?? 'tool';
  const args =
    typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args ?? {});
  const frames: ReplayFrame[] = [
    {
      kind: `tool.start:${name}`,
      index,
      payload: {
        event: 'on_run_step',
        data: {
          id,
          runId,
          index,
          type: 'tool_calls',
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: toolCall.id, name, args: '', type: 'tool_call' }],
          },
          usage: null,
        },
      },
    },
  ];
  for (const piece of chunk(args, Math.ceil(args.length / 2) || 1, 2)) {
    frames.push({
      kind: `tool.args:${name}`,
      index,
      payload: {
        event: 'on_run_step_delta',
        data: {
          id,
          delta: { type: 'tool_calls', tool_calls: [{ id: toolCall.id, index: 0, args: piece }] },
        },
      },
    });
  }
  const closedAt = toolCall.runStepClosedAt ?? Date.now();
  frames.push({
    kind: `tool.done:${name}`,
    index,
    payload: {
      event: 'on_run_step_completed',
      data: {
        result: {
          id,
          index: 0,
          completed_at: closedAt,
          tool_call: { ...toolCall, args, type: 'tool_call' },
        },
      },
    },
  });
  frames.push({
    kind: `tool.closed:${name}`,
    index,
    payload: {
      event: 'on_run_step_closed',
      data: {
        id,
        index,
        type: 'tool_calls',
        status: toolCall.runStepStatus ?? 'completed',
        created_at: closedAt - (toolCall.runStepDurationMs ?? 0),
        closed_at: closedAt,
      },
    },
  });
  return frames;
}

/**
 * Frames for `content`, in the order a run would have produced them. A part
 * the stream cannot restate (an error, a summary) leaves its slot empty.
 */
export function buildFrames(content: Part[], runId: string): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  content.forEach((part, index) => {
    if (part.type === 'text' || part.type === 'think') {
      const isThink = part.type === 'think';
      const kind = isThink ? 'think' : 'text';
      frames.push({ kind: `${kind}.start`, index, payload: messageStep(runId, index) });
      const value = textOf(isThink ? part.think : part.text);
      for (const piece of chunk(value, DELTA_CHARS, MAX_DELTAS)) {
        frames.push({
          kind: `${kind}.delta`,
          index,
          payload: {
            event: isThink ? 'on_reasoning_delta' : 'on_message_delta',
            data: {
              id: `step_${index}`,
              delta: {
                content: [
                  isThink ? { type: 'think', think: piece } : { type: 'text', text: piece },
                ],
              },
            },
          },
        });
      }
      return;
    }
    if (part.type === 'tool_call' && part.tool_call != null) {
      frames.push(...toolFrames(runId, index, part.tool_call as ToolCall));
      return;
    }
    if (part.type === 'activity_label') {
      const phase = part.activity_label_type === 'phase' ? 'phase' : 'batch';
      const event = 'on_activity_label';
      frames.push({
        kind: `label.pending:${phase}`,
        index,
        payload: {
          event,
          data: {
            index,
            part: { ...part, activity_label: '', pending: true },
            responseMessageId: runId,
          },
        },
      });
      frames.push({
        kind: `label.fill:${phase}`,
        index,
        payload: {
          event,
          data: { index, part: { ...part, pending: false }, responseMessageId: runId },
        },
      });
      return;
    }
    if (part.type === 'steer') {
      frames.push({
        kind: 'steer',
        index,
        payload: {
          event: 'on_steer_applied',
          data: { steerId: part.steerId, index, part, responseMessageId: runId },
        },
      });
    }
  });
  return frames;
}

export type ReplayServer = {
  url: string;
  /** Resolves once the client has opened the stream. */
  connected: Promise<void>;
  send(payload: Record<string, unknown>): void;
  end(): void;
  close(): Promise<void>;
};

/** A one-connection event stream the test writes to frame by frame. */
export async function startReplayServer(): Promise<ReplayServer> {
  let stream: ServerResponse | null = null;
  let markConnected: () => void = () => undefined;
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Content-Encoding': 'identity',
      'X-Accel-Buffering': 'no',
      'X-LibreChat-Generation-Protocol': '2',
    });
    response.flushHeaders();
    stream = response;
    markConnected();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/stream`,
    connected,
    send(payload) {
      stream?.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    end() {
      stream?.end();
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
