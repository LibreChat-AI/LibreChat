import { useRecoilState } from 'recoil';
import { ForkOptions } from 'librechat-data-provider';
import { Dropdown, Switch, InfoHoverCard, ESide } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

export const ForkSettings = () => {
  const localize = useLocalize();
  const [forkSetting, setForkSetting] = useRecoilState(store.forkSetting);
  const [splitAtTarget, setSplitAtTarget] = useRecoilState(store.splitAtTarget);
  const [remember, setRemember] = useRecoilState<boolean>(store.rememberDefaultFork);

  const forkOptions = [
    { value: ForkOptions.DIRECT_PATH, label: localize('com_ui_fork_visible') },
    { value: ForkOptions.INCLUDE_BRANCHES, label: localize('com_ui_fork_branches') },
    { value: ForkOptions.TARGET_LEVEL, label: localize('com_ui_fork_all_target') },
  ];

  return (
    <>
      <div className="pb-3">
        <div className="flex items-center justify-between">
          <div id="remember-default-fork-label"> {localize('com_ui_fork_default')} </div>
          <Switch
            id="rememberDefaultFork"
            checked={remember}
            onCheckedChange={setRemember}
            className="ml-4"
            data-testid="rememberDefaultFork"
            aria-labelledby="remember-default-fork-label"
          />
        </div>
      </div>
      {remember && (
        <div className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div id="fork-change-default-label">{localize('com_ui_fork_change_default')}</div>
              <InfoHoverCard
                side={ESide.Bottom}
                text={localize('com_nav_info_fork_change_default')}
              />
            </div>
            <Dropdown
              value={forkSetting}
              onChange={setForkSetting}
              options={forkOptions}
              sizeClasses="z-[50] w-[min(12.5rem,90vw)]"
              testId="fork-setting-dropdown"
              className="z-[50]"
              aria-labelledby="fork-change-default-label"
            />
          </div>
        </div>
      )}
      <div className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div id="split-at-target-label">{localize('com_ui_fork_split_target_setting')}</div>
            <InfoHoverCard
              side={ESide.Bottom}
              text={localize('com_nav_info_fork_split_target_setting')}
            />
          </div>
          <Switch
            id="splitAtTarget"
            checked={splitAtTarget}
            onCheckedChange={setSplitAtTarget}
            className="ml-4"
            data-testid="splitAtTarget"
            aria-labelledby="split-at-target-label"
          />
        </div>
      </div>
    </>
  );
};
