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

/** A separator reports the axis it divides, which is the opposite of its group's
 *  orientation: a vertical group stacks panels, so its handle is a horizontal bar. */
const handleBase =
  'group relative flex w-px items-center justify-center bg-border-medium after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-focus-control focus-visible:ring-offset-1 aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2';

const handleGrip =
  'z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-border-light bg-border-medium group-aria-[orientation=horizontal]:h-3 group-aria-[orientation=horizontal]:w-4';

const gripIcon = 'h-2.5 w-2.5 group-aria-[orientation=horizontal]:rotate-90';

const ResizableHandle = ({
  withHandle,
  className = '',
  ...props
}: ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}): JSX.Element => (
  <Separator className={cn(handleBase, className)} {...props}>
    {withHandle && (
      <div className={handleGrip}>
        <GripVertical className={gripIcon} />
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
  <Separator className={cn(handleBase, className)} {...props}>
    {withHandle && (
      <div
        className={cn(
          handleGrip,
          'invisible group-hover:visible group-active:visible group-data-[separator=active]:visible',
        )}
      >
        <GripVertical className={gripIcon} />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle, ResizableHandleAlt };
