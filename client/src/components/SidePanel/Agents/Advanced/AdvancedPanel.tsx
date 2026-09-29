import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { ChevronLeft, Check, Copy } from 'lucide-react';
import { Button, TooltipAnchor, labelVariants, useToastContext } from '@librechat/client';
import type { AgentForm } from '~/common';
import { useAgentPanelContext } from '~/Providers';
import OrchestrationHub from './OrchestrationHub';
import MaxAgentSteps from './MaxAgentSteps';
import { groupHeadingClass } from './ui';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';

export default function AdvancedPanel() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { watch } = useFormContext<AgentForm>();
  const currentAgentId = watch('id');
  const [copied, setCopied] = useState(false);

  const { setActivePanel } = useAgentPanelContext();

  const handleCopyAgentId = async () => {
    if (!currentAgentId) return;
    try {
      await navigator.clipboard.writeText(currentAgentId);
      setCopied(true);
      showToast({ message: localize('com_ui_agent_id_copied'), status: 'success' });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ message: localize('com_ui_error'), status: 'error' });
    }
  };

  return (
    <div className="mb-1 flex w-full flex-col gap-4 text-sm">
      <header className="grid grid-cols-[auto_1fr_auto] items-center gap-2 pt-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setActivePanel(Panel.builder)}
          aria-label={localize('com_ui_back_to_builder')}
          className="h-10 w-10 flex-shrink-0 rounded-xl border border-border-light text-text-secondary hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <h2 className="text-center text-base font-semibold text-text-primary">
          {localize('com_ui_advanced_settings')}
        </h2>
        <span aria-hidden="true" className="h-10 w-10" />
      </header>

      <div className="flex flex-col gap-5 px-2 pb-2">
        <section className="flex flex-col gap-3">
          <span className={groupHeadingClass}>{localize('com_ui_essentials')}</span>
          <MaxAgentSteps />
        </section>

        <OrchestrationHub currentAgentId={currentAgentId} />

        {currentAgentId && (
          <div className="flex items-center justify-between gap-2 border-t border-border-light pt-3">
            <span className={labelVariants({ variant: 'section' })}>
              {localize('com_ui_agent_id')}
            </span>
            <TooltipAnchor
              description={currentAgentId}
              render={
                <Button
                  variant="ghost"
                  onClick={handleCopyAgentId}
                  aria-label={localize('com_ui_agent_id_copy')}
                  className="h-auto gap-1.5 rounded-lg px-2 py-1 text-text-secondary hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
                >
                  <code className="max-w-[150px] truncate font-mono text-xs">{currentAgentId}</code>
                  <span className="t-icon-swap" data-state={copied ? 'b' : 'a'} aria-hidden="true">
                    <span className="t-icon" data-icon="a">
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="t-icon" data-icon="b">
                      <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
                    </span>
                  </span>
                </Button>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
