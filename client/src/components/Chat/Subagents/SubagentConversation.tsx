import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { CornerDownRight, Radio } from 'lucide-react';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@librechat/client';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ChildConversationTurn } from './adapters';
import type { TranslationKeys } from '~/hooks';
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
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { showThinkingAtom } from '~/store/showThinking';
import { useAgentsMapContext } from '~/Providers';
import { useChatSurface } from './surface';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const TRIGGER_LABELS = {
  parent_dispatch: 'com_ui_subagent_trigger_parent_dispatch',
  parent_continuation: 'com_ui_subagent_trigger_parent_continuation',
  external_event: 'com_ui_subagent_trigger_external_event',
} as const satisfies Record<ChildConversationTurn['trigger']['kind'], TranslationKeys>;

function TriggerIcon({ kind }: { kind: ChildConversationTurn['trigger']['kind'] }) {
  const Icon = kind === 'external_event' ? Radio : CornerDownRight;
  return (
    <SystemEventIcon>
      <Icon size={14} />
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
        <SystemEventHeader icon={<TriggerIcon kind="external_event" />} label={label} />
      </div>
    );
  } else {
    body = (
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className={systemEventHeaderClasses}>
            <SystemEventHeader
              icon={<TriggerIcon kind="external_event" />}
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
      icon={<TriggerIcon kind="external_event" />}
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

function TriggerMessage({ turn, fullWidth }: { turn: ChildConversationTurn; fullWidth: boolean }) {
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
      icon={<TriggerIcon kind={turn.trigger.kind} />}
      label={label}
      footer={null}
      timestamp={turn.trigger.createdAt}
      ariaLabel={label}
      headerPrefix=""
      isCreatedByUser={true}
      systemLabel={localize('com_ui_system_event')}
      fullWidth={fullWidth}
    >
      <div className="text-text-secondary flex items-center gap-2 py-1 text-sm">
        <SystemEventHeader icon={<TriggerIcon kind={turn.trigger.kind} />} label={label} />
      </div>
      {content.length > 0 && (
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
  agentId,
  conversationId,
  fullWidth,
  onCancelControl,
  detailState,
  onLoadDetails,
}: {
  turn: ChildConversationTurn;
  state: 'ready' | 'loading' | 'error';
  agentId?: string;
  conversationId?: string | null;
  fullWidth: boolean;
  onCancelControl?: (controlId: string) => void;
  detailState?: 'idle' | 'loading' | 'unavailable' | 'error';
  onLoadDetails?: () => void;
}) {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const agent = agentId == null ? undefined : agentsMap?.[agentId];
  const label = agent?.name ?? turn.activity.title;
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
  const iconData = {
    endpoint: EModelEndpoint.agents,
    modelLabel: label,
    isCreatedByUser: false,
  };
  return (
    <MessageRow
      id={`${turn.taskId}:assistant`}
      /** The main chat author glyph, unconditionally: with no resolved agent it
       *  falls back to the endpoint icon there too, so an unresolved child does
       *  not get a differently-inset placeholder of its own. */
      icon={<MessageIcon iconData={iconData} agent={agent} />}
      label={label}
      footer={footer}
      ariaLabel={label}
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
  agentId,
  conversationId,
  stateByTask,
  controllableTaskId,
  onCancelControl,
  detailStateByTask,
  onLoadTurnDetails,
}: {
  turns: ChildConversationTurn[];
  agentId?: string;
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
            <TriggerMessage turn={turn} fullWidth={fullWidth} />
          </div>
          <div className="px-4">
            <ChildMessage
              turn={turn}
              agentId={agentId}
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
