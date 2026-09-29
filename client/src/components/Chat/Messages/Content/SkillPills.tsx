import { memo } from 'react';
import { Pin, ScrollText } from 'lucide-react';
import { useLocalize } from '~/hooks';

/**
 * Origin tag driving the pill variant:
 *  - `'manual'` — the user invoked this skill via the `$` popover.
 *  - `'always-apply'` — the skill auto-primed because its frontmatter flag
 *    is set. Adds a pin icon so the ambient priming is visible to the user.
 *
 * Exported so message-render code can import and pass the appropriate
 * value without hardcoding string literals.
 */
export type SkillPillsSource = 'manual' | 'always-apply';

/**
 * Compact pill row rendered on a submitted user message, one chip per skill
 * primed into the turn. Presentational component — takes only the scalar
 * `skills` array (no full message object) so `React.memo` comparisons on
 * parent wrappers stay shallow and cheap.
 *
 * Backend persists the source field (`message.manualSkills` /
 * `message.alwaysAppliedSkills`), so callers reading from the message pass
 * `skills={message.manualSkills}` / `skills={message.alwaysAppliedSkills}`
 * and pills survive page reloads / history renders. The `source` prop picks
 * the icon variant so both flavors render from the same component.
 */
function SkillPills({
  skills,
  source = 'manual',
}: {
  skills?: string[];
  source?: SkillPillsSource;
}) {
  const localize = useLocalize();

  if (!skills || skills.length === 0) {
    return null;
  }

  const ariaLabelKey =
    source === 'always-apply'
      ? 'com_ui_skills_always_apply_invoked'
      : 'com_ui_skills_manual_invoked';

  return (
    <div className="flex flex-wrap gap-1.5 py-0.5" role="list" aria-label={localize(ariaLabelKey)}>
      {skills.map((name) => (
        <span
          key={name}
          role="listitem"
          data-skill-source={source}
          className="inline-flex items-center gap-1 rounded-full border border-border-light bg-surface-secondary px-2 py-1 text-xs text-text-secondary"
        >
          {source === 'always-apply' ? (
            <Pin className="h-3 w-3 text-status-info" aria-hidden="true" />
          ) : (
            <ScrollText className="h-3 w-3 text-status-info" aria-hidden="true" />
          )}
          <span className="max-w-[12rem] truncate">{name}</span>
        </span>
      ))}
    </div>
  );
}

export default memo(SkillPills);
