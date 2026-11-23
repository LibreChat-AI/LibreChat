import { memo } from 'react';
import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { MemoExoticComponent, ReactNode } from 'react';
import type {
  PartProps,
  ContentPart,
  PartRenderer,
  AgentToolCall,
  PartRenderers,
  PartRenderProps,
  ToolRenderProps,
} from './partTypes';
import { useMessageContext } from '../react/message';
import { partRenderers } from './partRenderers';

type ToolCallPart = ContentPart<ContentTypes.TOOL_CALL>;
type ToolCallValue = ToolCallPart[ContentTypes.TOOL_CALL];

/**
 * A registry entry the host set itself. Tool names and part types come from message data, so a
 * name like `constructor` must not reach a member every object inherits.
 */
const ownEntry = <T,>(
  registry: Partial<Record<string, T>>,
  key: string | undefined,
): T | undefined =>
  key != null && Object.prototype.hasOwnProperty.call(registry, key) ? registry[key] : undefined;

const isAgentToolCall = (toolCall: ToolCallValue): toolCall is AgentToolCall =>
  'args' in toolCall && (!toolCall.type || toolCall.type === ToolCallTypes.TOOL_CALL);

const renderToolCall = (
  renderers: PartRenderers,
  props: PartRenderProps<ToolCallPart>,
): ReactNode => {
  const toolCall = props.part[ContentTypes.TOOL_CALL];
  if (!toolCall) {
    return null;
  }
  if (!isAgentToolCall(toolCall)) {
    return renderers.parts[ContentTypes.TOOL_CALL]?.(props) ?? null;
  }
  const toolProps: ToolRenderProps = {
    ...props,
    toolCall,
    toolCallId: 'id' in toolCall && typeof toolCall.id === 'string' ? toolCall.id : undefined,
  };
  const render =
    renderers.matchTool?.(toolCall) ??
    ownEntry(renderers.tools, toolCall.name) ??
    renderers.defaultTool;
  const card = render(toolProps);
  return renderers.wrapTool ? renderers.wrapTool(card, toolProps) : card;
};

/** Routes one content part to the renderer for it: the host's when given, else the package's. */
export const Part: MemoExoticComponent<(props: PartProps) => ReactNode> = memo(function Part({
  part,
  renderers = partRenderers(),
  ...rest
}: PartProps) {
  const { partIndex } = useMessageContext();
  if (!part) {
    return null;
  }
  const props: PartRenderProps = { ...rest, part, partIndex };
  const claimed = renderers.claim?.(props);
  if (claimed !== undefined) {
    return claimed;
  }
  if (part.type === ContentTypes.TOOL_CALL) {
    return renderToolCall(renderers, { ...props, part });
  }
  const render = ownEntry(renderers.parts, part.type) as PartRenderer | undefined;
  return render?.(props) ?? null;
});
Part.displayName = 'Part';
