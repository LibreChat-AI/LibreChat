import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import type { TNmbReviewStatus } from 'librechat-data-provider';
import { useNmbMeQuery, useNmbReviewsQuery } from '~/data-provider';
import { useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import ReviewDetail from './ReviewDetail';
import { cn } from '~/utils';

const TABS: Array<{
  status: TNmbReviewStatus;
  labelKey: 'com_nmb_tab_pending' | 'com_nmb_tab_approved' | 'com_nmb_tab_rejected';
}> = [
  { status: 'pending', labelKey: 'com_nmb_tab_pending' },
  { status: 'approved-masked', labelKey: 'com_nmb_tab_approved' },
  { status: 'rejected', labelKey: 'com_nmb_tab_rejected' },
];

/** Reviewer-only queue of held prompts and documents. The server enforces the role. */
export default function NmbReviewsView() {
  const localize = useLocalize();
  const isSmallScreen = useDrawerViewport();
  const { data: me, isLoading: meLoading } = useNmbMeQuery();
  const [status, setStatus] = useState<TNmbReviewStatus>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  const reviewer = me?.enabled === true && me.reviewer === true;
  const { data, isLoading, isError, refetch } = useNmbReviewsQuery(status, { enabled: reviewer });
  useDocumentTitle(`${localize('com_nmb_reviews_title')} | LibreChat`);

  if (meLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!reviewer) {
    return <Navigate to="/c/new" replace />;
  }

  const items = data?.items ?? [];
  const selected = items.find((item) => item.id === openId) ?? null;

  return (
    <div className="bg-surface-primary-alt text-text-primary flex h-full w-full min-w-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 px-4 py-3 sm:px-5 md:px-6 lg:px-8">
        {isSmallScreen && <OpenSidebar />}
        <h1 className="text-base font-semibold">{localize('com_nmb_reviews_title')}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 sm:px-5 md:flex-row md:px-6 lg:px-8">
        <nav
          className="flex shrink-0 flex-col gap-2 md:w-80"
          aria-label={localize('com_nmb_reviews_title')}
        >
          <div role="tablist" className="flex gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.status}
                role="tab"
                type="button"
                aria-selected={status === tab.status}
                onClick={() => {
                  setStatus(tab.status);
                  setOpenId(null);
                }}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm',
                  status === tab.status
                    ? 'bg-surface-active font-medium'
                    : 'text-text-secondary hover:bg-surface-hover',
                )}
              >
                {localize(tab.labelKey)}
              </button>
            ))}
          </div>
          {isLoading && <Spinner className="size-5" />}
          {isError && (
            <button
              type="button"
              className="text-text-destructive text-left text-sm underline"
              onClick={() => refetch()}
            >
              {localize('com_nmb_load_failed')}
            </button>
          )}
          {!isLoading && !isError && items.length === 0 && (
            <p className="text-text-secondary text-sm">{localize('com_nmb_queue_empty')}</p>
          )}
          <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(item.id)}
                  aria-current={item.id === openId}
                  className={cn(
                    'border-border-light hover:bg-surface-hover w-full rounded-lg border px-3 py-2 text-left text-sm',
                    item.id === openId && 'bg-surface-active',
                  )}
                >
                  <div className="font-medium">{item.user_label}</div>
                  <div className="text-text-secondary">
                    {item.department ?? '-'} · {new Date(item.created_at).toLocaleString()}
                  </div>
                  <div className="text-text-secondary">
                    {localize('com_nmb_findings_count', { 0: String(item.findings.length) })}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="border-border-light min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border p-4">
          {selected ? (
            <ReviewDetail key={selected.id} review={selected} onDone={() => setOpenId(null)} />
          ) : (
            <p className="text-text-secondary text-sm">{localize('com_nmb_select_item')}</p>
          )}
        </main>
      </div>
    </div>
  );
}
