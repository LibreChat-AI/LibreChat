import { discordRuntimeCursorSchema } from 'librechat-data-provider';
import type { DiscordRuntimeApplications, DiscordRuntimeChannels } from 'librechat-data-provider';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { createDiscordApplicationModel } from '~/models/discord';
import { createDiscordInstallationStorage } from './discord';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { createAgentChannelMethods } from './channel';
import { responseScopeKeys } from './responseScope';
import { createUserModel } from '~/models/user';

export interface DiscordRuntimeStorage {
  applications(cursor: string | undefined, limit: number): Promise<DiscordRuntimeApplications>;
  channels(cursor: string | undefined, limit: number): Promise<DiscordRuntimeChannels>;
}
/** Discovery is a hint, never effect authorization; actual work still joins current authority. */
export function createDiscordRuntimeStorage(
  mongoose: typeof import('mongoose'),
): DiscordRuntimeStorage {
  const applications = createDiscordApplicationModel(mongoose);
  const channels = createAgentChannelModel(mongoose);
  const metadata = createAgentChannelMethods(mongoose);
  const indexes = createChannelIndexGate(() => [channels]);
  const installations = createDiscordInstallationStorage(mongoose);
  function page(cursor: string | undefined, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('Invalid Discord discovery page size');
    return cursor
      ? { _id: { $gt: new mongoose.Types.ObjectId(discordRuntimeCursorSchema.parse(cursor)) } }
      : {};
  }
  return {
    applications: (cursor, limit) =>
      runAsSystem(async () => {
        const rows = await applications
          .find(page(cursor, limit))
          .select('_id applicationId revision tenantId')
          .sort({ _id: 1 })
          .limit(limit + 1)
          .read('primary')
          .lean();
        const scanned = rows.slice(0, limit);
        const values = await Promise.all(
          scanned.map(async (row) => {
            const app = await installations.lookupApplication(row.applicationId);
            return app &&
              app.revision === row.revision &&
              (app.tenantId || '_') === (row.tenantId || '_')
              ? {
                  applicationId: app.applicationId,
                  applicationRevision: app.revision,
                  tenantId: app.tenantId || '_',
                }
              : null;
          }),
        );
        return {
          applications: values.filter((value) => value !== null),
          ...(rows.length > limit ? { next: String(scanned[scanned.length - 1]._id) } : {}),
        };
      }),
    channels: (cursor, limit) =>
      runAsSystem(async () => {
        await indexes();
        const rows = await channels
          .find({ ...page(cursor, limit), type: 'discord', status: 'active' })
          .select('_id channelId tenantId createdBy discord.applicationId')
          .sort({ _id: 1 })
          .limit(limit + 1)
          .read('primary')
          .lean();
        const scanned = rows.slice(0, limit);
        const owners = scanned.filter((row) => mongoose.isValidObjectId(row.createdBy));
        const [users, scopes] = await Promise.all([
          createUserModel(mongoose)
            .find({
              _id: { $in: owners.map((row) => row.createdBy) },
              agentTriggerDeletionStartedAt: { $exists: false },
            })
            .select('_id tenantId')
            .read('primary')
            .lean(),
          createResponseScopeModel(mongoose)
            .find({
              _id: {
                $in: owners.map(
                  (row) =>
                    responseScopeKeys(
                      { userId: row.createdBy, tenantId: row.tenantId || undefined },
                      '',
                    )[0],
                ),
              },
              closed: false,
            })
            .select('_id')
            .read('primary')
            .lean(),
        ]);
        const availableUsers = new Map(
          users.map((user) => [String(user._id), user.tenantId || '_']),
        );
        const availableScopes = new Set(scopes.map((scope) => scope._id));
        const apps = new Map<string, ReturnType<typeof installations.lookupApplication>>();
        const values = await Promise.all(
          scanned.map(async (row) => {
            if (
              !row.discord?.applicationId ||
              availableUsers.get(row.createdBy) !== (row.tenantId || '_') ||
              !availableScopes.has(
                responseScopeKeys(
                  { userId: row.createdBy, tenantId: row.tenantId || undefined },
                  '',
                )[0],
              )
            )
              return null;
            const applicationId = row.discord.applicationId;
            let app = apps.get(applicationId);
            if (!app) {
              app = installations.lookupApplication(applicationId);
              apps.set(applicationId, app);
            }
            return tenantStorage.run({ tenantId: row.tenantId || undefined }, async () => {
              const [channel, current] = await Promise.all([
                metadata.getAgentChannelMetadata(row.channelId),
                app,
              ]);
              if (
                !channel ||
                channel.type !== 'discord' ||
                channel.status !== 'active' ||
                !current ||
                channel.discord.applicationId !== current.applicationId ||
                (current.tenantId || '_') !== (row.tenantId || '_')
              )
                return null;
              return {
                tenantId: row.tenantId || '_',
                channelId: channel.channelId,
                applicationId: current.applicationId,
                applicationRevision: current.revision,
              };
            });
          }),
        );
        return {
          channels: values.filter((value) => value !== null),
          ...(rows.length > limit ? { next: String(scanned[scanned.length - 1]._id) } : {}),
        };
      }),
  };
}
