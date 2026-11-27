import { Shimmer, useLocalize } from '@librechat/client';
import type { TranslationKeys } from '@librechat/client';
import type { JSX } from 'react';
import { AGENT_STYLE_TOOLS } from '../../core/parts/routing';
import { useToolPreparation } from './preparation';

export interface ImageGenTextProps {
  progress: number;
  error?: boolean;
  /** Stopped rather than failed: kept separate from `error` so a generation the user cancelled
   *  is not labelled a failure. */
  cancelled?: boolean;
  toolName?: string;
  /** Model-authored label; wins over the phase texts (error state excepted). */
  intent?: string;
}

/** What a previewing tool says at each stage of its picture; an edit names two stages its own way. */
function stageKey(progress: number, editing: boolean): TranslationKeys {
  if (progress >= 1) {
    return editing ? 'com_ui_image_edited' : 'com_ui_image_created';
  }
  if (progress >= 0.7) {
    return 'com_ui_final_touch';
  }
  if (progress >= 0.5) {
    return 'com_ui_adding_details';
  }
  if (progress >= 0.3) {
    return editing ? 'com_ui_edit_editing_image' : 'com_ui_creating_image';
  }
  return 'com_ui_getting_started';
}

/** The status line of an image-generation card. */
export default function ImageGenText({
  progress,
  error,
  cancelled,
  toolName = '',
  intent,
}: ImageGenTextProps): JSX.Element {
  const localize = useLocalize();
  const preparationText = useToolPreparation();

  const getText = (): string => {
    /** Failure outranks cancellation: the legacy inference folds errors into its cancellation
     *  signal, so checking `cancelled` first would relabel a genuine failure as a user stop. */
    if (error) {
      return localize('com_ui_image_gen_failed');
    }
    if (cancelled) {
      return localize('com_ui_cancelled');
    }
    if (progress < 1 && preparationText != null) {
      return preparationText;
    }
    if (intent != null) {
      return intent;
    }
    if (AGENT_STYLE_TOOLS.has(toolName)) {
      return localize(stageKey(progress, toolName === 'image_edit_oai'));
    }
    return localize(progress >= 1 ? 'com_ui_image_created' : 'com_ui_generating_image');
  };

  const text = getText();

  return (
    <Shimmer active={progress < 1} className="tool-status-text min-w-0 truncate font-medium">
      {text}
    </Shimmer>
  );
}
