import DragDropOverlay from '~/components/Chat/Input/Files/DragDropOverlay';
import DragDropModal from '~/components/Chat/Input/Files/DragDropModal';
import { DragDropProvider, UploadModalProvider } from '~/Providers';
import { useDragHelpers } from '~/hooks';
import { cn } from '~/utils';

interface DragDropWrapperProps {
  children: React.ReactNode;
  className?: string;
}

function DragDropArea({ children, className }: DragDropWrapperProps) {
  const { isOver, canDrop, drop } = useDragHelpers();
  const isActive = canDrop && isOver;

  return (
    <div ref={drop} className={cn('relative flex h-full w-full', className)}>
      {children}
      {/** Always render overlay to avoid mount/unmount overhead */}
      <DragDropOverlay isActive={isActive} />
      <DragDropModal />
    </div>
  );
}

export default function DragDropWrapper({ children, className }: DragDropWrapperProps) {
  return (
    <DragDropProvider>
      <UploadModalProvider>
        <DragDropArea className={className}>{children}</DragDropArea>
      </UploadModalProvider>
    </DragDropProvider>
  );
}
