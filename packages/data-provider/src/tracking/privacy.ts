import { z } from 'zod';
import { stripAgentIdSuffix } from '../agents/identity';
import { EModelEndpoint, Providers } from '../schemas';
import { defaultModels } from '../config';

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
