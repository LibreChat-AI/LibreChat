import React, { useId } from 'react';
import { Button } from '@librechat/client';
import type { LucideIcon } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ShellProps = {
  icon: LucideIcon;
  tone: 'success' | 'error';
  title: string;
  children: React.ReactNode;
};

export default function Shell({ icon: Icon, tone, title, children }: ShellProps) {
  const localize = useLocalize();
  const titleId = useId();

  return (
    <div className="bg-surface-primary flex min-h-screen flex-col">
      <header className="mt-6 h-10 w-full">
        <img src="assets/logo.svg" className="h-full w-full object-contain" alt="" />
      </header>
      <main className="flex grow items-center justify-center p-6">
        <section
          aria-labelledby={titleId}
          className="flex w-full max-w-sm flex-col items-center px-6 py-8 text-center"
        >
          <div
            className={cn(
              'mb-5 flex size-12 items-center justify-center rounded-full',
              tone === 'success' ? 'bg-status-success-subtle' : 'bg-status-error-subtle',
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                'size-6',
                tone === 'success' ? 'text-status-success' : 'text-status-error',
              )}
            />
          </div>
          <h1 id={titleId} className="text-text-primary mb-2 text-2xl font-semibold">
            {title}
          </h1>
          {children}
          <Button variant="outline" className="mt-6 w-full" onClick={() => window.close()}>
            {localize('com_ui_close_window')}
          </Button>
        </section>
      </main>
    </div>
  );
}
