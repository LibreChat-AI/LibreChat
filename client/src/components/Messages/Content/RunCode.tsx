import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import debounce from 'lodash/debounce';
import { useRecoilCallback } from 'recoil';
import { Tools } from 'librechat-data-provider';
import { SquareTerminal, Check, X } from 'lucide';
import { MorphIcon, Spinner, TooltipAnchor, useToastContext } from '@librechat/client';
import type { IconNode } from '@librechat/client';
import type { CodeBarProps } from '~/common';
import { useToolCallMutation } from '~/data-provider';
import { cn, normalizeLanguage } from '~/utils';
import { useMessageContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

type RunState = 'idle' | 'loading' | 'success' | 'error';

const stateIcons: Record<RunState, IconNode> = {
  idle: SquareTerminal,
  loading: SquareTerminal,
  success: Check,
  error: X,
};

const RunCode: React.FC<CodeBarProps & { iconOnly?: boolean }> = React.memo(
  ({ lang, codeRef, blockIndex, iconOnly = false }) => {
    const localize = useLocalize();
    const { showToast } = useToastContext();
    const execute = useToolCallMutation(Tools.execute_code, {
      onError: () => {
        showToast({ message: localize('com_ui_run_code_error'), status: 'error' });
      },
    });

    const { messageId, conversationId, partIndex } = useMessageContext();
    const normalizedLang = useMemo(() => normalizeLanguage(lang), [lang]);
    // Read at click time so retention context is current without re-rendering every code block.
    const getIsTemporary = useRecoilCallback(
      ({ snapshot }) =>
        () =>
          snapshot.getPromise(store.isTemporary),
      [],
    );

    const handleExecute = useCallback(async () => {
      const codeString: string = codeRef.current?.textContent ?? '';
      if (
        typeof codeString !== 'string' ||
        codeString.length === 0 ||
        typeof normalizedLang !== 'string' ||
        normalizedLang.length === 0
      ) {
        return;
      }

      execute.mutate({
        partIndex,
        messageId,
        blockIndex,
        conversationId: conversationId ?? '',
        lang: normalizedLang,
        code: codeString,
        isTemporary: await getIsTemporary(),
      });
    }, [
      codeRef,
      execute,
      partIndex,
      messageId,
      blockIndex,
      conversationId,
      normalizedLang,
      getIsTemporary,
    ]);

    const debouncedExecute = useMemo(
      () => debounce(handleExecute, 1000, { leading: true }),
      [handleExecute],
    );

    useEffect(() => {
      return () => {
        debouncedExecute.cancel();
      };
    }, [debouncedExecute]);

    const [runState, setRunState] = useState<RunState>('idle');
    const timerRef = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
      if (execute.isLoading) {
        setRunState('loading');
      } else if (runState === 'loading') {
        const next: RunState = execute.isError ? 'error' : 'success';
        setRunState(next);
        timerRef.current = setTimeout(() => setRunState('idle'), next === 'error' ? 2000 : 1500);
      }
      return () => clearTimeout(timerRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [execute.isLoading, execute.isError]);

    if (typeof normalizedLang !== 'string' || normalizedLang.length === 0) {
      return null;
    }

    const isLoading = runState === 'loading';
    const isSuccess = runState === 'success';
    const isError = runState === 'error';
    const isIdle = runState === 'idle';
    const label = localize('com_ui_run_code');

    const stateIcon = stateIcons[runState];

    const button = (
      <button
        type="button"
        onClick={debouncedExecute}
        disabled={isLoading}
        aria-label={label}
        aria-busy={isLoading || undefined}
        className={cn(
          'inline-flex select-none items-center justify-center text-text-secondary transition-all duration-200 ease-out',
          'hover:bg-surface-hover hover:text-text-primary',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy',
          'disabled:pointer-events-none disabled:opacity-50',
          isError && 'text-text-destructive hover:text-text-destructive',
          iconOnly
            ? 'rounded-lg p-1.5'
            : 'ml-auto gap-2 rounded-lg p-1.5 md:rounded-md md:px-2 md:py-1',
        )}
      >
        <span className="relative flex size-[18px] items-center justify-center" aria-hidden="true">
          <MorphIcon
            icon={stateIcon}
            size={18}
            className={cn(
              'absolute transition-opacity duration-300',
              isLoading ? 'opacity-0' : 'opacity-100',
            )}
          />
          <span
            className={cn(
              'absolute transition-opacity duration-300',
              isLoading ? 'opacity-100' : 'opacity-0',
            )}
          >
            {isLoading && <Spinner size={18} />}
          </span>
        </span>
        {!iconOnly && (
          <span className="relative hidden overflow-hidden md:block">
            <span
              className={cn(
                'block whitespace-nowrap transition-all duration-300 ease-out',
                isIdle ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0',
              )}
            >
              {localize('com_ui_run_code')}
            </span>
            <span
              className={cn(
                'absolute inset-0 whitespace-nowrap transition-all duration-300 ease-out',
                isLoading ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0',
              )}
            >
              {localize('com_ui_running')}
            </span>
            <span
              className={cn(
                'absolute inset-0 whitespace-nowrap transition-all duration-300 ease-out',
                isSuccess ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0',
              )}
            >
              {localize('com_ui_complete')}
            </span>
            <span
              className={cn(
                'absolute inset-0 whitespace-nowrap transition-all duration-300 ease-out',
                isError ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0',
              )}
            >
              {localize('com_ui_failed')}
            </span>
          </span>
        )}
      </button>
    );

    return <TooltipAnchor description={label} render={button} />;
  },
);

export default RunCode;
