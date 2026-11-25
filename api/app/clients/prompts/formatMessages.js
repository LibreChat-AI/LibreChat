const { ATTACHMENT_ONLY_TEXT } = require('@librechat/api');
const { EModelEndpoint, ContentTypes } = require('librechat-data-provider');
const { AIMessage, HumanMessage, SystemMessage } = require('@librechat/agents/langchain/messages');

/**
 * Formats a message to OpenAI Vision API payload format.
 *
 * @param {Object} params - The parameters for formatting.
 * @param {Object} params.message - The message object to format.
 * @param {string} [params.message.role] - The role of the message sender (must be 'user').
 * @param {string} [params.message.content] - The text content of the message.
 * @param {EModelEndpoint} [params.endpoint] - Identifier for specific endpoint handling
 * @param {Array<string>} [params.image_urls] - The image_urls to attach to the message.
 * @returns {(Object)} - The formatted message.
 */
const formatVisionMessage = ({ message, image_urls, endpoint }) => {
  // Omit an empty text part for image-only messages. Anthropic rejects empty
  // text content blocks with HTTP 400, and an empty block adds nothing for
  // other providers either.
  const hasText = typeof message.content === 'string' && message.content.trim() !== '';
  const textPart = hasText ? [{ type: ContentTypes.TEXT, text: message.content }] : [];

  if (endpoint === EModelEndpoint.anthropic) {
    message.content = [...image_urls, ...textPart];
    return message;
  }

  message.content = [...textPart, ...image_urls];

  return message;
};

/**
 * Formats a message to OpenAI payload format based on the provided options.
 *
 * @param {Object} params - The parameters for formatting.
 * @param {Object} params.message - The message object to format.
 * @param {string} [params.message.role] - The role of the message sender (e.g., 'user', 'assistant').
 * @param {string} [params.message._name] - The name associated with the message.
 * @param {string} [params.message.sender] - The sender of the message.
 * @param {string} [params.message.text] - The text content of the message.
 * @param {string} [params.message.content] - The content of the message.
 * @param {Array<string>} [params.message.image_urls] - The image_urls attached to the message for Vision API.
 * @param {string} [params.userName] - The name of the user.
 * @param {string} [params.assistantName] - The name of the assistant.
 * @param {string} [params.endpoint] - Identifier for specific endpoint handling
 * @param {boolean} [params.langChain=false] - Whether to return a LangChain message object.
 * @returns {(Object|HumanMessage|AIMessage|SystemMessage)} - The formatted message.
 */
const formatMessage = ({ message, userName, assistantName, endpoint, langChain = false }) => {
  let { role: _role, _name, sender, text, content: _content, lc_id } = message;
  if (lc_id && lc_id[2] && !langChain) {
    const roleMapping = {
      SystemMessage: 'system',
      HumanMessage: 'user',
      AIMessage: 'assistant',
    };
    _role = roleMapping[lc_id[2]];
  }
  const role = _role ?? (sender && sender?.toLowerCase() === 'user' ? 'user' : 'assistant');
  const content = _content ?? text ?? '';
  const formattedMessage = {
    role,
    content,
  };

  const { image_urls } = message;
  if (Array.isArray(image_urls) && image_urls.length > 0 && role === 'user') {
    return formatVisionMessage({
      message: formattedMessage,
      image_urls: message.image_urls,
      endpoint,
    });
  }

  /**
   * An attachment-only turn whose files reach the model out-of-band (RAG,
   * code environment) leaves nothing in the content itself, and providers
   * such as Anthropic reject an empty user message outright.
   */
  if (role === 'user' && content === '' && message.files?.length > 0) {
    formattedMessage.content = ATTACHMENT_ONLY_TEXT;
  }

  if (_name) {
    formattedMessage.name = _name;
  }

  if (userName && formattedMessage.role === 'user') {
    formattedMessage.name = userName;
  }

  if (assistantName && formattedMessage.role === 'assistant') {
    formattedMessage.name = assistantName;
  }

  if (formattedMessage.name) {
    // Conform to API regex: ^[a-zA-Z0-9_-]{1,64}$
    // https://community.openai.com/t/the-format-of-the-name-field-in-the-documentation-is-incorrect/175684/2
    formattedMessage.name = formattedMessage.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (formattedMessage.name.length > 64) {
      formattedMessage.name = formattedMessage.name.substring(0, 64);
    }
  }

  if (!langChain) {
    return formattedMessage;
  }

  if (role === 'user') {
    return new HumanMessage(formattedMessage);
  } else if (role === 'assistant') {
    return new AIMessage(formattedMessage);
  } else {
    return new SystemMessage(formattedMessage);
  }
};

module.exports = {
  formatMessage,
};
