const {
  isEnabled,
  publishConversationTitle,
  runAgentConversationTitle,
  GenerationJobManager,
  getSafeErrorMetadata,
  allowsAssistantSideEffects,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo, getConvo } = require('~/models');
const { resolveConversationTitle } = require('../titlePolicy');

/**
 * Add title to conversation in a way that avoids memory retention.
 *
 * @param {ServerRequest} req
 * @param {Object} params
 * @param {string} params.text - The user's first message.
 * @param {TMessage} [params.response] - The assistant response (legacy/`final` timing only).
 * @param {AgentClient} params.client
 * @param {string} [params.conversationId] - Required for `immediate` timing, where
 *   `response` is not yet available; falls back to `response.conversationId`.
 * @param {number} [params.epoch] - Exact chat generation identity for detached titles.
 * @param {boolean} [params.immediate] - When true, the title is generated in parallel
 *   with the response (from the user's first message) and persisted to the conversation
 *   only after `convoReady` resolves (the conversation row must exist for `noUpsert`).
 * @param {Promise<void>} [params.convoReady] - Resolves once the conversation has been
 *   persisted; awaited before saving the title in `immediate` mode.
 * @param {AbortSignal} [params.signal] - When aborted (e.g. the user stops an
 *   immediate-mode generation), cancels the in-flight title model call so a
 *   turn stopped before the title finished does not consume the title model. A
 *   title that already finished generating is still persisted and surfaced.
 * @param {AbortSignal} [params.discardSignal] - When aborted, discards an
 *   already-generated title instead of persisting it. Used only when this stream
 *   is superseded by a newer run (or the turn failed), so a stale title does not
 *   clobber the conversation now owned by the newer run. A plain user Stop does
 *   NOT abort this — its generated title is kept.
 * @param {() => boolean} [params.canPublishEarly] - Whether the live stream still accepts title events.
 * @param {(params: { conversationId: string, title: string }) => Promise<void>|void} [params.onTitleGenerated]
 *   Called after caching the title for the live stream.
 */
const addTitle = async (
  req,
  {
    text,
    response,
    client,
    conversationId,
    immediate = false,
    epoch,
    convoReady,
    signal,
    discardSignal,
    canPublishEarly,
    onTitleGenerated,
  },
) => {
  const { TITLE_CONVO = true } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return;
  }

  if (!allowsAssistantSideEffects(req?.config, client.options.titleConvo)) {
    return;
  }

  // Skip title generation for temporary conversations
  if (req?.body?.isTemporary) {
    return;
  }

  const convoId = conversationId ?? response?.conversationId;
  if (!convoId) {
    logger.warn('[addTitle] Missing conversationId; skipping title generation');
    return;
  }

  if (typeof client.titleConvo !== 'function') return;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  try {
    await runAgentConversationTitle({
      appConfig: req.config,
      titleCache,
      key: `${req.user.id}-${convoId}`,
      epoch,
      signal,
      discardSignal,
      generate: (abortController) => client.titleConvo({ text, abortController, immediate }),
      publish: async (generated) => {
        const title = resolveConversationTitle(req, generated);
        if (title == null) return;
        await publishConversationTitle(
          { saveConvo, getConvo, titleCache },
          {
            ctx: {
              userId: req.user.id,
              isTemporary: req.resolvedConversation?.isTemporary ?? req.body?.isTemporary,
              expiredAt: req.resolvedConversation?.expiredAt,
              interfaceConfig: req.config?.interfaceConfig,
            },
            conversationId: convoId,
            title,
            convoReady,
            discardSignal,
            signal,
            isCurrent:
              epoch == null
                ? undefined
                : async () =>
                    (await GenerationJobManager.getJobStore().getGenerationEpoch(convoId)) ===
                    epoch,
            canPublishEarly,
            onTitleGenerated,
          },
        );
      },
    });
  } catch (error) {
    if (!signal?.aborted && !discardSignal?.aborted) {
      logger.error('Error generating title:', getSafeErrorMetadata(error));
    }
  }
};

module.exports = addTitle;
