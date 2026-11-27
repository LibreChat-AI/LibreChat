import { useId } from 'react';
import type { TSetOption, TConversation, TPreset } from 'librechat-data-provider';
import type { ParameterSection } from './groups';
import { countModified, isWideParameter } from './groups';
import { componentMapping } from './components';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * The grouped parameter grid shared by the chat panel and the agent builder, so a
 * parameter takes the same space and sits under the same heading in both.
 */
export default function Sections({
  sections,
  setOption,
  conversation,
}: {
  sections: ParameterSection[];
  setOption: TSetOption;
  conversation: Partial<TConversation> | Partial<TPreset> | null;
}) {
  const panelId = useId();
  const localize = useLocalize();

  return (
    <>
      {/* Every parameter this model can act on is on screen. A disclosure would
          trade the one thing a settings panel is for, seeing the current state at a
          glance, for vertical space that pairing and quieter headings give back
          anyway. */}
      {sections.map((section) => {
        const changed = countModified(section.settings, conversation);
        const headingId = `${panelId}-${section.id}`;

        return (
          <section key={section.id} aria-labelledby={headingId} className="pt-4 first:pt-0">
            <h3
              id={headingId}
              className="text-text-secondary mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase"
            >
              <span className="truncate">{localize(section.label)}</span>
              {/* Where this conversation's own answers are, which is what the owner
                  scans for before reaching for Reset. */}
              {changed > 0 && (
                <>
                  <span
                    aria-hidden="true"
                    className="bg-surface-tertiary text-text-primary shrink-0 rounded-full px-1.5 text-xs font-normal tracking-normal normal-case tabular-nums"
                  >
                    {changed}
                  </span>
                  <span className="sr-only">
                    {localize(
                      changed === 1
                        ? 'com_ui_params_changed_count_one'
                        : 'com_ui_params_changed_count',
                      { count: changed },
                    )}
                  </span>
                </>
              )}
            </h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              {section.settings.map((setting) => {
                const Component = componentMapping[setting.component];
                if (!Component) {
                  return null;
                }
                const { key, default: defaultValue, ...rest } = setting;

                /** The cell owns the span, not the control. The definitions carry a
                 *  columnSpan written for the four-column preset dialog, which says
                 *  nothing about a panel this narrow. */
                /** The cell stretches its control to the row, so a pair whose labels
                 *  wrap differently still lines their inputs up. Applied here rather
                 *  than in the shared controls, which the preset editors reuse. */
                return (
                  <div
                    key={key}
                    className={cn(
                      '*:h-full',
                      isWideParameter(setting) ? 'col-span-2' : 'col-span-1',
                    )}
                  >
                    <Component
                      settingKey={key}
                      defaultValue={defaultValue}
                      {...rest}
                      setOption={setOption}
                      conversation={conversation}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
