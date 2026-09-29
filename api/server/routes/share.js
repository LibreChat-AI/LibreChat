const mongoose = require('mongoose');
const express = require('express');
const {
  assertModelBoundContent,
  createShareContentPreflight,
  reportLocatorTraversalFailure,
  isEnabled,
  isContentFilterError,
  isConversationImportError,
  generateCheckAccess,
  grantCreationPermissions,
  ensureLinkPermissions,
  isFileSnapshotEnabled,
  isFileSnapshotKillSwitchActive,
  buildSharedLinkStartupPayload,
  deleteSharedLinkWithCleanup,
  updateSharedLinkPermissionsExpiration,
  isActiveExpirationDate,
  getSharedLinkExpiration,
  buildShareFileEtag,
  parseSharedLinksPageSize,
  isValidSharedLinksCursor,
  MAX_SHARED_LINK_SEARCH_LENGTH,
  createSharedLinkConfigMiddleware,
  createSharedLangfuseSessionResolver,
  recordShareLinkRejection,
  traceIdForMessage,
  resolveDownloadPath,
} = require('@librechat/api');
const {
  logger,
  runAsSystem,
  tenantStorage,
  createChatExpirationDate,
} = require('@librechat/data-schemas');
const { FileSources, PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getFiles,
  updateFile,
  getSharedMessages,
  createSharedLink,
  updateSharedLink,
  getSharedLinks,
  getSharedLink,
  getSharedLinkFile,
  backfillSharedLinkFiles,
  getMessages,
  getRoleByName,
} = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { cleanFileName, getContentDisposition } = require('~/server/utils/files');
const canAccessSharedLink = require('~/server/middleware/canAccessSharedLink');
const { forkSharedConversation } = require('~/server/utils/import/fork');
const { createForkLimiters, createShareLimiters } = require('~/server/middleware/limiters');
const optionalShareFileAuth = require('~/server/middleware/optionalShareFileAuth');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { getHeldCapabilities } = require('~/server/middleware/roles/capabilities');
const configMiddleware = require('~/server/middleware/config/app');
const { getAppConfig } = require('~/server/services/Config/app');
const router = express.Router();
const sharedLinkConfigMiddleware = createSharedLinkConfigMiddleware({ getAppConfig });

const getSharedLangfuseSessionUrl = createSharedLangfuseSessionResolver({
  getHeldCapabilities,
  getMessages,
});

const SHARE_SERVICE_ERROR_STATUS = {
  INVALID_PARAMS: 400,
  TARGET_MESSAGE_NOT_FOUND: 400,
  NO_MESSAGES: 400,
  CONVERSATION_NOT_FOUND: 404,
  SHARE_NOT_FOUND: 404,
  SHARE_EXISTS: 409,
  SHARE_REVISION_MISMATCH: 409,
};

const OBSERVABLE_SHARE_REJECTIONS = new Set(['TARGET_MESSAGE_NOT_FOUND', 'NO_MESSAGES']);

const sendShareServiceError = (req, res, error, fallbackMessage, operation) => {
  const status = SHARE_SERVICE_ERROR_STATUS[error?.code] ?? 500;
  const message = status === 500 ? fallbackMessage : error.message;
  const code = status === 500 ? undefined : error.code;

  if (OBSERVABLE_SHARE_REJECTIONS.has(code)) {
    const targetMessageId = req.body?.targetMessageId;
    const requestId = tenantStorage.getStore()?.requestId ?? req.requestId;
    const traceId =
      typeof targetMessageId === 'string' ? traceIdForMessage(targetMessageId) : undefined;

    recordShareLinkRejection(operation, code);
    logger.warn('[share] Shared link publication rejected', {
      event: 'share_link_rejected',
      operation,
      code,
      ...(requestId && { request_id: requestId }),
      ...(traceId && { trace_id: traceId }),
    });
  }

  return res.status(status).json({ message, ...(code && { code }) });
};

const checkSharedLinksAccess = generateCheckAccess({
  permissionType: PermissionTypes.SHARED_LINKS,
  permissions: [Permissions.CREATE],
  getRoleByName,
});

const resolveSharedLinkExpiration = (req, conversationId) =>
  getSharedLinkExpiration(
    { req, conversationId },
    {
      getConvo: async (userId, sourceConversationId) => {
        const Conversation = mongoose.models.Conversation;
        return Conversation.findOne(
          { conversationId: sourceConversationId, user: userId },
          'isTemporary expiredAt',
        ).lean();
      },
      createExpirationDate: createChatExpirationDate,
      logger,
    },
  );

/**
 * Shared messages
 */
const allowSharedLinks =
  process.env.ALLOW_SHARED_LINKS === undefined || isEnabled(process.env.ALLOW_SHARED_LINKS);

/** Run within the snapshot file's tenant context (mirrors canAccessSharedLink). */
const runWithTenant = (tenantId, fn) =>
  tenantId ? tenantStorage.run({ tenantId }, fn) : runAsSystem(fn);

/** Mirrors the owner preview route: pending records older than this are swept to
 * 'failed' on the next poll so the client poller terminates. */
const PREVIEW_LAZY_SWEEP_CUTOFF_MS = 2 * 60 * 1000;

const enforceSharedFileContentPolicy = (req, res, next) => {
  try {
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters: req.config?.filters,
      files: [req.liveFile],
    });
    return next();
  } catch (error) {
    if (isContentFilterError(error)) {
      return res.status(error.statusCode).json(error.body);
    }
    return next(error);
  }
};

/**
 * MIME types that are safe to render inline. Everything else (text/html, SVG,
 * and other active content) is served as an `attachment` so a public viewer
 * can't execute uploaded bytes under the app origin by opening the URL directly.
 */
const SAFE_INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/x-icon',
  'application/pdf',
]);

/**
 * Resolve a snapshotted file for a shared link. A file_id absent from the
 * share's snapshot is denied (404) — this prevents a viewer from reaching files
 * outside the shared-link snapshot. Only legacy shares (no `fileSnapshots` field
 * at all) trigger a lazy backfill; an ordinary miss does not rebuild. The live
 * file record is also required: if the original was deleted/expired, return a
 * clean 404 instead of letting the stream error after headers are sent.
 */
const resolveShareFile = async (req, res, next) => {
  try {
    // Global kill switch only (env-based, viewer-independent): disabling stops
    // serving for every link. The viewer's own config must NOT affect serving.
    if (isFileSnapshotKillSwitchActive()) {
      return res.status(404).json({ message: 'Shared file access is disabled' });
    }

    const { shareId, file_id } = req.params;
    const { file, hasSnapshots, optedOut } = await getSharedLinkFile(shareId, file_id);
    // Per-link opt-out: never serve and never backfill an opted-out link.
    if (optedOut) {
      return res.status(404).json({ message: 'File not found in shared link' });
    }
    let snapshot = file;
    if (!snapshot && !hasSnapshots) {
      snapshot = await backfillSharedLinkFiles(shareId, file_id);
    }
    if (!snapshot) {
      logger.warn(
        `[shareFileAccess] File ${file_id} not in snapshot for share ${shareId} (route ${req.originalUrl})`,
      );
      return res.status(404).json({ message: 'File not found in shared link' });
    }

    const [liveFile] = await getFiles({ file_id }, null, {});
    if (!liveFile) {
      logger.warn(
        `[shareFileAccess] Snapshotted file ${file_id} no longer available for share ${shareId}`,
      );
      return res.status(404).json({ message: 'File no longer available' });
    }

    // Pin to the snapshotted version so an old link can't surface post-share content
    // after a reused file_id (e.g. code-exec same-filename outputs) is overwritten.
    // sourceDispatchedAt changes for every source artifact emit; previewRevision
    // covers deferred/office generations, while `bytes` covers legacy records
    // without either marker and stays stable across URL refresh/preview updates.
    const revisionChanged =
      (snapshot.previewRevision ?? null) !== (liveFile.previewRevision ?? null);
    const sourceGenerationChanged =
      snapshot.sourceDispatchedAt != null &&
      snapshot.sourceDispatchedAt !== (liveFile.metadata?.sourceDispatchedAt ?? null);
    const bytesChanged =
      snapshot.bytes != null && liveFile.bytes != null && snapshot.bytes !== liveFile.bytes;
    if (revisionChanged || sourceGenerationChanged || bytesChanged) {
      logger.warn(
        `[shareFileAccess] Snapshot version mismatch for file ${file_id} (share ${shareId})`,
      );
      return res.status(404).json({ message: 'File no longer available' });
    }

    req.shareFile = snapshot;
    req.liveFile = liveFile;
    return next();
  } catch (error) {
    logger.error('[shareFileAccess] Error resolving shared file:', error);
    return res.status(500).json({ message: 'Error resolving shared file' });
  }
};

/** Stream (or redirect to) a snapshotted file from its original stored object. */
const streamSharedFile = async (req, res, file, requestedDisposition) => {
  const source = file.source || FileSources.local;

  // An update keeps the shareId, so these URLs are stable across re-publishes. Without
  // revalidation a viewer's cached copy would outlive a revoked "share files" choice or a
  // replaced snapshot by the max-age.
  const etag = buildShareFileEtag(file);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  if (source === FileSources.text) {
    if (req.liveFile?.text == null) {
      return res.status(404).send('No file content found');
    }
    const textFilename = file.filename?.toLowerCase().endsWith('.txt')
      ? file.filename
      : `${file.filename || file.file_id}.txt`;
    const disposition = requestedDisposition === 'inline' ? 'inline' : 'attachment';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', getContentDisposition(textFilename, disposition));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(req.liveFile.text);
  }

  const { getDownloadStream, getDownloadURL } = getStrategyFunctions(source);

  // Inline only safe preview types; anything else is forced to attachment.
  const disposition =
    requestedDisposition === 'inline' && SAFE_INLINE_TYPES.has(file.type) ? 'inline' : 'attachment';

  // Redirect to a signed storage URL only when explicitly requested (?direct=true);
  // by default stream through the server so blob (XHR) callers work without bucket CORS.
  const isDirectSource = source === FileSources.s3 || source === FileSources.cloudfront;
  if (req.query.direct === 'true' && getDownloadURL && isDirectSource) {
    try {
      const url = await getDownloadURL({
        req,
        file,
        customFilename: cleanFileName(file.filename),
        contentType: file.type || 'application/octet-stream',
      });
      if (url) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, url);
      }
    } catch (error) {
      logger.warn('[shareFileAccess] download URL generation failed, streaming instead:', error);
    }
  }

  if (!getDownloadStream) {
    return res.status(501).send('Not Implemented');
  }

  // Strip any cache-busting query string (e.g. code-output images add `?v=...`) so
  // the local stream resolves the real filename, not a literal `*.png?v=...` path.
  const streamPath = (resolveDownloadPath(file) || '').split('?')[0];
  const fileStream = await getDownloadStream(req, streamPath);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', getContentDisposition(file.filename, disposition));
  res.setHeader(
    'Content-Type',
    disposition === 'inline' ? file.type || 'application/octet-stream' : 'application/octet-stream',
  );
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      fileStream.removeListener('error', onError);
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
      resolve();
    };

    fileStream.once('error', onError);
    res.once('finish', onFinish);
    res.once('close', onClose);
    fileStream.pipe(res);
  });
};

if (allowSharedLinks) {
  const { forkIpLimiter, forkUserLimiter } = createForkLimiters();
  const { shareIpLimiter, shareUserLimiter } = createShareLimiters();

  router.get(
    '/:shareId/config',
    optionalJwtAuth,
    canAccessSharedLink,
    sharedLinkConfigMiddleware,
    (req, res) => {
      try {
        const payload = buildSharedLinkStartupPayload(req.config);
        res.set('Cache-Control', 'private, no-store');
        res.status(200).json(payload);
      } catch (error) {
        logger.error('Error getting shared startup config:', error);
        res.status(500).json({ message: 'Error getting shared startup config' });
      }
    },
  );

  router.get(
    '/:shareId',
    optionalJwtAuth,
    shareIpLimiter,
    shareUserLimiter,
    canAccessSharedLink,
    sharedLinkConfigMiddleware,
    async (req, res) => {
      try {
        const contentPreflight = createShareContentPreflight(req.config?.filters, {
          onTraversalFailure: reportLocatorTraversalFailure,
          sharedFileMetadata: true,
          legacyPii: req.config?.messageFilter?.pii,
        });
        const sharePromise = getSharedMessages(req.params.shareId, req.shareResourceId, {
          // Viewer-independent: the per-link choice (stored on the share) decides
          // file inclusion; only a global env kill switch can force it off here.
          snapshotFiles: !isFileSnapshotKillSwitchActive(),
          preflight: contentPreflight,
        });
        const langfuseSessionPromise = getSharedLangfuseSessionUrl({
          viewer: req.user,
          shareTenantId: req.shareTenantId,
          shareConversationId: req.shareConversationId,
          shareOwnerId: req.shareOwnerId,
          config: req.config?.langfuse,
        }).catch((error) => {
          logger.warn('[share] Failed to resolve Langfuse session link:', error);
          return null;
        });
        const [share, langfuseSessionUrl] = await Promise.all([
          sharePromise,
          langfuseSessionPromise,
        ]);
        if (share) {
          res.set('Cache-Control', 'private, no-store');
          res
            .status(200)
            .json(langfuseSessionUrl == null ? share : { ...share, langfuseSessionUrl });
        } else {
          res.status(404).end();
        }
      } catch (error) {
        if (isContentFilterError(error)) {
          return res.status(error.statusCode).json(error.body);
        }
        logger.error('Error getting shared messages:', error);
        res.status(500).json({ message: 'Error getting shared messages' });
      }
    },
  );

  router.post(
    '/:shareId/fork',
    requireJwtAuth,
    forkIpLimiter,
    forkUserLimiter,
    canAccessSharedLink,
    sharedLinkConfigMiddleware,
    async (req, res) => {
      try {
        const result = await forkSharedConversation({
          shareId: req.params.shareId,
          shareResourceId: req.shareResourceId,
          requestUserId: req.user.id,
          userRole: req.user.role,
          userTenantId: req.user.tenantId,
          targetMessageIndex: req.body?.targetMessageIndex,
          shareRevision: req.body?.shareRevision,
          // Viewer-independent: honor the global shared-file kill switch, matching
          // the GET share route so disabled file snapshots aren't copied into forks.
          snapshotFiles: !isFileSnapshotKillSwitchActive(),
          sharedContentPreflight: createShareContentPreflight(req.config?.filters, {
            onTraversalFailure: reportLocatorTraversalFailure,
            sharedFileMetadata: true,
            legacyPii: req.config?.messageFilter?.pii,
          }),
        });
        if (!result) {
          return res.status(404).json({ message: 'Shared conversation not found' });
        }
        return res.status(201).json(result);
      } catch (error) {
        if (isContentFilterError(error)) {
          return res.status(error.statusCode).json(error.body);
        }
        if (isConversationImportError(error)) {
          return res.status(error.statusCode).json(error.body);
        }
        if (error?.code !== 'SHARE_REVISION_MISMATCH') {
          logger.error('Error forking shared conversation:', error);
        }
        return sendShareServiceError(req, res, error, 'Error forking shared conversation', 'fork');
      }
    },
  );

  /**
   * Preview status for a snapshotted file. Read live from the file record so the
   * status is always current (deferred previews may resolve after the share was
   * created) and large extracted text is never embedded in the share document.
   */
  router.get(
    '/:shareId/files/:file_id/preview',
    optionalJwtAuth,
    optionalShareFileAuth,
    canAccessSharedLink,
    sharedLinkConfigMiddleware,
    resolveShareFile,
    enforceSharedFileContentPolicy,
    async (req, res) => {
      try {
        const { file_id } = req.params;
        let liveFile = req.liveFile;
        // Lazy-sweep orphaned pending records to 'failed' so the client preview
        // poller reaches a terminal state (mirrors the owner preview route).
        if (liveFile?.status === 'pending' && liveFile.updatedAt instanceof Date) {
          const ageMs = Date.now() - liveFile.updatedAt.getTime();
          if (ageMs > PREVIEW_LAZY_SWEEP_CUTOFF_MS) {
            const swept = await updateFile(
              { file_id, status: 'failed', previewError: 'orphaned' },
              { status: 'pending', updatedAt: liveFile.updatedAt },
            );
            if (swept) {
              liveFile = swept;
            }
          }
        }
        const status = liveFile?.status || 'ready';
        const payload = { file_id, status };
        if (status === 'ready' && liveFile?.text != null) {
          payload.text = liveFile.text;
          payload.textFormat = liveFile.textFormat ?? null;
        } else if (status === 'failed' && liveFile?.previewError) {
          payload.previewError = liveFile.previewError;
        }
        res.set('Cache-Control', 'private, no-store');
        return res.status(200).json(payload);
      } catch (error) {
        logger.error('[shareFileAccess] Error fetching shared preview:', error);
        return res.status(500).json({ message: 'Error fetching preview' });
      }
    },
  );

  /** Download a snapshotted file (attachment disposition). */
  router.get(
    '/:shareId/files/:file_id/download',
    optionalJwtAuth,
    optionalShareFileAuth,
    canAccessSharedLink,
    sharedLinkConfigMiddleware,
    resolveShareFile,
    enforceSharedFileContentPolicy,
    async (req, res) => {
      try {
        await runWithTenant(req.shareFile.tenantId, () =>
          streamSharedFile(req, res, req.shareFile, 'attachment'),
        );
      } catch (error) {
        logger.error('[shareFileAccess] Error downloading shared file:', error);
        if (!res.headersSent) {
          return res.status(500).send('Error downloading file');
        }
        res.destroy();
      }
    },
  );

  /** Inline-serve a snapshotted file (image src, generic view). */
  router.get(
    '/:shareId/files/:file_id',
    optionalJwtAuth,
    optionalShareFileAuth,
    canAccessSharedLink,
    sharedLinkConfigMiddleware,
    resolveShareFile,
    enforceSharedFileContentPolicy,
    async (req, res) => {
      try {
        await runWithTenant(req.shareFile.tenantId, () =>
          streamSharedFile(req, res, req.shareFile, 'inline'),
        );
      } catch (error) {
        logger.error('[shareFileAccess] Error serving shared file:', error);
        if (!res.headersSent) {
          return res.status(500).send('Error serving file');
        }
        res.destroy();
      }
    },
  );
}

/**
 * Shared links
 */
router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const sortBy =
      typeof req.query.sortBy === 'string' && ['createdAt', 'title'].includes(req.query.sortBy)
        ? req.query.sortBy
        : 'createdAt';
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

    if (search && search.length > MAX_SHARED_LINK_SEARCH_LENGTH) {
      return res.status(400).json({
        message: `search must be ${MAX_SHARED_LINK_SEARCH_LENGTH} characters or fewer`,
      });
    }

    if (cursor && !isValidSharedLinksCursor(cursor, sortBy)) {
      return res.status(400).json({ message: 'cursor is not valid for this sort' });
    }

    const params = {
      pageParam: cursor,
      pageSize: parseSharedLinksPageSize(req.query.pageSize),
      sortBy,
      sortDirection: ['asc', 'desc'].includes(req.query.sortDirection)
        ? req.query.sortDirection
        : 'desc',
      search: search || undefined,
    };

    const result = await getSharedLinks(
      req.user.id,
      params.pageParam,
      params.pageSize,
      params.sortBy,
      params.sortDirection,
      params.search,
    );

    res.status(200).send({
      links: result.links,
      nextCursor: result.nextCursor,
      hasNextPage: result.hasNextPage,
    });
  } catch (error) {
    logger.error('Error getting shared links:', error);
    res.status(500).json({ message: 'Error getting shared links' });
  }
});

router.get('/link/:conversationId', requireJwtAuth, async (req, res) => {
  try {
    const share = await getSharedLink(req.user.id, req.params.conversationId);

    if (share._id && share.success) {
      await ensureLinkPermissions(share._id, req.user.id);
    }

    return res.status(200).json({
      _id: share._id,
      success: share.success,
      shareId: share.shareId,
      targetMessageId: share.targetMessageId,
      snapshotFiles: share.snapshotFiles,
      conversationId: req.params.conversationId,
    });
  } catch (error) {
    logger.error('Error getting shared link:', error);
    res.status(500).json({ message: 'Error getting shared link' });
  }
});

router.post(
  '/:conversationId',
  requireJwtAuth,
  configMiddleware,
  checkSharedLinksAccess,
  async (req, res) => {
    try {
      const { targetMessageId, snapshotFiles: requestedSnapshotFiles } = req.body ?? {};
      if (
        targetMessageId !== undefined &&
        (typeof targetMessageId !== 'string' || targetMessageId.trim().length === 0)
      ) {
        return res.status(400).json({ message: 'targetMessageId must be a non-empty string' });
      }
      if (requestedSnapshotFiles !== undefined && typeof requestedSnapshotFiles !== 'boolean') {
        return res.status(400).json({ message: 'snapshotFiles must be a boolean' });
      }

      const expiredAt = await resolveSharedLinkExpiration(req, req.params.conversationId);
      if (expiredAt != null && !isActiveExpirationDate(expiredAt)) {
        return res.status(404).end();
      }

      const role = await getRoleByName(req.user.role);
      const sharedLinksPerms = role?.permissions?.[PermissionTypes.SHARED_LINKS] || {};
      const grantPublic = sharedLinksPerms[Permissions.SHARE_PUBLIC] === true;
      // Per-link opt-out: snapshot only when the feature is enabled AND the user
      // did not uncheck "share files" (body flag absent defaults to enabled).
      const snapshotFiles = isFileSnapshotEnabled(req.config) && requestedSnapshotFiles !== false;
      const contentPreflight = createShareContentPreflight(req.config?.filters, {
        onTraversalFailure: reportLocatorTraversalFailure,
        snapshotFiles,
        user: req.user,
        getFiles,
        sharedFileMetadata: true,
        sharedFileMetadataFiles: false,
        legacyPii: req.config?.messageFilter?.pii,
      });

      const created = await createSharedLink(
        req.user.id,
        req.params.conversationId,
        targetMessageId,
        expiredAt,
        snapshotFiles,
        ...(contentPreflight == null ? [] : [contentPreflight]),
      );
      if (created) {
        await grantCreationPermissions(created._id, req.user.id, grantPublic, expiredAt);
        res.status(200).json(created);
      } else {
        res.status(404).end();
      }
    } catch (error) {
      if (isContentFilterError(error)) {
        return res.status(error.statusCode).json(error.body);
      }
      if (!OBSERVABLE_SHARE_REJECTIONS.has(error?.code)) {
        logger.error('Error creating shared link:', error);
      }
      return sendShareServiceError(req, res, error, 'Error creating shared link', 'create');
    }
  },
);

/** Updating or re-scoping a link re-publishes conversation content, so it is gated
 * on the same CREATE permission as POST; revoking CREATE must stop updates too.
 * DELETE stays ungated so an owner can always retract a link they no longer may create. */
router.patch(
  '/:shareId',
  requireJwtAuth,
  configMiddleware,
  checkSharedLinksAccess,
  async (req, res) => {
    try {
      const { targetMessageId, snapshotFiles: requestedSnapshotFiles } = req.body ?? {};
      if (
        targetMessageId !== undefined &&
        (typeof targetMessageId !== 'string' || targetMessageId.trim().length === 0)
      ) {
        return res.status(400).json({ message: 'targetMessageId must be a non-empty string' });
      }
      if (requestedSnapshotFiles !== undefined && typeof requestedSnapshotFiles !== 'boolean') {
        return res.status(400).json({ message: 'snapshotFiles must be a boolean' });
      }

      let expiredAt;
      const SharedLink = mongoose.models.SharedLink;
      const existing = await SharedLink.findOne(
        { shareId: req.params.shareId, user: req.user.id },
        'conversationId',
      ).lean();
      if (existing?.conversationId) {
        expiredAt = await resolveSharedLinkExpiration(req, existing.conversationId);
      }
      if (expiredAt != null && !isActiveExpirationDate(expiredAt)) {
        return res.status(404).end();
      }

      const snapshotFiles = isFileSnapshotEnabled(req.config) && requestedSnapshotFiles !== false;
      const contentPreflight = createShareContentPreflight(req.config?.filters, {
        onTraversalFailure: reportLocatorTraversalFailure,
        snapshotFiles,
        user: req.user,
        getFiles,
        sharedFileMetadata: true,
        sharedFileMetadataFiles: false,
        legacyPii: req.config?.messageFilter?.pii,
      });
      const beforePublish =
        existing?._id && expiredAt !== undefined
          ? () => updateSharedLinkPermissionsExpiration(existing._id, expiredAt)
          : undefined;
      const updatedShare = await updateSharedLink(
        req.user.id,
        req.params.shareId,
        targetMessageId,
        expiredAt,
        snapshotFiles,
        contentPreflight,
        beforePublish,
      );
      if (!updatedShare) {
        return res.status(404).end();
      }

      return res.status(200).json(updatedShare);
    } catch (error) {
      if (isContentFilterError(error)) {
        return res.status(error.statusCode).json(error.body);
      }
      if (!OBSERVABLE_SHARE_REJECTIONS.has(error?.code)) {
        logger.error('Error updating shared link:', error);
      }
      return sendShareServiceError(req, res, error, 'Error updating shared link', 'update');
    }
  },
);

router.delete('/:shareId', requireJwtAuth, async (req, res) => {
  try {
    const result = await deleteSharedLinkWithCleanup(req.user.id, req.params.shareId);

    if (!result) {
      return res.status(404).json({ message: 'Share not found' });
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error deleting shared link:', error);
    return res.status(500).json({ message: 'Error deleting shared link' });
  }
});

module.exports = router;
