import type { TMessageContentParts, ContentMetadata, TextData, Text } from './types/content';
import type { TMessage, TAttachment } from './schemas';
import type { Agents } from './types/agents';
import type { TFile } from './types/files';
import { ContentTypes, ToolCallTypes } from './types/runs';
import { isToolErrorOutput } from './errors';
import { Tools } from './types/tools';

/**
 * A UI parts view of LibreChat message content, modelled on the AI SDK `UIMessage`.
 *
 * Matched against `ai@7.0.114` (`UIMessage`, `UIMessagePart`, `UIToolInvocation`) and
 * `@ai-sdk/react@4.0.117` (`useChat`). The shapes are structural copies, not imports: this
 * package does not depend on the AI SDK.
 *
 * Position invariant: `toUIParts(content)[i]` is the part for `content[i]`, holes included, so an
 * index-derived identity (the step index the stream reducers write to) survives the mapping.
 * A hole becomes a `step-start` part and maps back to a hole. Parts that have no content slot
 * (message files, web search sources) are appended after the last content part.
 */

/** Stream-only text chunk; never persisted, but it can appear in a message being built. */
export type TextDeltaContentPart = {
  type: ContentTypes.TEXT_DELTA;
  text?: string | TextData;
  text_delta?: string | TextData;
} & ContentMetadata;

/** Every content part the mapping accepts. */
export type MappableContentPart = TMessageContentParts | TextDeltaContentPart;

type ContentPartOf<T extends ContentTypes> = Extract<MappableContentPart, { type: T }>;
type ToolCallContentPart = ContentPartOf<ContentTypes.TOOL_CALL>;
type ToolCallValue = ToolCallContentPart['tool_call'];

/** AI SDK `providerMetadata`, keyed by provider; LibreChat keeps its own fields under one key. */
export type LibreChatProviderMetadata<T> = { librechat: T };

/** Fields of a `TextData` object other than its value, kept so the object form round-trips. */
type TextObjectFields = Omit<NonNullable<TextData>, 'value'>;

/** How the stored text field was shaped, so the reverse mapping restores that shape. */
type TextShape = {
  textObject?: TextObjectFields;
  /** The stored part had no text field at all, which is not the same as an empty string. */
  textAbsent?: true;
  /** The value the stored annotations index into; an edit away from it drops them. */
  annotatedValue?: string;
};

export type UITextPartMetadata = Omit<ContentPartOf<ContentTypes.TEXT>, 'type' | 'text'> &
  TextShape;

/** The `<think>` wrapper persisted reasoning carries, exactly as stored, so it can be restored. */
type ThinkWrapper = { thinkOpen?: string; thinkClose?: string };

export type UIReasoningPartMetadata = Omit<ContentPartOf<ContentTypes.THINK>, 'type' | 'think'> &
  TextShape &
  ThinkWrapper;

/** AI SDK `TextUIPart`. */
export type UITextPart = {
  type: 'text';
  text: string;
  state?: 'streaming' | 'done';
  providerMetadata?: LibreChatProviderMetadata<UITextPartMetadata>;
};

/** AI SDK `ReasoningUIPart`. */
export type UIReasoningPart = {
  type: 'reasoning';
  text: string;
  state?: 'streaming' | 'done';
  providerMetadata?: LibreChatProviderMetadata<UIReasoningPartMetadata>;
};

/** The content part a `file` UI part was mapped from, when it came from content. */
export type UIFilePartMetadata =
  | ({ source: ContentTypes.IMAGE_FILE } & Omit<ContentPartOf<ContentTypes.IMAGE_FILE>, 'type'>)
  | ({ source: ContentTypes.IMAGE_URL; urlObject: boolean } & Omit<
      ContentPartOf<ContentTypes.IMAGE_URL>,
      'type' | 'image_url'
    > & { detail?: Agents.ImageDetail })
  | ({ source: ContentTypes.VIDEO_URL } & Omit<
      ContentPartOf<ContentTypes.VIDEO_URL>,
      'type' | 'video_url'
    >)
  | ({ source: ContentTypes.INPUT_AUDIO; format: string } & Omit<
      ContentPartOf<ContentTypes.INPUT_AUDIO>,
      'type' | 'input_audio'
    >)
  /**
   * A `message.files` entry: `index` is its position in the stored array and `filepath` the path
   * it was viewed with, together its identity across edits even when two entries share a path.
   */
  | { source: 'attachment'; filepath: string; index: number };

/**
 * AI SDK `FileUIPart`. A part from a content slot names its content type as `source`; one with
 * `source: 'attachment'`, or no metadata at all (built by hand), is a message attachment.
 */
export type UIFilePart = {
  type: 'file';
  mediaType: string;
  filename?: string;
  url: string;
  providerMetadata?: LibreChatProviderMetadata<UIFilePartMetadata>;
};

/** AI SDK `SourceUrlUIPart`; built from web search attachments. */
export type UISourceUrlPart = {
  type: 'source-url';
  sourceId: string;
  url: string;
  title?: string;
};

/** AI SDK `StepStartUIPart`; stands in for a content slot no step has written yet. */
export type UIStepStartPart = { type: 'step-start' };

/** The subset of AI SDK tool states LibreChat content can express. */
export type UIToolState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'output-available'
  | 'output-error';

/** AI SDK tool `approval`, for a call paused for human review. */
export type UIToolApproval = { id: string; requestReason?: string };

export type UIToolInput = Agents.ToolCall['args'] | object;
export type UIToolOutput = string | CodeInterpreterOutputs;
type CodeInterpreterOutputs = Extract<
  ToolCallValue,
  { type: 'code_interpreter' }
>['code_interpreter']['outputs'];

export type UIToolPartMetadata = Omit<ToolCallContentPart, 'type' | 'tool_call'> & {
  /** The call as stored, so the reverse mapping restores fields the UI part does not carry. */
  toolCall: ToolCallValue;
};

/**
 * AI SDK `ToolUIPart`: `tool-<name>` with a lifecycle `state`. Cancelled, failed, rejected and
 * background-cancelled calls all surface as `output-error`; the exact marker stays on the stored
 * call. A call paused for human review is `approval-requested`.
 */
export type UIToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  state: UIToolState;
  input?: UIToolInput;
  output?: UIToolOutput;
  errorText?: string;
  approval?: UIToolApproval;
  callProviderMetadata?: LibreChatProviderMetadata<UIToolPartMetadata>;
};

type DataOf<T extends ContentTypes> = Omit<ContentPartOf<T>, 'type'>;

/** AI SDK `DataUIPart`: LibreChat parts with no AI SDK counterpart, carried whole. */
export type UIDataPart =
  | { type: 'data-agent-update'; data: DataOf<ContentTypes.AGENT_UPDATE> }
  | { type: 'data-summary'; data: DataOf<ContentTypes.SUMMARY> }
  | { type: 'data-activity-label'; data: DataOf<ContentTypes.ACTIVITY_LABEL> }
  | { type: 'data-steer'; data: DataOf<ContentTypes.STEER> }
  | { type: 'data-error'; data: DataOf<ContentTypes.ERROR> };

/** AI SDK `UIMessagePart`, narrowed to what LibreChat content produces. */
export type UIMessagePart =
  | UITextPart
  | UIReasoningPart
  | UIToolPart
  | UIFilePart
  | UISourceUrlPart
  | UIStepStartPart
  | UIDataPart;

/** What a `TMessage` carries that `UIMessage` has no field for. */
export type UIMessageMetadata = Pick<
  TMessage,
  | 'conversationId'
  | 'parentMessageId'
  | 'sender'
  | 'model'
  | 'endpoint'
  | 'error'
  | 'unfinished'
  | 'createdAt'
> & {
  /** Set when the message had no `content`, so its parts were built from `text` and `files`. */
  contentless?: boolean;
  /**
   * The stored `text` of a content-bearing message, present only when it differs from the text
   * parts joined, so a rebuild without a stored base keeps it.
   */
  text?: string;
  /** Set when a contentless message stored `content: []` rather than no `content` at all. */
  emptyContent?: true;
  /** The stored attachments, carried whole so a rebuild without a stored base keeps them. */
  attachments?: TAttachment[];
  /** Agents that produced parts of this message, in order of first appearance. */
  agentIds?: string[];
  /** Parallel content groups present in this message, in order of first appearance. */
  groupIds?: number[];
  activityLabels?: DataOf<ContentTypes.ACTIVITY_LABEL>[];
  steers?: DataOf<ContentTypes.STEER>[];
  summaries?: DataOf<ContentTypes.SUMMARY>[];
};

/**
 * AI SDK `UIMessage`. `role` omits the AI SDK's `system`: a `TMessage` is either created by the
 * user or not, so a system role could not survive the reverse mapping.
 */
export type UIMessage = {
  id: string;
  role: 'user' | 'assistant';
  metadata?: UIMessageMetadata;
  parts: UIMessagePart[];
};

type DataPartType = UIDataPart['type'];

const dataPartTypes = {
  [ContentTypes.AGENT_UPDATE]: 'data-agent-update',
  [ContentTypes.SUMMARY]: 'data-summary',
  [ContentTypes.ACTIVITY_LABEL]: 'data-activity-label',
  [ContentTypes.STEER]: 'data-steer',
  [ContentTypes.ERROR]: 'data-error',
} as const satisfies Partial<Record<ContentTypes, DataPartType>>;

const contentTypesByDataPart: Record<DataPartType, keyof typeof dataPartTypes> = {
  'data-agent-update': ContentTypes.AGENT_UPDATE,
  'data-summary': ContentTypes.SUMMARY,
  'data-activity-label': ContentTypes.ACTIVITY_LABEL,
  'data-steer': ContentTypes.STEER,
  'data-error': ContentTypes.ERROR,
};

const stepStart: UIStepStartPart = { type: 'step-start' };

export const isUIToolPart = (part: UIMessagePart): part is UIToolPart =>
  part.type.startsWith('tool-');

export const isUIDataPart = (part: UIMessagePart): part is UIDataPart =>
  part.type.startsWith('data-');

const hasKeys = (value: object) => Object.keys(value).length > 0;

const withLibreChatMetadata = <P extends object, M extends object>(part: P, metadata: M) =>
  hasKeys(metadata) ? { ...part, providerMetadata: { librechat: metadata } } : part;

const splitText = (text: string | TextData | undefined): { value: string } & TextShape => {
  if (text === undefined) {
    return { value: '', textAbsent: true };
  }
  if (text == null || typeof text === 'string') {
    return { value: text ?? '' };
  }
  const { value, ...textObject } = text;
  const stored = value ?? '';
  return {
    value: stored,
    textObject,
    ...((textObject.annotations?.length ?? 0) > 0 && { annotatedValue: stored }),
  };
};

/** Restores the stored text field; `undefined` means the field is left off the part. */
const joinText = (value: string, shape: TextShape): string | Text | undefined => {
  if (shape.textAbsent && value === '') {
    return undefined;
  }
  if (!shape.textObject) {
    return value;
  }
  if (shape.annotatedValue !== undefined && value !== shape.annotatedValue) {
    const { annotations: _stale, ...textObject } = shape.textObject;
    return { ...textObject, value };
  }
  return { ...shape.textObject, value };
};

const thinkOpenPattern = /^\s*<think>\s*/;
const thinkClosePattern = /\s*<\/think>\s*$/;

/**
 * Persisted reasoning is stored inside `<think>` tags, which every renderer strips; the view
 * exposes the reasoning alone and keeps the exact wrapper for the reverse mapping.
 */
const splitThinkTags = (value: string): { value: string } & ThinkWrapper => {
  const open = value.match(thinkOpenPattern)?.[0];
  const inner = open ? value.slice(open.length) : value;
  const close = inner.match(thinkClosePattern)?.[0];
  return {
    value: close ? inner.slice(0, inner.length - close.length) : inner,
    ...(open && { thinkOpen: open }),
    ...(close && { thinkClose: close }),
  };
};

const toTextMetadata = <M extends object>(rest: M, shape: TextShape) => ({
  ...rest,
  ...(shape.textObject && { textObject: shape.textObject }),
  ...(shape.textAbsent && { textAbsent: shape.textAbsent }),
  ...(shape.annotatedValue !== undefined && { annotatedValue: shape.annotatedValue }),
});

const parseToolInput = (args: UIToolInput | undefined) => {
  if (typeof args !== 'string') {
    return { input: args, complete: args != null };
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return {
      input: typeof parsed === 'object' && parsed !== null ? (parsed as object) : args,
      complete: true,
    };
  } catch {
    return { input: args, complete: false };
  }
};

type ToolCallFields = {
  name: string;
  id?: string;
  args?: UIToolInput;
  output?: UIToolOutput;
  /** Whether the call's output was submitted, by that variant's own sentinel. */
  submitted: boolean;
};

const readToolCall = (toolCall: ToolCallValue): ToolCallFields => {
  switch (toolCall.type) {
    case 'function':
      return {
        name: toolCall.function.name,
        id: toolCall.id || undefined,
        args: toolCall.function.arguments,
        output: toolCall.function.output ?? undefined,
        submitted: toolCall.function.output != null,
      };
    case 'code_interpreter':
      return {
        name: toolCall.type,
        id: toolCall.id || undefined,
        args: toolCall.code_interpreter.input,
        output: toolCall.code_interpreter.outputs,
        submitted: toolCall.code_interpreter.outputs.length > 0,
      };
    case 'retrieval':
    case 'file_search': {
      const output =
        'output' in toolCall && typeof toolCall.output === 'string' ? toolCall.output : undefined;
      return { name: toolCall.type, id: toolCall.id || undefined, output, submitted: !!output };
    }
    default:
      return {
        name: toolCall.name,
        id: toolCall.id || toolCall.stepId || undefined,
        args: toolCall.args,
        output: toolCall.output,
        submitted: toolCall.output != null && toolCall.output !== '',
      };
  }
};

/**
 * The failure a stored call records, if any: a failed or cancelled run step, an output the tool
 * renderers read as an error, a cancelled background task, or arguments rejected by validation.
 */
/**
 * Options for the forward mapping. Some tool outcomes are decided by knowledge this package does
 * not hold, such as a memory tool's failure prose or a background task's status attachment; the
 * caller that owns those rules supplies them here rather than the mapping copying them.
 */
export type UIMappingOptions = {
  /**
   * Returns a failure reason for a tool call the stored markers leave successful, or `undefined`.
   * The reason becomes the part's `errorText`, since the stored output (a background dispatch
   * handle, prose that reads as success) is not what established the failure; return the output
   * itself when it is the message to show. It receives the stored call; `toUIMessage` also passes
   * the message, for its attachments.
   */
  resolveToolFailure?: (toolCall: ToolCallValue, message?: TMessage) => string | undefined;
};

type MappingContext = UIMappingOptions & { message?: TMessage };

/**
 * `detail` says whether the stored output describes the failure (a failed step's partial output, an
 * error the tool returned); when it does not, as with a cancelled background task whose output is
 * the benign dispatch handle, the view reports the reason instead.
 */
type ToolFailure = { reason: string; detail: boolean };

const getToolFailure = (
  toolCall: ToolCallValue,
  output?: UIToolOutput,
): ToolFailure | undefined => {
  const { runStepStatus } = toolCall;
  if (runStepStatus === 'failed' || runStepStatus === 'cancelled') {
    return { reason: runStepStatus, detail: true };
  }
  if (typeof output === 'string' && isToolErrorOutput(output)) {
    return { reason: 'failed', detail: true };
  }
  if (!('name' in toolCall)) {
    return undefined;
  }
  if (toolCall.backgroundTask?.cancelled) {
    return { reason: 'cancelled', detail: false };
  }
  return toolCall.inputValidationError
    ? { reason: 'input-validation-error', detail: true }
    : undefined;
};

/** A caller-resolved failure is known from outside the output, so its reason is what the view shows. */
const resolveFailure = (
  toolCall: ToolCallValue,
  output: UIToolOutput | undefined,
  context?: MappingContext,
): ToolFailure | undefined => {
  const stored = getToolFailure(toolCall, output);
  if (stored) {
    return stored;
  }
  const reason = context?.resolveToolFailure?.(toolCall, context.message);
  return reason ? { reason, detail: false } : undefined;
};

const getToolApproval = (toolCall: ToolCallValue): UIToolApproval | undefined => {
  if (!('name' in toolCall) || !toolCall.approval) {
    return undefined;
  }
  const { actionId, description } = toolCall.approval;
  return { id: actionId, ...(description && { requestReason: description }) };
};

const toToolPart = (
  part: ToolCallContentPart,
  index: number,
  context?: MappingContext,
): UIToolPart => {
  const { tool_call: toolCall, type: _type, ...partMetadata } = part;
  const { name, id, args, output, submitted } = readToolCall(toolCall);
  const { input, complete } = parseToolInput(args);
  const { runStepStatus, progress } = toolCall;
  const failure = resolveFailure(toolCall, output, context);
  const approval = submitted ? undefined : getToolApproval(toolCall);

  let state: UIToolState = complete ? 'input-available' : 'input-streaming';
  if (failure) {
    state = 'output-error';
  } else if (submitted || runStepStatus === 'completed' || (progress ?? 0) >= 1) {
    state = 'output-available';
  } else if (approval) {
    state = 'approval-requested';
  }

  return {
    type: `tool-${name}`,
    toolCallId: id || `${ContentTypes.TOOL_CALL}-${part.streamedIndex ?? index}`,
    state,
    ...(input !== undefined && { input }),
    ...(state === 'output-available' && output !== undefined && { output }),
    ...(state === 'output-error' && {
      errorText: failure?.detail && typeof output === 'string' && output ? output : failure?.reason,
    }),
    ...(state === 'approval-requested' && { approval }),
    callProviderMetadata: { librechat: { ...partMetadata, toolCall } },
  };
};

const toDataPart = (part: ContentPartOf<keyof typeof dataPartTypes>): UIDataPart => {
  const { type, ...data } = part;
  return { type: dataPartTypes[type], data } as UIDataPart;
};

/**
 * Maps one content part to its UI part. A missing part (a hole in a streamed array) maps to
 * `step-start`, so indexes line up with the content array. So does a slot with no known type,
 * such as the `type: ''` lane placeholder a dual-conversation turn seeds, and a tool call slot
 * whose call has not arrived yet: persistence compacts those away, and the reverse mapping leaves
 * a hole in their place the same way.
 */
export function toUIPart(
  part: MappableContentPart | null | undefined,
  index = 0,
  options?: UIMappingOptions,
): UIMessagePart {
  if (part == null) {
    return stepStart;
  }
  switch (part.type) {
    case ContentTypes.TEXT: {
      const { type: _type, text, ...rest } = part;
      const { value, ...shape } = splitText(text);
      return withLibreChatMetadata(
        { type: 'text', text: value } satisfies UITextPart,
        toTextMetadata(rest, shape),
      );
    }
    case ContentTypes.TEXT_DELTA: {
      const { type: _type, text, text_delta: textDelta, ...rest } = part;
      const { value, ...shape } = splitText(textDelta ?? text);
      return withLibreChatMetadata(
        { type: 'text', text: value, state: 'streaming' } satisfies UITextPart,
        toTextMetadata(rest, shape),
      );
    }
    case ContentTypes.THINK: {
      const { type: _type, think, ...rest } = part;
      const { value: raw, ...shape } = splitText(think);
      const { value, ...wrapper } = splitThinkTags(raw);
      return withLibreChatMetadata({ type: 'reasoning', text: value } satisfies UIReasoningPart, {
        ...toTextMetadata(rest, shape),
        ...wrapper,
      });
    }
    case ContentTypes.TOOL_CALL:
      return part.tool_call == null ? stepStart : toToolPart(part, index, options);
    case ContentTypes.IMAGE_FILE: {
      const { type: _type, ...rest } = part;
      const { image_file: imageFile } = rest;
      return {
        type: 'file',
        mediaType: imageFile.type || 'image/*',
        filename: imageFile.filename,
        url: imageFile.filepath,
        providerMetadata: { librechat: { source: ContentTypes.IMAGE_FILE, ...rest } },
      };
    }
    case ContentTypes.IMAGE_URL: {
      const { type: _type, image_url: imageUrl, ...rest } = part;
      const urlObject = typeof imageUrl !== 'string';
      const detail = urlObject ? imageUrl.detail : undefined;
      return {
        type: 'file',
        mediaType: 'image/*',
        url: urlObject ? imageUrl.url : imageUrl,
        providerMetadata: {
          librechat: {
            source: ContentTypes.IMAGE_URL,
            urlObject,
            ...(detail !== undefined && { detail }),
            ...rest,
          },
        },
      };
    }
    case ContentTypes.VIDEO_URL: {
      const { type: _type, video_url: videoUrl, ...rest } = part;
      return {
        type: 'file',
        mediaType: 'video/*',
        url: videoUrl.url,
        providerMetadata: { librechat: { source: ContentTypes.VIDEO_URL, ...rest } },
      };
    }
    case ContentTypes.INPUT_AUDIO: {
      const { type: _type, input_audio: audio, ...rest } = part;
      return {
        type: 'file',
        mediaType: `audio/${audio.format}`,
        url: `data:audio/${audio.format};base64,${audio.data}`,
        providerMetadata: {
          librechat: { source: ContentTypes.INPUT_AUDIO, format: audio.format, ...rest },
        },
      };
    }
    case ContentTypes.AGENT_UPDATE:
    case ContentTypes.SUMMARY:
    case ContentTypes.ACTIVITY_LABEL:
    case ContentTypes.STEER:
    case ContentTypes.ERROR:
      return toDataPart(part);
  }
  return stepStart;
}

/** Maps a content array to UI parts, one per slot, holes included. */
export function toUIParts(
  content: ReadonlyArray<MappableContentPart | null | undefined>,
  options?: UIMappingOptions,
) {
  const parts: UIMessagePart[] = new Array(content.length);
  for (let i = 0; i < content.length; i++) {
    parts[i] = toUIPart(content[i], i, options);
  }
  return parts;
}

/**
 * Writes the view's `url`, `filename` and `mediaType` onto a stored file record where they differ
 * from what the forward mapping derived, so an edit lands and an untouched part round-trips.
 */
const applyFileEdits = <F extends Partial<TFile>>(
  file: F,
  part: UIFilePart,
  fallbackType: string,
) => {
  const edited = { ...file };
  if (part.url !== file.filepath) {
    edited.filepath = part.url;
  }
  if (part.filename !== undefined && part.filename !== file.filename) {
    edited.filename = part.filename;
  }
  if (part.mediaType !== (file.type || fallbackType)) {
    edited.type = part.mediaType;
  }
  return edited;
};

const fromFilePart = (
  part: UIFilePart,
  metadata: UIFilePartMetadata,
): TMessageContentParts | undefined => {
  switch (metadata.source) {
    case 'attachment':
      return undefined;
    case ContentTypes.IMAGE_FILE: {
      const { source: _source, image_file: imageFile, ...rest } = metadata;
      return {
        type: ContentTypes.IMAGE_FILE,
        image_file: applyFileEdits(imageFile, part, 'image/*'),
        ...rest,
      };
    }
    case ContentTypes.IMAGE_URL: {
      const { source: _source, urlObject, detail, ...rest } = metadata;
      const url = part.url;
      const imageUrl = urlObject ? { url, ...(detail !== undefined && { detail }) } : url;
      return { type: ContentTypes.IMAGE_URL, image_url: imageUrl, ...rest };
    }
    case ContentTypes.VIDEO_URL: {
      const { source: _source, ...rest } = metadata;
      return { type: ContentTypes.VIDEO_URL, video_url: { url: part.url }, ...rest };
    }
    case ContentTypes.INPUT_AUDIO: {
      const { source: _source, format: storedFormat, ...rest } = metadata;
      const data = part.url.slice(part.url.indexOf(',') + 1);
      const format = part.mediaType.startsWith('audio/')
        ? part.mediaType.slice('audio/'.length)
        : storedFormat;
      return { type: ContentTypes.INPUT_AUDIO, input_audio: { data, format }, ...rest };
    }
  }
};

const fromToolPart = (part: UIToolPart): TMessageContentParts => {
  const stored = part.callProviderMetadata?.librechat;
  if (stored) {
    const { toolCall, ...partMetadata } = stored;
    return { type: ContentTypes.TOOL_CALL, tool_call: toolCall, ...partMetadata };
  }
  const name = part.type.slice('tool-'.length);
  if (Array.isArray(part.output)) {
    return {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        type: ToolCallTypes.CODE_INTERPRETER,
        id: part.toolCallId,
        code_interpreter: {
          input: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? ''),
          outputs: part.output,
        },
        ...(part.state === 'output-error' && { runStepStatus: 'failed' as const }),
        ...(part.state === 'output-available' && { runStepStatus: 'completed' as const }),
      },
    };
  }
  const output = typeof part.output === 'string' ? part.output : part.errorText;
  return {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      type: ToolCallTypes.TOOL_CALL,
      name,
      id: part.toolCallId,
      ...(part.input !== undefined && {
        args: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
      }),
      ...(output !== undefined && { output }),
      ...(part.state === 'output-error' && { runStepStatus: 'failed' as const }),
      ...(part.state === 'output-available' && { runStepStatus: 'completed' as const }),
      ...(part.approval && {
        approval: {
          actionId: part.approval.id,
          allowed_decisions: [],
          ...(part.approval.requestReason && { description: part.approval.requestReason }),
        },
      }),
    },
  };
};

/**
 * Maps a UI part back to content. Returns `undefined` for parts with no content slot:
 * `step-start` (a hole), `source-url`, and `file` parts that are message attachments.
 *
 * Lossless for every part `toUIPart` produced except `text_delta`, which comes back as `text`.
 * A tool part restores the stored call as it was, so edits to `input`/`output` on a mapped
 * tool part are not written back; a tool part built by hand becomes an agents tool call.
 */
export function fromUIPart(part: UIMessagePart): TMessageContentParts | undefined {
  switch (part.type) {
    case 'text': {
      const { textObject, textAbsent, annotatedValue, ...rest } =
        part.providerMetadata?.librechat ?? {};
      const text = joinText(part.text, { textObject, textAbsent, annotatedValue });
      return { type: ContentTypes.TEXT, ...(text !== undefined && { text }), ...rest };
    }
    case 'reasoning': {
      const { textObject, textAbsent, annotatedValue, thinkOpen, thinkClose, ...rest } =
        part.providerMetadata?.librechat ?? {};
      const wrapped = `${thinkOpen ?? ''}${part.text}${thinkClose ?? ''}`;
      const think = joinText(wrapped, { textObject, textAbsent, annotatedValue });
      return { type: ContentTypes.THINK, ...(think !== undefined && { think }), ...rest };
    }
    case 'file':
      return part.providerMetadata
        ? fromFilePart(part, part.providerMetadata.librechat)
        : undefined;
    case 'step-start':
    case 'source-url':
      return undefined;
  }
  if (isUIDataPart(part)) {
    return { type: contentTypesByDataPart[part.type], ...part.data } as TMessageContentParts;
  }
  return fromToolPart(part);
}

/**
 * Collects content in slot order: a mapped part takes the next slot and `step-start` holds one
 * open as a hole, while parts with no content slot (sources, attachments) take none, so their
 * position in the view never shifts a step's index.
 */
const createContentWriter = () => {
  const content: TMessageContentParts[] = [];
  let slot = 0;
  const write = (part: UIMessagePart) => {
    const mapped = fromUIPart(part);
    if (mapped) {
      content[slot++] = mapped;
    } else if (part.type === 'step-start') {
      slot++;
      content.length = slot;
    }
  };
  return { content, write };
};

/** Maps UI parts back to a content array; `step-start` parts become holes again. */
export function fromUIParts(parts: ReadonlyArray<UIMessagePart>): TMessageContentParts[] {
  const writer = createContentWriter();
  for (const part of parts) {
    writer.write(part);
  }
  return writer.content;
}

/** A `file` part that stands for a `message.files` entry rather than a content slot. */
const isAttachmentPart = (part: UIMessagePart): part is UIFilePart =>
  part.type === 'file' &&
  (!part.providerMetadata || part.providerMetadata.librechat.source === 'attachment');

const toAttachmentFilePart = (file: Partial<TFile>, index: number): UIFilePart | undefined => {
  if (!file.filepath) {
    return undefined;
  }
  return {
    type: 'file',
    mediaType: file.type || 'application/octet-stream',
    ...(file.filename && { filename: file.filename }),
    url: file.filepath,
    providerMetadata: { librechat: { source: 'attachment', filepath: file.filepath, index } },
  };
};

type SourceLink = { link: string; title?: string };

/** The linkable results of a web search: organic, top stories, and plain link references. */
const getSourceLinks = (attachment: TAttachment): SourceLink[] => {
  const results = attachment[Tools.web_search];
  if (!results) {
    return [];
  }
  const links: SourceLink[] = [...(results.organic ?? []), ...(results.topStories ?? [])];
  for (const reference of results.references ?? []) {
    if (reference.type === 'link') {
      links.push(reference);
    }
  }
  return links;
};

/**
 * Appends one `source-url` part per distinct URL across every search attachment. The id carries a
 * message-wide ordinal, since provider tool-call ids repeat across agents and turns.
 */
const pushSourceParts = (parts: UIMessagePart[], attachments: TAttachment[] | undefined) => {
  const seen = new Set<string>();
  for (const attachment of attachments ?? []) {
    for (const source of getSourceLinks(attachment)) {
      if (seen.has(source.link)) {
        continue;
      }
      seen.add(source.link);
      parts.push({
        type: 'source-url',
        sourceId: `${attachment.toolCallId}-${seen.size - 1}`,
        url: source.link,
        ...(source.title && { title: source.title }),
      });
    }
  }
};

const pushUnique = <T>(seen: Set<T>, value: T | undefined) => {
  if (value !== undefined) {
    seen.add(value);
  }
};

/**
 * A `UIMessage` view of a `TMessage`: content parts in content order, then attachment files,
 * then web search sources. A message without `content` gets one text part from `text`.
 * One pass over the content builds both the parts and the metadata.
 */
export function toUIMessage(message: TMessage, options?: UIMappingOptions): UIMessage {
  const context: MappingContext = { ...options, message };
  const content = message.content;
  const parts: UIMessagePart[] = [];
  const agentIds = new Set<string>();
  const groupIds = new Set<number>();
  const activityLabels: UIMessageMetadata['activityLabels'] = [];
  const steers: UIMessageMetadata['steers'] = [];
  const summaries: UIMessageMetadata['summaries'] = [];

  const contentless = !content || (content.length === 0 && (message.text?.length ?? 0) > 0);
  let joinedText = '';

  if (content && !contentless) {
    for (let i = 0; i < content.length; i++) {
      const part = content[i] as MappableContentPart | undefined;
      const uiPart = toUIPart(part, i, context);
      parts.push(uiPart);
      if (part == null) {
        continue;
      }
      pushUnique(
        agentIds,
        part.agentId ??
          (part.type === ContentTypes.TOOL_CALL ? part.tool_call?.agentId : undefined),
      );
      pushUnique(groupIds, part.groupId);
      if (uiPart.type === 'text') {
        joinedText += uiPart.text;
      } else if (uiPart.type === 'data-agent-update') {
        pushUnique(agentIds, uiPart.data.agent_update.agentId);
      } else if (uiPart.type === 'data-activity-label') {
        activityLabels.push(uiPart.data);
      } else if (uiPart.type === 'data-steer') {
        steers.push(uiPart.data);
      } else if (uiPart.type === 'data-summary') {
        summaries.push(uiPart.data);
      }
    }
  } else {
    parts.push({ type: 'text', text: message.text ?? '' });
  }

  const files = message.files ?? [];
  for (let i = 0; i < files.length; i++) {
    const filePart = toAttachmentFilePart(files[i], i);
    if (filePart) {
      parts.push(filePart);
    }
  }
  pushSourceParts(parts, message.attachments);

  const metadata: UIMessageMetadata = {
    conversationId: message.conversationId,
    parentMessageId: message.parentMessageId,
    ...(message.sender !== undefined && { sender: message.sender }),
    ...(message.model !== undefined && { model: message.model }),
    ...(message.endpoint !== undefined && { endpoint: message.endpoint }),
    ...(message.error !== undefined && { error: message.error }),
    ...(message.unfinished !== undefined && { unfinished: message.unfinished }),
    ...(message.createdAt !== undefined && { createdAt: message.createdAt }),
    ...(contentless && { contentless: true }),
    ...(contentless && content && { emptyContent: true }),
    ...(message.attachments !== undefined && { attachments: message.attachments }),
    ...(!contentless &&
      message.text !== undefined &&
      message.text !== joinedText && { text: message.text }),
    ...(agentIds.size > 0 && { agentIds: Array.from(agentIds) }),
    ...(groupIds.size > 0 && { groupIds: Array.from(groupIds) }),
    ...(activityLabels.length > 0 && { activityLabels }),
    ...(steers.length > 0 && { steers }),
    ...(summaries.length > 0 && { summaries }),
  };

  return {
    id: message.messageId,
    role: message.isCreatedByUser ? 'user' : 'assistant',
    metadata,
    parts,
  };
}

const messageFields = ['sender', 'model', 'endpoint', 'error', 'unfinished', 'createdAt'] as const;

const pickMessageFields = (metadata: UIMessageMetadata | undefined) => {
  const fields: Partial<Pick<TMessage, (typeof messageFields)[number]>> = {};
  if (!metadata) {
    return fields;
  }
  for (const key of messageFields) {
    if (metadata[key] !== undefined) {
      Object.assign(fields, { [key]: metadata[key] });
    }
  }
  return fields;
};

const joinPartText = (parts: ReadonlyArray<UIMessagePart | undefined>) => {
  let text = '';
  for (const part of parts) {
    if (part?.type === 'text') {
      text += part.text;
    }
  }
  return text;
};

/**
 * `TMessage.text` of a content-bearing message is not derived from its parts, so the stored text
 * is kept unless the text parts changed, in which case the view's text wins. Without a base the
 * stored text travels in `metadata.text`.
 */
const resolveText = (text: string, metadata: UIMessageMetadata | undefined, base?: TMessage) => {
  if (metadata?.contentless) {
    return text;
  }
  if (base?.text === undefined) {
    return metadata?.text ?? text;
  }
  const baseText = joinPartText((base.content ?? []).map((part) => toUIPart(part)));
  return text === baseText ? base.text : text;
};

/**
 * Attachment `file` parts describe `message.files`: each is matched to its stored entry by the
 * position and path it was viewed with (so an edited `url` still finds it, and entries sharing a
 * path stay distinct), the view's edits are applied, parts built by hand become new entries, and stored entries the view never showed keep their slots
 * while the visible entries fill the others in view order.
 */
const reconcileFiles = (
  attachments: ReadonlyArray<UIFilePart>,
  baseFiles: TMessage['files'],
): TMessage['files'] => {
  if (!baseFiles && attachments.length === 0) {
    return undefined;
  }
  const claimed = new Set<Partial<TFile>>();
  /** A viewed part names its stored entry; a hand-built one takes the first unclaimed match. */
  const findStored = (part: UIFilePart) => {
    const metadata = part.providerMetadata?.librechat;
    if (metadata?.source === 'attachment') {
      const candidate = baseFiles?.[metadata.index];
      return candidate?.filepath === metadata.filepath ? candidate : undefined;
    }
    return baseFiles?.find((file) => file.filepath === part.url && !claimed.has(file));
  };
  const visible = attachments.map((part) => {
    const stored = findStored(part);
    if (stored) {
      claimed.add(stored);
      return applyFileEdits(stored, part, 'application/octet-stream');
    }
    return {
      filepath: part.url,
      ...(part.filename && { filename: part.filename }),
      type: part.mediaType,
    };
  });
  const files: Partial<TFile>[] = [];
  let next = 0;
  for (const file of baseFiles ?? []) {
    if (!file.filepath) {
      files.push(file);
    } else if (next < visible.length) {
      files.push(visible[next++]);
    }
  }
  return files.concat(visible.slice(next));
};

/** Reads an identity field from metadata, where an explicit `null` is a value, not an absence. */
const pickIdentity = <K extends 'conversationId' | 'parentMessageId'>(
  key: K,
  metadata: UIMessageMetadata | undefined,
  base: TMessage | undefined,
): TMessage[K] => {
  if (metadata && metadata[key] !== undefined) {
    return metadata[key];
  }
  return base?.[key] ?? null;
};

/**
 * Maps a `UIMessage` back onto a `TMessage`. `base` is the stored message with the same id,
 * whose fields the UI view does not carry (tree position, feedback, token counts) are kept.
 * A stored message round-trips only with its base: without one the message is rebuilt from the
 * view and its metadata, and a file record keeps only what its part shows (path, name, type).
 * One pass over the parts collects the text, the content and the attachments.
 */
export function fromUIMessage(message: UIMessage, base?: TMessage): TMessage {
  const metadata = message.metadata;
  const contentless = metadata?.contentless === true;
  const writer = createContentWriter();
  const attachments: UIFilePart[] = [];
  let text = '';
  let addedContent = false;
  for (const part of message.parts) {
    if (part.type === 'text') {
      text += part.text;
    } else if (isAttachmentPart(part)) {
      attachments.push(part);
      continue;
    } else if (part.type !== 'source-url' && part.type !== 'step-start') {
      addedContent = true;
    }
    writer.write(part);
  }
  const writesContent = !contentless || addedContent;

  const next: TMessage = {
    ...base,
    ...pickMessageFields(metadata),
    messageId: message.id,
    isCreatedByUser: message.role === 'user',
    conversationId: pickIdentity('conversationId', metadata, base),
    parentMessageId: pickIdentity('parentMessageId', metadata, base),
    text: resolveText(text, metadata, base),
  };
  if (writesContent) {
    next.content = writer.content;
  } else if (metadata?.emptyContent && base?.content === undefined) {
    next.content = [];
  }
  if (base?.attachments === undefined && metadata?.attachments !== undefined) {
    next.attachments = metadata.attachments;
  }
  const files = reconcileFiles(attachments, base?.files);
  if (files) {
    next.files = files;
  }
  return next;
}
