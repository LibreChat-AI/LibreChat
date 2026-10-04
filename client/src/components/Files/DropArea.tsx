import { useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { cn } from '~/utils';

export default function FileDropArea({
  children,
  className,
  onFiles,
  disabled,
  dropRef,
  overlay,
}: {
  children: ReactNode;
  className?: string;
  onFiles?: (files: File[]) => void;
  disabled?: boolean;
  dropRef?: Ref<HTMLDivElement>;
  overlay?: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      ref={dropRef}
      className={cn('relative', className, dragging && 'ring-border-heavy ring-2')}
      onDragOver={(event) => {
        if (!onFiles || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        setDragging(!disabled);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!onFiles) return;
        event.preventDefault();
        setDragging(false);
        if (!disabled) onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {overlay}
    </div>
  );
}
