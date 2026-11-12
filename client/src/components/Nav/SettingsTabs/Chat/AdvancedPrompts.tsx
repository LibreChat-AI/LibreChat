import { useCallback, useId } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { Switch, InfoHoverCard, ESide } from '@librechat/client';
import { PromptsEditorMode } from '~/common';
import { useLocalize } from '~/hooks';
import store from '~/store';

const { promptsEditorMode, alwaysMakeProd } = store;

export default function AdvancedPrompts() {
  const localize = useLocalize();
  const [mode, setMode] = useRecoilState(promptsEditorMode);
  const setAlwaysMakeProd = useSetRecoilState(alwaysMakeProd);

  const isAdvanced = mode === PromptsEditorMode.ADVANCED;

  const handleChange = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setAlwaysMakeProd(true);
      }
      setMode(checked ? PromptsEditorMode.ADVANCED : PromptsEditorMode.SIMPLE);
    },
    [setMode, setAlwaysMakeProd],
  );

  const rootId = useId();
  const labelId = `${rootId}-label`;

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <div id={labelId}>{localize('com_nav_advanced_prompts')}</div>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_advanced_prompts_desc')} />
      </div>
      <Switch
        id={rootId}
        checked={isAdvanced}
        onCheckedChange={handleChange}
        className="ms-4"
        data-testid="advancedPrompts"
        aria-labelledby={labelId}
      />
    </div>
  );
}
