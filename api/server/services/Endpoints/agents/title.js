const {
  isEnabled,
  publishConversationTitle,
  allowsAssistantSideEffects,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo, getConvo } = require('~/models');
const { resolveConversationTitle } = require('../titlePolicy');

/**
 * Generates an Agent conversation's title without saving it. The chat hands this to its
 * conversation's title task, which owns the deadline, the save and delivery.
 *
 * @param {ServerRequest} req
 * @param {Object} params
 * @param {string} params.text - The user's first message.
 * @param {TMessage} [params.response] - The assistant response (`final` timing only).
 * @param {AgentClient} params.client
 * @param {boolean} [params.immediate] - Generate from the user's message alone, in parallel
 *   with the response, awaiting the run instead of requiring it.
 * @param {AbortSignal} [params.signal] - Cancels the title model call.
 * @returns {Promise<string | undefined>}
 */
const generateTitle = async (req, { text, client, immediate = false, signal }) => {
  const { TITLE_CONVO = true } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO) || typeof client?.titleConvo !== 'function') {
    return;
  }
  if (!allowsAssistantSideEffects(req?.config, client.options?.titleConvo)) {
    return;
  }
  if (req?.body?.isTemporary) {
    return;
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
  try {
    const generated = await client.titleConvo({ text, abortController, immediate });
    if (!generated) {
      logger.debug('[generateTitle] No title generated');
      return;
    }
    return resolveConversationTitle(req, generated) ?? undefined;
  } catch (error) {
    logger.error('Client title error:', error);
    return;
  } finally {
    signal?.removeEventListener('abort', abort);
    abort();
  }
};

/**
 * Generates and publishes a title in one step, for a resumed approval turn that reports the
 * title on its own stream.
 *
 * @param {ServerRequest} req
 * @param {Object} params
 * @param {string} params.text - The user's first message.
 * @param {AgentClient} params.client
 * @param {string} params.conversationId
 * @param {(params: { conversationId: string, title: string }) => Promise<void>|void} [params.onTitleGenerated]
 *   Called after caching the title for the live stream.
 */
const addTitle = async (req, { text, client, conversationId, onTitleGenerated }) => {
  if (!conversationId) {
    logger.warn('[addTitle] Missing conversationId; skipping title generation');
    return;
  }
  try {
    const title = await generateTitle(req, { text, client });
    if (title == null) {
      return;
    }
    await publishConversationTitle(
      { saveConvo, getConvo, titleCache: getLogStores(CacheKeys.GEN_TITLE) },
      {
        ctx: {
          userId: req?.user?.id,
          isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
          expiredAt: req?.resolvedConversation?.expiredAt,
          interfaceConfig: req?.config?.interfaceConfig,
        },
        conversationId,
        title,
        onTitleGenerated,
      },
    );
  } catch (error) {
    logger.error('Error generating title:', error);
  }
};

module.exports = addTitle;
module.exports.generateTitle = generateTitle;
