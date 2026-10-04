import React, { memo, useState, useRef } from 'react';
import { useRecoilState } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { VisuallyHidden } from '@ariakit/react';
import { GitFork, InfoIcon } from 'lucide-react';
import { ForkOptions } from 'librechat-data-provider';
import { GitCommit, GitBranchPlus, ListTree } from 'lucide-react';
import { Button, Label, Checkbox, useToastContext } from '@librechat/client';
import { TranslationKeys, useLocalize, useNavigateToConvo } from '~/hooks';
import { useForkConvoMutation } from '~/data-provider';
import { hoverButtonClasses } from './styles';
import store from '~/store';

interface PopoverButtonProps {
  children: React.ReactNode;
  setting: ForkOptions;
  onClick: (setting: ForkOptions) => void;
  setActiveSetting: React.Dispatch<React.SetStateAction<TranslationKeys>>;
  timeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  hoverInfo?: React.ReactNode | string;
  hoverTitle?: React.ReactNode | string;
  hoverDescription?: React.ReactNode | string;
  label: string;
}

const optionLabels: Record<ForkOptions, TranslationKeys> = {
  [ForkOptions.DIRECT_PATH]: 'com_ui_fork_visible',
  [ForkOptions.INCLUDE_BRANCHES]: 'com_ui_fork_branches',
  [ForkOptions.TARGET_LEVEL]: 'com_ui_fork_all_target',
  [ForkOptions.DEFAULT]: 'com_ui_fork_from_message',
};

const chevronDown = (
  <svg width="1em" height="1em" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
    />
  </svg>
);

const PopoverButton: React.FC<PopoverButtonProps> = ({
  children,
  setting,
  onClick,
  setActiveSetting,
  timeoutRef,
  hoverInfo,
  hoverTitle,
  hoverDescription,
  label,
}) => {
  const localize = useLocalize();

  return (
    <Ariakit.HovercardProvider placement="right-start">
      <div className="flex flex-col items-center">
        <Ariakit.HovercardAnchor
          render={
            <Ariakit.Button
              onClick={() => onClick(setting)}
              onMouseEnter={() => {
                if (timeoutRef.current) {
                  clearTimeout(timeoutRef.current);
                  timeoutRef.current = null;
                }
                setActiveSetting(optionLabels[setting]);
              }}
              onMouseLeave={() => {
                if (timeoutRef.current) {
                  clearTimeout(timeoutRef.current);
                }
                timeoutRef.current = setTimeout(() => {
                  setActiveSetting(optionLabels[ForkOptions.DEFAULT]);
                }, 175);
              }}
              onFocus={() => {
                if (timeoutRef.current) {
                  clearTimeout(timeoutRef.current);
                  timeoutRef.current = null;
                }
                setActiveSetting(optionLabels[setting]);
              }}
              onBlur={() => {
                if (timeoutRef.current) {
                  clearTimeout(timeoutRef.current);
                }
                timeoutRef.current = setTimeout(() => {
                  setActiveSetting(optionLabels[ForkOptions.DEFAULT]);
                }, 175);
              }}
              className="border-border-medium bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary mx-0.5 w-14 flex-1 rounded-xl border-2 transition duration-200 ease-in-out"
              aria-label={label}
            >
              {children}
              <VisuallyHidden>{label}</VisuallyHidden>
            </Ariakit.Button>
          }
        />
        <Ariakit.HovercardDisclosure className="text-text-secondary focus:ring-text-primary rounded-full focus:ring-2 focus:outline-hidden">
          <VisuallyHidden>
            {localize('com_ui_fork_more_details_about', { 0: label })}
          </VisuallyHidden>
          {chevronDown}
        </Ariakit.HovercardDisclosure>
        {((hoverInfo != null && hoverInfo !== '') ||
          (hoverTitle != null && hoverTitle !== '') ||
          (hoverDescription != null && hoverDescription !== '')) && (
          <Ariakit.Hovercard
            gutter={16}
            shift={40}
            flip={false}
            className="border-border-medium bg-surface-secondary text-text-primary z-[999] w-80 rounded-2xl border p-4 shadow-md"
            portal={true}
            unmountOnHide={true}
          >
            <div className="space-y-2">
              <p className="text-text-secondary flex flex-col gap-2 text-sm">
                {hoverInfo && hoverInfo}
                {hoverTitle && <span className="flex flex-wrap gap-1 font-bold">{hoverTitle}</span>}
                {hoverDescription && hoverDescription}
              </p>
            </div>
          </Ariakit.Hovercard>
        )}
      </div>
    </Ariakit.HovercardProvider>
  );
};

interface CheckboxOptionProps {
  id: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  labelKey: TranslationKeys;
  infoKey: TranslationKeys;
  showToastOnCheck?: boolean;
}
const CheckboxOption: React.FC<CheckboxOptionProps> = ({
  id,
  checked,
  onToggle,
  labelKey,
  infoKey,
  showToastOnCheck = false,
}) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  return (
    <Ariakit.HovercardProvider placement="right-start">
      <div className="flex items-center justify-between">
        <Ariakit.HovercardAnchor
          render={
            <div className="flex items-center">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(value) => {
                  const isChecked = value === true;
                  if (isChecked && showToastOnCheck) {
                    showToast({
                      message: localize('com_ui_fork_remember_checked'),
                      status: 'info',
                    });
                  }
                  onToggle(isChecked);
                }}
                className="transition duration-300 ease-in-out"
                aria-label={localize(labelKey)}
              />
              <Label
                htmlFor={id}
                className="text-text-secondary hover:text-text-primary ml-2 w-auto cursor-pointer text-sm break-normal select-none"
              >
                {localize(labelKey)}
              </Label>
            </div>
          }
        />
        <Ariakit.HovercardDisclosure className="text-text-secondary focus:ring-text-primary ml-1 rounded-full focus:ring-2 focus:outline-hidden">
          <VisuallyHidden>{localize(infoKey)}</VisuallyHidden>
          {chevronDown}
        </Ariakit.HovercardDisclosure>
      </div>
      <Ariakit.Hovercard
        gutter={14}
        shift={40}
        flip={false}
        className="border-border-medium bg-surface-secondary text-text-primary z-[999] w-80 rounded-2xl border p-4 shadow-md"
        portal={true}
        unmountOnHide={true}
      >
        <div className="space-y-2">
          <p className="text-text-secondary text-sm">{localize(infoKey)}</p>
        </div>
      </Ariakit.Hovercard>
    </Ariakit.HovercardProvider>
  );
};

function Fork({
  messageId,
  conversationId: _convoId,
  forkingSupported = false,
  getLatestMessageId,
  isLast = false,
}: {
  messageId: string;
  conversationId: string | null;
  forkingSupported?: boolean;
  /** Read when a fork starts: the split target must be the tail at click time. */
  getLatestMessageId?: () => string | undefined;
  isLast?: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [remember, setRemember] = useState(false);
  const { navigateToConvo } = useNavigateToConvo();
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [forkSetting, setForkSetting] = useRecoilState(store.forkSetting);
  const [activeSetting, setActiveSetting] = useState(optionLabels.default);
  const [splitAtTarget, setSplitAtTarget] = useRecoilState(store.splitAtTarget);
  const [rememberGlobal, setRememberGlobal] = useRecoilState(store.rememberDefaultFork);
  const popoverStore = Ariakit.usePopoverStore({
    placement: 'bottom',
  });
  /** Read the open state from the store rather than mirroring it: Escape and
   *  outside clicks close the popover without going through the trigger, so a
   *  hand-kept copy would leave the button reading as active forever. */
  const isActive = Ariakit.useStoreState(popoverStore, 'open');

  const buttonStyle = hoverButtonClasses({ isActive, isLast });

  const forkConvo = useForkConvoMutation({
    onSuccess: (data) => {
      navigateToConvo(data.conversation);
      showToast({
        message: localize('com_ui_fork_success'),
        status: 'success',
      });
    },
    onMutate: () => {
      showToast({
        message: localize('com_ui_fork_processing'),
        status: 'info',
      });
    },
    onError: (error) => {
      /** Rate limit error (429 status code) */
      const isRateLimitError =
        (error as any)?.response?.status === 429 ||
        (error as any)?.status === 429 ||
        (error as any)?.statusCode === 429;

      showToast({
        message: isRateLimitError
          ? localize('com_ui_fork_error_rate_limit')
          : localize('com_ui_fork_error'),
        status: 'error',
      });
    },
  });

  const conversationId = _convoId ?? '';
  if (!forkingSupported || !conversationId || !messageId) {
    return null;
  }

  const onClick = (option: string) => {
    if (remember) {
      setRememberGlobal(true);
      setForkSetting(option);
    }

    forkConvo.mutate({
      messageId,
      conversationId,
      option,
      splitAtTarget,
      latestMessageId: getLatestMessageId?.(),
    });
  };

  const forkOptionsConfig = [
    {
      setting: ForkOptions.DIRECT_PATH,
      label: localize(optionLabels[ForkOptions.DIRECT_PATH]),
      icon: <GitCommit className="h-full w-full rotate-90 p-2" aria-hidden="true" />,
      hoverTitle: (
        <>
          <GitCommit className="h-5 w-5 rotate-90" aria-hidden="true" />
          {localize(optionLabels[ForkOptions.DIRECT_PATH])}
        </>
      ),
      hoverDescription: localize('com_ui_fork_info_visible'),
    },
    {
      setting: ForkOptions.INCLUDE_BRANCHES,
      label: localize(optionLabels[ForkOptions.INCLUDE_BRANCHES]),
      icon: <GitBranchPlus className="h-full w-full rotate-180 p-2" aria-hidden="true" />,
      hoverTitle: (
        <>
          <GitBranchPlus className="h-4 w-4 rotate-180" aria-hidden="true" />
          {localize(optionLabels[ForkOptions.INCLUDE_BRANCHES])}
        </>
      ),
      hoverDescription: localize('com_ui_fork_info_branches'),
    },
    {
      setting: ForkOptions.TARGET_LEVEL,
      label: localize(optionLabels[ForkOptions.TARGET_LEVEL]),
      icon: <ListTree className="h-full w-full p-2" aria-hidden="true" />,
      hoverTitle: (
        <>
          <ListTree className="h-5 w-5" aria-hidden="true" />
          {`${localize(optionLabels[ForkOptions.TARGET_LEVEL])} (${localize('com_endpoint_default')})`}
        </>
      ),
      hoverDescription: localize('com_ui_fork_info_target'),
    },
  ];

  return (
    <>
      <Ariakit.PopoverAnchor
        store={popoverStore}
        render={
          <Button
            variant="ghost"
            size="icon"
            className={buttonStyle}
            onClick={(e) => {
              if (rememberGlobal) {
                e.preventDefault();
                forkConvo.mutate({
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
            <GitFork size="19" aria-hidden="true" />
          </Button>
        }
      />
      <Ariakit.Popover
        store={popoverStore}
        gutter={10}
        className={`popover-animate ${isActive ? 'open' : ''} border-border-medium bg-surface-secondary flex w-60 flex-col gap-3 overflow-hidden rounded-2xl border p-2 px-4 shadow-lg`}
        style={{
          outline: 'none',
          pointerEvents: 'auto',
          zIndex: 50,
        }}
        portal={true}
        unmountOnHide={true}
      >
        <div className="text-text-primary flex h-8 w-full items-center justify-center text-sm">
          {localize(activeSetting)}
          <Ariakit.HovercardProvider placement="right-start">
            <div className="ml-auto flex h-6 w-6 items-center justify-center gap-1">
              <Ariakit.HovercardAnchor
                render={
                  <button
                    className="text-text-secondary flex h-5 w-5 cursor-help items-center rounded-full"
                    aria-label={localize('com_ui_fork_info_button_label')}
                  >
                    <InfoIcon aria-hidden="true" />
                  </button>
                }
              />
              <Ariakit.HovercardDisclosure className="text-text-secondary focus:ring-text-primary rounded-full focus:ring-2 focus:outline-hidden">
                <VisuallyHidden>{localize('com_ui_fork_more_info_options')}</VisuallyHidden>
                {chevronDown}
              </Ariakit.HovercardDisclosure>
            </div>
            <Ariakit.Hovercard
              gutter={19}
              shift={40}
              flip={false}
              className="border-border-medium bg-surface-secondary text-text-primary z-[999] w-80 rounded-2xl border p-4 shadow-md"
              portal={true}
              unmountOnHide={true}
            >
              <div className="text-text-secondary flex flex-col gap-2 space-y-2 text-sm">
                <span>{localize('com_ui_fork_info_1')}</span>
                <span>{localize('com_ui_fork_info_2')}</span>
                <span>
                  {localize('com_ui_fork_info_3', {
                    0: localize('com_ui_fork_split_target'),
                  })}
                </span>
              </div>
            </Ariakit.Hovercard>
          </Ariakit.HovercardProvider>
        </div>
        <div className="flex h-full w-full items-center justify-center gap-1">
          {forkOptionsConfig.map((opt) => (
            <PopoverButton
              key={opt.setting}
              setActiveSetting={setActiveSetting}
              timeoutRef={timeoutRef}
              onClick={onClick}
              setting={opt.setting}
              label={opt.label}
              hoverTitle={opt.hoverTitle}
              hoverDescription={opt.hoverDescription}
            >
              {opt.icon}
            </PopoverButton>
          ))}
        </div>
        <CheckboxOption
          id="split-target-checkbox"
          checked={splitAtTarget}
          onToggle={setSplitAtTarget}
          labelKey="com_ui_fork_split_target"
          infoKey="com_ui_fork_info_start"
        />
        <CheckboxOption
          id="remember-checkbox"
          checked={remember}
          onToggle={(checked) => {
            if (checked)
              showToast({ message: localize('com_ui_fork_remember_checked'), status: 'info' });
            setRemember(checked);
          }}
          labelKey="com_ui_fork_remember"
          infoKey="com_ui_fork_info_remember"
          showToastOnCheck
        />
      </Ariakit.Popover>
    </>
  );
}

/** Memoized: a send re-renders every row's toolbar, and nothing here depends on it. */
export default memo(Fork);
