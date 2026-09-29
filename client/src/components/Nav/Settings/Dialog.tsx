import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { X, ChevronLeft } from 'lucide-react';
import { Button, useMediaQuery } from '@librechat/client';
import { SettingsTabValues } from 'librechat-data-provider';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import type { TDialogProps } from '~/common';
import type { SettingsTab } from './types';
import { useSettingsContext } from './context';
import { useLocalize } from '~/hooks';
import Sidebar from './Sidebar';
import Content from './Content';
import { TABS } from './types';
import { cn } from '~/utils';

export default function SettingsDialog({ open, onOpenChange }: TDialogProps) {
  const localize = useLocalize();
  const ctx = useSettingsContext();
  const isSmallScreen = useMediaQuery('(max-width: 767px)');
  const [activeTab, setActiveTab] = useState<SettingsTab>(SettingsTabValues.GENERAL);
  const [query, setQuery] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);

  const searching = query.trim().length > 0;
  const inDetail = isSmallScreen && mobileDetail && !searching;
  const showSidebar = !isSmallScreen || !inDetail;
  const showContent = !isSmallScreen || inDetail || searching;
  const hideTabs = isSmallScreen && searching;
  const visibleTabs = TABS.filter((t) => !t.show || t.show(ctx));
  const effectiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : SettingsTabValues.GENERAL;
  const activeMeta = TABS.find((t) => t.id === effectiveTab);

  const selectTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    if (isSmallScreen) {
      setMobileDetail(true);
    }
  };

  return (
    <Transition appear show={open}>
      <Dialog as="div" className="relative z-50" onClose={() => onOpenChange(false)}>
        <TransitionChild
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black opacity-50 dark:opacity-80" aria-hidden="true" />
        </TransitionChild>
        <TransitionChild
          enter="ease-out duration-200"
          enterFrom="opacity-0 scale-95"
          enterTo="opacity-100 scale-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100 scale-100"
          leaveTo="opacity-0 scale-95"
        >
          <div className="fixed inset-0 flex w-screen items-center justify-center p-4">
            <DialogPanel
              className={cn(
                /** Headless UI panel, so it bypasses the shared dialog primitives
                 *  and needs the contrast edge declared here. `shadow-2xl` is a
                 *  black shadow with nothing to separate against on a black canvas. */
                'flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-surface-dialog shadow-2xl high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none',
                'md:h-[85vh] md:w-[900px]',
              )}
            >
              <DialogTitle
                as="div"
                className="flex items-center justify-between border-b border-border-light p-5"
              >
                {inDetail ? (
                  <button
                    type="button"
                    onClick={() => setMobileDetail(false)}
                    className="-ml-1 flex items-center gap-1 rounded-lg p-1 text-text-primary transition-colors hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-border-xheavy"
                    aria-label={localize('com_ui_back')}
                  >
                    <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                    <span className="text-lg font-medium">
                      {activeMeta ? localize(activeMeta.labelKey) : localize('com_nav_settings')}
                    </span>
                  </button>
                ) : (
                  <h2 className="text-lg font-medium text-text-primary">
                    {localize('com_nav_settings')}
                  </h2>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onOpenChange(false)}
                  aria-label={localize('com_ui_close_settings')}
                  className="h-auto w-auto rounded-lg p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-xheavy"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </Button>
              </DialogTitle>
              <Tabs.Root
                value={effectiveTab}
                onValueChange={(v) => setActiveTab(v as SettingsTab)}
                orientation="vertical"
                className="flex flex-1 flex-col gap-4 overflow-hidden p-5 md:flex-row md:gap-6"
              >
                {showSidebar && (
                  <Sidebar
                    ctx={ctx}
                    query={query}
                    onQueryChange={setQuery}
                    onSelectTab={selectTab}
                    showChevron={isSmallScreen}
                    hideTabs={hideTabs}
                  />
                )}
                {showContent && (
                  <div className="flex-1 overflow-y-auto md:pr-1">
                    {searching ? (
                      <Content activeTab={effectiveTab} query={query} ctx={ctx} />
                    ) : (
                      <Tabs.Content
                        value={effectiveTab}
                        tabIndex={-1}
                        className="focus:outline-none"
                      >
                        <Content activeTab={effectiveTab} query={query} ctx={ctx} />
                      </Tabs.Content>
                    )}
                  </div>
                )}
              </Tabs.Root>
            </DialogPanel>
          </div>
        </TransitionChild>
      </Dialog>
    </Transition>
  );
}
