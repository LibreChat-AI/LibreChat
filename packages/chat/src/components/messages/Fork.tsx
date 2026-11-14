import React, { memo, useId, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { GitFork, ChevronDown } from 'lucide-react';
import { ForkOptions } from 'librechat-data-provider';
import {
  Radio,
  Label,
  Button,
  Checkbox,
  useLocalize,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import type { TForkConvoRequest } from 'librechat-data-provider';
import type { TranslationKeys } from '@librechat/client';
import type { NamedExoticComponent } from 'react';
import { useMessagesHost } from '../../react/messages/host';

interface CompactCheckboxProps {
  id: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  label: string;
}

const CompactCheckbox: React.FC<CompactCheckboxProps> = ({ id, checked, onToggle, label }) => (
  <div className="flex items-center gap-2">
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={(value) => onToggle(value === true)}
      variant="fade"
      aria-label={label}
    />
    <Label
      htmlFor={id}
      variant="option"
      className="w-auto cursor-pointer text-xs break-normal select-none"
    >
      {label}
    </Label>
  </div>
);

type ForkProps = {
  messageId: string;
  conversationId: string | null;
  forkingSupported?: boolean;
  /** Read when a fork starts: the split target must be the tail at click time. */
  getLatestMessageId?: () => string | undefined;
  isLast?: boolean;
};

/** Whether a failed fork was refused by the rate limiter, however the transport reports it. */
function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) {
    return false;
  }
  const { status, statusCode, response } = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return response?.status === 429 || status === 429 || statusCode === 429;
}

function Fork({
  messageId,
  conversationId: _convoId,
  forkingSupported = false,
  getLatestMessageId,
  isLast = false,
}: ForkProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [remember, setRemember] = useState(false);
  /** Per fork, never remembered: a copy without files is a recovery step, not a preference. */
  const [excludeFiles, setExcludeFiles] = useState(false);
  const host = useMessagesHost();
  const forkConversation = host.useForkConversation();
  const {
    option: forkSetting,
    setOption: setForkSetting,
    splitAtTarget,
    setSplitAtTarget,
    rememberOption: rememberGlobal,
    setRememberOption: setRememberGlobal,
  } = host.useForkPreferences();
  const groupId = useId();
  const defaultMode = forkSetting || ForkOptions.TARGET_LEVEL;
  const [selected, setSelected] = useState<string>(defaultMode);
  /** The stored default can change while this toolbar stays mounted (Settings does it), so the
   *  picked mode follows it. Adjusting state during render replaces the pick before the first
   *  paint; an effect would paint the old mode once. */
  const [seenDefault, setSeenDefault] = useState(defaultMode);
  if (seenDefault !== defaultMode) {
    setSeenDefault(defaultMode);
    setSelected(defaultMode);
  }
  const [showMore, setShowMore] = useState(false);
  const popoverStore = Ariakit.usePopoverStore({
    placement: 'bottom',
  });
  /** Read the open state from the store rather than mirroring it: Escape and
   *  outside clicks close the popover without going through the trigger, so a
   *  hand-kept copy would leave the button reading as active forever. */
  const isActive = Ariakit.useStoreState(popoverStore, 'open');

  const startFork = (request: TForkConvoRequest) => {
    if (forkConversation == null) {
      return;
    }
    showToast({ message: localize('com_ui_fork_processing'), status: 'info' });
    forkConversation(request, {
      onSuccess: () => showToast({ message: localize('com_ui_fork_success'), status: 'success' }),
      onError: (error) =>
        showToast({
          message: isRateLimited(error)
            ? localize('com_ui_fork_error_rate_limit')
            : localize('com_ui_fork_error'),
          status: 'error',
        }),
    });
  };

  const conversationId = _convoId ?? '';
  if (!forkingSupported || forkConversation == null || !conversationId || !messageId) {
    return null;
  }

  const onClick = (option: string) => {
    if (remember) {
      setRememberGlobal(true);
      setForkSetting(option);
    }

    startFork({
      messageId,
      conversationId,
      option,
      splitAtTarget,
      latestMessageId: getLatestMessageId?.(),
      ...(excludeFiles ? { excludeFiles } : {}),
    });
  };

  const scopeOptions = [
    { value: 'before', label: localize('com_ui_fork_scope_before') },
    { value: 'after', label: localize('com_ui_fork_scope_after') },
  ];
  const modeOptions = [
    { value: ForkOptions.DIRECT_PATH, label: localize('com_ui_fork_mode_visible') },
    { value: ForkOptions.INCLUDE_BRANCHES, label: localize('com_ui_fork_mode_branches') },
    { value: ForkOptions.TARGET_LEVEL, label: localize('com_ui_fork_mode_all') },
  ];
  const modeHelp: Record<string, TranslationKeys> = {
    [ForkOptions.DIRECT_PATH]: 'com_ui_fork_desc_visible',
    [ForkOptions.INCLUDE_BRANCHES]: 'com_ui_fork_desc_branches',
    [ForkOptions.TARGET_LEVEL]: 'com_ui_fork_desc_target',
  };

  return (
    <>
      <Ariakit.PopoverAnchor
        store={popoverStore}
        render={
          <TooltipAnchor
            description={localize('com_ui_fork_open_menu')}
            render={
              <Button
                variant={isLast ? 'message-hover' : 'message-hover-reveal'}
                data-hover-active={isActive || undefined}
                onClick={(e) => {
                  if (rememberGlobal) {
                    e.preventDefault();
                    startFork({
                      messageId,
                      splitAtTarget,
                      conversationId,
                      option: forkSetting,
                      latestMessageId: getLatestMessageId?.(),
                    });
                  } else {
                    popoverStore.toggle();
                  }
                }}
                type="button"
                aria-label={localize('com_ui_fork_open_menu')}
              >
                <GitFork className="size-[1.1875rem]" aria-hidden="true" />
              </Button>
            }
          />
        }
      />
      <Ariakit.Popover
        store={popoverStore}
        gutter={10}
        aria-labelledby={`${groupId}-title`}
        className="animate-composer-popover border-border-medium bg-surface-secondary rounded-theme-popover pointer-events-auto flex w-[min(21rem,92vw)] flex-col overflow-hidden border p-4 shadow-lg outline-none motion-reduce:transition-none"
        style={{ zIndex: 50 }}
        portal={true}
        unmountOnHide={true}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            popoverStore.hide();
            onClick(selected);
          }}
        >
          <div className="flex flex-col gap-0.5">
            <h2 id={`${groupId}-title`} className="text-text-primary text-sm font-semibold">
              {localize('com_ui_fork_from_message')}
            </h2>
            <p className="text-text-secondary text-xs">{localize('com_ui_fork_subtitle')}</p>
          </div>
          <div className="flex flex-col gap-2.5">
            <Radio
              tone="raised"
              fullWidth
              options={scopeOptions}
              value={splitAtTarget ? 'after' : 'before'}
              onChange={(value) => setSplitAtTarget(value === 'after')}
              aria-labelledby={`${groupId}-title`}
            />
            <p className="text-text-secondary text-xs" aria-live="polite">
              {localize(
                splitAtTarget ? 'com_ui_fork_scope_after_help' : 'com_ui_fork_scope_before_help',
              )}
            </p>
          </div>
          <div className="flex flex-col">
            <Button
              type="button"
              variant="inline-link"
              className="self-start"
              aria-expanded={showMore}
              aria-controls={`${groupId}-more`}
              onClick={() => setShowMore((open) => !open)}
            >
              {localize(showMore ? 'com_ui_fork_fewer_options' : 'com_ui_fork_more_options')}
              <ChevronDown
                className={`size-4 transition-transform duration-300 ease-out motion-reduce:transition-none ${showMore ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </Button>
            <div
              id={`${groupId}-more`}
              aria-hidden={!showMore || undefined}
              {...(showMore ? {} : { inert: '' })}
              className={`grid transition-all duration-300 ease-out motion-reduce:transition-none ${showMore ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            >
              <div className="-m-1 min-h-0 overflow-hidden">
                <div
                  className={`transition-opacity duration-300 ease-out motion-reduce:transition-none ${showMore ? 'opacity-100' : 'opacity-0'}`}
                >
                  {/* The space under the link lives inside the reveal, so a collapsed region leaves no gap. */}
                  <div className="flex flex-col gap-3 p-1 pt-4">
                    <div className="flex flex-col gap-2">
                      <span
                        id={`${groupId}-mode`}
                        className="text-text-primary text-xs font-medium"
                      >
                        {localize('com_ui_fork_include')}
                      </span>
                      <Radio
                        tone="raised"
                        fullWidth
                        size="sm"
                        options={modeOptions}
                        value={selected}
                        onChange={setSelected}
                        aria-labelledby={`${groupId}-mode`}
                      />
                      <p className="text-text-secondary text-xs" aria-live="polite">
                        {localize(modeHelp[selected] ?? 'com_ui_fork_desc_target')}
                      </p>
                    </div>
                    <CompactCheckbox
                      id="exclude-files-checkbox"
                      checked={excludeFiles}
                      onToggle={setExcludeFiles}
                      label={localize('com_ui_fork_exclude_files')}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="border-border-light flex items-center justify-between gap-3 border-t pt-3">
            <CompactCheckbox
              id="remember-checkbox"
              checked={remember}
              onToggle={setRemember}
              label={localize('com_ui_fork_remember')}
            />
            <Button type="submit" variant="submit">
              <GitFork className="size-4" aria-hidden="true" />
              {localize('com_ui_fork')}
            </Button>
          </div>
        </form>
      </Ariakit.Popover>
    </>
  );
}

/** Memoized: a send re-renders every row's toolbar, and nothing here depends on it. */
const MemoFork: NamedExoticComponent<ForkProps> = memo(Fork);

export default MemoFork;
