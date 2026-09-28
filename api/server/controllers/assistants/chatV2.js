const { v4 } = require('uuid');
const { sleep } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const {
  sendEvent,
  countTokens,
  checkBalance,
  createBalanceReservations,
  getBalanceConfig,
  getTransactionsConfig,
  getModelMaxTokens,
  ATTACHMENT_ONLY_TEXT,
  isContentFilterError,
  hasActiveFilePolicy,
  preflightAssistantRunContent,
  reportLocatorTraversalFailure,
  preflightAssistantUserMessageContent,
} = require('@librechat/api');
const {
  Time,
  Constants,
  RunStatus,
  CacheKeys,
  ContentTypes,
  ToolCallTypes,
  EModelEndpoint,
  retrievalMimeTypes,
  AssistantStreamEvents,
} = require('librechat-data-provider');
const {
  initThread,
  recordUsage,
  saveUserMessage,
  addThreadMetadata,
  saveAssistantMessage,
} = require('~/server/services/Threads');
const { runAssistant, createOnTextProgress } = require('~/server/services/AssistantService');
const { createErrorHandler } = require('~/server/controllers/assistants/errors');
const validateAuthor = require('~/server/middleware/assistants/validateAuthor');
const { createRun, StreamRunManager } = require('~/server/services/Runs');
const { addTitle } = require('~/server/services/Endpoints/assistants');
const { createRunBody } = require('~/server/services/createRunBody');
const setHeaders = require('~/server/middleware/setHeaders');
const {
  getConvo,
  getMultiplier,
  getTransactions,
  reserveBalance,
  renewBalanceReservation,
  releaseBalanceReservation,
  getFiles,
} = require('~/models');
const { logViolation, getLogStores } = require('~/cache');
const { getOpenAIClient } = require('./helpers');

/**
 * @route POST /
 * @desc Chat with an assistant
 * @access Public
 * @param {ServerRequest} req - The request object, containing the request data.
 * @param {Express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
const chatV2 = async (req, res) => {
  const appConfig = req.config;

  /** @type {{files: MongoFile[]}} */
  const {
    text,
    model,
    endpoint,
    files = [],
    promptPrefix,
    assistant_id,
    instructions,
    endpointOption,
    thread_id: _thread_id,
    messageId: _messageId,
    conversationId: convoId,
    parentMessageId: _parentId = Constants.NO_PARENT,
    clientTimestamp,
  } = req.body;
  logger.debug('[/assistants/chat/] request', {
    endpoint,
    conversationId: convoId,
    assistantId: assistant_id,
    hasText: typeof text === 'string' && text.length > 0,
    fileCount: Array.isArray(files) ? files.length : 0,
  });

  /** @type {OpenAI} */
  let openai;
  /** @type {string|undefined} - the current thread id */
  let thread_id = _thread_id;
  /** @type {string|undefined} - the current run id */
  let run_id;
  /** @type {string|undefined} - the parent messageId */
  let parentMessageId = _parentId;
  /** @type {TMessage[]} */
  let previousMessages = [];
  /** @type {import('librechat-data-provider').TConversation | null} */
  let conversation = null;
  /** @type {string[]} */
  let file_ids = [];
  /** @type {Set<string>} */
  let attachedFileIds = new Set();
  /** @type {TMessage | null} */
  let requestMessage = null;

  const userMessageId = v4();
  const responseMessageId = v4();

  /** @type {string} - The conversation UUID - created if undefined */
  const conversationId = convoId ?? v4();

  const cache = getLogStores(CacheKeys.ABORT_KEYS);
  const cacheKey = `${req.user.id}:${conversationId}`;

  /** @type {Run | undefined} - The completed run, undefined if incomplete */
  let completedRun;
  let contentRejected = false;
  const balanceReservations = createBalanceReservations();

  const getContext = () => ({
    openai,
    run_id,
    endpoint,
    cacheKey,
    thread_id,
    completedRun,
    assistant_id,
    conversationId,
    parentMessageId,
    responseMessageId,
  });

  const handleError = createErrorHandler({ req, res, getContext });

  try {
    res.on('close', async () => {
      if (!completedRun && !contentRejected) {
        await handleError(new Error('Request closed'));
      }
    });

    if (convoId && !_thread_id) {
      completedRun = true;
      throw new Error('Missing thread_id for existing conversation');
    }

    if (!assistant_id) {
      completedRun = true;
      throw new Error('Missing assistant_id');
    }

    const checkBalanceBeforeRun = async () => {
      const balanceConfig = getBalanceConfig(appConfig);
      if (!balanceConfig?.enabled) {
        return;
      }
      const transactions =
        (await getTransactions({
          user: req.user.id,
          context: 'message',
          conversationId,
        })) ?? [];

      const totalPreviousTokens = Math.abs(
        transactions.reduce((acc, curr) => acc + curr.rawAmount, 0),
      );

      // TODO: make promptBuffer a config option; buffer for titles, needs buffer for system instructions
      const promptBuffer = parentMessageId === Constants.NO_PARENT && !_thread_id ? 200 : 0;
      // 5 is added for labels
      let promptTokens = (await countTokens(text + (promptPrefix ?? ''))) + 5;
      promptTokens += totalPreviousTokens + promptBuffer;
      // Count tokens up to the current context window
      promptTokens = Math.min(promptTokens, getModelMaxTokens(model));

      return await checkBalance(
        {
          req,
          res,
          txData: {
            model,
            user: req.user.id,
            tokenType: 'prompt',
            amount: promptTokens,
          },
        },
        {
          getMultiplier,
          reserveBalance,
          renewBalanceReservation,
          releaseBalanceReservation,
          logViolation,
          balanceConfig,
        },
      );
    };

    const { openai: _openai } = await getOpenAIClient({
      req,
      res,
      endpointOption,
    });

    openai = _openai;
    await validateAuthor({ req, openai });
    try {
      await preflightAssistantRunContent({
        onTraversalFailure: reportLocatorTraversalFailure,
        config: req.config,
        openai,
        user: req.user,
        assistantId: assistant_id,
        threadId: _thread_id,
        getFiles,
      });
    } catch (error) {
      if (!isContentFilterError(error)) {
        throw error;
      }
      contentRejected = true;
      return res.status(error.statusCode).json(error.body);
    }
    if (previousMessages.length) {
      parentMessageId = previousMessages[previousMessages.length - 1].messageId;
    }

    /**
     * Threads rejects an empty message body, so an attachment-only turn sends
     * a minimal note instead. The persisted message keeps its empty text.
     */
    const isAttachmentOnly = !text?.trim() && files.length > 0;
    let userMessage = {
      role: 'user',
      content: [
        {
          type: ContentTypes.TEXT,
          text: isAttachmentOnly ? ATTACHMENT_ONLY_TEXT : text,
        },
      ],
      metadata: {
        messageId: userMessageId,
      },
    };

    /** @type {CreateRunBody | undefined} */
    const body = createRunBody({
      assistant_id,
      model,
      promptPrefix,
      instructions,
      endpointOption,
      clientTimestamp,
    });

    let existingConversationPromise;
    const getExistingConversation = () => {
      if (!convoId) {
        return Promise.resolve(null);
      }
      existingConversationPromise ??= getConvo(req.user.id, convoId);
      return existingConversationPromise;
    };

    const getRequestFileIds = async () => {
      let thread_file_ids = [];
      if (convoId) {
        const convo = await getExistingConversation();
        if (convo && convo.file_ids) {
          thread_file_ids = convo.file_ids;
        }
      }

      if (files.length || thread_file_ids.length) {
        attachedFileIds = new Set([...file_ids, ...thread_file_ids]);

        let attachmentIndex = 0;
        for (const file of files) {
          file_ids.push(file.file_id);
          if (file.type.startsWith('image')) {
            userMessage.content.push({
              type: ContentTypes.IMAGE_FILE,
              [ContentTypes.IMAGE_FILE]: { file_id: file.file_id },
            });
          }

          if (!userMessage.attachments) {
            userMessage.attachments = [];
          }

          userMessage.attachments.push({
            file_id: file.file_id,
            tools: [{ type: ToolCallTypes.CODE_INTERPRETER }],
          });

          if (file.type.startsWith('image')) {
            continue;
          }

          const mimeType = file.type;
          const isSupportedByRetrieval = retrievalMimeTypes.some((regex) => regex.test(mimeType));
          if (isSupportedByRetrieval) {
            userMessage.attachments[attachmentIndex].tools.push({
              type: ToolCallTypes.FILE_SEARCH,
            });
          }

          attachmentIndex++;
        }
      }
    };

    /** @type {Promise<Run>|undefined} */
    let userMessagePromise;
    const inspectFinalMessageFiles = hasActiveFilePolicy(req.config?.filters);

    const initializeThread = async () => {
      if (!inspectFinalMessageFiles) {
        await getRequestFileIds();
      }

      // TODO: may allow multiple messages to be created beforehand in a future update
      const initThreadBody = {
        messages: [userMessage],
        metadata: {
          user: req.user.id,
          conversationId,
        },
      };

      const result = await initThread({ openai, body: initThreadBody, thread_id });
      thread_id = result.thread_id;

      createOnTextProgress({
        openai,
        conversationId,
        userMessageId,
        messageId: responseMessageId,
        thread_id,
      });

      requestMessage = {
        user: req.user.id,
        text,
        messageId: userMessageId,
        parentMessageId,
        // TODO: make sure client sends correct format for `files`, use zod
        files,
        file_ids,
        conversationId,
        isCreatedByUser: true,
        assistant_id,
        thread_id,
        model: assistant_id,
        endpoint,
      };

      previousMessages.push(requestMessage);

      /* asynchronous */
      userMessagePromise = saveUserMessage(req, { ...requestMessage, model });

      conversation = {
        conversationId,
        endpoint,
        promptPrefix: promptPrefix,
        instructions: instructions,
        assistant_id,
        // model,
      };

      if (file_ids.length) {
        conversation.file_ids = file_ids;
      }
    };

    if (inspectFinalMessageFiles) {
      await getRequestFileIds();
      try {
        await preflightAssistantUserMessageContent({
          onTraversalFailure: reportLocatorTraversalFailure,
          config: req.config,
          user: req.user,
          message: userMessage,
          fileIds: [...attachedFileIds, ...file_ids],
          getFiles,
        });
      } catch (error) {
        if (!isContentFilterError(error)) {
          throw error;
        }
        contentRejected = true;
        return res.status(error.statusCode).json(error.body);
      }
    }

    const promises = [initializeThread(), balanceReservations.track(checkBalanceBeforeRun())];
    await Promise.all(promises);

    const sendInitialResponse = () => {
      sendEvent(res, {
        sync: true,
        conversationId,
        // messages: previousMessages,
        requestMessage,
        responseMessage: {
          user: req.user.id,
          messageId: openai.responseMessage.messageId,
          parentMessageId: userMessageId,
          conversationId,
          assistant_id,
          thread_id,
          model: assistant_id,
        },
      });
    };

    /** @type {RunResponse | typeof StreamRunManager | undefined} */
    let response;

    const processRun = async (retry = false) => {
      if (endpoint === EModelEndpoint.azureAssistants) {
        body.model = openai._options.model;
        openai.attachedFileIds = attachedFileIds;
        if (retry) {
          response = await runAssistant({
            openai,
            thread_id,
            run_id,
            in_progress: openai.in_progress,
          });
          return;
        }

        /* NOTE:
         * By default, a Run will use the model and tools configuration specified in Assistant object,
         * but you can override most of these when creating the Run for added flexibility:
         */
        const run = await createRun({
          openai,
          thread_id,
          body,
        });

        run_id = run.id;
        await cache.set(cacheKey, `${thread_id}:${run_id}`, Time.TEN_MINUTES);
        sendInitialResponse();

        // todo: retry logic
        response = await runAssistant({ openai, thread_id, run_id });
        return;
      }

      /** @type {{[AssistantStreamEvents.ThreadRunCreated]: (event: ThreadRunCreated) => Promise<void>}} */
      const handlers = {
        [AssistantStreamEvents.ThreadRunCreated]: async (event) => {
          await cache.set(cacheKey, `${thread_id}:${event.data.id}`, Time.TEN_MINUTES);
          run_id = event.data.id;
          sendInitialResponse();
        },
      };

      /** @type {undefined | TAssistantEndpoint} */
      const config = appConfig.endpoints?.[endpoint] ?? {};
      /** @type {undefined | TBaseEndpoint} */
      const allConfig = appConfig.endpoints?.all;

      const streamRunManager = new StreamRunManager({
        req,
        res,
        openai,
        handlers,
        thread_id,
        attachedFileIds,
        parentMessageId: userMessageId,
        responseMessage: openai.responseMessage,
        streamRate: allConfig?.streamRate ?? config.streamRate,
        // streamOptions: {

        // },
      });

      await streamRunManager.runAssistant({
        thread_id,
        body,
      });

      response = streamRunManager;
      response.text = streamRunManager.intermediateText;
    };

    try {
      await preflightAssistantRunContent({
        onTraversalFailure: reportLocatorTraversalFailure,
        config: req.config,
        openai,
        user: req.user,
        assistantId: assistant_id,
        threadId: thread_id,
        getFiles,
      });
    } catch (error) {
      if (!isContentFilterError(error)) {
        throw error;
      }
      contentRejected = true;
      return res.status(error.statusCode).json(error.body);
    }
    setHeaders(req, res, () => {});
    await processRun();
    logger.debug('[/assistants/chat/] response', {
      run: response.run,
      steps: response.steps,
    });

    if (response.run.status === RunStatus.CANCELLED) {
      logger.debug('[/assistants/chat/] Run cancelled, handled by `abortRun`');
      return res.end();
    }

    if (response.run.status === RunStatus.IN_PROGRESS) {
      balanceReservations.holdUntil(processRun(true));
    }

    completedRun = response.run;

    /** @type {ResponseMessage} */
    const responseMessage = {
      ...(response.responseMessage ?? response.finalMessage),
      text: response.text,
      parentMessageId: userMessageId,
      conversationId,
      user: req.user.id,
      assistant_id,
      thread_id,
      model: assistant_id,
      endpoint,
      spec: endpointOption.spec,
      iconURL: endpointOption.iconURL,
    };

    sendEvent(res, {
      final: true,
      conversation,
      requestMessage: {
        parentMessageId,
        thread_id,
      },
    });
    res.end();

    if (userMessagePromise) {
      await userMessagePromise;
    }
    await saveAssistantMessage(req, { ...responseMessage, model });

    if (parentMessageId === Constants.NO_PARENT && !_thread_id) {
      addTitle(req, {
        text,
        responseText: response.text,
        conversationId,
      });
    }

    await addThreadMetadata({
      openai,
      thread_id,
      messageId: responseMessage.messageId,
      messages: response.messages,
    });

    if (!response.run.usage) {
      await sleep(3000);
      completedRun = await openai.beta.threads.runs.retrieve(response.run.id, { thread_id });
      if (completedRun.usage) {
        await recordUsage({
          ...completedRun.usage,
          user: req.user.id,
          model: completedRun.model ?? model,
          conversationId,
          transactions: getTransactionsConfig(req.config),
        });
      }
    } else {
      await recordUsage({
        ...response.run.usage,
        user: req.user.id,
        model: response.run.model ?? model,
        conversationId,
        transactions: getTransactionsConfig(req.config),
      });
    }
  } catch (error) {
    await handleError(error);
  } finally {
    await balanceReservations.release();
  }
};

module.exports = chatV2;
