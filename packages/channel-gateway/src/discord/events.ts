import { z } from 'zod';
import { createPublicKey, verify } from 'node:crypto';

const snowflake = z.string().regex(/^[0-9]{1,20}$/);
const user = z.object({ id: snowflake, bot: z.boolean().optional() });
const valueOption = z
  .object({
    name: z.string().min(1).max(32),
    type: z.number().int(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();
const option = valueOption.extend({ options: z.array(valueOption).max(25).optional() });
const component = z.object({
  type: z.number().int(),
  custom_id: z.string().max(100).optional(),
  value: z.string().max(4000).optional(),
});
const common = {
  id: snowflake,
  application_id: snowflake,
  token: z.string().min(1).max(4096),
  version: z.literal(1),
  guild_id: snowflake.optional(),
  context: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  authorizing_integration_owners: z
    .object({ '0': snowflake.optional(), '1': snowflake.optional() })
    .strict()
    .optional(),
  channel_id: snowflake.optional(),
  member: z.object({ user }).optional(),
  user: user.optional(),
};
export const interactionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(1), application_id: snowflake.optional() }),
  z.object({
    ...common,
    type: z.literal(2),
    data: z.object({
      id: snowflake,
      name: z.string().min(1).max(32),
      type: z.literal(1).optional(),
      options: z.array(option).max(25).optional(),
    }),
  }),
  z.object({
    ...common,
    type: z.literal(3),
    message: z.object({ id: snowflake }).optional(),
    data: z.object({
      custom_id: z.string().min(1).max(100),
      component_type: z.number().int(),
      values: z.array(z.string().max(100)).max(25).optional(),
    }),
  }),
  z.object({
    ...common,
    type: z.literal(5),
    data: z.object({
      custom_id: z.string().min(1).max(100),
      components: z
        .array(z.object({ type: z.literal(1), components: z.array(component).max(5) }))
        .max(5),
    }),
  }),
]);
export type DiscordInteraction = z.infer<typeof interactionSchema>;

export interface DiscordSignaturePolicy {
  publicKey: string;
  maxBodyBytes: number;
  maxAgeMs: number;
  now?: number;
}

/** Verifies the exact bytes received, before decoding or trusting any interaction fields. */
export function verifyDiscordSignature(
  body: Buffer,
  signature: string,
  timestamp: string,
  policy: DiscordSignaturePolicy,
): boolean {
  if (
    !Number.isSafeInteger(policy.maxBodyBytes) ||
    policy.maxBodyBytes <= 0 ||
    body.length > policy.maxBodyBytes ||
    !Number.isFinite(policy.maxAgeMs) ||
    policy.maxAgeMs <= 0 ||
    !/^[a-f\d]{64}$/i.test(policy.publicKey) ||
    !/^[a-f\d]{128}$/i.test(signature) ||
    !/^\d{1,16}$/.test(timestamp)
  )
    return false;
  const signedAt = Number(timestamp) * 1000;
  const now = policy.now ?? Date.now();
  if (
    !Number.isSafeInteger(signedAt) ||
    !Number.isFinite(now) ||
    Math.abs(now - signedAt) > policy.maxAgeMs
  )
    return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(policy.publicKey, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      key,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

export function parseDiscordInteraction(body: Buffer, maxBodyBytes: number): DiscordInteraction {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || body.length > maxBodyBytes)
    throw new Error('Discord interaction body exceeds limit');
  return interactionSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
  );
}

export interface DiscordCommandEvent {
  provider: 'discord';
  applicationId: string;
  guildId: string;
  externalUserId: string;
  externalChannelId: string;
  externalMessageKey: string;
  externalThreadKey: string;
  deduplicationKey: string;
  input: string;
}

/** A slash command starts a fresh lane; the interaction ID is its durable admission identity. */
export function normalizeDiscordCommand(
  interaction: DiscordInteraction,
  applicationId: string,
  commandName = 'ask',
): DiscordCommandEvent | null {
  if (
    interaction.type !== 2 ||
    interaction.application_id !== applicationId ||
    !interaction.guild_id ||
    interaction.context !== 0 ||
    interaction.authorizing_integration_owners?.['0'] !== interaction.guild_id ||
    !interaction.channel_id ||
    interaction.data.name !== commandName
  )
    return null;
  const actor = interaction.member?.user;
  if (!actor || actor.bot) return null;
  const options = interaction.data.options ?? [];
  if (
    options.length !== 1 ||
    options[0].name !== 'prompt' ||
    options[0].type !== 3 ||
    typeof options[0].value !== 'string'
  )
    return null;
  const input = options[0].value.trim();
  if (!input || input.length > 6000) return null;
  return {
    provider: 'discord',
    applicationId,
    guildId: interaction.guild_id,
    externalUserId: actor.id,
    externalChannelId: interaction.channel_id,
    externalMessageKey: `${interaction.channel_id}:${interaction.id}`,
    externalThreadKey: `${interaction.channel_id}:${interaction.id}`,
    deduplicationKey: interaction.id,
    input,
  };
}
