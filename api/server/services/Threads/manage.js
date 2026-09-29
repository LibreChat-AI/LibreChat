const path = require('path');
const { v4 } = require('uuid');
const { countTokens } = require('@librechat/api');
const { escapeRegExp } = require('@librechat/data-schemas');
const {
  Constants,
  ContentTypes,
  AnnotationTypes,
  defaultOrderQuery,
} = require('librechat-data-provider');
const { saveMessage, getMessages, spendTokens, saveConvo } = require('~/models');
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

  const convo = {
    endpoint: params.endpoint,
    conversationId: params.conversationId,
    promptPrefix: params.promptPrefix,
    instructions: params.instructions,
    assistant_id: params.assistant_id,
    model: params.model,
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
    { context: 'api/server/services/Threads/manage.js #saveUserMessage' },
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
 * Overrides the instructions of the assistant.
 * @param {string} [params.promptPrefix] - Optional: from preset for `additional_instructions` field.
 * @return {Promise<Run>} A promise that resolves to the created run object.
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
    sender: 'Assistant',
    isCreatedByUser: false,
    text: params.text,
    unfinished: false,
    // tokenCount,
    iconURL: params.iconURL,
    spec: params.spec,
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
    { context: 'api/server/services/Threads/manage.js #saveAssistantMessage' },
  );

  if (savedConvo != null) {
    req.resolvedConversation = savedConvo;
  }

  return message;
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
 * Synchronizes LibreChat messages to Thread Messages.
 * Updates the LibreChat DB with any missing Thread Messages and
 * updates the missing Thread Messages' metadata with their corresponding db messageId's.
 *
 * Also updates the existing conversation's file_ids with any new file_ids.
 *
 * @param {Object} params - The parameters for synchronizing messages.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {string} params.endpoint - The current endpoint.
 * @param {string} params.thread_id - The current thread ID.
 * @param {TMessage[]} params.dbMessages - The LibreChat DB messages.
 * @param {ThreadMessage[]} params.apiMessages - The thread messages from the API.
 * @param {string} [params.assistant_id] - The current assistant ID.
 * @param {string} params.conversationId - The current conversation ID.
 * @return {Promise<TMessage[]>} A promise that resolves to the updated messages
 */
async function syncMessages({
  openai,
  endpoint,
  thread_id,
  dbMessages,
  apiMessages,
  assistant_id,
  conversationId,
}) {
  let result = [];
  let dbMessageMap = new Map(dbMessages.map((msg) => [msg.messageId, msg]));

  const modifyPromises = [];
  const recordPromises = [];
  const ctx = {
    userId: openai.req?.user?.id,
    isTemporary: openai.req?.resolvedConversation?.isTemporary ?? openai.req?.body?.isTemporary,
    expiredAt: openai.req?.resolvedConversation?.expiredAt,
    interfaceConfig: openai.req?.config?.interfaceConfig,
  };

  /**
   *
   * Modify API message and save newMessage to DB
   *
   * @param {Object} params - The parameters object
   * @param {TMessage} params.dbMessage
   * @param {dbMessage} params.apiMessage
   */
  const processNewMessage = async ({ dbMessage, apiMessage }) => {
    recordPromises.push(saveMessage(ctx, { ...dbMessage, user: openai.req.user.id }));

    if (!apiMessage.id.includes('msg_')) {
      return;
    }

    if (dbMessage.aggregateMessages?.length > 1) {
      modifyPromises.push(
        addThreadMetadata({
          openai,
          thread_id,
          messageId: dbMessage.messageId,
          messages: dbMessage.aggregateMessages,
        }),
      );
      return;
    }

    modifyPromises.push(
      openai.beta.threads.messages.update(apiMessage.id, {
        thread_id,
        metadata: {
          messageId: dbMessage.messageId,
        },
      }),
    );
  };

  let lastMessage = null;

  for (let i = 0; i < apiMessages.length; i++) {
    const apiMessage = apiMessages[i];

    // Check if the message exists in the database based on metadata
    const dbMessageId = apiMessage.metadata && apiMessage.metadata.messageId;
    let dbMessage = dbMessageMap.get(dbMessageId);

    if (dbMessage) {
      // If message exists in DB, use its messageId and update parentMessageId
      dbMessage.parentMessageId = lastMessage ? lastMessage.messageId : Constants.NO_PARENT;
      lastMessage = dbMessage;
      result.push(dbMessage);
      continue;
    }

    if (apiMessage.role === 'assistant' && lastMessage && lastMessage.role === 'assistant') {
      // Aggregate assistant messages
      lastMessage.content = [...lastMessage.content, ...apiMessage.content];
      lastMessage.files = [...(lastMessage.files ?? []), ...(apiMessage.files ?? [])];
      lastMessage.aggregateMessages.push({ id: apiMessage.id });
    } else {
      // Handle new or missing message
      const newMessage = {
        thread_id,
        conversationId,
        messageId: v4(),
        endpoint,
        parentMessageId: lastMessage ? lastMessage.messageId : Constants.NO_PARENT,
        role: apiMessage.role,
        isCreatedByUser: apiMessage.role === 'user',
        // TODO: process generated files in content parts
        content: apiMessage.content,
        aggregateMessages: [{ id: apiMessage.id }],
        model: apiMessage.role === 'user' ? null : apiMessage.assistant_id,
        user: openai.req.user.id,
        unfinished: false,
      };

      if (apiMessage.file_ids?.length) {
        // TODO: retrieve file objects from API
        newMessage.files = apiMessage.file_ids.map((file_id) => ({ file_id }));
      }

      /* Assign assistant_id if defined */
      if (assistant_id && apiMessage.role === 'assistant' && !newMessage.model) {
        apiMessage.model = assistant_id;
        newMessage.model = assistant_id;
      }

      result.push(newMessage);
      lastMessage = newMessage;

      if (apiMessage.role === 'user') {
        processNewMessage({ dbMessage: newMessage, apiMessage });
        continue;
      }
    }

    const nextMessage = apiMessages[i + 1];
    const processAssistant = !nextMessage || nextMessage.role === 'user';

    if (apiMessage.role === 'assistant' && processAssistant) {
      processNewMessage({ dbMessage: lastMessage, apiMessage });
    }
  }

  const attached_file_ids = apiMessages.reduce((acc, msg) => {
    if (msg.role === 'user' && msg.file_ids?.length) {
      return [...acc, ...msg.file_ids];
    }

    return acc;
  }, []);

  await Promise.all(modifyPromises);
  await Promise.all(recordPromises);

  const savedConvo = await saveConvo(
    ctx,
    {
      conversationId,
      file_ids: attached_file_ids,
    },
    { context: 'api/server/services/Threads/manage.js #syncMessages' },
  );
  if (savedConvo != null) {
    openai.req.resolvedConversation = savedConvo;
  }

  return result;
}

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

const uniqueCitationStart = '^====||===';
const uniqueCitationEnd = '==|||||^';

/**
 * Sorts, processes, and flattens messages to a single string.
 *
 * @param {object} params - The parameters for processing messages.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {RunClient} params.client - The LibreChat client that manages the run: either refers to `OpenAI` or `StreamRunManager`.
 * @param {ThreadMessage[]} params.messages - An array of messages.
 * @returns {Promise<{messages: ThreadMessage[], text: string, edited: boolean}>} The sorted messages, the flattened text, and whether it was edited.
 */
async function processMessages({ openai, client, messages = [] }) {
  const sorted = messages.sort((a, b) => a.created_at - b.created_at);

  let text = '';
  let edited = false;
  const sources = new Map();
  const fileRetrievalPromises = [];

  for (const message of sorted) {
    message.files = [];
    for (const content of message.content) {
      const type = content.type;
      const contentType = content[type];
      const currentFileId = contentType?.file_id;

      if (type === ContentTypes.IMAGE_FILE && !client.processedFileIds.has(currentFileId)) {
        fileRetrievalPromises.push(
          retrieveAndProcessFile({
            openai,
            client,
            file_id: currentFileId,
            basename: `${currentFileId}.png`,
          })
            .then((file) => {
              client.processedFileIds.add(currentFileId);
              message.files.push(file);
            })
            .catch((error) => {
              console.error(`Failed to retrieve file: ${error.message}`);
            }),
        );
        continue;
      }

      let currentText = contentType?.value ?? '';

      /** @type {{ annotations: Annotation[] }} */
      const { annotations } = contentType ?? {};

      if (!annotations?.length) {
        text += currentText;
        continue;
      }

      const replacements = [];
      const annotationPromises = annotations.map(async (annotation) => {
        const type = annotation.type;
        const annotationType = annotation[type];
        const file_id = annotationType?.file_id;
        const alreadyProcessed = client.processedFileIds.has(file_id);

        let file;
        let replacementText = '';

        try {
          if (alreadyProcessed) {
            file = await retrieveAndProcessFile({ openai, client, file_id, unknownType: true });
          } else if (type === AnnotationTypes.FILE_PATH) {
            const basename = path.basename(annotation.text);
            file = await retrieveAndProcessFile({
              openai,
              client,
              file_id,
              basename,
            });
            replacementText = file.filepath;
          } else if (type === AnnotationTypes.FILE_CITATION && file_id) {
            file = await retrieveAndProcessFile({
              openai,
              client,
              file_id,
              unknownType: true,
            });
            if (file && file.filename) {
              if (!sources.has(file.filename)) {
                sources.set(file.filename, sources.size + 1);
              }
              replacementText = `${uniqueCitationStart}${sources.get(
                file.filename,
              )}${uniqueCitationEnd}`;
            }
          }

          if (file && replacementText) {
            replacements.push({
              start: annotation.start_index,
              end: annotation.end_index,
              text: replacementText,
            });
            edited = true;
            if (!alreadyProcessed) {
              client.processedFileIds.add(file_id);
              message.files.push(file);
            }
          }
        } catch (error) {
          console.error(`Failed to process annotation: ${error.message}`);
        }
      });

      await Promise.all(annotationPromises);

      // Apply replacements in reverse order
      replacements.sort((a, b) => b.start - a.start);
      for (const { start, end, text: replacementText } of replacements) {
        currentText = currentText.slice(0, start) + replacementText + currentText.slice(end);
      }

      text += currentText;
    }
  }

  await Promise.all(fileRetrievalPromises);

  // Handle adjacent identical citations with the unique format
  const adjacentCitationRegex = new RegExp(
    `${escapeRegExp(uniqueCitationStart)}(\\d+)${escapeRegExp(
      uniqueCitationEnd,
    )}(\\s*)${escapeRegExp(uniqueCitationStart)}(\\d+)${escapeRegExp(uniqueCitationEnd)}`,
    'g',
  );
  text = text.replace(adjacentCitationRegex, (match, num1, space, num2) => {
    return num1 === num2
      ? `${uniqueCitationStart}${num1}${uniqueCitationEnd}`
      : `${uniqueCitationStart}${num1}${uniqueCitationEnd}${space}${uniqueCitationStart}${num2}${uniqueCitationEnd}`;
  });

  // Remove any remaining adjacent identical citations
  const remainingAdjacentRegex = new RegExp(
    `(${escapeRegExp(uniqueCitationStart)}(\\d+)${escapeRegExp(uniqueCitationEnd)})\\s*\\1+`,
    'g',
  );
  text = text.replace(remainingAdjacentRegex, '$1');

  // Replace the unique citation format with the final format
  text = text.replace(new RegExp(escapeRegExp(uniqueCitationStart), 'g'), '^');
  text = text.replace(new RegExp(escapeRegExp(uniqueCitationEnd), 'g'), '^');

  if (sources.size) {
    text += '\n\n';
    Array.from(sources.entries()).forEach(([source, index], arrayIndex) => {
      text += `^${index}.^ ${source}${arrayIndex === sources.size - 1 ? '' : '\n'}`;
    });
  }

  return { messages: sorted, text, edited };
}

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
