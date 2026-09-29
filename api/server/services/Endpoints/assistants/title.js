const { isEnabled, sanitizeTitle, getAttachmentTitleText } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const initializeClient = require('./initalize');
const { saveConvo } = require('~/models');
const { resolveConversationTitle } = require('../titlePolicy');

/**
 * Generates a conversation title using OpenAI SDK
 * @param {Object} params
 * @param {OpenAI} params.openai - The OpenAI SDK client instance
 * @param {string} params.text - User's message text
 * @param {string} params.responseText - Assistant's response text
 * @returns {Promise<string>}
 */
const generateTitle = async ({ openai, text, responseText }) => {
  const titlePrompt = `Please generate a concise title (max 40 characters) for a conversation that starts with:
User: ${text}
Assistant: ${responseText}

Title:`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'user',
        content: titlePrompt,
      },
    ],
    temperature: 0.7,
    max_tokens: 20,
  });

  const title = completion.choices[0]?.message?.content?.trim() || 'New conversation';
  return sanitizeTitle(title);
};

/**
 * Adds a title to a conversation asynchronously
 * @param {ServerRequest} req
 * @param {Object} params
 * @param {string} params.text - User's message text
 * @param {string} params.responseText - Assistant's response text
 * @param {string} params.conversationId - Conversation ID
 */
const addTitle = async (req, { text, responseText, conversationId }) => {
  const { TITLE_CONVO = 'true' } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return;
  }

  // Skip title generation for temporary conversations
  if (req?.body?.isTemporary) {
    return;
  }

  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;

  try {
    const { openai } = await initializeClient({ req });
    const generatedTitle = await generateTitle({ openai, text, responseText });
    const title = resolveConversationTitle(req, generatedTitle);
    if (title == null) {
      return;
    }
    await titleCache.set(key, title, 120000);

    const reqCtx = {
      userId: req?.user?.id,
      isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
      expiredAt: req?.resolvedConversation?.expiredAt,
      interfaceConfig: req?.config?.interfaceConfig,
    };
    await saveConvo(
      reqCtx,
      {
        conversationId,
        title,
      },
      { context: 'api/server/services/Endpoints/assistants/addTitle.js', noUpsert: true },
    );
  } catch (error) {
    logger.error('[addTitle] Error generating title:', error);
    /**
     * An attachment-only turn has no text to fall back on, and saving the
     * empty string would replace the conversation's default title with a
     * blank sidebar entry. Use the filenames, then the response, and leave
     * the default in place when neither says anything.
     */
    const fallbackSource = text || getAttachmentTitleText(req?.body?.files) || responseText || '';
    if (!fallbackSource) {
      return;
    }
    const submittedFallback =
      fallbackSource.length > 40 ? fallbackSource.substring(0, 37) + '...' : fallbackSource;
    const fallbackTitle = resolveConversationTitle(req, submittedFallback);
    if (fallbackTitle == null) {
      return;
    }
    await titleCache.set(key, fallbackTitle, 120000);
    await saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
        expiredAt: req?.resolvedConversation?.expiredAt,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      {
        conversationId,
        title: fallbackTitle,
      },
      { context: 'api/server/services/Endpoints/assistants/addTitle.js', noUpsert: true },
    );
  }
};

module.exports = addTitle;
