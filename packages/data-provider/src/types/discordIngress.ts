import { z } from 'zod';
import { channelSnowflakeSchema } from '../channelProvider';

const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordIngressActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), prompt: z.string().min(1).max(6000) }).strict(),
  z.object({ kind: z.literal('link') }).strict(),
  z.object({ kind: z.literal('status') }).strict(),
  z
    .object({
      kind: z.literal('cancel'),
      reference: reference.optional(),
      messageId: channelSnowflakeSchema.optional(),
    })
    .strict()
    .refine((action) => Boolean(action.reference) === Boolean(action.messageId)),
  z.object({ kind: z.literal('confirm'), reference }).strict(),
  z.object({ kind: z.literal('review'), reference, messageId: channelSnowflakeSchema }).strict(),
  z
    .object({
      kind: z.literal('decide'),
      reference: channelSnowflakeSchema,
      choice: z.number().int().min(0).max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal('feedback'),
      reference,
      rating: z.enum(['thumbsUp', 'thumbsDown']),
      messageId: channelSnowflakeSchema,
    })
    .strict(),
]);
export type DiscordIngressAction = z.infer<typeof discordIngressActionSchema>;
export const discordInboxFenceSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    eventId: channelSnowflakeSchema,
    owner: reference,
    epoch: z.number().int().positive(),
  })
  .strict();
export type DiscordInboxFence = z.infer<typeof discordInboxFenceSchema>;

/** Link identifiers and revisions are independent random 43-character values, not account details. */
export function discordConfirmationControl(linkId: string, revision: string): string {
  if (![linkId, revision].every((value) => /^[\w-]{43}$/.test(value)))
    throw new TypeError('Invalid Discord confirmation');
  return `lc1:c:${linkId}${revision}`;
}
export function discordConfirmationParts(
  reference: string,
): { linkId: string; revision: string } | null {
  return /^[\w-]{86}$/.test(reference)
    ? { linkId: reference.slice(0, 43), revision: reference.slice(43) }
    : null;
}
export function discordRunControl(
  kind: 'cancel' | 'thumbsUp' | 'thumbsDown' | 'review',
  runId: string,
): string {
  if (!/^[\w-]{1,80}$/.test(runId)) throw new TypeError('Invalid Discord run reference');
  return `lc1:${{ cancel: 'x', thumbsUp: 'u', thumbsDown: 'd', review: 'r' }[kind]}:${runId}`;
}
/** Private decision controls identify an immutable, owner-bound inbox review, never model text. */
export function discordDecisionControl(reference: string, choice: number): string {
  channelSnowflakeSchema.parse(reference);
  if (!Number.isInteger(choice) || choice < 0 || choice > 3)
    throw new TypeError('Invalid Discord review choice');
  return `lc1:v:${reference}:${choice}`;
}
/** Parsing identifies a capability; the command service still authorizes its actor and source. */
export function parseDiscordControl(
  customId: string,
  messageId?: string,
): DiscordIngressAction | null {
  if (customId.length > 100) return null;
  const decision = /^lc1:v:([0-9]+):([0-3])$/.exec(customId);
  if (decision) {
    const parsed = discordIngressActionSchema.safeParse({
      kind: 'decide',
      reference: decision[1],
      choice: Number(decision[2]),
    });
    return parsed.success ? parsed.data : null;
  }
  const match = /^lc1:([cxudr]):([\w-]+)$/.exec(customId);
  if (!match) return null;
  const [, kind, reference] = match;
  if (kind === 'c')
    return discordConfirmationParts(reference) ? { kind: 'confirm', reference } : null;
  const source = channelSnowflakeSchema.safeParse(messageId);
  if (!source.success || reference.length > 80) return null;
  if (kind === 'r') return { kind: 'review', reference, messageId: source.data };
  const parsed = discordIngressActionSchema.safeParse(
    kind === 'x'
      ? { kind: 'cancel', reference, messageId }
      : {
          kind: 'feedback',
          reference,
          messageId,
          rating: kind === 'u' ? 'thumbsUp' : 'thumbsDown',
        },
  );
  return parsed.success ? parsed.data : null;
}
