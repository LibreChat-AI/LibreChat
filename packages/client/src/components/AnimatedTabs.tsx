import { forwardRef, useEffect, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import type { ElementRef } from 'react';
import { cn, disabledInkClasses } from '~/utils';
import './AnimatedTabs.css';
import { JSX } from 'react/jsx-runtime';

export interface TabItem {
  id?: string;
  label: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
}

export interface AnimatedTabsProps {
  tabs: TabItem[];
  className?: string;
  tabListClassName?: string;
  tabClassName?: string;
  tabPanelClassName?: string;
  tabListProps?: Ariakit.TabListProps;
  containerClassName?: string;
  defaultSelectedId?: string;
  tone?: 'default' | 'muted';
}

function usePrevious<T>(value: T) {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

const Tab = forwardRef<ElementRef<typeof Ariakit.Tab>, Ariakit.TabProps>(function Tab(props, ref) {
  const tabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const tabElement = tabRef.current;
    if (!tabElement) return;

    const updateState = () => {
      const isSelected = tabElement.getAttribute('aria-selected') === 'true';
      tabElement.setAttribute('data-state', isSelected ? 'active' : 'inactive');
    };

    updateState();

    const observer = new MutationObserver(updateState);
    observer.observe(tabElement, { attributes: true, attributeFilter: ['aria-selected'] });

    return () => observer.disconnect();
  }, []);

  return (
    <Ariakit.Tab
      ref={(node) => {
        // Forward the ref to both our local ref and the provided ref
        tabRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      {...props}
      className={cn(
        'animated-tab aria-selected:text-text-primary flex items-center justify-center gap-2 border-none text-sm font-medium whitespace-nowrap outline-hidden transition-colors select-none aria-disabled:opacity-50',
        disabledInkClasses,
        props.className,
      )}
    />
  );
});

const TabPanel = forwardRef<ElementRef<typeof Ariakit.TabPanel>, Ariakit.TabPanelProps>(
  function TabPanel(props, ref) {
    const tab = Ariakit.useTabContext();
    const previousTabId = usePrevious(Ariakit.useStoreState(tab, 'selectedId'));
    const wasOpen = props.tabId && previousTabId === props.tabId;

    return (
      <Ariakit.TabPanel
        ref={ref}
        {...props}
        data-was-open={wasOpen || undefined}
        className={`animated-tab-panel max-w-full ${props.className || ''}`}
      />
    );
  },
);

export function AnimatedTabs({
  tabs,
  className = '',
  tabListClassName = '',
  tabClassName = '',
  tabPanelClassName = '',
  containerClassName = '',
  tabListProps = {},
  defaultSelectedId,
  tone = 'default',
}: AnimatedTabsProps): JSX.Element {
  const tabIds = tabs.map((tab, index) => tab.id || `tab-${index}`);
  const firstTabId = defaultSelectedId || tabIds[0];
  const tabListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList) return;

    // Function to update the underline position
    const updateUnderline = () => {
      const activeTab = tabList.querySelector('[data-state="active"]') as HTMLElement;
      if (!activeTab) return;

      tabList.style.setProperty('--tab-left', `${activeTab.offsetLeft}px`);
      tabList.style.setProperty('--tab-width', `${activeTab.offsetWidth}px`);
    };

    updateUnderline();

    const observer = new MutationObserver(updateUnderline);
    observer.observe(tabList, { attributes: true, subtree: true, attributeFilter: ['data-state'] });

    return () => observer.disconnect();
  }, [tabs]);

  return (
    <div className={`w-full ${className}`}>
      <Ariakit.TabProvider defaultSelectedId={firstTabId}>
        <Ariakit.TabList
          ref={tabListRef}
          aria-label="Tabs"
          className={`animated-tab-list flex py-1 ${tabListClassName}`}
          {...tabListProps}
        >
          {tabs.map((tab, index) => (
            <Tab
              key={tabIds[index]}
              id={tabIds[index]}
              disabled={tab.disabled}
              className={cn(tone === 'muted' && 'text-text-secondary', tabClassName)}
              data-state={tabIds[index] === firstTabId ? 'active' : 'inactive'}
            >
              {/* TypeScript workaround for React i18next children type compatibility */}
              {tab.label}
            </Tab>
          ))}
        </Ariakit.TabList>

        <div
          className={cn(
            'animated-panels relative flex w-full flex-col items-center overflow-hidden p-0',
            containerClassName,
          )}
        >
          {tabs.map((tab, index) => (
            <TabPanel
              key={`panel-${tabIds[index]}`}
              id={`panel-${tabIds[index]}`}
              tabId={tabIds[index]}
              className={tabPanelClassName}
            >
              {/* TypeScript workaround for React i18next children type compatibility */}
              {tab.content}
            </TabPanel>
          ))}
        </div>
      </Ariakit.TabProvider>
    </div>
  );
}
