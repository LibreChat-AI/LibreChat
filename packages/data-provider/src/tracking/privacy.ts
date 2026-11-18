import { z } from 'zod';
import { stripAgentIdSuffix } from '../agents/identity';
import { EModelEndpoint, Providers } from '../schemas';
import { Constants, defaultModels } from '../config';
import { Tools } from '../types/tools';

const models = new Set<string>(Object.values(defaultModels).flat());
const providers = new Set<string>([...Object.values(EModelEndpoint), ...Object.values(Providers)]);

/** Configured labels are private; only the bundled catalog supplies public names. */
export const productModelSchema = z
  .string()
  .transform((value) => (models.has(value) ? value : 'custom'));
export const productProviderSchema = z
  .string()
  .transform((value) => (providers.has(value) ? value : 'custom'));

/** Ephemeral IDs embed model and sender labels; only persisted agent identities leave the host. */
export const productAgentIdSchema = z
  .string()
  .transform((value) => {
    const id = stripAgentIdSuffix(value);
    // Encoded labels and saved IDs containing this separator are ambiguous; omit both.
    if (id.includes('__')) return undefined;
    return id.startsWith('agent_') || id.startsWith('asst_') ? id : undefined;
  })
  .pipe(z.string().min(1).max(256).optional());

/** Exact public tool names, shared with server classification and transport validation. */
export const productBuiltinToolNameSchema = z.enum([
  Tools.execute_code,
  Tools.code_interpreter,
  Tools.file_search,
  Tools.web_search,
  Tools.retrieval,
  Tools.memory,
  Tools.ui_resources,
  Tools.read_file,
  Tools.bash_tool,
  Constants.PROGRAMMATIC_TOOL_CALLING,
  Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
  Constants.SUBAGENT,
  Constants.CHECK_BACKGROUND_TASK,
  'tool_search',
  'write_file',
  'edit_file',
  'grep_search',
  'glob_search',
  'create_file',
  'search_workspace',
  'list_workspace_files',
  'ask_user_question',
  'set_memory',
  'delete_memory',
]);
export type ProductBuiltinToolName = z.infer<typeof productBuiltinToolNameSchema>;
