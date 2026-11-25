const { v4 } = require('uuid');
const {
  countTokens,
  isAnnounceableReply,
  syncMessages: syncThreadMessages,
  processMessages: processThreadMessages,
} = require('@librechat/api');
const { Constants, ContentTypes, defaultOrderQuery } = require('librechat-data-provider');
const {
  saveConvo,
  getMessages,
  spendTokens,
  saveMessage,
  stampConvoLastResponse,
} = require('~/models');
const { retrieveAndProcessFile } = require('~/server/services/Files/process');

/**
 * Initializes a new thread or adds messages to an existing thread.
 *
 * @param {Object} params - The parameters for initializing a thread.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {Object} params.body - The body of the request.
 * @param {ThreadMessage[]} params.body.messages - A list of messages to start the thread with.
 * @param {Object} [params.body.metadata] - Optional metadata for the thread.
 * @param {string} [params.thread_id] - Optional existing thread ID. If provided, a message will be added to this thread.
 * @return {Promise<Thread>} A promise that resolves to the newly created thread object or the updated thread object.
 */
async function initThread({ openai, body, thread_id: _thread_id }) {
  let thread = {};
  const messages = [];
  if (_thread_id) {
    const message = await openai.beta.threads.messages.create(_thread_id, body.messages[0]);
    messages.push(message);
  } else {
    thread = await openai.beta.threads.create(body);
  }

  const thread_id = _thread_id || thread.id;
  return { messages, thread_id, ...thread };
}

/**
 * Saves a user message to the DB in the Assistants endpoint format.
 *
 * @param {Object} req - The request object.
 * @param {Object} params - The parameters of the user message
 * @param {string} params.user - The user's ID.
 * @param {string} params.text - The user's prompt.
 * @param {string} params.messageId - The user message Id.
 * @param {string} params.model - The model used by the assistant.
 * @param {string} params.assistant_id - The current assistant Id.
 * @param {string} params.thread_id - The thread Id.
 * @param {string} params.conversationId - The message's conversationId
 * @param {string} params.endpoint - The conversation endpoint
 * @param {string} [params.parentMessageId] - Optional if initial message.
 * Defaults to Constants.NO_PARENT.
 * @param {string} [params.instructions] - Optional: from preset for `instructions` field.
 * Overrides the instructions of the assistant.
 * @param {string} [params.promptPrefix] - Optional: from preset for `additional_instructions` field.
 * @param {import('librechat-data-provider').TFile[]} [params.files] - Optional. List of Attached File Objects.
 * @param {string[]} [params.file_ids] - Optional. List of File IDs attached to the userMessage.
 * @return {Promise<Run>} A promise that resolves to the created run object.
 */
async function saveUserMessage(req, params) {
  const tokenCount = await countTokens(params.text);

  const userMessage = {
    user: params.user,
    endpoint: params.endpoint,
    messageId: params.messageId,
    conversationId: params.conversationId,
    parentMessageId: params.parentMessageId ?? Constants.NO_PARENT,
    /* For messages, use the assistant_id instead of model */
    model: params.assistant_id,
    thread_id: params.thread_id,
    sender: 'User',
    text: params.text,
    isCreatedByUser: true,
    tokenCount,
  };

  // Only confirmed new conversations seed membership; saveConvo applies it on insert.
  const chatProjectId =
    req?.resolvedConversation === null ? req.chatProjectContext?.projectId : undefined;
  const convo = {
    endpoint: params.endpoint,
    conversationId: params.conversationId,
    promptPrefix: params.promptPrefix,
    instructions: params.instructions,
    assistant_id: params.assistant_id,
    model: params.model,
    ...(typeof chatProjectId === 'string' && chatProjectId ? { chatProjectId } : {}),
  };
  if (params.files?.length) {
    userMessage.files = params.files.map(({ file_id }) => ({ file_id }));
    convo.file_ids = params.file_ids;
  }

  const ctx = {
    userId: req?.user?.id,
    isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
    expiredAt: req?.resolvedConversation?.expiredAt,
    interfaceConfig: req?.config?.interfaceConfig,
  };
  const message = await saveMessage(ctx, userMessage);
  const savedConvo = await saveConvo(
    { ...ctx, expiredAt: message?.expiredAt ?? ctx.expiredAt },
    convo,
    {
      context: 'api/server/services/Threads/manage.js #saveUserMessage',
      ...(message?._id != null ? { appendMessageIds: [message._id] } : {}),
    },
  );
  if (savedConvo != null) {
    req.resolvedConversation = savedConvo;
  }
  return message;
}

/**
 * Saves an Assistant message to the DB in the Assistants endpoint format.
 *
 * @param {Object} req - The request object.
 * @param {Object} params - The parameters of the Assistant message
 * @param {string} params.user - The user's ID.
 * @param {string} params.messageId - The message Id.
 * @param {string} params.text - The concatenated text of the message.
 * @param {string} params.assistant_id - The assistant Id.
 * @param {string} params.thread_id - The thread Id.
 * @param {string} params.model - The model used by the assistant.
 * @param {ContentPart[]} params.content - The message content parts.
 * @param {string} params.conversationId - The message's conversationId
 * @param {string} params.endpoint - The conversation endpoint
 * @param {string} params.parentMessageId - The latest user message that triggered this response.
 * @param {string} [params.instructions] - Optional: from preset for `instructions` field.
 * @param {string} [params.spec] - Optional: Model spec identifier.
 * @param {string} [params.iconURL]
 * @param {import('librechat-data-provider').TAttachment[]} [params.attachments]
 * Overrides the instructions of the assistant.
 * @param {string} [params.promptPrefix] - Optional: from preset for `additional_instructions` field.
 * @return {Promise<{message: Object|null, conversation: Object|null}>} The persisted assistant
 * message and the conversation snapshot settled by the same write.
 */
async function saveAssistantMessage(req, params) {
  // const tokenCount = // TODO: need to count each content part

  const ctx = {
    userId: req?.user?.id,
    isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
    expiredAt: req?.resolvedConversation?.expiredAt,
    interfaceConfig: req?.config?.interfaceConfig,
  };
  const message = await saveMessage(ctx, {
    user: params.user,
    endpoint: params.endpoint,
    messageId: params.messageId,
    conversationId: params.conversationId,
    parentMessageId: params.parentMessageId,
    thread_id: params.thread_id,
    /* For messages, use the assistant_id instead of model */
    model: params.assistant_id,
    content: params.content,
    attachments: params.attachments,
    sender: 'Assistant',
    isCreatedByUser: false,
    text: params.text,
    unfinished: false,
    // tokenCount,
    iconURL: params.iconURL,
    spec: params.spec,
  });

  const announceable = isAnnounceableReply({
    messageId: message?.messageId,
    content: params.content,
    text: params.text,
    isTemporary: ctx.isTemporary,
  });

  const savedConvo = await saveConvo(
    { ...ctx, expiredAt: message?.expiredAt ?? ctx.expiredAt },
    {
      endpoint: params.endpoint,
      conversationId: params.conversationId,
      promptPrefix: params.promptPrefix,
      instructions: params.instructions,
      assistant_id: params.assistant_id,
      model: params.model,
      iconURL: params.iconURL,
      spec: params.spec,
    },
    {
      context: 'api/server/services/Threads/manage.js #saveAssistantMessage',
      /** Judged by the same predicate every other persistence path asks, so an assistant row
       *  that renders nothing cannot raise a dot here that opening the chat can never clear.
       *  `saveConvo` assigns the timestamp past its own awaited reads, so a catch-up recorded
       *  while one of them is in flight cannot outrank this reply. */
      stampReply: announceable,
      ...(announceable ? { replyMessageId: message.messageId } : {}),
      ...(message?._id != null ? { appendMessageIds: [message._id] } : {}),
    },
  );

  if (savedConvo != null) {
    req.resolvedConversation = savedConvo;
  }

  return { message, conversation: savedConvo };
}

/**
 * Records LibreChat messageId to all response messages' metadata
 *
 * @param {Object} params - The parameters for initializing a thread.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {string} params.thread_id - Response thread ID.
 * @param {string} params.messageId - The response `messageId` generated by LibreChat.
 * @param {StepMessage[] | Message[]} params.messages - A list of messages to start the thread with.
 * @return {Promise<ThreadMessage[]>} A promise that resolves to the updated messages
 */
async function addThreadMetadata({ openai, thread_id, messageId, messages }) {
  const promises = [];
  for (const message of messages) {
    promises.push(
      openai.beta.threads.messages.update(message.id, {
        thread_id,
        metadata: {
          messageId,
        },
      }),
    );
  }

  return await Promise.all(promises);
}

/**
 * Synchronizes LibreChat messages to Thread Messages; see `syncMessages` in `@librechat/api`.
 *
 * @param {Parameters<typeof import('@librechat/api').syncMessages>[1]} params
 * @return {Promise<TMessage[]>} A promise that resolves to the updated messages
 */
const syncMessages = (params) =>
  syncThreadMessages({ saveMessage, saveConvo, stampConvoLastResponse, addThreadMetadata }, params);

/**
 * Maps messages to their corresponding steps. Steps with message creation will be paired with their messages,
 * while steps without message creation will be returned as is.
 *
 * @param {RunStep[]} steps - An array of steps from the run.
 * @param {Message[]} messages - An array of message objects.
 * @returns {(StepMessage | RunStep)[]} An array where each element is either a step with its corresponding message (StepMessage) or a step without a message (RunStep).
 */
function mapMessagesToSteps(steps, messages) {
  // Create a map of messages indexed by their IDs for efficient lookup
  const messageMap = messages.reduce((acc, msg) => {
    acc[msg.id] = msg;
    return acc;
  }, {});

  // Map each step to its corresponding message, or return the step as is if no message ID is present
  return steps
    .sort((a, b) => a.created_at - b.created_at)
    .map((step) => {
      const messageId = step.step_details?.message_creation?.message_id;

      if (messageId && messageMap[messageId]) {
        return { step, message: messageMap[messageId] };
      }
      return step;
    });
}

/**
 * Checks for any missing messages; if missing,
 * synchronizes LibreChat messages to Thread Messages
 *
 * @param {Object} params - The parameters for initializing a thread.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {string} params.endpoint - The current endpoint.
 * @param {string} [params.latestMessageId] - Optional: The latest message ID from LibreChat.
 * @param {string} params.thread_id - Response thread ID.
 * @param {string} params.run_id - Response Run ID.
 * @param {string} params.conversationId - LibreChat conversation ID.
 * @return {Promise<TMessage[]>} A promise that resolves to the updated messages
 */
async function checkMessageGaps({
  openai,
  endpoint,
  latestMessageId,
  thread_id,
  run_id,
  conversationId,
}) {
  const promises = [];
  promises.push(openai.beta.threads.messages.list(thread_id, defaultOrderQuery));
  promises.push(openai.beta.threads.runs.steps.list(run_id, { thread_id }));
  /** @type {[{ data: ThreadMessage[] }, { data: RunStep[] }]} */
  const [response, stepsResponse] = await Promise.all(promises);

  const steps = mapMessagesToSteps(stepsResponse.data, response.data);
  /** @type {ThreadMessage} */
  const currentMessage = {
    id: v4(),
    content: [],
    assistant_id: null,
    created_at: Math.floor(new Date().getTime() / 1000),
    object: 'thread.message',
    role: 'assistant',
    run_id,
    thread_id,
    endpoint,
    metadata: {
      messageId: latestMessageId,
    },
  };

  for (const step of steps) {
    if (!currentMessage.assistant_id && step.assistant_id) {
      currentMessage.assistant_id = step.assistant_id;
    }
    if (step.message) {
      currentMessage.id = step.message.id;
      currentMessage.created_at = step.message.created_at;
      currentMessage.content = currentMessage.content.concat(step.message.content);
    } else if (step.step_details?.type === 'tool_calls' && step.step_details?.tool_calls?.length) {
      currentMessage.content = currentMessage.content.concat(
        step.step_details?.tool_calls.map((toolCall) => ({
          [ContentTypes.TOOL_CALL]: {
            ...toolCall,
            progress: 2,
          },
          type: ContentTypes.TOOL_CALL,
        })),
      );
    }
  }

  let addedCurrentMessage = false;
  const apiMessages = response.data
    .map((msg) => {
      if (msg.id === currentMessage.id) {
        addedCurrentMessage = true;
        return currentMessage;
      }
      return msg;
    })
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!addedCurrentMessage) {
    apiMessages.push(currentMessage);
  }

  const dbMessages = await getMessages({ conversationId, user: openai.req.user.id });
  const assistant_id = dbMessages?.[0]?.model;

  const syncedMessages = await syncMessages({
    openai,
    endpoint,
    thread_id,
    dbMessages,
    apiMessages,
    assistant_id,
    conversationId,
  });

  return Object.values(
    [...dbMessages, ...syncedMessages].reduce(
      (acc, message) => ({ ...acc, [message.messageId]: message }),
      {},
    ),
  );
}

/**
 * Records token usage for a given completion request.
 * @param {Object} params - The parameters for initializing a thread.
 * @param {number} params.prompt_tokens - The number of prompt tokens used.
 * @param {number} params.completion_tokens - The number of completion tokens used.
 * @param {string} params.model - The model used by the assistant run.
 * @param {string} params.user - The user's ID.
 * @param {string} params.conversationId - LibreChat conversation ID.
 * @param {string} [params.context='message'] - The context of the usage. Defaults to 'message'.
 * @param {AppConfig['transactions']} [params.transactions] - Resolved transactions config.
 * @return {Promise<void>}
 */
const recordUsage = async ({
  prompt_tokens,
  completion_tokens,
  model,
  user,
  conversationId,
  context = 'message',
  transactions,
}) => {
  await spendTokens(
    {
      user,
      model,
      context,
      conversationId,
      transactions,
    },
    { promptTokens: prompt_tokens, completionTokens: completion_tokens },
  );
};

/**
 * Sorts, processes, and flattens messages to a single string; see `processMessages` in
 * `@librechat/api`.
 *
 * @param {object} params - The parameters for processing messages.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {RunClient} params.client - The LibreChat client that manages the run: either refers to `OpenAI` or `StreamRunManager`.
 * @param {ThreadMessage[]} params.messages - An array of messages.
 * @returns {Promise<{messages: ThreadMessage[], text: string, edited: boolean}>} The sorted messages, the flattened text, and whether it was edited.
 */
const processMessages = (params) => processThreadMessages({ retrieveAndProcessFile }, params);

module.exports = {
  initThread,
  recordUsage,
  processMessages,
  saveUserMessage,
  checkMessageGaps,
  addThreadMetadata,
  mapMessagesToSteps,
  saveAssistantMessage,
};
