const { logger } = require('@librechat/data-schemas');
const {
  getSafeErrorMetadata,
  preflightCodeOutputBatch: runCodeOutputBatchPreflight,
} = require('@librechat/api');
const {
  EModelEndpoint,
  mergeFileConfig,
  getEndpointFileConfig,
} = require('librechat-data-provider');
const { prepareCodeOutputForInspection } = require('./process');

const preflightCodeOutputBatch = async ({ req, artifact, codeExecutionContext }) => {
  const mergedFileConfig = mergeFileConfig(req.config?.fileConfig);
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig: mergedFileConfig,
    endpoint: EModelEndpoint.agents,
  });
  return await runCodeOutputBatchPreflight({
    filters: req.config?.filters,
    artifact,
    limits: {
      fileLimit: endpointFileConfig.fileLimit,
      fileSizeLimit: endpointFileConfig.fileSizeLimit ?? mergedFileConfig.serverFileSizeLimit,
      totalSizeLimit:
        endpointFileConfig.totalSizeLimit ??
        endpointFileConfig.fileSizeLimit ??
        mergedFileConfig.serverFileSizeLimit,
    },
    prepare: ({ file, sessionId, maxBytes, inspectContent }) =>
      prepareCodeOutputForInspection({
        req,
        id: file.id,
        name: file.name,
        session_id: sessionId,
        maxBytes,
        inspectContent,
        codeApiBaseUrl: codeExecutionContext?.baseUrl,
        executionProfile: codeExecutionContext?.executionProfile,
        bridgeWorkerId: codeExecutionContext?.bridgeWorkerId,
        executionRouteKey: codeExecutionContext?.executionRouteKey,
      }),
    /** The batch degrades this artifact to the download fallback and the turn
     *  still succeeds, so this warning is the only trace the failure leaves.
     *  Carry the cause: without it a Code API that refused the download, one
     *  routed to the wrong execution profile, and a file too large to inspect
     *  all read as the same sentence. `getSafeErrorMetadata` is what keeps
     *  that from reaching for the artifact's name or the upstream body —
     *  both can echo submitted content into the log. */
    onInspectionUnavailable: (index, cause) => {
      logger.warn(
        `[preflightCodeOutputBatch] Generated artifact ${index + 1} could not be inspected`,
        getSafeErrorMetadata(cause),
      );
    },
  });
};

module.exports = {
  preflightCodeOutputBatch,
};
