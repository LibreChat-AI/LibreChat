import { useRef, useState, useEffect, useCallback } from 'react';
import { Import, Upload } from 'lucide-react';
import { Label, Button, Spinner } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface DropzoneProps {
  onFile: (file: File) => void;
  isUploading: boolean;
  focusOnMount?: boolean;
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return transfer?.types?.includes('Files') === true;
}

/**
 * The visible control is an ordinary settings row, matching its siblings.
 * Drag-and-drop is an additional affordance revealed only while a file is
 * dragged over this row, so the section stays compact at rest.
 *
 * The enter/leave counter is required: both events fire for every child
 * element crossed during a drag, so a naive boolean flickers the overlay off
 * as soon as the pointer moves between the label and the button.
 */
export default function Dropzone({ onFile, isUploading, focusOnMount = false }: DropzoneProps) {
  const localize = useLocalize();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const depthRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (focusOnMount) {
      buttonRef.current?.focus();
    }
  }, [focusOnMount]);

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        onFile(file);
      }
      event.target.value = '';
    },
    [onFile],
  );

  useEffect(() => {
    const surface = rootRef.current;
    if (!surface || isUploading) {
      return;
    }

    const reset = () => {
      depthRef.current = 0;
      setIsDragging(false);
    };

    const onDragEnter = (event: Event) => {
      const transfer = (event as DragEvent).dataTransfer;
      if (!hasFiles(transfer)) {
        return;
      }
      depthRef.current += 1;
      setIsDragging(true);
    };

    const onDragOver = (event: Event) => {
      if (hasFiles((event as DragEvent).dataTransfer)) {
        event.preventDefault();
      }
    };

    const onDragLeave = (event: Event) => {
      if (!hasFiles((event as DragEvent).dataTransfer)) {
        return;
      }
      depthRef.current -= 1;
      if (depthRef.current <= 0) {
        reset();
      }
    };

    const onDrop = (event: Event) => {
      const transfer = (event as DragEvent).dataTransfer;
      if (!hasFiles(transfer)) {
        return;
      }
      event.preventDefault();
      reset();
      const file = transfer?.files?.[0];
      if (file) {
        onFile(file);
      }
    };

    surface.addEventListener('dragenter', onDragEnter);
    surface.addEventListener('dragover', onDragOver);
    surface.addEventListener('dragleave', onDragLeave);
    surface.addEventListener('drop', onDrop);

    return () => {
      surface.removeEventListener('dragenter', onDragEnter);
      surface.removeEventListener('dragover', onDragOver);
      surface.removeEventListener('dragleave', onDragLeave);
      surface.removeEventListener('drop', onDrop);
    };
  }, [onFile, isUploading]);

  return (
    <div ref={rootRef} className="relative flex items-center justify-between">
      <Label id="import-data-label">{localize('com_ui_settings_label_import')}</Label>

      {/* Named by the row label AND its own content so the accessible name
          always contains the visible text, including while it reads
          "Importing" (WCAG 2.5.3). */}
      <Button
        ref={buttonRef}
        id="import-data-button"
        variant="outline"
        aria-labelledby="import-data-label import-data-button"
        disabled={isUploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {isUploading ? (
          <>
            <Spinner className="mr-1 size-4" aria-hidden="true" />
            <span>{localize('com_ui_importing')}</span>
          </>
        ) : (
          <>
            <Import className="mr-1 size-4" aria-hidden="true" />
            <span>{localize('com_ui_import')}</span>
          </>
        )}
      </Button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.zip"
        className="hidden"
        onChange={handleFileInput}
      />

      {/* Always mounted so the fade runs on the way out as well as in;
          conditionally rendering it would snap straight to the end state.
          The insets cancel the row wrapper's `px-4 py-3` so the tint reaches
          the section card's edges. `rounded-t-xl` matches the card's own
          `rounded-xl`, since this row sits at the top of its section. */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute -inset-x-4 -inset-y-3 z-10 rounded-t-xl',
          'flex items-center justify-center gap-2 text-sm font-medium',
          'transition-opacity duration-200 ease-out motion-reduce:transition-none',
          isDragging
            ? 'bg-surface-primary/70 opacity-100 backdrop-blur-sm'
            : 'bg-transparent opacity-0',
        )}
      >
        <Upload className="text-text-primary size-4 shrink-0" />
        <span className="text-text-primary">{localize('com_ui_import_drop')}</span>
      </div>
    </div>
  );
}
