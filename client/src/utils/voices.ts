export type SpeechVoicesSnapshot = {
  voices: SpeechSynthesisVoice[];
  supported: boolean;
};

let snapshot: SpeechVoicesSnapshot = { voices: [], supported: true };
const listeners = new Set<() => void>();
let initialized = false;

const notify = () => {
  listeners.forEach((listener) => listener());
};

const readVoices = (synth: SpeechSynthesis) => {
  try {
    const voices = synth.getVoices();
    if (!Array.isArray(voices)) {
      console.error('getVoices() did not return an array');
      return;
    }
    snapshot = { voices, supported: true };
    notify();
  } catch (error) {
    console.error('Error updating voices:', error);
    snapshot = { voices: [], supported: false };
    notify();
  }
};

/**
 * Module-level speech-synthesis voices store. Every message row mounts a TTS
 * button; per-instance `getVoices()` state guaranteed one post-mount re-render
 * per row and the instances clobbered each other's `onvoiceschanged` handler
 * (last mount won, any unmount nulled it for the rest). One shared listener
 * feeds all subscribers instead.
 */
export const subscribeSpeechVoices = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);
  if (!initialized) {
    initialized = true;
    const synth = window.speechSynthesis as SpeechSynthesis | undefined;
    if (!synth) {
      snapshot = { voices: [], supported: false };
    } else {
      readVoices(synth);
      try {
        synth.addEventListener('voiceschanged', () => readVoices(synth));
      } catch (error) {
        console.error('Error subscribing to voiceschanged:', error);
      }
    }
  }
  return () => {
    listeners.delete(onStoreChange);
  };
};

export const getSpeechVoicesSnapshot = (): SpeechVoicesSnapshot => snapshot;
