import React, { useState, useEffect } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Slider, InputNumber, Switch } from '@librechat/client';
import { cn, defaultTextProps, optionText } from '~/utils/';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function AutoSendTextSelector() {
  const localize = useLocalize();

  const speechToText = useRecoilValue(store.speechToText);
  const [autoSendText, setAutoSendText] = useRecoilState(store.autoSendText);

  // Local state for enabled/disabled toggle
  const [isEnabled, setIsEnabled] = useState(autoSendText !== -1);
  const [delayValue, setDelayValue] = useState(autoSendText === -1 ? 3 : autoSendText);

  // Sync local state when autoSendText changes externally
  useEffect(() => {
    setIsEnabled(autoSendText !== -1);
    if (autoSendText !== -1) {
      setDelayValue(autoSendText);
    }
  }, [autoSendText]);

  const handleToggle = (enabled: boolean) => {
    setIsEnabled(enabled);
    if (enabled) {
      setAutoSendText(delayValue);
    } else {
      setAutoSendText(-1);
    }
  };

  const handleSliderChange = (value: number[]) => {
    const newValue = value[0];
    setDelayValue(newValue);
    if (isEnabled) {
      setAutoSendText(newValue);
    }
  };

  const handleInputChange = (value: string | number | null) => {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    const newValue = Number.isNaN(parsed) ? 3 : parsed;
    setDelayValue(newValue);
    if (isEnabled) {
      setAutoSendText(newValue);
    }
  };

  const labelId = 'auto-send-text-label';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div id={labelId}>{localize('com_nav_auto_send_text')}</div>
        </div>
        <Switch
          id="autoSendTextToggle"
          checked={isEnabled}
          onCheckedChange={handleToggle}
          className="ml-4"
          data-testid="autoSendTextToggle"
          aria-labelledby={labelId}
          disabled={!speechToText}
        />
      </div>
      {isEnabled && (
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center justify-between">
            <div id="auto-send-delay-label" className="text-sm text-text-secondary">
              {localize('com_nav_setting_delay')}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Slider
              value={[delayValue]}
              onValueChange={handleSliderChange}
              onDoubleClick={() => {
                setDelayValue(3);
                if (isEnabled) {
                  setAutoSendText(3);
                }
              }}
              min={0}
              max={60}
              step={1}
              className="ml-4 flex h-4 w-24"
              disabled={!speechToText || !isEnabled}
              aria-labelledby="auto-send-delay-label"
            />
            <div className="w-2" />
            <InputNumber
              value={`${delayValue} s`}
              disabled={!speechToText || !isEnabled}
              onChange={handleInputChange}
              min={0}
              max={60}
              aria-labelledby="auto-send-delay-label"
              className={cn(
                defaultTextProps,
                cn(
                  optionText,
                  'reset-rc-number-input reset-rc-number-input-text-right h-auto w-12 border-0 group-hover/temp:border-border-light',
                ),
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
