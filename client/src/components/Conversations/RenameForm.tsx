import React, { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { Button, Input } from '@librechat/client';
import type { KeyboardEvent } from 'react';
import { cn } from '~/utils';

interface RenameFormProps {
  titleInput: string;
  setTitleInput: (value: string) => void;
  onSubmit: (title: string) => void;
  onCancel: () => void;
  localize: (key: any, options?: any) => string;
}

const RenameForm: React.FC<RenameFormProps> = ({
  titleInput,
  setTitleInput,
  onSubmit,
  onCancel,
  localize,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Escape':
        onCancel();
        break;
      case 'Enter':
        onSubmit(titleInput);
        break;
      case 'Tab':
        break;
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex w-full items-center rounded-lg bg-surface-active-alt p-1.5"
      role="form"
      aria-label={localize('com_ui_rename_conversation')}
    >
      <Input
        ref={inputRef}
        type="text"
        className={cn(
          'h-auto w-full rounded border-0 bg-transparent p-0.5 text-sm leading-tight focus-visible:outline-none',
        )}
        value={titleInput}
        onChange={(e) => setTitleInput(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={100}
        aria-label={localize('com_ui_new_conversation_title')}
      />
      <div className="flex gap-1" role="toolbar">
        <Button
          variant="row-action"
          size="icon"
          onClick={() => onCancel()}
          className={cn('size-auto p-1 focus:outline-none focus:ring-2 focus:ring-text-primary')}
          aria-label={localize('com_ui_cancel')}
          type="button"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="row-action"
          size="icon"
          onClick={() => onSubmit(titleInput)}
          className={cn('size-auto p-1 focus:outline-none focus:ring-2 focus:ring-text-primary')}
          aria-label={localize('com_ui_save')}
          type="button"
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
};

export default RenameForm;
