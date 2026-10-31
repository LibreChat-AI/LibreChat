import { Types } from 'mongoose';
import { FileContext, CHANNEL_ARTIFACT_FILES_HARD_MAX } from 'librechat-data-provider';
import type {
  ResponseArtifactFile,
  ResponseArtifactQuery,
  RunArtifactRunScope,
} from '~/types/file';
import { getTenantId, isReservedTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { SERVER_AUTHORED_MESSAGE_FILTER } from '~/utils/authored';

/** Null denotes an absent/expired owned response; query failures remain operational errors. */
export async function readResponseArtifactCatalog(
  mongoose: typeof import('mongoose'),
  scope: RunArtifactRunScope,
  query: ResponseArtifactQuery,
): Promise<ResponseArtifactFile[] | null> {
  if (
    [scope.userId, scope.conversationId, scope.runId].some(
      (value) => typeof value !== 'string' || !value.trim(),
    )
  )
    throw new TypeError('A complete response artifact scope is required');
  if (!['list', 'file', 'authorize'].includes(query.kind))
    throw new TypeError('Invalid response artifact query');
  const tenantId = scope.tenantId ?? undefined;
  const current = getTenantId();
  if (
    (tenantId != null &&
      (!tenantId.trim() || isReservedTenantId(tenantId) || tenantId === SYSTEM_TENANT_ID)) ||
    (current && current !== SYSTEM_TENANT_ID && current !== tenantId)
  )
    throw new TypeError('Response artifact tenant does not match authenticated scope');
  if (
    query.kind === 'list' &&
    (!Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > CHANNEL_ARTIFACT_FILES_HARD_MAX + 1)
  )
    throw new TypeError('Invalid response artifact page size');
  if (query.kind === 'file' && (typeof query.fileId !== 'string' || !query.fileId))
    throw new TypeError('A response artifact file ID is required');
  const partition = tenantId ?? { $in: [null, ''] };
  const expiry = { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] };
  const message = {
    user: scope.userId,
    tenantId: partition,
    conversationId: scope.conversationId,
    messageId: scope.runId,
    ...SERVER_AUTHORED_MESSAGE_FILTER,
    ...expiry,
  };
  const Message = mongoose.model('Message');
  if (query.kind === 'authorize') return (await Message.exists(message)) ? [] : null;
  const users: Array<string | Types.ObjectId> = [scope.userId];
  if (Types.ObjectId.isValid(scope.userId)) users.push(new Types.ObjectId(scope.userId));
  const rows = await Message.aggregate<{ files: ResponseArtifactFile[] }>([
    { $match: message },
    { $limit: 1 },
    { $project: { attachments: { $cond: [{ $isArray: '$attachments' }, '$attachments', []] } } },
    {
      $lookup: {
        // Collection metadata only; the lookup below explicitly scopes both owner and tenant.
        // eslint-disable-next-line no-restricted-syntax
        from: mongoose.model('File').collection.name,
        let: {
          attachmentIds: {
            $map: { input: '$attachments', as: 'attachment', in: '$$attachment.file_id' },
          },
        },
        pipeline: [
          {
            $match: {
              user: { $in: users },
              tenantId: partition,
              conversationId: scope.conversationId,
              ...(query.kind === 'file' ? { file_id: query.fileId } : {}),
              $and: [
                expiry,
                { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
                {
                  $or: [
                    { context: FileContext.run_artifact, 'metadata.runFile.runId': scope.runId },
                    {
                      context: FileContext.execute_code,
                      $expr: { $in: ['$file_id', '$$attachmentIds'] },
                    },
                  ],
                },
              ],
            },
          },
          { $sort: { createdAt: 1, file_id: 1 } },
          { $limit: query.kind === 'file' ? 1 : query.limit },
          {
            $project: {
              _id: 0,
              file_id: 1,
              user: { $toString: '$user' },
              tenantId: 1,
              conversationId: 1,
              filename: 1,
              filepath: 1,
              storageKey: 1,
              storageRegion: 1,
              bytes: 1,
              type: 1,
              source: 1,
              expiredAt: 1,
              expiresAt: 1,
            },
          },
        ],
        as: 'files',
      },
    },
    { $project: { _id: 0, files: 1 } },
  ]);
  return rows[0]?.files ?? null;
}
