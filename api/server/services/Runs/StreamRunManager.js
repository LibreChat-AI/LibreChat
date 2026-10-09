const { sleep } = require('@librechat/agents');
const { sendEvent } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  Constants,
  StepTypes,
  ContentTypes,
  ToolCallTypes,
  MessageContentTypes,
  AssistantStreamEvents,
} = require('librechat-data-provider');
const { retrieveAndProcessFile } = require('~/server/services/Files/process');
const { processRequiredActions } = require('~/server/services/ToolService');
const { processMessages } = require('~/server/services/Threads');
const { createOnProgress } = require('~/server/utils');

/**
 * Implements the StreamRunManager functionality for managing the streaming
 * and processing of run steps, messages, and tool calls within a thread.
 * @implements {StreamRunManager}
 */
class StreamRunManager {
  constructor(fields) {
    this.index = 0;
    /** @type {Map<string, RunStep>} */
    this.steps = new Map();

    /** @type {Map<string, number} */
    this.mappedOrder = new Map();
    /** @type {Map<string, StepToolCall} */
    this.orderedRunSteps = new Map();
    /** @type {Set<string>} */
    this.processedFileIds = new Set();
    /** @type {Map<string, (delta: ToolCallDelta | string) => Promise<void>} */
    this.progressCallbacks = new Map();
    /** @type {Run | null} */
    this.run = null;

    /** @type {ServerRequest} */
    this.req = fields.req;
    /** @type {Express.Response} */
    this.res = fields.res;
    /** @type {OpenAI} */
    this.openai = fields.openai;
    /** @type {string} */
    this.apiKey = this.openai.apiKey;
    /** @type {string} */
    this.parentMessageId = fields.parentMessageId;
    /** @type {string} */
    this.thread_id = fields.thread_id;
    /** @type {RunCreateAndStreamParams} */
    this.initialRunBody = fields.runBody;
    /**
     * @type {Object.<AssistantStreamEvents, (event: AssistantStreamEvent) => Promise<void>>}
     */
    this.clientHandlers = fields.handlers ?? {};
    /** @type {OpenAIRequestOptions} */
    this.streamOptions = fields.streamOptions ?? {};
    /** @type {Partial<TMessage>} */
    this.finalMessage = fields.responseMessage ?? {};
    /** @type {ThreadMessage[]} */
    this.messages = [];
    /** @type {string} */
    this.text = '';
    /** @type {string} */
    this.intermediateText = '';
    /** @type {Set<string>} */
    this.attachedFileIds = fields.attachedFileIds;
    /** @type {undefined | Promise<ChatCompletion>} */
    this.visionPromise = fields.visionPromise;
    /** @type {number} */
    this.streamRate = fields.streamRate ?? Constants.DEFAULT_STREAM_RATE;

    /**
     * @type {Object.<AssistantStreamEvents, (event: AssistantStreamEvent) => Promise<void>>}
     */
    this.handlers = {
      [AssistantStreamEvents.ThreadCreated]: this.handleThreadCreated,
      [AssistantStreamEvents.ThreadRunCreated]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunQueued]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunInProgress]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunRequiresAction]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunCompleted]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunFailed]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunCancelling]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunCancelled]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunExpired]: this.handleRunEvent,
      [AssistantStreamEvents.ThreadRunStepCreated]: this.handleRunStepEvent,
      [AssistantStreamEvents.ThreadRunStepInProgress]: this.handleRunStepEvent,
      [AssistantStreamEvents.ThreadRunStepCompleted]: this.handleRunStepEvent,
      [AssistantStreamEvents.ThreadRunStepFailed]: this.handleRunStepEvent,
      [AssistantStreamEvents.ThreadRunStepCancelled]: this.handleRunStepEvent,
      [AssistantStreamEvents.ThreadRunStepExpired]: this.handleRunStepEvent,
      [AssistantStreamEvents.ThreadRunStepDelta]: this.handleRunStepDeltaEvent,
      [AssistantStreamEvents.ThreadMessageCreated]: this.handleMessageEvent,
      [AssistantStreamEvents.ThreadMessageInProgress]: this.handleMessageEvent,
      [AssistantStreamEvents.ThreadMessageCompleted]: this.handleMessageEvent,
      [AssistantStreamEvents.ThreadMessageIncomplete]: this.handleMessageEvent,
      [AssistantStreamEvents.ThreadMessageDelta]: this.handleMessageDeltaEvent,
      [AssistantStreamEvents.ErrorEvent]: this.handleErrorEvent,
    };
  }

  /**
   *
   * Sends the content data to the client via SSE.
   *
   * @param {StreamContentData} data
   * @returns {Promise<void>}
   */
  async addContentData(data) {
    const { type, index, edited } = data;
    /** @type {ContentPart} */
    const contentPart = data[type];
    this.finalMessage.content[index] = { type, [type]: contentPart };

    if (type === ContentTypes.TEXT && !edited) {
      this.text += contentPart.value;
      return;
    }

    const contentData = {
      index,
      type,
      [type]: contentPart,
      thread_id: this.thread_id,
      messageId: this.finalMessage.messageId,
      conversationId: this.finalMessage.conversationId,
    };

    sendEvent(this.res, contentData);
  }

  /* <------------------ Misc. Helpers ------------------> */
  /** Returns the latest intermediate text
   * @returns {string}
   */
  getText() {
    return this.intermediateText;
  }

  /** Returns the current, intermediate message
   * @returns {TMessage}
   */
  getIntermediateMessage() {
    return {
      conversationId: this.finalMessage.conversationId,
      messageId: this.finalMessage.messageId,
      parentMessageId: this.parentMessageId,
      model: this.req.body.assistant_id,
      endpoint: this.req.body.endpoint,
      isCreatedByUser: false,
      user: this.req.user.id,
      text: this.getText(),
      sender: 'Assistant',
      unfinished: true,
      error: false,
    };
  }

  /* <------------------ Main Event Handlers ------------------> */

  /**
   * Run the assistant and handle the events.
   * @param {Object} params -
   * The parameters for running the assistant.
   * @param {string} params.thread_id - The thread id.
   * @param {RunCreateAndStreamParams} params.body - The body of the run.
   * @returns {Promise<void>}
   */
  async runAssistant({ thread_id, body }) {
    const streamRun = this.openai.beta.threads.runs.createAndStream(
      thread_id,
      body,
      this.streamOptions,
    );
    for await (const event of streamRun) {
      await this.handleEvent(event);
    }
  }

  /**
   * Handle the event.
   * @param {AssistantStreamEvent} event - The stream event object.
   * @returns {Promise<void>}
   */
  async handleEvent(event) {
    const handler = this.handlers[event.event];
    const clientHandler = this.clientHandlers[event.event];

    if (clientHandler) {
      await clientHandler.call(this, event);
    }

    if (handler) {
      await handler.call(this, event);
    } else {
      logger.warn(`Unhandled event type: ${event.event}`);
    }
  }

  /**
   * Handle thread.created event
   * @param {ThreadCreated} event -
   * The thread.created event object.
   */
  async handleThreadCreated(event) {
    logger.debug('Thread created:', event.data);
  }

  /**
   * Handle Run Events
   * @param {ThreadRunCreated | ThreadRunQueued | ThreadRunInProgress | ThreadRunRequiresAction | ThreadRunCompleted | ThreadRunFailed | ThreadRunCancelling | ThreadRunCancelled | ThreadRunExpired} event -
   * The run event object.
   */
  async handleRunEvent(event) {
    this.run = event.data;
    logger.debug('Run event:', this.run);
    if (event.event === AssistantStreamEvents.ThreadRunRequiresAction) {
      await this.onRunRequiresAction(event);
    } else if (event.event === AssistantStreamEvents.ThreadRunCompleted) {
      logger.debug('Run completed:', this.run);
    }
  }

  /**
   * Handle Run Step Events
   * @param {ThreadRunStepCreated | ThreadRunStepInProgress | ThreadRunStepCompleted | ThreadRunStepFailed | ThreadRunStepCancelled | ThreadRunStepExpired} event -
   * The run step event object.
   */
  async handleRunStepEvent(event) {
    logger.debug('Run step event:', event.data);

    const step = event.data;
    this.steps.set(step.id, step);

    if (event.event === AssistantStreamEvents.ThreadRunStepCreated) {
      this.onRunStepCreated(event);
    } else if (event.event === AssistantStreamEvents.ThreadRunStepCompleted) {
      this.onRunStepCompleted(event);
    }
  }

  /* <------------------ Delta Events ------------------> */

  /** @param {CodeImageOutput} */
  async handleCodeImageOutput(output) {
    if (this.processedFileIds.has(output.image?.file_id)) {
      return;
    }

    const { file_id } = output.image;
    const file = await retrieveAndProcessFile({
      openai: this.openai,
      client: this,
      file_id,
      basename: `${file_id}.png`,
    });

    const prelimImage = file;

    // check if every key has a value before adding to content
    const prelimImageKeys = Object.keys(prelimImage);
    const validImageFile = prelimImageKeys.every((key) => prelimImage[key]);

    if (!validImageFile) {
      return;
    }

    const index = this.getStepIndex(file_id);
    const image_file = {
      [ContentTypes.IMAGE_FILE]: prelimImage,
      type: ContentTypes.IMAGE_FILE,
      index,
    };
    this.addContentData(image_file);
    this.processedFileIds.add(file_id);
  }

  /**
   * Create Tool Call Stream
   * @param {number} index - The index of the tool call.
   * @param {StepToolCall} toolCall -
   * The current tool call object.
   */
  createToolCallStream(index, toolCall) {
    /** @type {StepToolCall} */
    const state = toolCall;
    const type = state.type;
    const data = state[type];

    /** @param {ToolCallDelta} */
    const deltaHandler = async (delta) => {
      for (const key in delta) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
          logger.warn('Unhandled tool call delta key', {
            key,
            toolCallType: type,
            deltaKeys: Object.keys(delta),
          });
          continue;
        }

        if (Array.isArray(delta[key])) {
          if (!Array.isArray(data[key])) {
            data[key] = [];
          }

          for (const d of delta[key]) {
            if (typeof d === 'object' && !Object.prototype.hasOwnProperty.call(d, 'index')) {
              logger.warn('Tool call array delta is missing an index', {
                key,
                toolCallType: type,
                valueType: typeof d,
              });
              continue;
            }

            const imageOutput = type === ToolCallTypes.CODE_INTERPRETER && d?.type === 'image';

            if (imageOutput) {
              await this.handleCodeImageOutput(d);
              continue;
            }

            const { index, ...updateData } = d;
            // Ensure the data at index is an object or undefined before assigning
            if (typeof data[key][index] !== 'object' || data[key][index] === null) {
              data[key][index] = {};
            }
            // Merge the updateData into data[key][index]
            for (const updateKey in updateData) {
              data[key][index][updateKey] = updateData[updateKey];
            }
          }
        } else if (typeof delta[key] === 'string' && typeof data[key] === 'string') {
          // Concatenate strings
          // data[key] += delta[key];
        } else if (
          typeof delta[key] === 'object' &&
          delta[key] !== null &&
          !Array.isArray(delta[key])
        ) {
          // Merge objects
          data[key] = { ...data[key], ...delta[key] };
        } else {
          // Directly set the value for other types
          data[key] = delta[key];
        }

        state[type] = data;

        this.addContentData({
          [ContentTypes.TOOL_CALL]: toolCall,
          type: ContentTypes.TOOL_CALL,
          index,
        });

        await sleep(this.streamRate);
      }
    };

    return deltaHandler;
  }

  /**
   * @param {string} stepId -
   * @param {StepToolCall} toolCall -
   *
   */
  handleNewToolCall(stepId, toolCall) {
    const stepKey = this.generateToolCallKey(stepId, toolCall);
    const index = this.getStepIndex(stepKey);
    this.getStepIndex(toolCall.id, index);
    toolCall.progress = 0.01;
    this.orderedRunSteps.set(index, toolCall);
    const progressCallback = this.createToolCallStream(index, toolCall);
    this.progressCallbacks.set(stepKey, progressCallback);

    this.addContentData({
      [ContentTypes.TOOL_CALL]: toolCall,
      type: ContentTypes.TOOL_CALL,
      index,
    });
  }

  /**
   * Handle Completed Tool Call
   * @param {string} stepId - The id of the step the tool_call is part of.
   * @param {StepToolCall} toolCall - The tool call object.
   *
   */
  handleCompletedToolCall(stepId, toolCall) {
    if (toolCall.type === ToolCallTypes.FUNCTION) {
      return;
    }

    const stepKey = this.generateToolCallKey(stepId, toolCall);
    const index = this.getStepIndex(stepKey);
    toolCall.progress = 1;
    this.orderedRunSteps.set(index, toolCall);
    this.addContentData({
      [ContentTypes.TOOL_CALL]: toolCall,
      type: ContentTypes.TOOL_CALL,
      index,
    });
  }

  /**
   * Handle Run Step Delta Event
   * @param {ThreadRunStepDelta} event -
   * The run step delta event object.
   */
  async handleRunStepDeltaEvent(event) {
    const { delta, id: stepId } = event.data;

    if (!delta.step_details) {
      logger.warn('Undefined or unhandled run step delta', {
        stepId,
        deltaKeys: Object.keys(delta ?? {}),
      });
      return;
    }

    /** @type {{ tool_calls: Array<ToolCallDeltaObject> }} */
    const { tool_calls } = delta.step_details;

    if (!tool_calls) {
      logger.warn('Unhandled run step details', {
        stepId,
        stepDetailType: delta.step_details.type,
        detailKeys: Object.keys(delta.step_details),
      });
      return;
    }

    for (const toolCall of tool_calls) {
      const stepKey = this.generateToolCallKey(stepId, toolCall);

      if (!this.mappedOrder.has(stepKey)) {
        this.handleNewToolCall(stepId, toolCall);
        continue;
      }

      const toolCallDelta = toolCall[toolCall.type];
      const progressCallback = this.progressCallbacks.get(stepKey);
      progressCallback(toolCallDelta);
    }
  }

  /**
   * Handle Message Delta Event
   * @param {ThreadMessageDelta} event -
   * The Message Delta event object.
   */
  async handleMessageDeltaEvent(event) {
    const message = event.data;
    const onProgress = this.progressCallbacks.get(message.id);
    const content = message.delta.content?.[0];

    if (content && content.type === MessageContentTypes.TEXT) {
      this.intermediateText += content.text.value;
      onProgress(content.text.value);
      await sleep(this.streamRate);
    }
  }

  /**
   * Handle Error Event
   * @param {ErrorEvent} event -
   * The Error event object.
   */
  async handleErrorEvent(event) {
    logger.error('Error event:', event.data);
  }

  /* <------------------ Misc. Helpers ------------------> */

  /**
   * Gets the step index for a given step key, creating a new index if it doesn't exist.
   * @param {string} stepKey -
   * The access key for the step. Either a message.id, tool_call key, or file_id.
   * @param {number | undefined} [overrideIndex] - An override index to use an alternative stepKey.
   * This is necessary due to the toolCall Id being unavailable in delta stream events.
   * @returns {number | undefined} index - The index of the step; `undefined` if invalid key or using overrideIndex.
   */
  getStepIndex(stepKey, overrideIndex) {
    if (!stepKey) {
      return;
    }

    if (!isNaN(overrideIndex)) {
      this.mappedOrder.set(stepKey, overrideIndex);
      return;
    }

    let index = this.mappedOrder.get(stepKey);

    if (index === undefined) {
      index = this.index;
      this.mappedOrder.set(stepKey, this.index);
      this.index++;
    }

    return index;
  }

  /**
   * Generate Tool Call Key
   * @param {string} stepId - The id of the step the tool_call is part of.
   * @param {StepToolCall} toolCall - The tool call object.
   * @returns {string} key - The generated key for the tool call.
   */
  generateToolCallKey(stepId, toolCall) {
    return `${stepId}_tool_call_${toolCall.index}_${toolCall.type}`;
  }

  /**
   * Check Missing Outputs
   * @param {ToolOutput[]} tool_outputs - The tool outputs.
   * @param {RequiredAction[]} actions - The required actions.
   * @returns {ToolOutput[]} completeOutputs - The complete outputs.
   */
  checkMissingOutputs(tool_outputs = [], actions = []) {
    const missingOutputs = [];
    const MISSING_OUTPUT_MESSAGE =
      'The tool failed to produce an output. The tool may not be currently available or experienced an unhandled error.';
    const outputIds = new Set();
    const validatedOutputs = tool_outputs.map((output) => {
      if (!output) {
        logger.warn('Tool output is undefined');
        return;
      }
      outputIds.add(output.tool_call_id);
      if (!output.output) {
        logger.warn(`Tool output exists but has no output property (ID: ${output.tool_call_id})`);
        return {
          ...output,
          output: MISSING_OUTPUT_MESSAGE,
        };
      }
      return output;
    });

    for (const item of actions) {
      const { tool, toolCallId, run_id, thread_id } = item;
      const outputExists = outputIds.has(toolCallId);

      if (!outputExists) {
        logger.warn(
          `The "${tool}" tool (ID: ${toolCallId}) failed to produce an output. run_id: ${run_id} thread_id: ${thread_id}`,
        );
        missingOutputs.push({
          tool_call_id: toolCallId,
          output: MISSING_OUTPUT_MESSAGE,
        });
      }
    }

    return [...validatedOutputs, ...missingOutputs];
  }

  /* <------------------ Run Event handlers ------------------> */

  /**
   * Handle Run Events Requiring Action
   * @param {ThreadRunRequiresAction} event -
   * The run event object requiring action.
   */
  async onRunRequiresAction(event) {
    const run = event.data;
    const { submit_tool_outputs } = run.required_action;
    const actions = submit_tool_outputs.tool_calls.map((item) => {
      const functionCall = item.function;
      const args = JSON.parse(functionCall.arguments);
      return {
        tool: functionCall.name,
        toolInput: args,
        toolCallId: item.id,
        run_id: run.id,
        thread_id: this.thread_id,
      };
    });

    const { tool_outputs: preliminaryOutputs } = await processRequiredActions(this, actions);
    const tool_outputs = this.checkMissingOutputs(preliminaryOutputs, actions);
    /** @type {AssistantStream | undefined} */
    let toolRun;
    try {
      toolRun = this.openai.beta.threads.runs.submitToolOutputsStream(
        run.id,
        {
          thread_id: run.thread_id,
          tool_outputs,
          stream: true,
        },
        this.streamOptions,
      );
    } catch (error) {
      logger.error('Error submitting tool outputs:', error);
      throw error;
    }

    for await (const event of toolRun) {
      await this.handleEvent(event);
    }
  }

  /* <------------------ RunStep Event handlers ------------------> */

  /**
   * Handle Run Step Created Events
   * @param {ThreadRunStepCreated} event -
   * The created run step event object.
   */
  async onRunStepCreated(event) {
    const step = event.data;
    const isMessage = step.type === StepTypes.MESSAGE_CREATION;

    if (isMessage) {
      /** @type {MessageCreationStepDetails} */
      const { message_creation } = step.step_details;
      const stepKey = message_creation.message_id;
      const index = this.getStepIndex(stepKey);
      this.orderedRunSteps.set(index, message_creation);

      const { onProgress: progressCallback } = createOnProgress();

      const onProgress = progressCallback({
        index,
        res: this.res,
        messageId: this.finalMessage.messageId,
        conversationId: this.finalMessage.conversationId,
        thread_id: this.thread_id,
        type: ContentTypes.TEXT,
      });

      this.progressCallbacks.set(stepKey, onProgress);
      this.orderedRunSteps.set(index, step);
      return;
    }

    if (step.type !== StepTypes.TOOL_CALLS) {
      logger.warn('Unhandled step creation type:', step.type);
      return;
    }

    /** @type {{ tool_calls: StepToolCall[] }} */
    const { tool_calls } = step.step_details;
    for (const toolCall of tool_calls) {
      this.handleNewToolCall(step.id, toolCall);
    }
  }

  /**
   * Handle Run Step Completed Events
   * @param {ThreadRunStepCompleted} event -
   * The completed run step event object.
   */
  async onRunStepCompleted(event) {
    const step = event.data;
    const isMessage = step.type === StepTypes.MESSAGE_CREATION;

    if (isMessage) {
      logger.debug('RunStep Message completion: to be handled by Message Event.', step);
      return;
    }

    /** @type {{ tool_calls: StepToolCall[] }} */
    const { tool_calls } = step.step_details;
    for (let i = 0; i < tool_calls.length; i++) {
      const toolCall = tool_calls[i];
      toolCall.index = i;
      this.handleCompletedToolCall(step.id, toolCall);
    }
  }

  /* <------------------ Message Event handlers ------------------> */

  /**
   * Handle Message Event
   * @param {ThreadMessageCreated | ThreadMessageInProgress | ThreadMessageCompleted | ThreadMessageIncomplete} event -
   * The Message event object.
   */
  async handleMessageEvent(event) {
    if (event.event === AssistantStreamEvents.ThreadMessageCompleted) {
      await this.messageCompleted(event);
    }
  }

  /**
   * Handle Message Completed Events
   * @param {ThreadMessageCompleted} event -
   * The Completed Message event object.
   */
  async messageCompleted(event) {
    const message = event.data;
    const result = await processMessages({
      openai: this.openai,
      client: this,
      messages: [message],
    });
    const index = this.mappedOrder.get(message.id);
    this.addContentData({
      [ContentTypes.TEXT]: { value: result.text },
      type: ContentTypes.TEXT,
      edited: result.edited,
      index,
    });
    this.messages.push(message);
  }
}

module.exports = StreamRunManager;
