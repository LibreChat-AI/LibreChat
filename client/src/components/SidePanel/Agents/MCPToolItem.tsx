import { useState } from 'react';
import { Button } from '@librechat/client';
import { Check, Clock, Code2, Captions, Info, Zap } from 'lucide-react';
import type { AgentToolType } from 'librechat-data-provider';
import OptionToggle from './OptionToggle';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface MCPToolItemProps {
  tool: AgentToolType;
  isSelected: boolean;
  isDeferred: boolean;
  isProgrammatic: boolean;
  isBackground: boolean;
  isIntent: boolean;
  /** Intent labels never reach a programmatic-only tool (no card renders for
   *  calls made from code), so the toggle is shown inert with an explanation. */
  intentDisabled: boolean;
  deferredToolsEnabled: boolean;
  programmaticToolsEnabled: boolean;
  programmaticToolsAvailable: boolean;
  backgroundToolsEnabled: boolean;
  toolIntentsEnabled: boolean;
  onToggleSelect: () => void;
  onToggleDefer: () => void;
  onToggleProgrammatic: () => void;
  onToggleBackground: () => void;
  onToggleIntent: () => void;
}

const iconButton = 'size-6 rounded-md';

export default function MCPToolItem({
  tool,
  isSelected,
  isDeferred,
  onToggleDefer,
  onToggleSelect,
  isProgrammatic,
  onToggleProgrammatic,
  isBackground,
  onToggleBackground,
  isIntent,
  intentDisabled,
  onToggleIntent,
  deferredToolsEnabled,
  programmaticToolsEnabled,
  programmaticToolsAvailable,
  backgroundToolsEnabled,
  toolIntentsEnabled,
}: MCPToolItemProps) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState(false);

  const description = tool.metadata.description?.trim();
  const detailsId = `mcp-tool-details-${tool.tool_id}`;

  return (
    <div className="overflow-hidden rounded-lg">
      <div className="flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-surface-secondary">
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={isSelected}
          aria-label={tool.metadata.name}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-2 text-left',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded border border-border-medium transition-colors',
              isSelected && 'bg-surface-inverted text-text-inverted',
            )}
          >
            {isSelected && <Check className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
            {tool.metadata.name}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {deferredToolsEnabled && (
            <OptionToggle
              icon={Clock}
              pressed={isDeferred}
              label={localize('com_ui_mcp_defer_loading')}
              tooltip={localize('com_ui_mcp_click_to_defer')}
              activeBorderClass="border-series-4"
              onToggle={onToggleDefer}
            />
          )}
          {programmaticToolsEnabled && (
            <OptionToggle
              icon={Code2}
              pressed={isProgrammatic}
              label={localize('com_ui_mcp_programmatic')}
              tooltip={localize(
                programmaticToolsAvailable
                  ? 'com_ui_mcp_click_to_programmatic'
                  : 'com_ui_mcp_programmatic_requires_code',
              )}
              activeBorderClass="border-series-6"
              disabled={!programmaticToolsAvailable && !isProgrammatic}
              onToggle={onToggleProgrammatic}
            />
          )}
          {backgroundToolsEnabled && (
            <OptionToggle
              icon={Zap}
              pressed={isBackground}
              label={localize('com_ui_mcp_background')}
              tooltip={localize('com_ui_mcp_click_to_background')}
              activeBorderClass="border-series-1"
              onToggle={onToggleBackground}
            />
          )}
          {toolIntentsEnabled && (
            <OptionToggle
              icon={Captions}
              pressed={isIntent}
              disabled={intentDisabled}
              label={localize('com_ui_mcp_intent')}
              tooltip={localize(
                intentDisabled ? 'com_ui_mcp_intent_programmatic' : 'com_ui_mcp_click_to_intent',
              )}
              activeBorderClass="border-series-3"
              onToggle={onToggleIntent}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={localize('com_ui_tools_info')}
            className={cn(
              iconButton,
              expanded ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <Info className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {/* Auto-height reveal via grid-template-rows 0fr -> 1fr so the panel — and
          the auto-sized dialog around it — grow/shrink smoothly instead of jumping. */}
      <div
        id={detailsId}
        className={cn(
          'grid transition-[grid-template-rows] [transition-duration:var(--resize-dur)] [transition-timing-function:var(--resize-ease)] motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              'border-t border-border-light px-3 py-3 transition-opacity duration-200 ease-out motion-reduce:transition-none',
              expanded ? 'opacity-100' : 'opacity-0',
            )}
          >
            <p className="max-h-44 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
              {description || localize('com_ui_mcp_no_description')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
