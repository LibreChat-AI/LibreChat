import { z } from 'zod';
import { channelSnowflakeSchema, discordThreadBindingSchema } from 'librechat-data-provider';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordThreadRouteModel } from '~/models/discordThread';

const erasureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('application'), applicationId: channelSnowflakeSchema }).strict(),
  z
    .object({
      kind: z.literal('guild'),
      applicationId: channelSnowflakeSchema,
      guildId: channelSnowflakeSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal('channel'), channelId: discordThreadBindingSchema.shape.channelId })
    .strict(),
]);
/** The parent closes first; opaque capacity-bounded pins survive without private routing references. */
export async function eraseDiscordThreadRoutes(
  mongoose: typeof import('mongoose'),
  scope: { tenantId?: string } & (
    | { kind: 'application'; applicationId: string }
    | { kind: 'guild'; applicationId: string; guildId: string }
    | { kind: 'channel'; channelId: string }
  ),
): Promise<void> {
  const current = getTenantId() || undefined;
  if (current === SYSTEM_TENANT_ID || (scope.tenantId || undefined) !== current)
    throw new TypeError('Discord thread erasure requires matching tenant scope');
  const { tenantId: _tenantId, ...input } = scope;
  void _tenantId;
  const key = erasureSchema.parse(input);
  await createDiscordThreadRouteModel(mongoose).deleteMany({
    tenantId: current ?? null,
    ...(key.kind === 'channel'
      ? { channelId: key.channelId }
      : {
          applicationId: key.applicationId,
          ...(key.kind === 'guild' ? { guildId: key.guildId } : {}),
        }),
  });
}
