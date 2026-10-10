import { memo } from 'react';
import { User, Sparkles, ScrollText } from 'lucide-react';
import type { TTracePrompt, TTraceMessage, TTraceContent } from 'librechat-data-provider';
import type { RecordPresentation } from './present';
import type { TranslationKeys } from '~/hooks';
import StackedToolIcons from '~/components/Chat/Messages/Content/ToolOutput/StackedToolIcons';
import { formatJSON } from '~/utils/json';
import { useLocalize } from '~/hooks';

type ToolTitle = (name: string) => Pick<RecordPresentation, 'title' | 'caption'>;

const ROLE_LABELS: Record<Exclude<TTraceMessage['role'], 'tool'>, TranslationKeys> = {
  system: 'com_ui_trace_message_system',
  user: 'com_ui_trace_message_user',
  assistant: 'com_ui_model',
};

function Text({ content }: { content: TTraceContent }) {
  const localize = useLocalize();
  return (
    <>
      <p className="text-text-primary max-h-48 overflow-auto text-sm break-words whitespace-pre-wrap">
        {content.value}
      </p>
      {content.truncated && (
        <p className="text-text-secondary text-xs">{localize('com_ui_trace_truncated')}</p>
      )}
    </>
  );
}

function Message({
  message,
  toolTitleFor,
  mcpIconMap,
}: {
  message: TTraceMessage;
  toolTitleFor: ToolTitle;
  mcpIconMap: Map<string, string>;
}) {
  const localize = useLocalize();
  const tool = message.role === 'tool' && message.toolName != null ? message.toolName : undefined;
  const toolTitle = tool != null ? toolTitleFor(tool) : undefined;
  return (
    <li className="border-border-light bg-surface-primary-alt flex flex-col gap-1 rounded-lg border p-2">
      <span className="text-text-secondary flex items-center gap-1.5 text-xs font-medium">
        {message.role === 'user' && <User className="size-3.5" aria-hidden="true" />}
        {message.role === 'assistant' && <Sparkles className="size-3.5" aria-hidden="true" />}
        {message.role === 'tool' && (
          <StackedToolIcons toolNames={[tool ?? '']} mcpIconMap={mcpIconMap} />
        )}
        {message.role === 'tool'
          ? localize('com_ui_trace_message_tool', {
              0: toolTitle?.title ?? localize('com_ui_trace_kind_tool'),
            })
          : localize(ROLE_LABELS[message.role])}
        {toolTitle?.caption != null && <span className="font-normal">{toolTitle.caption}</span>}
      </span>
      {message.text != null && <Text content={message.text} />}
      {message.attachments != null && (
        <p className="text-text-secondary text-xs">
          {localize('com_ui_trace_message_attachments', { 0: message.attachments.join(', ') })}
        </p>
      )}
      {message.toolCalls?.map((call, index) => {
        const { title, caption } = toolTitleFor(call.name);
        return (
          <details key={`${call.name}-${index}`} className="group text-xs">
            <summary className="text-text-primary hover:bg-surface-hover flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 marker:content-none">
              <StackedToolIcons toolNames={[call.name]} mcpIconMap={mcpIconMap} />
              <span className="min-w-0 truncate">
                {localize('com_ui_trace_message_asked_tool', { 0: title })}
              </span>
              {caption != null && <span className="text-text-secondary truncate">{caption}</span>}
            </summary>
            {call.args != null && (
              <pre className="text-text-secondary mt-1 max-h-40 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
                {call.args.truncated ? call.args.value : formatJSON(call.args.value)}
              </pre>
            )}
          </details>
        );
      })}
    </li>
  );
}

/**
 * A model call as a conversation: what it wrote, then what it was given. The
 * instructions stay folded, since they are long and the same on every call, and
 * the newest messages, which the call answered, are what opens.
 */
function Conversation({
  prompt,
  reply,
  toolTitleFor,
  mcpIconMap,
}: {
  prompt?: TTracePrompt;
  reply?: TTraceMessage;
  toolTitleFor: ToolTitle;
  mcpIconMap: Map<string, string>;
}) {
  const localize = useLocalize();
  const heading = 'text-xs font-semibold uppercase tracking-wide text-text-secondary';
  const [first, ...rest] = prompt?.messages ?? [];
  const system = first?.role === 'system' ? first : undefined;
  const messages = system != null ? rest : (prompt?.messages ?? []);
  return (
    <div className="flex flex-col gap-4">
      {reply != null && (
        <section className="flex flex-col gap-1.5">
          <h4 className={heading}>{localize('com_ui_trace_reply')}</h4>
          <ul className="flex flex-col gap-1.5">
            <Message message={reply} toolTitleFor={toolTitleFor} mcpIconMap={mcpIconMap} />
          </ul>
        </section>
      )}
      {prompt != null && (
        <section className="flex flex-col gap-1.5">
          <h4 className={heading}>{localize('com_ui_trace_prompt')}</h4>
          {system?.text != null && (
            <details className="border-border-light bg-surface-primary-alt rounded-lg border p-2 text-sm">
              <summary className="text-text-secondary flex cursor-pointer items-center gap-1.5 text-xs font-medium marker:content-none">
                <ScrollText className="size-3.5" aria-hidden="true" />
                {localize('com_ui_trace_message_system')}
              </summary>
              <div className="mt-1.5 flex flex-col gap-1">
                <Text content={system.text} />
              </div>
            </details>
          )}
          {prompt.omitted > 0 && (
            <p className="text-text-secondary px-2 text-xs">
              {localize('com_ui_trace_prompt_omitted', { 0: String(prompt.omitted) })}
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {messages.map((message, index) => (
              <Message
                key={index}
                message={message}
                toolTitleFor={toolTitleFor}
                mcpIconMap={mcpIconMap}
              />
            ))}
          </ul>
          {prompt.tools != null && (
            <details className="text-text-secondary px-2 text-xs">
              <summary className="cursor-pointer">
                {localize('com_ui_trace_prompt_tools', { 0: String(prompt.tools.length) })}
              </summary>
              <p className="mt-1 break-words">
                {prompt.tools.map((name) => toolTitleFor(name).title).join(', ')}
              </p>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

export default memo(Conversation);
