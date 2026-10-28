/**
 * Client-side tool execution for the Open Responses API.
 *
 * A caller may declare function tools it will execute itself:
 *
 *   POST /v1/responses
 *   { "model": "...", "input": "...",
 *     "tools": [{ "type": "function", "name": "open_service_page",
 *                 "parameters": { ... } }] }
 *
 * Such a tool is made visible to the model but is never executed on the server.
 * When the model calls one, the run ends and the call is handed back as a
 * `function_call` output item. The caller executes it and continues by replaying
 * *both* items in the next request's `input` — the `function_call` it received
 * and the `function_call_output` it produced:
 *
 *   POST /v1/responses
 *   { "model": "...", "tools": [...],
 *     "input": [ ...earlier items,
 *                { "type": "function_call", "call_id": "call_1",
 *                  "name": "open_service_page", "arguments": "{...}" },
 *                { "type": "function_call_output", "call_id": "call_1",
 *                  "output": "..." } ] }
 *
 * `convertInputToMessages` turns that pair into an assistant message carrying
 * the tool call and a matching tool result, which is the adjacency providers
 * require.
 *
 * Replay is the only continuation this endpoint supports for a tool exchange.
 * `previous_response_id` does not carry one: the server persists a turn as
 * text (`saveResponseOutput` keeps `output_text`, `saveInputMessages` keeps
 * `role: 'user'`), so neither item survives, and the id is rejected outright
 * with 404 unless the first request also asked for `store: true`. Sending
 * `previous_response_id` with a bare `function_call_output` therefore produces
 * a tool result whose call is missing.
 *
 * This is the stateless shape OpenAI defines: no run is suspended, nothing is
 * checkpointed, and no per-caller state is held between the two requests.
 *
 * The handoff needs the client call to be the turn's only call, so each tool's
 * description asks the model for that shape, and a batch that mixes one with a
 * server tool is answered with the same instruction rather than executed.
 */
import { logger } from '@librechat/data-schemas';
import type {
  LCTool,
  StandardGraph,
  ToolCallRequest,
  ToolExecuteResult,
  ToolExecuteBatchRequest,
} from '@librechat/agents';
import type { FunctionTool, Tool } from './types';

/** JSON Schema stand-in for a tool that declares no parameters. */
const EMPTY_PARAMETERS = { type: 'object', properties: {} } as const;

/**
 * Matches the character set OpenAI accepts for function names, so a tool that
 * works against their API works here without renaming.
 */
const CLIENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Told to the model in every client tool's description.
 *
 * A batch that mixes a client tool with a server tool still enters the tool
 * node (`toolsCondition` treats a turn as invoked only when *every* call on it
 * is), so the handoff cannot happen from such a batch. This asks the model for
 * the shape that can hand off; {@link createClientToolExecuteHandler} handles
 * the batch that arrives anyway.
 */
const SINGLE_CALL_NOTICE = 'Call this tool on its own: it must be the only tool call of its turn.';

/** A tool entry the caller will execute itself. */
function isFunctionTool(tool: Tool | undefined | null): tool is FunctionTool {
  return tool?.type === 'function';
}

/**
 * The names the request declares as caller-executed.
 *
 * Read at ingress, before any agent is loaded, so validation can tell a call
 * the caller owns from one the server does.
 */
export function declaredClientToolNames(tools: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(tools)) {
    return names;
  }
  for (const tool of tools) {
    if (isToolObject(tool) && isFunctionTool(tool) && typeof tool.name === 'string') {
      names.add(tool.name);
    }
  }
  return names;
}

/**
 * A declarable tool entry: an object carrying a non-empty string `type`.
 *
 * Checked so that a malformed entry is rejected at ingress rather than being
 * mistaken for a hosted tool and skipped.
 */
function isToolObject(value: unknown): value is Tool {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const { type } = value as { type?: unknown };
  return typeof type === 'string' && type !== '';
}

/**
 * Why the request's `tools` cannot be declared, or undefined when they can.
 *
 * Every entry must be an object with a string `type`. Only `type: 'function'`
 * entries are treated as client tools; the rest are hosted/provider tools that
 * the server owns, and are left alone so that adding a client tool to a request
 * cannot quietly disable them.
 */
export function validateClientTools(tools: unknown): string | undefined {
  if (tools === undefined) {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    return 'tools must be an array';
  }

  const names = new Set<string>();
  for (let i = 0; i < tools.length; i++) {
    const tool: unknown = tools[i];
    if (!isToolObject(tool)) {
      return `tools[${i}] must be an object with a string type`;
    }
    if (!isFunctionTool(tool)) {
      continue;
    }
    const { name, description, parameters } = tool;

    if (typeof name !== 'string' || name === '') {
      return 'each function tool requires a name';
    }
    if (!CLIENT_TOOL_NAME_PATTERN.test(name)) {
      return `function tool name may contain only letters, digits, underscores and hyphens: ${name}`;
    }
    if (names.has(name)) {
      return `duplicate function tool name: ${name}`;
    }
    /** OpenAI clients send `null` for an absent description or parameter schema. */
    if (description != null && typeof description !== 'string') {
      return `function tool description must be a string: ${name}`;
    }
    if (parameters != null && (typeof parameters !== 'object' || Array.isArray(parameters))) {
      return `function tool parameters must be a JSON Schema object: ${name}`;
    }
    if (tool.strict != null && typeof tool.strict !== 'boolean') {
      return `function tool strict must be a boolean: ${name}`;
    }
    names.add(name);
  }

  return undefined;
}

/**
 * The request's function tools as model-visible definitions, with no
 * server-side executor. Assumes {@link validateClientTools} already passed.
 *
 * The caller's description is carried as sent; {@link mergeClientToolDefinitions}
 * is what adds {@link SINGLE_CALL_NOTICE}, because only there is it known
 * whether the agent has a server tool to be batched with.
 */
export function buildClientToolDefinitions(tools: Tool[] | undefined | null): LCTool[] {
  if (tools == null) {
    return [];
  }
  return tools.filter(isFunctionTool).map(({ name, description, parameters }) => ({
    name,
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
    parameters: (parameters ?? EMPTY_PARAMETERS) as LCTool['parameters'],
    /** Callable by the model itself, and by nothing else. */
    allowed_callers: ['direct' as const],
  }));
}

/** The caller's description with the single-call instruction as its own sentence. */
function withSingleCallNotice(definition: LCTool): LCTool {
  const { description } = definition;
  return {
    ...definition,
    description:
      typeof description === 'string' && description !== ''
        ? `${description} ${SINGLE_CALL_NOTICE}`
        : SINGLE_CALL_NOTICE,
  };
}

/**
 * Appends the client tools to the run's model-visible definitions.
 *
 * A caller-declared name never displaces a server tool: on collision the
 * server's definition wins and the client's is dropped, and the dropped names
 * are reported so the request can be refused rather than left waiting for a
 * handoff that the surviving server tool will never produce.
 *
 * `serverDefinitions` must cover every agent in the run, not just the primary
 * one: the interception matches on tool name and marks calls in a graph-wide
 * set, so a name a subagent owns collides just as a primary one does.
 *
 * {@link SINGLE_CALL_NOTICE} is added only when the run actually has a server
 * tool. With none, every batch is client-only and hands off as issued, so the
 * caller's description reaches the model exactly as written.
 */
export function mergeClientToolDefinitions(
  agentDefinitions: LCTool[] | undefined,
  clientDefinitions: LCTool[],
  serverDefinitions: LCTool[] = agentDefinitions ?? [],
): { toolDefinitions: LCTool[]; names: Set<string>; shadowed: string[] } {
  const existing = agentDefinitions ?? [];
  if (clientDefinitions.length === 0) {
    return { toolDefinitions: existing, names: new Set<string>(), shadowed: [] };
  }

  const serverNames = new Set(serverDefinitions.map((definition) => definition.name));
  const annotate = serverNames.size > 0;
  const shadowed: string[] = [];
  const accepted: LCTool[] = [];
  const names = new Set<string>();

  for (const definition of clientDefinitions) {
    if (serverNames.has(definition.name)) {
      shadowed.push(definition.name);
      continue;
    }
    accepted.push(annotate ? withSingleCallNotice(definition) : definition);
    names.add(definition.name);
  }

  return { toolDefinitions: [...existing, ...accepted], names, shadowed };
}

export interface RunStepHandler {
  handle: (event: string, data: unknown, metadata?: unknown, graph?: StandardGraph) => void;
}

/**
 * Wraps the run-step handler so that a call to a caller-declared tool ends the
 * run instead of being executed on the server.
 *
 * The SDK routes a model turn to the tool node only while some tool call on the
 * message is *not* in `graph.invokedToolIds` (`toolsCondition`); once every call
 * is marked, the turn routes to END instead. That is exactly the semantics here
 * — the call was invoked, by the caller rather than by us — and it is why the
 * run stops with `status: 'completed'` rather than aborting or looping an error
 * result back to the model.
 *
 * Two orderings matter. The delegate records the call first, which is what puts
 * the `function_call` item into the response the caller receives. And the marks
 * must land before the agent node returns: they are written from `on_run_step`,
 * which the SDK dispatches while the model's tool calls are still streaming, so
 * they precede routing. That second ordering is the one part of the mechanism
 * unit tests cannot prove — it needs an integration test against the pinned SDK
 * build.
 *
 * `toolsCondition` marks a turn invoked only when *every* call on it is, so a
 * model that calls a client tool and a server tool in the same batch still
 * enters the tool node and cannot hand off from that turn.
 * {@link createClientToolExecuteHandler} answers the client call there with an
 * instruction to call it alone, which the next turn can hand off.
 */
export function createClientToolRunStepHandler({
  delegate,
  clientToolNames,
}: {
  delegate: RunStepHandler;
  clientToolNames: Set<string>;
}): RunStepHandler {
  if (clientToolNames.size === 0) {
    return delegate;
  }
  return {
    handle: (event, data, metadata, graph) => {
      delegate.handle(event, data, metadata, graph);
      if (graph == null) {
        return;
      }
      const stepData = data as {
        stepDetails?: { tool_calls?: Array<{ id?: string; name?: string }> };
      };
      const invoked = graph.invokedToolIds ?? new Set<string>();
      for (const toolCall of stepData?.stepDetails?.tool_calls ?? []) {
        if (
          toolCall?.id != null &&
          toolCall.id !== '' &&
          clientToolNames.has(toolCall.name ?? '')
        ) {
          invoked.add(toolCall.id);
        }
      }
      graph.invokedToolIds = invoked;
    },
  };
}

/**
 * What the model is told when it calls a client tool in a batch that also holds
 * a server tool.
 *
 * Returned as a successful tool result rather than an error: the call did not
 * execute, but nothing failed, and `status: 'error'` would reach the model
 * wrapped in the SDK's `Error: … Please fix your mistakes.` framing and count
 * as a tool failure. The wording asks for the one shape that can hand off.
 */
export function clientToolDeferralContent(name: string): string {
  return `"${name}" is executed by the caller, not by this server, so it cannot run in the same turn as another tool. Call "${name}" again as the only tool call of its turn.`;
}

export interface ToolExecuteHandler {
  handle: (event: string, data: ToolExecuteBatchRequest) => void | Promise<void>;
}

/**
 * Wraps the tool-execution handler so a caller-declared tool call that reached
 * the tool node is answered with {@link clientToolDeferralContent} instead of
 * the host's generic `Tool <name> not found`.
 *
 * Only a mixed batch gets here: a batch holding client calls alone is marked
 * invoked in `on_run_step` and routes to END, so the tool node never sees it.
 * The client-only branch below is therefore defensive, covering a batch that
 * reaches execution despite the marking.
 *
 * The batch's server calls go to the delegate untouched and their results are
 * merged with ours, because `resolve` is authoritative for the whole batch and
 * must carry a result for every call the SDK dispatched. Results are matched by
 * `toolCallId` rather than position, so the merge order does not matter.
 *
 * Deliberately uncapped: a model that keeps repeating the mixed batch is
 * already bounded by the run's `recursionLimit`, so a counter here would add
 * run state for a bound that exists. The warning is what makes the frequency
 * measurable if that assumption turns out to be wrong.
 */
export function createClientToolExecuteHandler({
  delegate,
  clientToolNames,
  responseId,
  onDeferred,
}: {
  delegate: ToolExecuteHandler;
  clientToolNames: Set<string>;
  responseId: string;
  /** Reports the answer given to a deferred call, so the run can show it was answered. */
  onDeferred?: (callId: string, output: string) => void;
}): ToolExecuteHandler {
  if (clientToolNames.size === 0) {
    return delegate;
  }

  return {
    handle: (event, data) => {
      const executable: ToolCallRequest[] = [];
      const results: ToolExecuteResult[] = [];
      const deferredNames: string[] = [];
      for (const toolCall of data.toolCalls) {
        if (!clientToolNames.has(toolCall.name)) {
          executable.push(toolCall);
          continue;
        }
        const content = clientToolDeferralContent(toolCall.name);
        results.push({
          toolCallId: toolCall.id,
          status: 'success',
          content,
        });
        deferredNames.push(toolCall.name);
        onDeferred?.(toolCall.id, content);
      }

      if (results.length === 0) {
        return delegate.handle(event, data);
      }

      logger.warn(
        `[Responses API] Request ${responseId} called caller-executed tool(s) alongside server tools, which cannot hand off; asked the model to call them alone: ${deferredNames.join(', ')}`,
      );
      for (const result of results) {
        data.onResult?.(result);
      }

      if (executable.length === 0) {
        data.resolve(results);
        return;
      }

      return delegate.handle(event, {
        ...data,
        toolCalls: executable,
        resolve: (executed: ToolExecuteResult[]): void => data.resolve([...executed, ...results]),
      });
    },
  };
}

/** Everything a run needs in order to honor the caller's function tools. */
export interface ClientToolHandoff {
  /** The agent's model-visible definitions with the accepted client tools appended. */
  toolDefinitions: LCTool[];
  /**
   * The caller's `function` entries that reached the model. Hosted entries the
   * server ignores are absent, and `strict` is dropped because the run has no
   * way to enforce it -- so echoing this on the response describes the tools
   * the run actually ran with rather than the request's ask.
   */
  appliedTools: FunctionTool[];
  /** Why the request's tools cannot be honored, or undefined when they can. */
  error?: string;
  /**
   * The names the model sees as caller-executed. The streaming lifecycle needs
   * them to recognize a call the server will never run, and so never close
   * through `on_tool_end`. Empty when the request declared none.
   */
  clientToolNames: ReadonlySet<string>;
  wrapRunStep: (delegate: RunStepHandler) => RunStepHandler;
  wrapToolExecute: (
    delegate: ToolExecuteHandler,
    onDeferred?: (callId: string, output: string) => void,
  ) => ToolExecuteHandler;
}

const identity = <T>(delegate: T): T => delegate;

/**
 * Assembles the client-tool handoff for one request: what the model sees, what
 * the response should report, and the two handler wrappers that hand a call
 * back to the caller.
 *
 * Built in one place so a request path only wires it in. A request that
 * declares no function tool gets the agent's definitions unchanged and identity
 * wrappers, so the common request pays nothing.
 *
 * Assumes {@link validateClientTools} already passed at ingress.
 */
export function createClientToolHandoff({
  tools,
  agentDefinitions,
  serverDefinitions,
  responseId,
}: {
  tools?: Tool[] | null;
  agentDefinitions?: LCTool[];
  /** Every agent's definitions, primary and subagents alike; defaults to the primary's. */
  serverDefinitions?: LCTool[];
  responseId: string;
}): ClientToolHandoff {
  const declared = buildClientToolDefinitions(tools);
  if (declared.length === 0) {
    return {
      toolDefinitions: agentDefinitions ?? [],
      appliedTools: [],
      clientToolNames: new Set<string>(),
      wrapRunStep: identity,
      wrapToolExecute: identity,
    };
  }

  const { toolDefinitions, names, shadowed } = mergeClientToolDefinitions(
    agentDefinitions,
    declared,
    serverDefinitions ?? agentDefinitions ?? [],
  );

  /* Refused rather than dropped with a warning: the server tool wins the name,
     so the caller would wait for a handoff that can never arrive. */
  if (shadowed.length > 0) {
    return {
      toolDefinitions: agentDefinitions ?? [],
      appliedTools: [],
      clientToolNames: new Set<string>(),
      wrapRunStep: identity,
      wrapToolExecute: identity,
      error:
        `function tool name is already provided by this agent: ${shadowed.join(', ')}; ` +
        'rename the tool or remove it from the request',
    };
  }

  return {
    toolDefinitions,
    appliedTools: (tools ?? [])
      .filter((tool): tool is FunctionTool => isFunctionTool(tool) && names.has(tool.name))
      .map(({ strict: _strict, ...applied }) => applied),
    clientToolNames: names,
    wrapRunStep: (delegate) => createClientToolRunStepHandler({ delegate, clientToolNames: names }),
    wrapToolExecute: (delegate, onDeferred) =>
      createClientToolExecuteHandler({ delegate, clientToolNames: names, responseId, onDeferred }),
  };
}
