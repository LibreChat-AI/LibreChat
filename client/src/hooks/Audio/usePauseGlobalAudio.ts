import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import { globalAudioId } from '~/common';
import store from '~/store';

function usePauseGlobalAudio(index = 0) {
  /* Global Audio Variables */
  const setAudioRunId = useSetRecoilState(store.audioRunFamily(index));
  const setActiveRunId = useSetAtom(activeRunFamily(index));
  const setGlobalIsPlaying = useSetRecoilState(store.globalAudioPlayingFamily(index));
  const setIsGlobalAudioFetching = useSetRecoilState(store.globalAudioFetchingFamily(index));
  const [globalAudioURL, setGlobalAudioURL] = useRecoilState(store.globalAudioURLFamily(index));

  const pauseGlobalAudio = useCallback(() => {
    if (globalAudioURL != null && globalAudioURL !== '') {
      const globalAudio = document.getElementById(globalAudioId);
      if (globalAudio) {
        console.log('Pausing global audio', globalAudioURL);
        (globalAudio as HTMLAudioElement).pause();
        setGlobalIsPlaying(false);
      }
      URL.revokeObjectURL(globalAudioURL);
      setIsGlobalAudioFetching(false);
      setGlobalAudioURL(null);
      setActiveRunId(null);
      setAudioRunId(null);
    }
  }, [
    setAudioRunId,
    setActiveRunId,
    globalAudioURL,
    setGlobalAudioURL,
    setGlobalIsPlaying,
    setIsGlobalAudioFetching,
  ]);

  return { pauseGlobalAudio };
}

export default usePauseGlobalAudio;
