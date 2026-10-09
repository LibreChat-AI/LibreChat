const { ATTACHMENT_ONLY_TEXT } = require('@librechat/api');
const { EModelEndpoint, ContentTypes } = require('librechat-data-provider');
const {
  AIMessage,
  ToolMessage,
  HumanMessage,
  SystemMessage,
} = require('@librechat/agents/langchain/messages');

/**
 * Stands in for a user turn that carries no text and whose attachments are no longer
 * being resent, so the turn stays valid without inventing content it never had.
 */
const EMPTY_MESSAGE_PLACEHOLDER = '(no text)';

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

/**
 * Formats an array of messages for LangChain.
 *
 * @param {Array<Object>} messages - The array of messages to format.
 * @param {Object} formatOptions - The options for formatting each message.
 * @param {string} [formatOptions.userName] - The name of the user.
 * @param {string} [formatOptions.assistantName] - The name of the assistant.
 * @returns {Array<(HumanMessage|AIMessage|SystemMessage)>} - The array of formatted LangChain messages.
 */
const formatLangChainMessages = (messages, formatOptions) =>
  messages.map((msg) => formatMessage({ ...formatOptions, message: msg, langChain: true }));

/**
 * Formats a LangChain message object by merging properties from `lc_kwargs` or `kwargs` and `additional_kwargs`.
 *
 * @param {Object} message - The message object to format.
 * @param {Object} [message.lc_kwargs] - Contains properties to be merged. Either this or `message.kwargs` should be provided.
 * @param {Object} [message.kwargs] - Contains properties to be merged. Either this or `message.lc_kwargs` should be provided.
 * @param {Object} [message.kwargs.additional_kwargs] - Additional properties to be merged.
 *
 * @returns {Object} The formatted LangChain message.
 */
const formatFromLangChain = (message) => {
  const { additional_kwargs, ...message_kwargs } = message.lc_kwargs ?? message.kwargs;
  return {
    ...message_kwargs,
    ...additional_kwargs,
  };
};

/**
 * Formats an array of messages for LangChain, handling tool calls and creating ToolMessage instances.
 *
 * @param {Array<Partial<TMessage>>} payload - The array of messages to format.
 * @returns {Array<(HumanMessage|AIMessage|SystemMessage|ToolMessage)>} - The array of formatted LangChain messages, including ToolMessages for tool calls.
 */
const formatAgentMessages = (payload) => {
  const messages = [];

  for (const message of payload) {
    if (typeof message.content === 'string') {
      /** An empty string yields a blank text block, which strict providers (Bedrock,
       *  Anthropic) reject outright for the whole request. `formatVisionMessage`
       *  already guards this for image-bearing sends; history replay of a
       *  promptless send reaches here with no `image_urls`, so guard it too. */
      message.content = message.content.trim()
        ? [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: message.content }]
        : [];
    }
    if (message.role !== 'assistant') {
      const formatted = formatMessage({ message, langChain: true });
      /** A promptless send replayed from history can reduce to nothing once its
       *  attachments are no longer resent. Providers reject a blank text block and
       *  an empty content array alike, but dropping the turn is not safe either:
       *  nothing merges the assistant turns it would leave adjacent, and the same
       *  providers reject consecutive assistant messages. Keep the turn, and give
       *  it the smallest honest stand-in for the content that is no longer there. */
      const { content: formattedContent } = formatted;
      const isEmpty = Array.isArray(formattedContent)
        ? formattedContent.length === 0
        : typeof formattedContent === 'string' && formattedContent.trim() === '';
      if (isEmpty) {
        formatted.content = [
          { type: ContentTypes.TEXT, [ContentTypes.TEXT]: EMPTY_MESSAGE_PLACEHOLDER },
        ];
      }
      messages.push(formatted);
      continue;
    }

    let currentContent = [];
    let lastAIMessage = null;
    /**
     * Every AIMessage produced from this TMessage that received `tool_calls`,
     * in order. Multi-step tool turns (where the agent loop cycles the LLM
     * multiple times with intervening tool results) produce one AIMessage per
     * cycle, each owning a different `tool_call_id`. We attach persisted
     * Vertex Gemini 3 thought signatures (`metadata.thoughtSignatures`,
     * keyed by `tool_call_id`) onto each one so every step has its right
     * signature on resume — Vertex validates per-step, not per-turn
     * (issue #13006 follow-up).
     */
    const toolBearingAIMessages = [];

    let hasReasoning = false;
    for (const part of message.content) {
      if (part.type === ContentTypes.TEXT && part.tool_call_ids) {
        /*
        If there's pending content, it needs to be aggregated as a single string to prepare for tool calls.
        For Anthropic models, the "tool_calls" field on a message is only respected if content is a string.
         */
        if (currentContent.length > 0) {
          let content = currentContent.reduce((acc, curr) => {
            if (curr.type === ContentTypes.TEXT) {
              return `${acc}${curr[ContentTypes.TEXT]}\n`;
            }
            return acc;
          }, '');
          content = `${content}\n${part[ContentTypes.TEXT] ?? ''}`.trim();
          lastAIMessage = new AIMessage({ content });
          messages.push(lastAIMessage);
          currentContent = [];
          continue;
        }

        // Create a new AIMessage with this text and prepare for tool calls
        lastAIMessage = new AIMessage({
          content: part.text || '',
        });

        messages.push(lastAIMessage);
      } else if (part.type === ContentTypes.TOOL_CALL) {
        if (!lastAIMessage) {
          throw new Error('Invalid tool call structure: No preceding AIMessage with tool_call_ids');
        }

        // Note: `tool_calls` list is defined when constructed by `AIMessage` class, and outputs should be excluded from it
        const {
          output,
          args: _args,
          inputValidationError: _inputValidationError,
          ...tool_call
        } = part.tool_call;
        // TODO: investigate; args as dictionary may need to be provider-or-tool-specific
        let args = _args;
        try {
          args = JSON.parse(_args);
        } catch (_e) {
          if (typeof _args === 'string') {
            args = { input: _args };
          }
        }

        tool_call.args = args;
        lastAIMessage.tool_calls.push(tool_call);
        if (toolBearingAIMessages[toolBearingAIMessages.length - 1] !== lastAIMessage) {
          toolBearingAIMessages.push(lastAIMessage);
        }

        // Add the corresponding ToolMessage
        messages.push(
          new ToolMessage({
            tool_call_id: tool_call.id,
            name: tool_call.name,
            content: output || '',
          }),
        );
      } else if (part.type === ContentTypes.THINK) {
        hasReasoning = true;
        continue;
      } else if (part.type === ContentTypes.STEER) {
        /*
        A mid-run steer: user speech persisted inline in the assistant message.
        Flush any accumulated assistant text first so ordering is preserved, then
        replay the steer as a standalone user message. `lastAIMessage` is NOT
        reset — the aggregator emits a fresh text-with-tool_call_ids part for any
        post-steer tool step, and preceding tool_call parts already pushed their
        ToolMessages, so the HumanMessage lands after them (valid provider order).
         */
        if (currentContent.length > 0) {
          if (currentContent.some((curr) => curr.type !== ContentTypes.TEXT)) {
            /** Non-text parts (images, files) must survive the flush intact —
             *  folding to text here would drop them from replayed history. */
            messages.push(new AIMessage({ content: currentContent }));
          } else {
            const content = currentContent
              .reduce((acc, curr) => `${acc}${curr[ContentTypes.TEXT] ?? ''}\n`, '')
              .trim();
            if (content.length > 0) {
              messages.push(new AIMessage({ content }));
            }
          }
          currentContent = [];
        }
        messages.push(
          new HumanMessage({
            content:
              Array.isArray(part.media) && part.media.length > 0
                ? part.media
                : (part[ContentTypes.STEER] ?? ''),
            additional_kwargs: { source: 'steer' },
          }),
        );
        /** A post-steer tool_call must mint a FRESH assistant anchor —
         *  attaching to the pre-steer one would emit its ToolMessage after
         *  the HumanMessage while the call sat before it (invalid order). */
        lastAIMessage = null;
      } else if (
        part.type === ContentTypes.ERROR ||
        part.type === ContentTypes.AGENT_UPDATE ||
        part.type === ContentTypes.ACTIVITY_LABEL
      ) {
        // ACTIVITY_LABEL parts are UI-only progress notes — never model input.
        continue;
      } else {
        currentContent.push(part);
      }
    }

    if (hasReasoning) {
      currentContent = currentContent
        .reduce((acc, curr) => {
          if (curr.type === ContentTypes.TEXT) {
            return `${acc}${curr[ContentTypes.TEXT]}\n`;
          }
          return acc;
        }, '')
        .trim();
    }

    if (currentContent.length > 0) {
      messages.push(new AIMessage({ content: currentContent }));
    }

    /**
     * Restore signatures per-step. The persisted shape is
     * `{ [tool_call_id]: signature }`; for each tool-bearing AIMessage we
     * build a position-aligned `additional_kwargs.signatures` array (empty
     * placeholders for tool_calls without a stored signature). Agents'
     * `fixThoughtSignatures` then dispatches the non-empty entries to
     * functionCall parts in order — order matches because non-empty
     * signatures and tool_calls share their original parts ordering.
     */
    const sigsByCallId = message.metadata?.thoughtSignatures;
    if (sigsByCallId && typeof sigsByCallId === 'object' && toolBearingAIMessages.length > 0) {
      for (const aiMsg of toolBearingAIMessages) {
        const sigs = aiMsg.tool_calls.map((tc) => sigsByCallId[tc.id] ?? '');
        if (sigs.some((s) => typeof s === 'string' && s.length > 0)) {
          aiMsg.additional_kwargs ??= {};
          aiMsg.additional_kwargs.signatures = sigs;
        }
      }
    }
  }

  return messages;
};

module.exports = {
  formatMessage,
  formatFromLangChain,
  formatAgentMessages,
  formatLangChainMessages,
};
