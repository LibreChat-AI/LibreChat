import React from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Slider, InputNumber } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function DecibelSelector() {
  const localize = useLocalize();
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const [playbackRate, setPlaybackRate] = useRecoilState(store.playbackRate);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center justify-between">
        <div id="playback-rate-label">{localize('com_nav_playback_rate')}</div>
        <div className="w-2" />
        <small className="high-contrast:opacity-100 opacity-40">
          ({localize('com_endpoint_default_with_num', { 0: '1' })})
        </small>
      </div>
      <div className="flex items-center justify-between">
        <Slider
          value={[playbackRate ?? 1]}
          onValueChange={(value) => setPlaybackRate(value[0])}
          onDoubleClick={() => setPlaybackRate(null)}
          min={0.1}
          max={2}
          step={0.1}
          className="ml-4 flex h-4 w-24"
          disabled={!textToSpeech}
          aria-labelledby="playback-rate-label"
        />
        <div className="w-2" />
        <InputNumber
          value={playbackRate ?? 1}
          disabled={!textToSpeech}
          onChange={(value) => setPlaybackRate(value ? value[0] : 0)}
          min={0.1}
          max={2}
          aria-labelledby="playback-rate-label"
          variant="option"
          className="w-12"
        />
      </div>
    </div>
  );
}
