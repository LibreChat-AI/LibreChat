const { klona } = require('klona');
const { sleep } = require('@librechat/agents');
const { sendEvent } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  StepTypes,
  RunStatus,
  StepStatus,
  ContentTypes,
  ToolCallTypes,
  imageGenTools,
  EModelEndpoint,
  defaultOrderQuery,
} = require('librechat-data-provider');
const { retrieveAndProcessFile } = require('~/server/services/Files/process');
const { processRequiredActions } = require('~/server/services/ToolService');
const { RunManager, waitForRun } = require('~/server/services/Runs');
const { processMessages } = require('~/server/services/Threads');
const { createOnProgress } = require('~/server/utils');
const { TextStream } = require('~/app/clients');

/**
 * Sorts, processes, and flattens messages to a single string.
 *
 * @param {Object} params - Params for creating the onTextProgress function.
 * @param {OpenAI} params.openai - The OpenAI SDK client instance.
 * @param {string} params.conversationId - The current conversation ID.
 * @param {string} params.userMessageId - The user message ID; response's `parentMessageId`.
 * @param {string} params.messageId - The response message ID.
 * @param {string} params.thread_id - The current thread ID.
 * @returns {void}
 */
async function createOnTextProgress({
  openai,
  conversationId,
  userMessageId,
  messageId,
  thread_id,
}) {
  openai.responseMessage = {
    conversationId,
    parentMessageId: userMessageId,
    role: 'assistant',
    messageId,
    content: [],
  };

  openai.responseText = '';

  openai.addContentData = (data) => {
    const { type, index } = data;
    openai.responseMessage.content[index] = { type, [type]: data[type] };

    if (type === ContentTypes.TEXT) {
      openai.responseText += data[type].value;
      return;
    }

    const contentData = {
      index,
      type,
      [type]: data[type],
      messageId,
      thread_id,
      conversationId,
    };

    logger.debug('Assistant content event', {
      index,
      type,
      hasContent: data[type] != null,
      messageId,
      thread_id,
      conversationId,
    });
    sendEvent(openai.res, contentData);
  };
}

/**
 * Retrieves the response from an OpenAI run.
 *
 * @param {Object} params - The parameters for getting the response.
 * @param {OpenAI} params.openai - The OpenAI SDK client instance.
 * @param {string} params.run_id - The ID of the run to get the response for.
 * @param {string} params.thread_id - The ID of the thread associated with the run.
 * @return {Promise<OpenAIAssistantFinish | OpenAIAssistantAction[] | ThreadMessage[] | RequiredActionFunctionToolCall[]>}
 */
async function getResponse({ openai, run_id, thread_id }) {
  const run = await waitForRun({ openai, run_id, thread_id, pollIntervalMs: 2000 });

  if (run.status === RunStatus.COMPLETED) {
    const messages = await openai.beta.threads.messages.list(thread_id, defaultOrderQuery);
    const newMessages = messages.data.filter((msg) => msg.run_id === run_id);

    return newMessages;
  } else if (run.status === RunStatus.REQUIRES_ACTION) {
    const actions = [];
    run.required_action?.submit_tool_outputs.tool_calls.forEach((item) => {
      const functionCall = item.function;
      const args = JSON.parse(functionCall.arguments);
      actions.push({
        tool: functionCall.name,
        toolInput: args,
        toolCallId: item.id,
        run_id,
        thread_id,
      });
    });

    return actions;
  }

  const runInfo = JSON.stringify(run, null, 2);
  throw new Error(`Unexpected run status ${run.status}.\nFull run info:\n\n${runInfo}`);
}

/**
 * Filters the steps to keep only the most recent instance of each unique step.
 * @param {RunStep[]} steps - The array of RunSteps to filter.
 * @return {RunStep[]} The filtered array of RunSteps.
 */
function filterSteps(steps = []) {
  if (steps.length <= 1) {
    return steps;
  }
  const stepMap = new Map();

  steps.forEach((step) => {
    if (!step) {
      return;
    }

    const effectiveTimestamp = Math.max(
      step.created_at,
      step.expired_at || 0,
      step.cancelled_at || 0,
      step.failed_at || 0,
      step.completed_at || 0,
    );

    if (!stepMap.has(step.id) || effectiveTimestamp > stepMap.get(step.id).effectiveTimestamp) {
      const latestStep = { ...step, effectiveTimestamp };
      if (latestStep.last_error) {
        // testing to see if we ever step into this
      }
      stepMap.set(step.id, latestStep);
    }
  });

  return Array.from(stepMap.values()).map((step) => {
    delete step.effectiveTimestamp;
    return step;
  });
}

/**
 * @callback InProgressFunction
 * @param {Object} params - The parameters for the in progress step.
 * @param {RunStep} params.step - The step object with details about the message creation.
 * @returns {Promise<void>} - A promise that resolves when the step is processed.
 */

function hasToolCallChanged(previousCall, currentCall) {
  return JSON.stringify(previousCall) !== JSON.stringify(currentCall);
}

/**
 * Creates a handler function for steps in progress, specifically for
 * processing messages and managing seen completed messages.
 *
 * @param {OpenAI} openai - The OpenAI SDK client instance.
 * @param {string} thread_id - The ID of the thread the run is in.
 * @param {ThreadMessage[]} messages - The accumulated messages for the run.
 * @return {InProgressFunction} a function to handle steps in progress.
 */
function createInProgressHandler(openai, thread_id, messages) {
  openai.index = 0;
  openai.mappedOrder = new Map();
  openai.seenToolCalls = new Map();
  openai.processedFileIds = new Set();
  openai.completeToolCallSteps = new Set();
  openai.seenCompletedMessages = new Set();

  /**
   * The in_progress function for handling message creation steps.
   *
   * @type {InProgressFunction}
   */
  async function in_progress({ step }) {
    if (step.type === StepTypes.TOOL_CALLS) {
      const { tool_calls } = step.step_details;

      for (const _toolCall of tool_calls) {
        /** @type {StepToolCall} */
        const toolCall = _toolCall;
        const previousCall = openai.seenToolCalls.get(toolCall.id);

        // If the tool call isn't new and hasn't changed
        if (previousCall && !hasToolCallChanged(previousCall, toolCall)) {
          continue;
        }

        let toolCallIndex = openai.mappedOrder.get(toolCall.id);
        if (toolCallIndex === undefined) {
          // New tool call
          toolCallIndex = openai.index;
          openai.mappedOrder.set(toolCall.id, openai.index);
          openai.index++;
        }

        if (step.status === StepStatus.IN_PROGRESS) {
          toolCall.progress =
            previousCall && previousCall.progress
              ? Math.min(previousCall.progress + 0.2, 0.95)
              : 0.01;
        } else {
          toolCall.progress = 1;
          openai.completeToolCallSteps.add(step.id);
        }

        if (
          toolCall.type === ToolCallTypes.CODE_INTERPRETER &&
          step.status === StepStatus.COMPLETED
        ) {
          const { outputs } = toolCall[toolCall.type];

          for (const output of outputs) {
            if (output.type !== 'image') {
              continue;
            }

            if (openai.processedFileIds.has(output.image?.file_id)) {
              continue;
            }

            const { file_id } = output.image;
            const file = await retrieveAndProcessFile({
              openai,
              client: openai,
              file_id,
              basename: `${file_id}.png`,
            });

            const prelimImage = file;

            // check if every key has a value before adding to content
            const prelimImageKeys = Object.keys(prelimImage);
            const validImageFile = prelimImageKeys.every((key) => prelimImage[key]);

            if (!validImageFile) {
              continue;
            }

            const image_file = {
              [ContentTypes.IMAGE_FILE]: prelimImage,
              type: ContentTypes.IMAGE_FILE,
              index: openai.index,
            };
            openai.addContentData(image_file);
            openai.processedFileIds.add(file_id);
            openai.index++;
          }
        } else if (
          toolCall.type === ToolCallTypes.FUNCTION &&
          step.status === StepStatus.COMPLETED &&
          imageGenTools.has(toolCall[toolCall.type].name)
        ) {
          /* If a change is detected, skip image generation tools as already processed */
          openai.seenToolCalls.set(toolCall.id, toolCall);
          continue;
        }

        openai.addContentData({
          [ContentTypes.TOOL_CALL]: toolCall,
          index: toolCallIndex,
          type: ContentTypes.TOOL_CALL,
        });

        // Update the stored tool call
        openai.seenToolCalls.set(toolCall.id, toolCall);
      }
    } else if (step.type === StepTypes.MESSAGE_CREATION && step.status === StepStatus.COMPLETED) {
      const { message_id } = step.step_details.message_creation;
      if (openai.seenCompletedMessages.has(message_id)) {
        return;
      }

      openai.seenCompletedMessages.add(message_id);

      const message = await openai.beta.threads.messages.retrieve(message_id, { thread_id });
      if (!message?.content?.length) {
        return;
      }
      messages.push(message);

      let messageIndex = openai.mappedOrder.get(step.id);
      if (messageIndex === undefined) {
        // New message
        messageIndex = openai.index;
        openai.mappedOrder.set(step.id, openai.index);
        openai.index++;
      }

      const result = await processMessages({ openai, client: openai, messages: [message] });
      openai.addContentData({
        [ContentTypes.TEXT]: { value: result.text },
        type: ContentTypes.TEXT,
        index: messageIndex,
      });

      // Create the Factory Function to stream the message
      const { onProgress: progressCallback } = createOnProgress({
        // todo: add option to save partialText to db
        // onProgress: () => {},
      });

      // This creates a function that attaches all of the parameters
      // specified here to each SSE message generated by the TextStream
      const onProgress = progressCallback({
        res: openai.res,
        index: messageIndex,
        messageId: openai.responseMessage.messageId,
        conversationId: openai.responseMessage.conversationId,
        type: ContentTypes.TEXT,
        thread_id,
      });

      // Create a small buffer before streaming begins
      await sleep(500);

      const stream = new TextStream(result.text, { delay: 9 });
      await stream.processTextStream(onProgress);
    }
  }

  return in_progress;
}

/**
 * Initializes a RunManager with handlers, then invokes waitForRun to monitor and manage an OpenAI run.
 *
 * @param {Object} params - The parameters for managing and monitoring the run.
 * @param {OpenAI} params.openai - The OpenAI SDK client instance.
 * @param {string} params.run_id - The ID of the run to manage and monitor.
 * @param {string} params.thread_id - The ID of the thread associated with the run.
 * @param {RunStep[]} params.accumulatedSteps - The accumulated steps for the run.
 * @param {ThreadMessage[]} params.accumulatedMessages - The accumulated messages for the run.
 * @param {InProgressFunction} [params.in_progress] - The `in_progress` function from a previous run.
 * @return {Promise<RunResponse>} A promise that resolves to an object containing the run and managed steps.
 */
async function runAssistant({
  openai,
  run_id,
  thread_id,
  accumulatedSteps = [],
  accumulatedMessages = [],
  in_progress: inProgress,
}) {
  const appConfig = openai.req.config;
  let steps = accumulatedSteps;
  let messages = accumulatedMessages;
  const in_progress = inProgress ?? createInProgressHandler(openai, thread_id, messages);
  openai.in_progress = in_progress;

  const runManager = new RunManager({
    in_progress,
    final: async ({ step, runStatus, stepsByStatus }) => {
      logger.debug(`[runAssistant] Final step for ${run_id} with status ${runStatus}`, step);

      const promises = [];
      // promises.push(
      //   openai.beta.threads.messages.list(thread_id, defaultOrderQuery),
      // );

      // const finalSteps = stepsByStatus[runStatus];
      // for (const stepPromise of finalSteps) {
      //   promises.push(stepPromise);
      // }

      // loop across all statuses
      for (const [_status, stepsPromises] of Object.entries(stepsByStatus)) {
        promises.push(...stepsPromises);
      }

      const resolved = await Promise.all(promises);
      const finalSteps = filterSteps(steps.concat(resolved));

      if (step.type === StepTypes.MESSAGE_CREATION) {
        const incompleteToolCallSteps = finalSteps.filter(
          (s) => s && s.type === StepTypes.TOOL_CALLS && !openai.completeToolCallSteps.has(s.id),
        );
        for (const incompleteToolCallStep of incompleteToolCallSteps) {
          await in_progress({ step: incompleteToolCallStep });
        }
      }
      await in_progress({ step });
      // const res = resolved.shift();
      // messages = messages.concat(res.data.filter((msg) => msg && msg.run_id === run_id));
      resolved.push(step);
      /* Note: no issues without deep cloning, but it's safer to do so */
      steps = klona(finalSteps);
    },
  });

  const { endpoint = EModelEndpoint.azureAssistants } = openai.req.body;
  /** @type {AppConfig['endpoints']['assistants']} */
  const assistantsEndpointConfig = appConfig.endpoints?.[endpoint] ?? {};
  const { pollIntervalMs, timeoutMs } = assistantsEndpointConfig;

  const run = await waitForRun({
    openai,
    run_id,
    thread_id,
    runManager,
    pollIntervalMs,
    timeout: timeoutMs,
  });

  if (!run.required_action) {
    // const { messages: sortedMessages, text } = await processMessages(openai, messages);
    // return { run, steps, messages: sortedMessages, text };
    const sortedMessages = messages.sort((a, b) => a.created_at - b.created_at);
    return {
      run,
      steps,
      messages: sortedMessages,
      finalMessage: openai.responseMessage,
      text: openai.responseText,
    };
  }

  const { submit_tool_outputs } = run.required_action;
  const actions = submit_tool_outputs.tool_calls.map((item) => {
    const functionCall = item.function;
    const args = JSON.parse(functionCall.arguments);
    return {
      tool: functionCall.name,
      toolInput: args,
      toolCallId: item.id,
      run_id,
      thread_id,
    };
  });

  const tool_outputs = await processRequiredActions(openai, actions);
  const toolRun = await openai.beta.threads.runs.submitToolOutputs(run.id, {
    thread_id: run.thread_id,
    tool_outputs,
  });

  // Recursive call with accumulated steps and messages
  return await runAssistant({
    openai,
    run_id: toolRun.id,
    thread_id,
    accumulatedSteps: steps,
    accumulatedMessages: messages,
    in_progress,
  });
}

module.exports = {
  getResponse,
  runAssistant,
  createOnTextProgress,
};
