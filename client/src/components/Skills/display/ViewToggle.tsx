import { Eye, Code } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type SkillViewMode = 'rendered' | 'source';

interface ViewToggleProps {
  viewMode: SkillViewMode;
  setViewMode: (mode: SkillViewMode) => void;
}

const MODES: ReadonlyArray<{ mode: SkillViewMode; Icon: LucideIcon; labelKey: TranslationKeys }> = [
  { mode: 'rendered', Icon: Eye, labelKey: 'com_ui_skill_view_rendered' },
  { mode: 'source', Icon: Code, labelKey: 'com_ui_skill_view_source' },
];

/**
 * Segmented control for the rendered/source swap.
 *
 * The active state is one thumb that slides between the options rather than a
 * background appearing on one button as it disappears from the other, so the
 * change reads as a single movement. Option widths are fixed so the thumb can
 * travel by exactly one option without measuring.
 */
export default function ViewToggle({ viewMode, setViewMode }: ViewToggleProps) {
  const localize = useLocalize();

  return (
    <div
      role="group"
      aria-label={`${localize('com_ui_skill_view_rendered')} / ${localize('com_ui_skill_view_source')}`}
      className="bg-surface-tertiary relative inline-flex h-7 rounded-lg p-0.5 text-sm font-medium"
    >
      <span
        aria-hidden="true"
        className={cn(
          /** Logical inset plus a mirrored translation: under RTL flex puts the
           *  first option on the right, so a physically-left thumb would sit
           *  under the wrong option in both states. */
          'bg-surface-primary absolute start-0.5 top-0.5 h-6 w-7 rounded-md shadow-xs transition-transform duration-200 ease-out motion-reduce:transition-none',
          viewMode === 'source' && 'translate-x-7 rtl:-translate-x-7',
        )}
      />
      {MODES.map(({ mode, Icon, labelKey }) => (
        <button
          key={mode}
          type="button"
          onClick={() => setViewMode(mode)}
          className={cn(
            'relative flex w-7 items-center justify-center rounded-md transition-colors',
            viewMode === mode ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
          )}
          aria-label={localize(labelKey)}
          aria-pressed={viewMode === mode}
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
