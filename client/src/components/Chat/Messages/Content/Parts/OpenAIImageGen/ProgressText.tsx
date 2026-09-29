import { AGENT_STYLE_TOOLS } from '.';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function ProgressText({
  progress,
  error,
  cancelled,
  toolName = '',
  intent,
}: {
  progress: number;
  error?: boolean;
  /** Stopped rather than failed — kept separate from `error` so a generation
   *  the user cancelled is not labelled a failure. */
  cancelled?: boolean;
  toolName?: string;
  /** Model-authored label; wins over the phase texts (error state excepted). */
  intent?: string;
}) {
  const localize = useLocalize();

  const getText = () => {
    /** Failure outranks cancellation: the legacy inference folds errors into
     *  its cancellation signal, so checking `cancelled` first would relabel a
     *  genuine failure as a user stop. */
    if (error) {
      return localize('com_ui_image_gen_failed');
    }
    if (cancelled) {
      return localize('com_ui_cancelled');
    }
    if (intent != null) {
      return intent;
    }

    if (toolName === 'image_edit_oai') {
      if (progress >= 1) {
        return localize('com_ui_image_edited');
      }
      if (progress >= 0.7) {
        return localize('com_ui_final_touch');
      }
      if (progress >= 0.5) {
        return localize('com_ui_adding_details');
      }
      if (progress >= 0.3) {
        return localize('com_ui_edit_editing_image');
      }
      return localize('com_ui_getting_started');
    }

    if (toolName === 'gemini_image_gen') {
      if (progress >= 1) {
        return localize('com_ui_image_created');
      }
      if (progress >= 0.7) {
        return localize('com_ui_final_touch');
      }
      if (progress >= 0.5) {
        return localize('com_ui_adding_details');
      }
      if (progress >= 0.3) {
        return localize('com_ui_creating_image');
      }
      return localize('com_ui_getting_started');
    }

    if (AGENT_STYLE_TOOLS.has(toolName)) {
      if (progress >= 1) {
        return localize('com_ui_image_created');
      }
      if (progress >= 0.7) {
        return localize('com_ui_final_touch');
      }
      if (progress >= 0.5) {
        return localize('com_ui_adding_details');
      }
      if (progress >= 0.3) {
        return localize('com_ui_creating_image');
      }
      return localize('com_ui_getting_started');
    }

    if (progress >= 1) {
      return localize('com_ui_image_created');
    }
    return localize('com_ui_generating_image');
  };

  const text = getText();

  return (
    <span
      className={cn('tool-status-text min-w-0 truncate font-medium', progress < 1 && 'shimmer')}
    >
      {text}
    </span>
  );
}
