import { FileContext, FileSources } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export const labels: Partial<Record<string, TranslationKeys>> = {
  [FileContext.agents]: 'com_ui_agents',
  [FileContext.skill_file]: 'com_ui_skills',
  [FileContext.avatar]: 'com_ui_avatar',
  [FileContext.unknown]: 'com_ui_unknown',
  [FileContext.assistants]: 'com_ui_assistants',
  [FileContext.image_generation]: 'com_ui_image_gen',
  [FileContext.assistants_output]: 'com_ui_assistants_output',
  [FileContext.message_attachment]: 'com_ui_attachment',
  [FileContext.run_artifact]: 'com_ui_published_file',
  [FileSources.azure]: 'com_ui_azure',
  [FileSources.openai]: 'com_ui_openai',
  [FileSources.local]: 'com_ui_host',
};
