import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Radio } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@librechat/client';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ChildConversationTurn } from './adapters';
import type { TranslationKeys } from '~/hooks';
import type { TurnAuthor } from './author';
import SystemEventHeader, {
  SystemEventIcon,
  systemEventHeaderClasses,
} from '~/components/Chat/Messages/ui/SystemEvent';
import { SubagentActivityContent, SubagentStatus } from './SubagentActivity';
import ContentParts from '~/components/Chat/Messages/Content/ContentParts';
import { isAbnormalTerminalStatus, isLiveSubagentStatus } from './status';
import { messageFooterClasses } from '~/components/Chat/Messages/styles';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import { ElapsedTimer } from '~/components/Chat/Messages/Elapsed';
import { showThinkingAtom } from '~/store/showThinking';
import { useChatSurface } from './surface';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const TRIGGER_LABELS = {
  parent_dispatch: 'com_ui_subagent_trigger_parent_dispatch',
  parent_continuation: 'com_ui_subagent_trigger_parent_continuation',
  external_event: 'com_ui_subagent_trigger_external_event',
} as const satisfies Record<ChildConversationTurn['trigger']['kind'], TranslationKeys>;

function ExternalEventIcon() {
  return (
    <SystemEventIcon>
      <Radio size={14} />
    </SystemEventIcon>
  );
}

function ExternalEventTrigger({
  turn,
  fullWidth,
}: {
  turn: ChildConversationTurn;
  fullWidth: boolean;
}) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState(false);
  const details = turn.trigger.externalEvent;
  const label = localize('com_ui_subagent_trigger_external_event');
  let body: ReactNode;
  if (details == null) {
    body = (
      <div className="text-text-secondary flex items-center gap-2 py-1 text-sm">
        <SystemEventHeader icon={<ExternalEventIcon />} label={label} />
      </div>
    );
  } else {
    body = (
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className={systemEventHeaderClasses}>
            <SystemEventHeader
              icon={<ExternalEventIcon />}
              label={label}
              detail={`${details.eventType} · ${details.sourceType}`}
              expanded={expanded}
            />
            <span className="sr-only">{details.occurredAt}</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="text-text-secondary pt-0.5 pb-1 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>{localize('com_ui_subagent_event_type')}</dt>
            <dd className="text-text-primary break-words">{details.eventType}</dd>
            <dt>{localize('com_ui_subagent_event_source')}</dt>
            <dd className="text-text-primary break-words">{details.sourceType}</dd>
            <dt>{localize('com_ui_subagent_event_received')}</dt>
            <dd className="text-text-primary break-words">
              {new Date(details.occurredAt).toLocaleString()}
            </dd>
            {details.expectedActionToolName != null && (
              <>
                <dt>{localize('com_ui_subagent_event_expected_action')}</dt>
                <dd className="text-text-primary break-words">{details.expectedActionToolName}</dd>
              </>
            )}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <MessageRow
      id={`${turn.taskId}:trigger`}
      icon={<ExternalEventIcon />}
      label={label}
      footer={null}
      timestamp={turn.trigger.createdAt ?? details?.occurredAt}
      ariaLabel={label}
      headerPrefix=""
      isCreatedByUser={true}
      systemLabel={localize('com_ui_system_event')}
      fullWidth={fullWidth}
    >
      {body}
    </MessageRow>
  );
}

/** A parent agent's briefing or follow-up is the user side of this conversation
 *  with the parent as its author, so it is main chat's user turn under the
 *  parent's name and face. Only an external event, which no agent wrote, stays
 *  a system turn. */
function TriggerMessage({
  turn,
  fullWidth,
  parentAuthor,
}: {
  turn: ChildConversationTurn;
  fullWidth: boolean;
  parentAuthor: TurnAuthor;
}) {
  const showThinking = useAtomValue(showThinkingAtom);
  const localize = useLocalize();
  const label = localize(TRIGGER_LABELS[turn.trigger.kind]);
  const content = useMemo<TMessageContentParts[]>(
    () =>
      turn.trigger.summary === ''
        ? []
        : [
            {
              type: ContentTypes.TEXT,
              text: turn.trigger.summary,
            } as TMessageContentParts,
          ],
    [turn.trigger.summary],
  );
  if (turn.trigger.kind === 'external_event') {
    return <ExternalEventTrigger turn={turn} fullWidth={fullWidth} />;
  }
  return (
    <MessageRow
      id={`${turn.taskId}:trigger`}
      icon={parentAuthor.icon}
      label={parentAuthor.name}
      footer={null}
      timestamp={turn.trigger.createdAt}
      ariaLabel={label}
      headerPrefix=""
      isCreatedByUser={true}
      showAuthor
      fullWidth={fullWidth}
    >
      {content.length > 0 ? (
        <ContentParts
          content={content}
          messageId={`${turn.taskId}:trigger`}
          conversationId={null}
          isCreatedByUser={true}
          showThinking={showThinking}
          isLast={false}
          isSubmitting={false}
          isLatestMessage={false}
        />
      ) : (
        <div className="text-text-secondary text-sm italic">{label}</div>
      )}
      {turn.trigger.summaryTruncated === true && (
        <div className="text-text-secondary mt-1 text-xs italic">
          {localize('com_ui_subagent_trigger_truncated')}
        </div>
      )}
    </MessageRow>
  );
}

function ChildMessage({
  turn,
  state,
  author,
  conversationId,
  fullWidth,
  onCancelControl,
  detailState,
  onLoadDetails,
}: {
  turn: ChildConversationTurn;
  state: 'ready' | 'loading' | 'error';
  author: TurnAuthor;
  conversationId?: string | null;
  fullWidth: boolean;
  onCancelControl?: (controlId: string) => void;
  detailState?: 'idle' | 'loading' | 'unavailable' | 'error';
  onLoadDetails?: () => void;
}) {
  const localize = useLocalize();
  const detailsLimited = turn.activity.activityTruncated === true;
  let limitedNotice: ReactNode;
  if (detailsLimited && onLoadDetails != null && detailState !== 'unavailable') {
    limitedNotice = (
      <Button type="button" variant="ghost" size="sm" onClick={onLoadDetails}>
        {detailState === 'error'
          ? localize('com_ui_retry')
          : localize('com_ui_subagent_show_full_activity')}
      </Button>
    );
  } else {
    limitedNotice = localize('com_ui_subagent_activity_details_unavailable');
  }
  let footerContent: ReactNode = null;
  if (isAbnormalTerminalStatus(turn.activity.status)) {
    footerContent = <SubagentStatus activity={turn.activity} />;
  } else if (isLiveSubagentStatus(turn.activity.status)) {
    const triggeredAt = turn.trigger.createdAt ?? turn.trigger.externalEvent?.occurredAt;
    const startedAt = triggeredAt == null ? NaN : Date.parse(triggeredAt);
    footerContent = <ElapsedTimer start={Number.isFinite(startedAt) ? startedAt : undefined} />;
  }
  /** The main chat footer's own metrics, held whether or not anything occupies
   *  the slot: the timer leaving at completion must not step the turns below it
   *  upward, and the reading has to be sized by the same `text-xs` its main
   *  chat counterpart inherits rather than by the panel's body size. */
  const footer = (
    <div className={cn('mt-1 flex justify-start gap-3', messageFooterClasses)}>{footerContent}</div>
  );
  return (
    <MessageRow
      id={`${turn.taskId}:assistant`}
      icon={author.icon}
      label={author.name}
      footer={footer}
      ariaLabel={author.name}
      headerPrefix=""
      isCreatedByUser={false}
      fullWidth={fullWidth}
    >
      <SubagentActivityContent
        activity={turn.activity}
        activityId={`${turn.taskId}:assistant`}
        state={state}
        showPrompt={false}
        conversationId={conversationId}
        underHeaderIcon
        onCancelControl={onCancelControl}
      />
      {detailsLimited && detailState !== 'loading' && (
        <div className="text-text-secondary mt-2 text-xs">{limitedNotice}</div>
      )}
      {detailState === 'loading' && (
        <div className="text-text-secondary mt-2 text-xs" aria-live="polite">
          {localize('com_ui_loading')}
        </div>
      )}
    </MessageRow>
  );
}

export default function SubagentConversation({
  turns,
  author,
  parentAuthor,
  conversationId,
  stateByTask,
  controllableTaskId,
  onCancelControl,
  detailStateByTask,
  onLoadTurnDetails,
}: {
  turns: ChildConversationTurn[];
  /** The child agent: every assistant turn's header. */
  author: TurnAuthor;
  /** The agent that briefs the child: every parent-written turn's header. */
  parentAuthor: TurnAuthor;
  conversationId?: string | null;
  stateByTask?: ReadonlyMap<string, 'ready' | 'loading' | 'error'>;
  controllableTaskId?: string;
  onCancelControl?: (taskId: string, controlId: string) => void;
  detailStateByTask?: ReadonlyMap<string, 'idle' | 'loading' | 'unavailable' | 'error'>;
  onLoadTurnDetails?: (taskId: string) => void;
}) {
  const { maximizeChatSpace: fullWidth } = useChatSurface();
  return (
    <div className="flex flex-col gap-6 py-4" data-subagent-conversation>
      {turns.map((turn) => (
        <section
          key={turn.taskId}
          className="flex flex-col gap-4"
          data-subagent-thread-turn={turn.taskId}
        >
          <div className="px-4">
            <TriggerMessage turn={turn} fullWidth={fullWidth} parentAuthor={parentAuthor} />
          </div>
          <div className="px-4">
            <ChildMessage
              turn={turn}
              author={author}
              conversationId={conversationId}
              fullWidth={fullWidth}
              state={stateByTask?.get(turn.taskId) ?? 'ready'}
              onCancelControl={
                onCancelControl == null || turn.taskId !== controllableTaskId
                  ? undefined
                  : (controlId) => onCancelControl(turn.taskId, controlId)
              }
              detailState={detailStateByTask?.get(turn.taskId)}
              onLoadDetails={
                turn.activity.activityTruncated !== true || onLoadTurnDetails == null
                  ? undefined
                  : () => onLoadTurnDetails(turn.taskId)
              }
            />
          </div>
        </section>
      ))}
    </div>
  );
}
