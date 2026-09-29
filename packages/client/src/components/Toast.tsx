import { X } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import * as RadixToast from '@radix-ui/react-toast';
import { NotificationSeverity } from '~/common';
import { useToast, useLocalize } from '~/hooks';

export function Toast(): JSX.Element {
  const { toast, onOpenChange } = useToast();
  const localize = useLocalize();
  const persistent = toast.duration === Infinity;
  const severityClassName = {
    [NotificationSeverity.INFO]: 'border-status-info-strong bg-status-info-strong',
    [NotificationSeverity.SUCCESS]: 'border-status-success-strong bg-status-success-strong',
    [NotificationSeverity.WARNING]: 'border-status-warning-strong bg-status-warning-strong',
    [NotificationSeverity.ERROR]: 'border-status-error-strong bg-status-error-strong',
  };

  return (
    <RadixToast.Root
      key={toast.id}
      open={toast.open}
      onOpenChange={(open) => onOpenChange(open, toast.id)}
      duration={toast.duration}
      className="toast-root"
      style={{
        minHeight: '74px',
        marginBottom: '0px',
      }}
    >
      <div className="w-full p-1 text-center md:w-auto md:text-justify">
        <div
          className={`alert-root pointer-events-auto inline-flex flex-row gap-2 rounded-md border px-3 py-2 font-bold text-text-on-status ${
            severityClassName[toast.severity]
          }`}
        >
          {toast.showIcon && (
            <div className="mt-1 flex-shrink-0 flex-grow-0">
              <svg
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                viewBox="0 0 24 24"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="icon-sm"
                height="1em"
                width="1em"
                xmlns="http://www.w3.org/2000/svg"
              >
                <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
          )}
          <RadixToast.Description className="flex-1 justify-center gap-2">
            <div className="whitespace-pre-wrap text-left">{toast.message}</div>
          </RadixToast.Description>
          {persistent && (
            <RadixToast.Close
              aria-label={localize('com_ui_close')}
              className="ml-2 inline-flex flex-shrink-0 flex-grow-0 items-center justify-center self-center rounded-sm opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            >
              <X className="h-4 w-4" strokeWidth={3} />
            </RadixToast.Close>
          )}
        </div>
      </div>
    </RadixToast.Root>
  );
}
