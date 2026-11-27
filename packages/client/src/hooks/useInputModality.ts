import { useEffect } from 'react';

type Modality = 'keyboard' | 'pointer';

let refCount = 0;
let current: Modality | null = null;

function apply(modality: Modality) {
  if (current === modality) {
    return;
  }
  current = modality;
  document.documentElement.dataset.inputModality = modality;
}

function handlePointer() {
  apply('pointer');
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    apply('keyboard');
  }
}

/**
 * Tracks whether the user is currently interacting via pointer or keyboard and
 * reflects it on `document.documentElement` as `data-input-modality`. Lets CSS
 * gate focus styling so text inputs only show a focus ring for keyboard users
 * (text inputs match `:focus-visible` on pointer focus too, which CSS alone
 * cannot distinguish). Ref-counted so concurrent mounts share one listener set.
 */
export default function useInputModality(): void {
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    if (refCount === 0) {
      apply('pointer');
      window.addEventListener('pointerdown', handlePointer, true);
      window.addEventListener('keydown', handleKeydown, true);
    }
    refCount += 1;
    return () => {
      refCount -= 1;
      if (refCount === 0) {
        window.removeEventListener('pointerdown', handlePointer, true);
        window.removeEventListener('keydown', handleKeydown, true);
        delete document.documentElement.dataset.inputModality;
        current = null;
      }
    };
  }, []);
}
