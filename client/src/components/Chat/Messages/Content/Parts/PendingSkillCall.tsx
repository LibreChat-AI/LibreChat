import { ScrollText } from 'lucide-react';
import { ROW_GLYPH_SLOT, TOOL_ROW_CLASSES } from '../rows';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Minimal variant of `SkillCall` used for the interim window between
 * submit and the backend's real `skill` tool_call content part landing
 * on the message.
 *
 * Strips the expand/collapse affordance that `SkillCall` inherits from
 * `ProgressText` — there's nothing to expand during priming (empty
 * output), and leaving the chevron + cursor-pointer on a non-functional
 * button is misleading. Same ScrollText icon, same shimmer, same
 * localized label strings (`com_ui_skill_running` / `com_ui_skill_finished`)
 * so the visual language matches the real card it'll be replaced by.
 *
 * `loaded=false` → "Running X" with pulsing icon + shimmer.
 * `loaded=true`  → "Ran X" with static icon; driven by
 *                  `ContentParts.hasRealContent`, which flips true as
 *                  soon as any streamed content part arrives, matching
 *                  the transition users see for model-invoked skills.
 */
export default function PendingSkillCall({
  skillName,
  loaded,
}: {
  skillName: string;
  loaded: boolean;
}) {
  const localize = useLocalize();
  const text = loaded
    ? localize('com_ui_skill_finished', { 0: skillName })
    : localize('com_ui_skill_running', { 0: skillName });

  return (
    <div className={TOOL_ROW_CLASSES}>
      <div className="progress-text-wrapper text-token-text-secondary relative -mt-[0.75px] h-5 w-full leading-5">
        <div
          className="progress-text-content absolute left-0 right-0 top-0 max-w-full overflow-visible whitespace-nowrap"
          style={{ opacity: 1, transform: 'none' }}
        >
          <div className="inline-flex w-full items-center gap-2">
            {/** The real `SkillCall` replaces this row in place once the skill
             *   finalizes; sharing its glyph slot keeps that swap still. */}
            <span className={ROW_GLYPH_SLOT} aria-hidden="true">
              <ScrollText
                className={cn('size-4 shrink-0 text-text-secondary', !loaded && 'animate-pulse')}
              />
            </span>
            <span className={cn(!loaded && 'shimmer', 'min-w-0 truncate font-medium')}>{text}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
