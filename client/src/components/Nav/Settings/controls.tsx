import { useContext, useCallback } from 'react';
import Cookies from 'js-cookie';
import { useRecoilState } from 'recoil';
import { ThemeContext } from '@librechat/client';
import type { ComponentType } from 'react';
import type { TranslationKeys } from '~/hooks';
import { ThemeSelector, LangSelector } from '~/components/Appearance';
import ToggleSwitch from '../SettingsTabs/ToggleSwitch';
import store from '~/store';

export function toggleControl(opts: {
  stateAtom: Parameters<typeof ToggleSwitch>[0]['stateAtom'];
  localizationKey: TranslationKeys;
  switchId: string;
  hoverCardText?: TranslationKeys;
  onCheckedChange?: (value: boolean) => void;
}): ComponentType {
  const Control = () => (
    <ToggleSwitch
      stateAtom={opts.stateAtom}
      localizationKey={opts.localizationKey}
      switchId={opts.switchId}
      hoverCardText={opts.hoverCardText}
      onCheckedChange={opts.onCheckedChange}
    />
  );
  Control.displayName = `Toggle(${opts.switchId})`;
  return Control;
}

export function ThemeSetting() {
  const { theme, setTheme } = useContext(ThemeContext);
  const onChange = useCallback((value: string) => setTheme(value), [setTheme]);
  return <ThemeSelector theme={theme} onChange={onChange} />;
}

export function LangSetting() {
  const [langcode, setLangcode] = useRecoilState(store.lang);
  const onChange = useCallback(
    (value: string) => {
      const userLang =
        value === 'auto' ? navigator.language || navigator.languages?.[0] || 'en-US' : value;
      requestAnimationFrame(() => {
        document.documentElement.lang = userLang;
      });
      setLangcode(userLang);
      Cookies.set('lang', userLang, { expires: 365 });
    },
    [setLangcode],
  );
  return <LangSelector langcode={langcode} onChange={onChange} />;
}
