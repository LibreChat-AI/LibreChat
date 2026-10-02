import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Pencil, Check, Loader2, X } from 'lucide-react';
import { Input, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

type Props = {
  name?: string;
  isLoading?: boolean;
  isError?: boolean;
  onSave: (newName: string) => void;
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const PromptName: React.FC<Props> = ({ name, isLoading = false, isError = false, onSave }) => {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  const wasLoadingRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** Prevents duplicate saves when Enter/Escape already called commitName before blur fires */
  const skipBlurRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(name);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  }, []);

  const commitName = useCallback(() => {
    const savedName = newName?.trim();
    if (savedName && savedName !== name) {
      setSaveStatus('saving');
      onSave(savedName);
    } else {
      setNewName(name);
    }
    setIsEditing(false);
  }, [newName, name, onSave]);

  const saveName = useCallback(() => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    commitName();
  }, [commitName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        skipBlurRef.current = true;
        setNewName(name);
        setIsEditing(false);
      }
      // Ignore the Enter that commits an IME composition (see useTextarea.ts).
      if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
        e.preventDefault();
        skipBlurRef.current = true;
        commitName();
      }
    },
    [name, commitName],
  );

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (isLoading) {
      setSaveStatus('saving');
    } else if (wasLoadingRef.current && !isLoading) {
      setSaveStatus(isError ? 'error' : 'saved');
      if (isError) {
        setNewName(name);
      }
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, isError, name]);

  useEffect(() => {
    setNewName(name);
  }, [name]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const displayButton = (
    <button
      type="button"
      onClick={() => {
        if (!isLoading && saveStatus !== 'saving') {
          setIsEditing(true);
        }
      }}
      className="text-text-primary hover:text-text-secondary h-8 min-w-0 flex-1 cursor-text truncate pl-2 text-left text-base font-semibold transition-colors focus:outline-hidden"
      aria-label={localize('com_ui_edit') + ': ' + (newName ?? '')}
    >
      {newName}
    </button>
  );

  const readView = newName ? (
    <TooltipAnchor description={newName} render={displayButton} />
  ) : (
    displayButton
  );

  return (
    <div className="group/title relative mr-2 flex h-8 min-w-0 flex-1 items-center">
      {isEditing ? (
        <Input
          ref={inputRef}
          type="text"
          value={newName ?? ''}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={saveName}
          disabled={isLoading}
          className="text-text-primary focus:border-border-medium h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent pr-0 pl-2 text-base font-semibold disabled:opacity-60"
          aria-label={localize('com_ui_name')}
        />
      ) : (
        readView
      )}
      <div className="ml-1.5 flex shrink-0 items-center justify-center">
        {saveStatus === 'saving' && (
          <Loader2
            className="text-text-secondary size-4 animate-spin"
            aria-label={localize('com_ui_saving')}
          />
        )}
        {saveStatus === 'saved' && (
          <Check
            className="text-status-success size-4 transition-opacity duration-300"
            aria-label={localize('com_ui_saved')}
          />
        )}
        {saveStatus === 'error' && (
          <X
            className="text-text-destructive size-4 transition-opacity duration-300"
            aria-label={localize('com_ui_error')}
          />
        )}
        {saveStatus === 'idle' && !isEditing && (
          <Pencil
            className="text-text-secondary size-3.5 opacity-0 transition-opacity group-hover/title:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
};

export default PromptName;
