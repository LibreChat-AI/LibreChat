import { ComponentTypes, SettingTypes } from 'librechat-data-provider';
import type { SettingDefinition, TConversation, TPreset } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export interface ParameterSection {
  id: string;
  label: TranslationKeys;
  settings: SettingDefinition[];
}

/**
 * The panel's order of questions, rather than the order the definitions happen to
 * arrive in.
 *
 * A provider hands over a flat list built for its API, so a panel that renders it
 * as-is asks about temperature, then reasoning, then whether to resend files, with
 * nothing to say which of those belong together. Grouping is the client's job
 * because it is a reading order, not part of the contract: the same key means the
 * same thing wherever it appears, so one map serves every endpoint.
 *
 * Keys are listed per section rather than matched by prefix. A provider is free to
 * name a parameter anything, and a wrong guess would file it under a heading that
 * misdescribes it; an unknown key falls to the last section instead, where it is
 * still visible and still editable.
 */
const SECTIONS: ReadonlyArray<{ id: string; label: TranslationKeys; keys: readonly string[] }> = [
  {
    id: 'identity',
    label: 'com_ui_params_identity',
    keys: ['chatGptLabel', 'modelLabel', 'promptPrefix', 'system'],
  },
  {
    id: 'sampling',
    label: 'com_ui_params_sampling',
    keys: ['temperature', 'topP', 'top_p', 'topK', 'frequency_penalty', 'presence_penalty'],
  },
  {
    id: 'limits',
    label: 'com_ui_params_limits',
    keys: [
      'maxContextTokens',
      'max_tokens',
      'maxOutputTokens',
      'maxTokens',
      'fileTokenLimit',
      'stop',
    ],
  },
  {
    id: 'reasoning',
    label: 'com_ui_params_reasoning',
    keys: [
      'effort',
      'reasoning_effort',
      'reasoning_mode',
      'reasoning_summary',
      'reasoning_context',
      'thinking',
      'thinkingBudget',
      'thinkingDisplay',
      'thinkingLevel',
      'verbosity',
    ],
  },
  {
    id: 'context',
    label: 'com_ui_context',
    keys: [
      'resendFiles',
      'imageDetail',
      'promptCache',
      'promptCacheTtl',
      'web_search',
      'url_context',
    ],
  },
  {
    id: 'advanced',
    label: 'com_ui_advanced',
    keys: ['useResponsesApi', 'disableStreaming', 'region', 'model'],
  },
  /** Everything a deployment added that this map has never heard of. */
  { id: 'other', label: 'com_ui_misc', keys: [] },
];

const SECTION_BY_KEY = new Map<string, string>(
  SECTIONS.flatMap((section) => section.keys.map((key) => [key, section.id] as const)),
);

/**
 * Whether a parameter needs the whole row rather than one of the two columns.
 *
 * Free text is the only thing in the panel that is read back as text: a system
 * prompt, a custom name, a list of stop sequences. Half of a 300px panel turns
 * those into a peephole. A number, a toggle or a choice says the same thing in a
 * narrow column as in a wide one, so two of them cost one row instead of two,
 * which is the whole reason the panel fits without hiding anything.
 */
export function isWideParameter(setting: SettingDefinition): boolean {
  if (setting.component === ComponentTypes.Textarea || setting.component === ComponentTypes.Tags) {
    return true;
  }
  return setting.component === ComponentTypes.Input && setting.type !== SettingTypes.Number;
}

/**
 * Files the parameters under their headings, keeping each provider's own order
 * inside a section and dropping the sections this endpoint has nothing for.
 *
 * Within a section the narrow parameters come first. They sit two to a row, so a
 * full-width one landing between them breaks the pairs on either side and leaves a
 * gap beside whatever follows it. Sending the wide ones to the end of their own
 * section packs the columns and leaves a single ragged edge at the bottom.
 */
export function groupParameters(parameters: SettingDefinition[]): ParameterSection[] {
  const bySection = new Map<string, SettingDefinition[]>();
  for (const setting of parameters) {
    if (setting == null) {
      continue;
    }
    const id = SECTION_BY_KEY.get(setting.key) ?? 'other';
    const existing = bySection.get(id);
    if (existing) {
      existing.push(setting);
      continue;
    }
    bySection.set(id, [setting]);
  }

  const sections: ParameterSection[] = [];
  for (const section of SECTIONS) {
    const settings = bySection.get(section.id);
    if (settings != null && settings.length > 0) {
      sections.push({
        id: section.id,
        label: section.label,
        settings: [
          ...settings.filter((setting) => !isWideParameter(setting)),
          ...settings.filter(isWideParameter),
        ],
      });
    }
  }
  return sections;
}

/**
 * Whether a parameter's control has anything to show. A combobox or dropdown with no
 * choices renders nothing, which Bedrock's region does when the deployment lists no
 * regions; dropping it before grouping keeps a section from standing empty around it.
 */
export function hasControl(setting: SettingDefinition): boolean {
  if (
    setting.component !== ComponentTypes.Combobox &&
    setting.component !== ComponentTypes.Dropdown
  ) {
    return true;
  }
  return (setting.items?.length ?? 0) > 0 || (setting.options?.length ?? 0) > 0;
}

/**
 * Whether this conversation says something about a parameter that its default does
 * not already say. It is what the panel counts to tell the owner where their changes
 * are, so an absent value and a value equal to the default both read as untouched.
 */
export function isModified(
  setting: SettingDefinition,
  conversation: Partial<TConversation> | Partial<TPreset> | null,
): boolean {
  const value = conversation?.[setting.key as keyof typeof conversation];
  if (value == null) {
    return false;
  }
  const fallback = setting.default;
  /** Clearing a field reads as untouched only when there was nothing to clear. */
  if (value === '') {
    return fallback != null && fallback !== '';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return Array.isArray(fallback) && fallback.length > 0;
    }
    return JSON.stringify(value) !== JSON.stringify(fallback);
  }
  return value !== fallback;
}

export function countModified(
  settings: SettingDefinition[],
  conversation: Partial<TConversation> | Partial<TPreset> | null,
): number {
  return settings.reduce(
    (count, setting) => (isModified(setting, conversation) ? count + 1 : count),
    0,
  );
}
