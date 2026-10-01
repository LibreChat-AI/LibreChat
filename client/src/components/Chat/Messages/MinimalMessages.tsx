import React from 'react';
import { cn } from '~/utils';

const MinimalMessages = React.forwardRef(
  (
    props: { children: React.ReactNode; className?: string },
    ref: React.ForwardedRef<HTMLDivElement>,
  ) => {
    return (
      <div
        className={cn(
          'bg-surface-secondary relative flex w-full grow overflow-hidden',
          props.className,
        )}
      >
        <div className="bg-surface-secondary relative h-full w-full flex-1 overflow-auto">
          <div className="flex h-full flex-col" role="presentation" tabIndex={0}>
            <div className="flex-1 overflow-hidden overflow-y-auto">
              <div className="relative h-full">
                <div
                  ref={ref}
                  style={{
                    height: '100%',
                    overflowY: 'auto',
                    width: '100%',
                  }}
                >
                  <div className="flex flex-col pb-9 text-sm">
                    {props.children}
                    <div className="group h-0 w-full shrink-0" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

export default MinimalMessages;
