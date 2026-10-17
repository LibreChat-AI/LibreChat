import { WritableAtom, useAtom } from 'jotai';
import { RecoilState, useRecoilState } from 'recoil';
import { Switch, InfoHoverCard, ESide } from '@librechat/client';
import { useLocalize } from '~/hooks';

type LocalizeFn = ReturnType<typeof useLocalize>;
type LocalizeKey = Parameters<LocalizeFn>[0];

interface ToggleSwitchProps {
  stateAtom: RecoilState<boolean> | WritableAtom<boolean, [boolean], void>;
  localizationKey: LocalizeKey;
  hoverCardText?: LocalizeKey;
  /** Rendered after the label, outside its accessible name (for example a Beta pill). */
  badge?: React.ReactNode;
  switchId: string;
  onCheckedChange?: (value: boolean) => void;
  showSwitch?: boolean;
  disabled?: boolean;
  strongLabel?: boolean;
}

function isRecoilState<T>(atom: unknown): atom is RecoilState<T> {
  return atom != null && typeof atom === 'object' && 'key' in atom;
}

const RecoilToggle: React.FC<
  Omit<ToggleSwitchProps, 'stateAtom'> & { stateAtom: RecoilState<boolean> }
> = ({
  stateAtom,
  localizationKey,
  hoverCardText,
  badge,
  switchId,
  onCheckedChange,
  disabled = false,
  strongLabel = false,
}) => {
  const [switchState, setSwitchState] = useRecoilState(stateAtom);
  const localize = useLocalize();

  const handleCheckedChange = (value: boolean) => {
    setSwitchState(value);
    onCheckedChange?.(value);
  };

  const labelId = `${switchId}-label`;

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <div id={labelId}>
          {strongLabel ? <strong>{localize(localizationKey)}</strong> : localize(localizationKey)}
        </div>
        {badge}
        {hoverCardText && <InfoHoverCard side={ESide.Bottom} text={localize(hoverCardText)} />}
      </div>
      <Switch
        id={switchId}
        checked={switchState}
        onCheckedChange={handleCheckedChange}
        disabled={disabled}
        className="ml-4"
        data-testid={switchId}
        aria-labelledby={labelId}
      />
    </div>
  );
};

const JotaiToggle: React.FC<
  Omit<ToggleSwitchProps, 'stateAtom'> & { stateAtom: WritableAtom<boolean, [boolean], void> }
> = ({
  stateAtom,
  localizationKey,
  hoverCardText,
  badge,
  switchId,
  onCheckedChange,
  disabled = false,
  strongLabel = false,
}) => {
  const [switchState, setSwitchState] = useAtom(stateAtom);
  const localize = useLocalize();

  const handleCheckedChange = (value: boolean) => {
    setSwitchState(value);
    onCheckedChange?.(value);
  };

  const labelId = `${switchId}-label`;

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <div id={labelId}>
          {strongLabel ? <strong>{localize(localizationKey)}</strong> : localize(localizationKey)}
        </div>
        {badge}
        {hoverCardText && <InfoHoverCard side={ESide.Bottom} text={localize(hoverCardText)} />}
      </div>
      <Switch
        id={switchId}
        checked={switchState}
        onCheckedChange={handleCheckedChange}
        disabled={disabled}
        className="ml-4"
        data-testid={switchId}
        aria-labelledby={labelId}
      />
    </div>
  );
};

const ToggleSwitch: React.FC<ToggleSwitchProps> = (props) => {
  const { stateAtom, showSwitch = true } = props;

  if (!showSwitch) {
    return null;
  }

  const isRecoil = isRecoilState(stateAtom);

  if (isRecoil) {
    return <RecoilToggle {...props} stateAtom={stateAtom as RecoilState<boolean>} />;
  }

  return <JotaiToggle {...props} stateAtom={stateAtom as WritableAtom<boolean, [boolean], void>} />;
};

export default ToggleSwitch;
