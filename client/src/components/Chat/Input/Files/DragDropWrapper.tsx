import DragDropOverlay from '~/components/Chat/Input/Files/DragDropOverlay';
import DragDropModal from '~/components/Chat/Input/Files/DragDropModal';
import { DragDropProvider, UploadModalProvider } from '~/Providers';
import FileDropArea from '~/components/Files/DropArea';
import { useDragHelpers } from '~/hooks';

interface DragDropWrapperProps {
  children: React.ReactNode;
  className?: string;
}

function DragDropArea({ children, className }: DragDropWrapperProps) {
  const { isOver, canDrop, drop } = useDragHelpers();
  const isActive = canDrop && isOver;

  return (
    <FileDropArea
      dropRef={drop}
      className={`flex h-full w-full ${className ?? ''}`}
      overlay={<DragDropOverlay isActive={isActive} />}
    >
      {children}
      <DragDropModal />
    </FileDropArea>
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
