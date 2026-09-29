import { JSX } from 'react/jsx-runtime';
import { GripVertical } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { ComponentProps } from 'react';
import { cn } from '~/utils';

const ResizablePanelGroup = ({
  className = '',
  ...props
}: ComponentProps<typeof Group>): JSX.Element => (
  <Group className={cn('h-full w-full', className)} {...props} />
);

const ResizablePanel: typeof Panel = Panel;

const ResizableHandle = ({
  withHandle,
  className = '',
  ...props
}: ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}): JSX.Element => (
  <Separator
    className={cn(
      'bg-border-medium focus-visible:ring-focus-control relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden',
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="bg-border-medium border-border-light z-10 flex h-4 w-3 items-center justify-center rounded-sm border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </Separator>
);

const ResizableHandleAlt = ({
  withHandle,
  className = '',
  ...props
}: ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}): JSX.Element => (
  <Separator
    className={cn(
      'group bg-border-medium focus-visible:ring-focus-control relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden',
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="bg-border-medium border-border-light invisible z-10 flex h-4 w-3 items-center justify-center rounded-sm border group-hover:visible group-active:visible group-data-[separator=active]:visible">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle, ResizableHandleAlt };
