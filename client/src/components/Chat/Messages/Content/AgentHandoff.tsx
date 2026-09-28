import React, { useEffect, useId, useMemo, useRef, useState, useCallback } from 'react';
import copy from 'copy-to-clipboard';
import { ChevronDown } from 'lucide-react';
import { Button } from '@librechat/client';
import { EModelEndpoint, Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { unescapeJsonString } from './Parts/parseJsonField';
import MessageIcon from '~/components/Share/MessageIcon';
import { toolPanelSpacingClassName } from './disclosure';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { useAgentsMapContext } from '~/Providers';
import { cn } from '~/utils';

interface AgentHandoffProps {
  name: string;
  args: string | Record<string, unknown>;
}

interface HandoffField {
  key?: string;
  value: string;
}

const PARTIAL_STRING_FIELD = /^\s*\{\s*"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)/s;

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value == null) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function fieldsFromRecord(record: Record<string, unknown>): HandoffField[] {
  return Object.entries(record).reduce<HandoffField[]>((fields, [key, rawValue]) => {
    const value = formatValue(rawValue);
    if (value) {
      fields.push({ key, value });
    }
    return fields;
  }, []);
}

function parseHandoffFields(args: string | Record<string, unknown>): HandoffField[] {
  if (typeof args !== 'string') {
    return fieldsFromRecord(args);
  }

  const trimmed = args.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return fieldsFromRecord(parsed as Record<string, unknown>);
    }
    const value = formatValue(parsed);
    return value ? [{ value }] : [];
  } catch {
    const partialField = trimmed.match(PARTIAL_STRING_FIELD);
    if (partialField) {
      const value = unescapeJsonString(partialField[2]);
      return value ? [{ key: partialField[1], value }] : [];
    }
    return trimmed.startsWith('{') ? [] : [{ value: trimmed }];
  }
}

/**
 * The SDK's own prompt keys, which are the ones that carry product meaning.
 * Any other key is an admin-authored `promptKey` from the agent graph (see
 * `handoffPromptKeyCompatibility`), so it is author content with no
 * localization key to map to and is left as written, like an agent's own name.
 */
const HANDOFF_FIELD_LABELS: Record<string, TranslationKeys> = {
  instruction: 'com_ui_handoff_field_instructions',
  instructions: 'com_ui_handoff_field_instructions',
  context: 'com_ui_handoff_field_context',
};

function fieldLabel(key: string, localize: (translationKey: TranslationKeys) => string): string {
  const known = HANDOFF_FIELD_LABELS[key.toLowerCase()];
  if (known) {
    return localize(known);
  }
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

const AgentHandoff: React.FC<AgentHandoffProps> = ({ name, args: _args = '' }) => {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const [showInfo, setShowInfo] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const contentId = useId();
  const headingId = `${contentId}-heading`;
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(showInfo);

  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  const targetAgentId = useMemo(() => {
    if (typeof name !== 'string' || !name.startsWith(Constants.LC_TRANSFER_TO_)) {
      return null;
    }
    return name.replace(Constants.LC_TRANSFER_TO_, '');
  }, [name]);

  const targetAgent = useMemo(() => {
    if (!targetAgentId || !agentsMap) {
      return null;
    }
    return agentsMap[targetAgentId];
  }, [agentsMap, targetAgentId]);

  const fields = useMemo(() => parseHandoffFields(_args), [_args]);
  const copyText = useMemo(
    () =>
      fields.length === 1
        ? fields[0].value
        : fields
            .map(({ key, value }) => `${key ? `${fieldLabel(key, localize)}\n` : ''}${value}`)
            .join('\n\n'),
    [fields, localize],
  );
  const hasInfo = fields.length > 0;
  const agentName = targetAgent?.name || localize('com_ui_agent');

  /** `copy-to-clipboard` rather than `navigator.clipboard`, matching the other
   *  message-content copy controls: the async API is undefined on a
   *  non-secure origin (a LAN deployment served over http), where
   *  dereferencing it throws before any rejection handler can run and the
   *  button silently does nothing. */
  const handleCopy = useCallback(() => {
    if (!copy(copyText, { format: 'text/plain' })) {
      return;
    }
    clearTimeout(copiedTimerRef.current);
    setIsCopied(true);
    copiedTimerRef.current = setTimeout(() => setIsCopied(false), 2000);
  }, [copyText]);

  return (
    <div className="my-2">
      <Button
        variant="ghost"
        className={cn(
          'tool-status-text h-auto justify-start gap-2 rounded-none p-0 font-normal text-text-secondary hover:bg-transparent hover:text-text-primary',
          !hasInfo && 'pointer-events-none disabled:opacity-100',
        )}
        disabled={!hasInfo}
        onClick={hasInfo ? () => setShowInfo(!showInfo) : undefined}
        aria-expanded={hasInfo ? showInfo : undefined}
        aria-controls={hasInfo ? contentId : undefined}
        aria-label={`${localize('com_ui_transferred_to')} ${agentName}`}
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-border-light">
          <MessageIcon
            message={
              {
                endpoint: EModelEndpoint.agents,
                isCreatedByUser: false,
              } as TMessage
            }
            agent={targetAgent || undefined}
          />
        </div>
        <span className="select-none">{localize('com_ui_transferred_to')}</span>
        <span className="select-none font-medium text-text-primary">{agentName}</span>
        {hasInfo && (
          <ChevronDown
            className={cn(
              'size-4 shrink-0 translate-y-[1px] text-text-secondary transition-transform duration-200 ease-out',
              showInfo && 'rotate-180',
            )}
            aria-hidden="true"
          />
        )}
      </Button>
      <div id={contentId} style={expandStyle} aria-hidden={!showInfo || undefined}>
        <div className="overflow-hidden" ref={expandRef}>
          {hasInfo && (
            <section
              aria-labelledby={headingId}
              className={cn(
                toolPanelSpacingClassName,
                'group/handoff ml-8 max-w-3xl border-l-2 border-border-medium py-1 pl-4 pr-1',
              )}
            >
              <div className="mb-1.5 flex min-h-5 items-center justify-between gap-2">
                <span
                  id={headingId}
                  className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                >
                  {localize('com_ui_handoff_instructions')}
                </span>
                <CopyButton
                  isCopied={isCopied}
                  iconOnly
                  onClick={handleCopy}
                  label={localize('com_ui_copy_to_clipboard')}
                  copiedLabel={localize('com_ui_copied_to_clipboard')}
                  /** Only the reveal-on-hover behavior is local; the icon
                   *  crossfade, tooltip, hover and focus ring come from the
                   *  shared primitive. */
                  className="shrink-0 opacity-60 focus-visible:opacity-100 group-focus-within/handoff:opacity-100 group-hover/handoff:opacity-100"
                />
              </div>
              {fields.length === 1 ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                  {fields[0].value}
                </p>
              ) : (
                <dl className="space-y-3">
                  {fields.map(({ key, value }, index) => (
                    <div key={`${key ?? 'field'}-${index}`}>
                      {key && (
                        <dt className="mb-0.5 text-xs font-medium text-text-secondary">
                          {fieldLabel(key, localize)}
                        </dt>
                      )}
                      <dd className="whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentHandoff;
