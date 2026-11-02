import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export default function CancelledIcon(): ReactNode {
  return (
    <div className="text-text-secondary flex h-full w-full items-center justify-center rounded-full bg-transparent">
      <X className="size-4" aria-hidden="true" />
    </div>
  );
}
