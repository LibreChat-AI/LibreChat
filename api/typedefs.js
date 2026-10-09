/**
 * @namespace typedefs
 */

/**
 * @exports OpenAI
 * @typedef {import('openai').OpenAI} OpenAI
 * @memberof typedefs
 */
/**
 * @exports OpenAIImagesResponse
 * @typedef {Promise<import('openai').OpenAI.ImagesResponse>} OpenAIImagesResponse
 * @memberof typedefs
 */

/**
 * @exports ServerRequest
 * @typedef {import('express').Request & {
 *   user?: IUser;
 *   config?: AppConfig;
 * }} ServerRequest
 * @memberof typedefs
 */

/**
 * @template T
 * @typedef {ReadableStream<T> | NodeJS.ReadableStream} NodeStream
 * @memberof typedefs
 */

/**
 * @template T
 * @typedef {(req: ServerRequest, filepath: string) => Promise<NodeStream<T>>} NodeStreamDownloader
 * @memberof typedefs
 */

/**
 * @exports ServerResponse
 * @typedef {import('express').Response} ServerResponse
 * @memberof typedefs
 */

/**
 * @exports NextFunction
 * @typedef {import('express').NextFunction} NextFunction
 * @memberof typedefs
 */

/**
 * @exports Graph
 * @typedef {import('@librechat/agents').Graph} Graph
 * @memberof typedefs
 */

/**
 * @exports StandardGraph
 * @typedef {import('@librechat/agents').StandardGraph} StandardGraph
 * @memberof typedefs
 */

/**
 * @exports MessageContentComplex
 * @typedef {import('@librechat/agents').MessageContentComplex} MessageContentComplex
 * @memberof typedefs
 */

/**
 * @exports EventHandler
 * @typedef {import('@librechat/agents').EventHandler} EventHandler
 * @memberof typedefs
 */

/**
 * @exports ModelEndData
 * @typedef {import('@librechat/agents').ModelEndData} ModelEndData
 * @memberof typedefs
 */

/**
 * @exports ToolEndData
 * @typedef {import('@librechat/agents').ToolEndData} ToolEndData
 * @memberof typedefs
 */

/**
 * @exports ToolEndCallback
 * @typedef {import('@librechat/agents').ToolEndCallback} ToolEndCallback
 * @memberof typedefs
 */

/**
 * @exports ChatModelStreamHandler
 * @typedef {import('@librechat/agents').ChatModelStreamHandler} ChatModelStreamHandler
 * @memberof typedefs
 */

/**
 * @exports ContentAggregator
 * @typedef {import('@librechat/agents').ContentAggregatorResult['aggregateContent']} ContentAggregator
 * @memberof typedefs
 */

/**
 * @exports GraphEvents
 * @typedef {import('@librechat/agents').GraphEvents} GraphEvents
 * @memberof typedefs
 */

/**
 * @exports AgentRun
 * @typedef {import('@librechat/agents').Run} AgentRun
 * @memberof typedefs
 */

/**
 * @exports IState
 * @typedef {import('@librechat/agents').IState} IState
 * @memberof typedefs
 */

/**
 * @exports ClientCallbacks
 * @typedef {import('@librechat/agents').ClientCallbacks} ClientCallbacks
 * @memberof typedefs
 */

/**
 * @exports OpenAIClientOptions
 * @typedef {import('@librechat/agents').OpenAIClientOptions} OpenAIClientOptions
 * @memberof typedefs
 */

/**
 * @exports AnthropicClientOptions
 * @typedef {import('@librechat/agents').AnthropicClientOptions} AnthropicClientOptions
 * @memberof typedefs
 */

/**
 * @exports BedrockClientOptions
 * @typedef {import('@librechat/agents').BedrockConverseClientOptions} BedrockClientOptions
 * @memberof typedefs
 */

/**
 * @exports VertexAIClientOptions
 * @typedef {import('@librechat/agents').VertexAIClientOptions} VertexAIClientOptions
 * @memberof typedefs
 */

/**
 * @exports GoogleClientOptions
 * @typedef {import('@librechat/agents').GoogleClientOptions} GoogleClientOptions
 * @memberof typedefs
 */

/**
 * @exports StreamEventData
 * @typedef {import('@librechat/agents').StreamEventData} StreamEventData
 * @memberof typedefs
 */

/**
 * @exports BaseMessage
 * @typedef {import('@librechat/agents/langchain/messages').BaseMessage} BaseMessage
 * @memberof typedefs
 */

/**
 * @exports UsageMetadata
 * @typedef {import('@librechat/agents/langchain/messages').UsageMetadata} UsageMetadata
 * @memberof typedefs
 */

/**
 * @exports LangChainToolCall
 * @typedef {import('@librechat/agents/langchain/messages/tool').ToolCall} LangChainToolCall
 * @memberof typedefs
 */

/**
 * @exports GraphRunnableConfig
 * @typedef {import('@librechat/agents/langchain/runnables').RunnableConfig<{
 *  req: ServerRequest;
 * thread_id: string;
 * run_id: string;
 * agent_id: string;
 * name: string;
 * agent_index: number;
 * last_agent_index: number;
 * hide_sequential_outputs: boolean;
 * version?: 'v1' | 'v2';
 * streamMode?: string
 * }> & {
 * toolCall?: LangChainToolCall & { stepId?: string };
 * }} GraphRunnableConfig
 * @memberof typedefs
 */

/**
 * @exports Ollama
 * @typedef {import('ollama').Ollama} Ollama
 * @memberof typedefs
 */

/**
 * @exports AxiosResponse
 * @typedef {import('axios').AxiosResponse} AxiosResponse
 * @memberof typedefs
 */

/**
 * @exports Anthropic
 * @typedef {import('@anthropic-ai/sdk').default} Anthropic
 * @memberof typedefs
 */

/**
 * @exports AnthropicMessage
 * @typedef {import('@anthropic-ai/sdk').default.MessageParam} AnthropicMessage
 * @memberof typedefs
 */

/**
 * @exports AnthropicMessageStartEvent
 * @typedef {import('@anthropic-ai/sdk').default.MessageStartEvent} AnthropicMessageStartEvent
 * @memberof typedefs
 */

/**
 * @exports AnthropicMessageDeltaEvent
 * @typedef {import('@anthropic-ai/sdk').default.MessageDeltaEvent} AnthropicMessageDeltaEvent
 * @memberof typedefs
 */

/**
 * @exports GenerativeModel
 * @typedef {import('@google/generative-ai').GenerativeModel} GenerativeModel
 * @memberof typedefs
 */

/**
 * @exports GenerateContentRequest
 * @typedef {import('@google/generative-ai').GenerateContentRequest} GenerateContentRequest
 * @memberof typedefs
 */

/**
 * @exports GenAIUsageMetadata
 * @typedef {import('@google/generative-ai').UsageMetadata} GenAIUsageMetadata
 * @memberof typedefs
 */

/**
 * @exports AssistantStreamEvent
 * @typedef {import('openai').default.Beta.AssistantStreamEvent} AssistantStreamEvent
 * @memberof typedefs
 */

/**
 * @exports AssistantStream
 * @typedef {AsyncIterable<AssistantStreamEvent>} AssistantStream
 * @memberof typedefs
 */

/**
 * @exports RunCreateAndStreamParams
 * @typedef {import('openai').OpenAI.Beta.Threads.RunCreateAndStreamParams} RunCreateAndStreamParams
 * @memberof typedefs
 */

/**
 * @exports ChatCompletionContentPartImage
 * @typedef {import('openai').OpenAI.ChatCompletionContentPartImage} ChatCompletionContentPartImage
 * @memberof typedefs
 */

/**
 * @exports ChatCompletion
 * @typedef {import('openai').OpenAI.ChatCompletion} ChatCompletion
 * @memberof typedefs
 */

/**
 * @exports ChatCompletionPayload
 * @typedef {import('openai').OpenAI.ChatCompletionCreateParams} ChatCompletionPayload
 * @memberof typedefs
 */

/**
 * @exports OllamaMessage
 * @typedef {import('ollama').Message} OllamaMessage
 * @memberof typedefs
 */

/**
 * @exports ChatCompletionMessage
 * @typedef {import('openai').OpenAI.ChatCompletionMessageParam} ChatCompletionMessage
 * @memberof typedefs
 */

/**
 * @exports CohereChatStreamRequest
 * @typedef {import('cohere-ai').Cohere.ChatStreamRequest} CohereChatStreamRequest
 * @memberof typedefs
 */

/**
 * @exports CohereChatRequest
 * @typedef {import('cohere-ai').Cohere.ChatRequest} CohereChatRequest
 * @memberof typedefs
 */

/**
 * @exports OpenAIRequestOptions
 * @typedef {import('openai').OpenAI.RequestOptions} OpenAIRequestOptions
 * @memberof typedefs
 */

/**
 * @exports ThreadCreated
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadCreated} ThreadCreated
 * @memberof typedefs
 */

/**
 * @exports ThreadRunCreated
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunCreated} ThreadRunCreated
 * @memberof typedefs
 */

/**
 * @exports ThreadRunQueued
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunQueued} ThreadRunQueued
 * @memberof typedefs
 */

/**
 * @exports ThreadRunInProgress
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunInProgress} ThreadRunInProgress
 * @memberof typedefs
 */

/**
 * @exports ThreadRunRequiresAction
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunRequiresAction} ThreadRunRequiresAction
 * @memberof typedefs
 */

/**
 * @exports ThreadRunCompleted
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunCompleted} ThreadRunCompleted
 * @memberof typedefs
 */

/**
 * @exports ThreadRunFailed
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunFailed} ThreadRunFailed
 * @memberof typedefs
 */

/**
 * @exports ThreadRunCancelling
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunCancelling} ThreadRunCancelling
 * @memberof typedefs
 */

/**
 * @exports ThreadRunCancelled
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunCancelled} ThreadRunCancelled
 * @memberof typedefs
 */

/**
 * @exports ThreadRunExpired
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunExpired} ThreadRunExpired
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepCreated
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepCreated} ThreadRunStepCreated
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepInProgress
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepInProgress} ThreadRunStepInProgress
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepDelta
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepDelta} ThreadRunStepDelta
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepCompleted
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepCompleted} ThreadRunStepCompleted
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepFailed
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepFailed} ThreadRunStepFailed
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepCancelled
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepCancelled} ThreadRunStepCancelled
 * @memberof typedefs
 */

/**
 * @exports ThreadRunStepExpired
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadRunStepExpired} ThreadRunStepExpired
 * @memberof typedefs
 */

/**
 * @exports ThreadMessageCreated
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadMessageCreated} ThreadMessageCreated
 * @memberof typedefs
 */

/**
 * @exports ThreadMessageInProgress
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadMessageInProgress} ThreadMessageInProgress
 * @memberof typedefs
 */

/**
 * @exports ThreadMessageDelta
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadMessageDelta} ThreadMessageDelta
 * @memberof typedefs
 */

/**
 * @exports ThreadMessageCompleted
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadMessageCompleted} ThreadMessageCompleted
 * @memberof typedefs
 */

/**
 * @exports ThreadMessageIncomplete
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ThreadMessageIncomplete} ThreadMessageIncomplete
 * @memberof typedefs
 */

/**
 * @exports ErrorEvent
 * @typedef {import('openai').default.Beta.AssistantStreamEvent.ErrorEvent} ErrorEvent
 * @memberof typedefs
 */

/**
 * @exports ToolCallDeltaObject
 * @typedef {import('openai').default.Beta.Threads.Runs.Steps.ToolCallDeltaObject} ToolCallDeltaObject
 * @memberof typedefs
 */

/**
 * @exports ToolCallDelta
 * @typedef {import('openai').default.Beta.Threads.Runs.Steps.ToolCallDelta} ToolCallDelta
 * @memberof typedefs
 */

/**
 * @exports AgentToolCallDelta
 * @typedef {import('librechat-data-provider').Agents.ToolCallDelta} AgentToolCallDelta
 * @memberof typedefs
 */

/**
 * @exports ToolCallChunk
 * @typedef {import('librechat-data-provider').Agents.ToolCallChunk} ToolCallChunk
 * @memberof typedefs
 */

/**
 * @exports MessageContentImageUrl
 * @typedef {import('librechat-data-provider').Agents.MessageContentImageUrl} MessageContentImageUrl
 * @memberof typedefs
 */

/** Web Search */

/**
 * @exports SearchResult
 * @typedef {import('@librechat/agents').SearchResult} SearchResult
 * @memberof typedefs
 */

/**
 * @exports SearchResultData
 * @typedef {import('@librechat/agents').SearchResultData} SearchResultData
 * @memberof typedefs
 */

/**
 * @exports ValidSource
 * @typedef {import('librechat-data-provider').ValidSource} ValidSource
 * @memberof typedefs
 */

/** Prompts */
/**
 * @exports TPrompt
 * @typedef {import('librechat-data-provider').TPrompt} TPrompt
 * @memberof typedefs
 */

/**
 * @exports TPromptGroup
 * @typedef {import('librechat-data-provider').TPromptGroup} TPromptGroup
 * @memberof typedefs
 */

/**
 * @exports TCreatePrompt
 * @typedef {import('librechat-data-provider').TCreatePrompt} TCreatePrompt
 * @memberof typedefs
 */

/**
 * @exports TCreatePromptRecord
 * @typedef {import('librechat-data-provider').TCreatePromptRecord} TCreatePromptRecord
 * @memberof typedefs
 */
/**
 * @exports TCreatePromptResponse
 * @typedef {import('librechat-data-provider').TCreatePromptResponse} TCreatePromptResponse
 * @memberof typedefs
 */
/**
 * @exports TUpdatePromptGroupResponse
 * @typedef {import('librechat-data-provider').TUpdatePromptGroupResponse} TUpdatePromptGroupResponse
 * @memberof typedefs
 */

/**
 * @exports TPromptGroupsWithFilterRequest
 * @typedef {import('librechat-data-provider').TPromptGroupsWithFilterRequest } TPromptGroupsWithFilterRequest
 * @memberof typedefs
 */

/**
 * @exports PromptGroupListResponse
 * @typedef {import('librechat-data-provider').PromptGroupListResponse } PromptGroupListResponse
 * @memberof typedefs
 */

/**
 * @exports TGetCategoriesResponse
 * @typedef {import('librechat-data-provider').TGetCategoriesResponse } TGetCategoriesResponse
 * @memberof typedefs
 */

/**
 * @exports TGetRandomPromptsResponse
 * @typedef {import('librechat-data-provider').TGetRandomPromptsResponse } TGetRandomPromptsResponse
 * @memberof typedefs
 */

/**
 * @exports TGetRandomPromptsRequest
 * @typedef {import('librechat-data-provider').TGetRandomPromptsRequest } TGetRandomPromptsRequest
 * @memberof typedefs
 */

/**
 * @exports TUpdatePromptGroupPayload
 * @typedef {import('librechat-data-provider').TUpdatePromptGroupPayload } TUpdatePromptGroupPayload
 * @memberof typedefs
 */

/**
 * @exports TDeletePromptVariables
 * @typedef {import('librechat-data-provider').TDeletePromptVariables } TDeletePromptVariables
 * @memberof typedefs
 */

/**
 * @exports TDeletePromptResponse
 * @typedef {import('librechat-data-provider').TDeletePromptResponse } TDeletePromptResponse
 * @memberof typedefs
 */

/* Roles */

/**
 * @exports TRole
 * @typedef {import('librechat-data-provider').TRole } TRole
 * @memberof typedefs
 */

/**
 * @exports PermissionTypes
 * @typedef {import('librechat-data-provider').PermissionTypes } PermissionTypes
 * @memberof typedefs
 */

/**
 * @exports Permissions
 * @typedef {import('librechat-data-provider').Permissions } Permissions
 * @memberof typedefs
 */

/** Assistants */
/**
 * @exports Assistant
 * @typedef {import('librechat-data-provider').Assistant} Assistant
 * @memberof typedefs
 */

/**
 * @exports AssistantDocument
 * @typedef {import('librechat-data-provider').AssistantDocument} AssistantDocument
 * @memberof typedefs
 */

/**
 * @exports OpenAIFile
 * @typedef {import('librechat-data-provider').File} OpenAIFile
 * @memberof typedefs
 */

/**
 * @exports TConfig
 * @typedef {import('librechat-data-provider').TConfig} TConfig
 * @memberof typedefs
 */

/**
 * @exports TPayload
 * @typedef {import('librechat-data-provider').TPayload} TPayload
 * @memberof typedefs
 */

/**
 * @exports TAzureModelConfig
 * @typedef {import('librechat-data-provider').TAzureModelConfig} TAzureModelConfig
 * @memberof typedefs
 */

/**
 * @exports TAzureGroup
 * @typedef {import('librechat-data-provider').TAzureGroup} TAzureGroup
 * @memberof typedefs
 */

/**
 * @exports TAzureGroups
 * @typedef {import('librechat-data-provider').TAzureGroups} TAzureGroups
 * @memberof typedefs
 */

/**
 * @exports TAzureModelGroupMap
 * @typedef {import('librechat-data-provider').TAzureModelGroupMap} TAzureModelGroupMap
 * @memberof typedefs
 */
/**
 * @exports TAzureGroupMap
 * @typedef {import('librechat-data-provider').TAzureGroupMap} TAzureGroupMap
 * @memberof typedefs
 */

/**
 * @exports TAzureConfig
 * @typedef {import('librechat-data-provider').TAzureConfig} TAzureConfig
 * @memberof typedefs
 */

/**
 * @exports TModelsConfig
 * @typedef {import('librechat-data-provider').TModelsConfig} TModelsConfig
 * @memberof typedefs
 */

/**
 * @exports TStartupConfig
 * @typedef {import('librechat-data-provider').TStartupConfig} TStartupConfig
 * @memberof typedefs
 */

/**
 * @exports TConfigDefaults
 * @typedef {import('librechat-data-provider').TConfigDefaults} TConfigDefaults
 * @memberof typedefs
 */

/**
 * @exports TPlugin
 * @typedef {import('librechat-data-provider').TPlugin} TPlugin
 * @memberof typedefs
 */

/**
 * @exports TAzureConfigValidationResult
 * @typedef {import('librechat-data-provider').TAzureConfigValidationResult} TAzureConfigValidationResult
 * @memberof typedefs
 */

/**
 * @exports EImageOutputType
 * @typedef {import('librechat-data-provider').EImageOutputType} EImageOutputType
 * @memberof typedefs
 */

/**
 * @exports TCustomConfig
 * @typedef {import('librechat-data-provider').TCustomConfig} TCustomConfig
 * @memberof typedefs
 */

/**
 * @exports TProviderSchema
 * @typedef {import('librechat-data-provider').TProviderSchema} TProviderSchema
 * @memberof typedefs
 */

/**
 * @exports TBaseEndpoint
 * @typedef {import('librechat-data-provider').TBaseEndpoint} TBaseEndpoint
 * @memberof typedefs
 */

/**
 * @exports TEndpoint
 * @typedef {import('librechat-data-provider').TEndpoint} TEndpoint
 * @memberof typedefs
 */

/**
 * @exports TEndpointsConfig
 * @typedef {import('librechat-data-provider').TEndpointsConfig} TEndpointsConfig
 * @memberof typedefs
 */

/**
 * @exports TMessage
 * @typedef {import('librechat-data-provider').TMessage} TMessage
 * @memberof typedefs
 */

/**
 * @exports TConversation
 * @typedef {import('librechat-data-provider').TConversation} TConversation
 * @memberof typedefs
 */

/**
 * @exports TModelSpec
 * @typedef {import('librechat-data-provider').TModelSpec} TModelSpec
 * @memberof typedefs
 */

/**
 * @exports TPlugin
 * @typedef {import('librechat-data-provider').TPlugin} TPlugin
 * @memberof typedefs
 */

/**
 * @exports FileSources
 * @typedef {import('librechat-data-provider').FileSources} FileSources
 * @memberof typedefs
 */

/**
 * @exports TMessage
 * @typedef {import('librechat-data-provider').TMessage} TMessage
 * @memberof typedefs
 */

/**
 * @exports ImageFile
 * @typedef {import('librechat-data-provider').ImageFile} ImageFile
 * @memberof typedefs
 */

/**
 * @exports TMessageContentParts
 * @typedef {import('librechat-data-provider').TMessageContentParts} TMessageContentParts
 * @memberof typedefs
 */

/**
 * @exports StreamContentData
 * @typedef {import('librechat-data-provider').StreamContentData} StreamContentData
 * @memberof typedefs
 */

/**
 * @exports ActionRequest
 * @typedef {import('librechat-data-provider').ActionRequest} ActionRequest
 * @memberof typedefs
 */

/**
 * @exports Action
 * @typedef {import('librechat-data-provider').Action} Action
 * @memberof typedefs
 */

/**
 * @exports ActionMetadata
 * @typedef {import('librechat-data-provider').ActionMetadata} ActionMetadata
 * @memberof typedefs
 */

/**
 * @exports ActionAuth
 * @typedef {import('librechat-data-provider').ActionAuth} ActionAuth
 * @memberof typedefs
 */

/**
 * @exports DeleteFilesBody
 * @typedef {import('librechat-data-provider').DeleteFilesBody} DeleteFilesBody
 * @memberof typedefs
 */

/**
 * @exports FileMetadata
 * @typedef {Object} FileMetadata
 * @property {string} file_id - The identifier of the file.
 * @property {string} [temp_file_id] - The temporary identifier of the file.
 * @property {string} endpoint - The conversation endpoint origin for the file upload.
 * @property {string} [assistant_id] - The assistant ID if file upload is in the `knowledge` context.
 * @property {string} [tool_resource] - The relevant tool resource for the file upload.
 * @memberof typedefs
 */

/**
 * @exports FileObject
 * @typedef {{file_id: string, filepath: string, source: string, bytes?: number, width?: number, height?: number}} FileObject
 * @memberof typedefs
 *

/**
 * @exports ArtifactPromises
 * @typedef {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} ArtifactPromises
 * @memberof typedefs
 *

/**
 * @typedef {Object} ImageOnlyMetadata
 * @property {number} width - The width of the image.
 * @property {number} height - The height of the image.
 *
 * @typedef {FileMetadata & ImageOnlyMetadata} ImageMetadata
 * @memberof typedefs
 */

/**
 * @exports MongooseSchema
 * @typedef {import('mongoose').Schema} MongooseSchema
 * @memberof typedefs
 */

/**
 * @exports MongoFile
 * @typedef {import('@librechat/data-schemas').IMongoFile} MongoFile
 * @memberof typedefs
 */

/**
 * @exports ISession
 * @typedef {import('@librechat/data-schemas').ISession} ISession
 * @memberof typedefs
 */

/**
 * @exports IBalance
 * @typedef {import('@librechat/data-schemas').IBalance} IBalance
 * @memberof typedefs
 */

/**
 * @exports IUser
 * @typedef {import('@librechat/data-schemas').IUser} IUser
 * @memberof typedefs
 */

/**
 * @exports IPluginAuth
 * @typedef {import('@librechat/data-schemas').IPluginAuth} IPluginAuth
 * @memberof typedefs
 */

/**
 * @exports IRole
 * @typedef {import('@librechat/data-schemas').IRole} IRole
 * @memberof typedefs
 */

/**
 * @exports ObjectId
 * @typedef {import('mongoose').Types.ObjectId} ObjectId
 * @memberof typedefs
 */

/**
 * @exports uploadImageBuffer
 * @typedef {import('~/server/services/Files/process').uploadImageBuffer} uploadImageBuffer
 * @memberof typedefs
 */

/**
 * @exports processFileURL
 * @typedef {import('~/server/services/Files/process').processFileURL} processFileURL
 * @memberof typedefs
 */

/**
 *
 * @typedef {Object} ImageGenOptions
 * @property {ServerRequest} req - The request object.
 * @property {boolean} isAgent - Whether the request is from an agent.
 * @property {processFileURL} processFileURL - The function to process a file URL.
 * @property {boolean} returnMetadata - Whether to return metadata.
 * @property {uploadImageBuffer} uploadImageBuffer - The function to upload an image buffer.
 * @memberof typedefs
 */

/**
 * @typedef {Partial<ImageGenOptions> & {
 *   message?: string,
 *   signal?: AbortSignal,
 *   memory?: ConversationSummaryBufferMemory,
 *   tool_resources?: AgentToolResources,
 *   jobCreatedAt?: number,
 *   web_search?: ReturnType<typeof import('~/server/services/Tools/search').createOnSearchResults>,
 * }} LoadToolOptions
 * @memberof typedefs
 */

/**
 * @exports EModelEndpoint
 * @typedef {import('librechat-data-provider').EModelEndpoint} EModelEndpoint
 * @memberof typedefs
 */

/**
 * @exports TEndpointOption
 * @typedef {import('librechat-data-provider').TEndpointOption} TEndpointOption
 * @memberof typedefs
 */

/**
 * @exports TAttachment
 * @typedef {import('librechat-data-provider').TAttachment} TAttachment
 * @memberof typedefs
 */

/**
 * @exports AssistantCreateParams
 * @typedef {import('librechat-data-provider').AssistantCreateParams} AssistantCreateParams
 * @memberof typedefs
 */

/**
 * @exports AssistantUpdateParams
 * @typedef {import('librechat-data-provider').AssistantUpdateParams} AssistantUpdateParams
 * @memberof typedefs
 */

/**
 * @exports AssistantListParams
 * @typedef {import('librechat-data-provider').AssistantListParams} AssistantListParams
 * @memberof typedefs
 */

/**
 * @exports AssistantListResponse
 * @typedef {import('librechat-data-provider').AssistantListResponse} AssistantListResponse
 * @memberof typedefs
 */

/**
 * @exports ContentPart
 * @typedef {import('librechat-data-provider').ContentPart} ContentPart
 * @memberof typedefs
 */

/**
 * @exports StepTypes
 * @typedef {import('librechat-data-provider').StepTypes} StepTypes
 * @memberof typedefs
 */

/**
 * @exports TContentData
 * @typedef {import('librechat-data-provider').TContentData} TContentData
 * @memberof typedefs
 */

/**
 * @exports ContentPart
 * @typedef {import('librechat-data-provider').ContentPart} ContentPart
 * @memberof typedefs
 */

/**
 * @exports PartMetadata
 * @typedef {import('librechat-data-provider').PartMetadata} PartMetadata
 * @memberof typedefs
 */

/**
 * @exports ThreadMessage
 * @typedef {import('openai').OpenAI.Beta.Threads.Message} ThreadMessage
 * @memberof typedefs
 */

/**
 * @exports Annotation
 * @typedef {import('openai').OpenAI.Beta.Threads.Messages.Annotation} Annotation
 * @memberof typedefs
 */

/**
 * @exports TAssistantEndpoint
 * @typedef {import('librechat-data-provider').TAssistantEndpoint} TAssistantEndpoint
 * @memberof typedefs
 */

/**
 * @exports TAgentsEndpoint
 * @typedef {import('librechat-data-provider').TAgentsEndpoint} TAgentsEndpoint
 * @memberof typedefs
 */

/**
 * @exports Agent
 * @typedef {import('librechat-data-provider').Agent} Agent
 * @memberof typedefs
 */

/**
 * @exports TEphemeralAgent
 * @typedef {import('librechat-data-provider').TEphemeralAgent} TEphemeralAgent
 * @memberof typedefs
 */

/**
 * @exports TWebSearchKeys
 * @typedef {import('@librechat/data-schemas').TWebSearchKeys} TWebSearchKeys
 * @memberof typedefs
 */

/**
 * @exports AgentToolResources
 * @typedef {import('librechat-data-provider').AgentToolResources} AgentToolResources
 * @memberof typedefs
 */

/**
 * @exports AgentCreateParams
 * @typedef {import('librechat-data-provider').AgentCreateParams} AgentCreateParams
 * @memberof typedefs
 */

/**
 * @exports AgentUpdateParams
 * @typedef {import('librechat-data-provider').AgentUpdateParams} AgentUpdateParams
 * @memberof typedefs
 */

/**
 * @exports AgentListParams
 * @typedef {import('librechat-data-provider').AgentListParams} AgentListParams
 * @memberof typedefs
 */

/**
 * @exports AgentListResponse
 * @typedef {import('librechat-data-provider').AgentListResponse} AgentListResponse
 * @memberof typedefs
 */

/** Permissions */
/**
 * @exports TUpdateResourcePermissionsRequest
 * @typedef {import('librechat-data-provider').TUpdateResourcePermissionsRequest} TUpdateResourcePermissionsRequest
 * @memberof typedefs
 */

/**
 * @exports TUpdateResourcePermissionsResponse
 * @typedef {import('librechat-data-provider').TUpdateResourcePermissionsResponse} TUpdateResourcePermissionsResponse
 * @memberof typedefs
 */

/**
 * @exports AppConfig
 * @typedef {import('@librechat/data-schemas').AppConfig} AppConfig
 * @memberof typedefs
 */

/**
 * @exports JsonSchemaType
 * @typedef {import('@librechat/data-schemas').JsonSchemaType} JsonSchemaType
 * @memberof typedefs
 */

/**
 * @exports MCPServers
 * @typedef {import('@librechat/api').MCPServers} MCPServers
 * @memberof typedefs
 */

/**
 * @exports BalanceReservation
 * @typedef {import('@librechat/api').BalanceReservation} BalanceReservation
 * @memberof typedefs
 */

/**
 * @exports BalanceReservations
 * @typedef {import('@librechat/api').BalanceReservations} BalanceReservations
 * @memberof typedefs
 */

/**
 * @exports Keyv
 * @typedef {import('keyv')} Keyv
 * @memberof typedefs
 */

/**
 * @exports MCPManager
 * @typedef {import('@librechat/api').MCPManager} MCPManager
 * @memberof typedefs
 */

/**
 * @exports MCPConnection
 * @typedef {import('@librechat/api').MCPConnection} MCPConnection
 * @memberof typedefs
 */

/**
 * @exports LCFunctionTool
 * @typedef {import('@librechat/api').LCFunctionTool} LCFunctionTool
 * @memberof typedefs
 */

/**
 * @exports FlowStateManager
 * @typedef {import('@librechat/api').FlowStateManager} FlowStateManager
 * @memberof typedefs
 */

/**
 * @exports LCAvailableTools
 * @typedef {import('@librechat/api').LCAvailableTools} LCAvailableTools
 * @memberof typedefs
 */

/**
 * @exports LCTool
 * @typedef {import('@librechat/api').LCTool} LCTool
 * @memberof typedefs
 */

/**
 * @exports FormattedContent
 * @typedef {import('@librechat/api').FormattedContent} FormattedContent
 * @memberof typedefs
 */

/**
 * Represents details of the message creation by the run step, including the ID of the created message.
 *
 * @exports MessageCreationStepDetails
 * @typedef {Object} MessageCreationStepDetails
 * @property {Object} message_creation - Details of the message creation.
 * @property {string} message_creation.message_id - The ID of the message that was created by this run step.
 * @property {'message_creation'} type - Always 'message_creation'.
 * @memberof typedefs
 */

/**
 * Represents a text log output from the Code Interpreter tool call.
 * @typedef {Object} CodeLogOutput
 * @property {'logs'} type - Always 'logs'.
 * @property {string} logs - The text output from the Code Interpreter tool call.
 */

/**
 * Represents an image output from the Code Interpreter tool call.
 * @typedef {Object} CodeImageOutput
 * @property {'image'} type - Always 'image'.
 * @property {Object} image - The image object.
 * @property {string} image.file_id - The file ID of the image.
 */

/**
 * Details of the Code Interpreter tool call the run step was involved in.
 * Includes the tool call ID, the code interpreter definition, and the type of tool call.
 *
 * @typedef {Object} CodeToolCall
 * @property {string} id - The ID of the tool call.
 * @property {Object} code_interpreter - The Code Interpreter tool call definition.
 * @property {string} code_interpreter.input - The input to the Code Interpreter tool call.
 * @property {Array<(CodeLogOutput | CodeImageOutput)>} code_interpreter.outputs - The outputs from the Code Interpreter tool call.
 * @property {'code_interpreter'} type - The type of tool call, always 'code_interpreter'.
 * @memberof typedefs
 */

/**
 * Details of a Function tool call the run step was involved in.
 * Includes the tool call ID, the function definition, and the type of tool call.
 *
 * @typedef {Object} FunctionToolCall
 * @property {string} id - The ID of the tool call object.
 * @property {Object} function - The definition of the function that was called.
 * @property {string} function.arguments - The arguments passed to the function.
 * @property {string} function.name - The name of the function.
 * @property {string|null} function.output - The output of the function, null if not submitted.
 * @property {'function'} type - The type of tool call, always 'function'.
 * @memberof typedefs
 */

/**
 * Details of a Retrieval tool call the run step was involved in.
 * Includes the tool call ID and the type of tool call.
 *
 * @typedef {Object} RetrievalToolCall
 * @property {string} id - The ID of the tool call object.
 * @property {unknown} retrieval - An empty object for now.
 * @property {'retrieval'} type - The type of tool call, always 'retrieval'.
 * @memberof typedefs
 */

/**
 * Details of the tool calls involved in a run step.
 * Can be associated with one of three types of tools: `code_interpreter`, `retrieval`, or `function`.
 *
 * @typedef {Object} ToolCallsStepDetails
 * @property {Array<CodeToolCall | RetrievalToolCall | FunctionToolCall>} tool_calls - An array of tool calls the run step was involved in.
 * @property {'tool_calls'} type - Always 'tool_calls'.
 * @memberof typedefs
 */

/**
 * Details of the tool calls involved in a run step.
 * Can be associated with one of three types of tools: `code_interpreter`, `retrieval`, or `function`.
 *
 * @exports StepToolCall
 * @typedef {(CodeToolCall | RetrievalToolCall | FunctionToolCall) & PartMetadata} StepToolCall
 * @memberof typedefs
 */

/**
 * Represents a tool call object required for certain actions in the OpenAI API,
 * including the function definition and type of the tool call.
 *
 * @exports RequiredActionFunctionToolCall
 * @typedef {Object} RequiredActionFunctionToolCall
 * @property {string} id - The ID of the tool call, referenced when submitting tool outputs.
 * @property {Object} function - The function definition associated with the tool call.
 * @property {string} function.arguments - The arguments that the model expects to be passed to the function.
 * @property {string} function.name - The name of the function.
 * @property {'function'} type - The type of tool call the output is required for, currently always 'function'.
 * @memberof typedefs
 */

/**
 * @exports RunManager
 * @typedef {import('./server/services/Runs/RunManager.js').RunManager} RunManager
 * @memberof typedefs
 */

/**
 * @exports TAgentClient
 * @typedef {import('./server/controllers/agents/client')} TAgentClient
 * @memberof typedefs
 */

/**
 * @typedef {Object} AgentClientOptions
 * @property {Agent} agent - The agent configuration object
 * @property {string} endpoint - The endpoint identifier for the agent
 * @property {ServerRequest} req - The request object
 * @property {string} [name] - The username
 * @property {string} [modelLabel] - The label for the model being used
 * @property {number} [maxContextTokens] - Maximum number of tokens allowed in context
 * @property {Object} [endpointTokenConfig] - Token configuration for the endpoint
 * @property {boolean} [resendFiles] - Whether to resend files
 * @property {string} [imageDetail] - Detail level for image processing
 * @property {Object} [spec] - Specification object
 * @property {Promise<MongoFile[]>} [attachments] - Promise resolving to file attachments
 * @property {Object} [headers] - Additional headers for requests
 * @property {string} [proxy] - Proxy configuration
 * @property {Object} [tools] - Available tools for the agent
 * @property {Object} [eventHandlers] - Custom event handlers
 * @property {import('@librechat/api').AgentStartupTelemetry} [startupTelemetry] - Startup latency recorder
 * @property {Object} [addParams] - Additional parameters to add to requests
 * @property {string[]} [dropParams] - Parameters to remove from requests
 * @memberof typedefs
 */

/**
 * @exports ImportBatchBuilder
 * @typedef {import('./server/utils/import/importBatchBuilder.js').ImportBatchBuilder} ImportBatchBuilder
 * @memberof typedefs
 */

/**
 * @exports Thread
 * @typedef {Object} Thread
 * @property {string} id - The identifier of the thread.
 * @property {'thread'} object - The object type, always 'thread'.
 * @property {number} created_at - The Unix timestamp (in seconds) for when the thread was created.
 * @property {Object} [metadata] - Optional metadata associated with the thread.
 * @property {Message[]} [messages] - An array of messages associated with the thread.
 * @memberof typedefs
 */

/**
 * @exports Message
 * @typedef {Object} Message
 * @property {string} id - The identifier of the message.
 * @property {'thread.message'} object - The object type, always 'thread.message'.
 * @property {number} created_at - The Unix timestamp (in seconds) for when the message was created.
 * @property {string} thread_id - The thread ID that this message belongs to.
 * @property {'user'|'assistant'} role - The entity that produced the message. One of 'user' or 'assistant'.
 * @property {Object[]} content - The content of the message in an array of text and/or images.
 * @property {'text'|'image_file'} content[].type - The type of content, either 'text' or 'image_file'.
 * @property {Object} [content[].text] - The text content, present if type is 'text'.
 * @property {string} content[].text.value - The data that makes up the text.
 * @property {Object[]} [content[].text.annotations] - Annotations for the text content.
 * @property {Object} [content[].image_file] - The image file content, present if type is 'image_file'.
 * @property {string} content[].image_file.file_id - The File ID of the image in the message content.
 * @property {string[]} [file_ids] - Optional list of File IDs for the message.
 * @property {string|null} [assistant_id] - If applicable, the ID of the assistant that authored this message.
 * @property {string|null} [run_id] - If applicable, the ID of the run associated with the authoring of this message.
 * @property {Object} [metadata] - Optional metadata for the message, a map of key-value pairs.
 * @memberof typedefs
 */

/**
 * @exports UserMessageContent
 * @typedef {Object} UserMessageContent
 * @property {Object[]} content - The content of the message in an array of text and/or images.
 * @property {string} content[].type - The type of content, either 'text' or 'image_file'.
 * @property {Object} [content[].text] - The text content, present if type is 'text'.
 * @property {string} content[].text.value - The data that makes up the text.
 * @property {Object} [content[].image_url] - The image file content, present if type is 'image_file'.
 * @property {string} content[].image_url.url - The File ID of the image in the message content.
 * @property {'auto' | 'low' | 'high'} content[].image_url.detail: 'auto' - the quality to use for the image, either 'auto', 'low', or 'high'.
 * @memberof typedefs
 */

/**
 * Represents a message payload with various potential properties,
 * including roles, sender information, and content.
 *
 * @typedef {Object} PayloadMessage
 * @property {string} [role] - The role of the message sender (e.g., 'user', 'assistant').
 * @property {string} [name] - The name associated with the message.
 * @property {string} [sender] - The sender of the message.
 * @property {string} [text] - The text content of the message.
 * @property {(string|Array<UserMessageContent>)} [content] - The content of the message, which could be a string or an array of the 'content' property from the Message type.
 * @memberof typedefs
 */

/**
 * @exports FunctionTool
 * @typedef {import('@librechat/data-schemas').FunctionTool} FunctionTool
 * @memberof typedefs
 */

/**
 * @exports Tool
 * @typedef {Object} Tool
 * @property {'code_interpreter'|'retrieval'|'function'} type - The type of tool, can be 'code_interpreter', 'retrieval', or 'function'.
 * @property {FunctionTool} [function] - The function tool, present if type is 'function'.
 * @memberof typedefs
 */

/**
 * @exports Run
 * @typedef {Object} Run
 * @property {string} id - The identifier of the run.
 * @property {string} object - The object type, always 'thread.run'.
 * @property {number} created_at - The Unix timestamp (in seconds) for when the run was created.
 * @property {string} thread_id - The ID of the thread that was executed on as a part of this run.
 * @property {string} assistant_id - The ID of the assistant used for execution of this run.
 * @property {'queued'|'in_progress'|'requires_action'|'cancelling'|'cancelled'|'failed'|'completed'|'expired'} status - The status of the run: queued, in_progress, requires_action, cancelling, cancelled, failed, completed, or expired.
 * @property {Object} [required_action] - Details on the action required to continue the run.
 * @property {string} required_action.type - The type of required action, always 'submit_tool_outputs'.
 * @property {Object} required_action.submit_tool_outputs - Details on the tool outputs needed for the run to continue.
 * @property {Object[]} required_action.submit_tool_outputs.tool_calls - A list of the relevant tool calls.
 * @property {string} required_action.submit_tool_outputs.tool_calls[].id - The ID of the tool call.
 * @property {string} required_action.submit_tool_outputs.tool_calls[].type - The type of tool call the output is required for, always 'function'.
 * @property {Object} required_action.submit_tool_outputs.tool_calls[].function - The function definition.
 * @property {string} required_action.submit_tool_outputs.tool_calls[].function.name - The name of the function.
 * @property {string} required_action.submit_tool_outputs.tool_calls[].function.arguments - The arguments that the model expects you to pass to the function.
 * @property {Object} [last_error] - The last error associated with this run.
 * @property {string} last_error.code - One of 'server_error' or 'rate_limit_exceeded'.
 * @property {string} last_error.message - A human-readable description of the error.
 * @property {number} [expires_at] - The Unix timestamp (in seconds) for when the run will expire.
 * @property {number} [started_at] - The Unix timestamp (in seconds) for when the run was started.
 * @property {number} [cancelled_at] - The Unix timestamp (in seconds) for when the run was cancelled.
 * @property {number} [failed_at] - The Unix timestamp (in seconds) for when the run failed.
 * @property {number} [completed_at] - The Unix timestamp (in seconds) for when the run was completed.
 * @property {string} [model] - The model that the assistant used for this run.
 * @property {string} [instructions] - The instructions that the assistant used for this run.
 * @property {string} [additional_instructions] - Optional. Appends additional instructions
 * at the end of the instructions for the run. This is useful for modifying
 * @property {Tool[]} [tools] - The list of tools used for this run.
 * @property {string[]} [file_ids] - The list of File IDs used for this run.
 * @property {Object} [metadata] - Metadata associated with this run.
 * @property {Object} [usage] -  Usage statistics related to the run. This value will be `null` if the run is not in a terminal state (i.e. `in_progress`, `queued`, etc.).
 * @property {number} [usage.completion_tokens] - Number of completion tokens used over the course of the run.
 * @property {number} [usage.prompt_tokens] - Number of prompt tokens used over the course of the run.
 * @property {number} [usage.total_tokens] - Total number of tokens used (prompt + completion).
 * @memberof typedefs
 */

/**
 * @exports RunStep
 * @typedef {Object} RunStep
 * @property {string} id - The identifier of the run step.
 * @property {string} object - The object type, always 'thread.run.step'.
 * @property {number} created_at - The Unix timestamp (in seconds) for when the run step was created.
 * @property {string} assistant_id - The ID of the assistant associated with the run step.
 * @property {string} thread_id - The ID of the thread that was run.
 * @property {string} run_id - The ID of the run that this run step is a part of.
 * @property {'message_creation' | 'tool_calls'} type - The type of run step.
 * @property {'in_progress' | 'cancelled' | 'failed' | 'completed' | 'expired'} status - The status of the run step.
 * @property {MessageCreationStepDetails | ToolCallsStepDetails} step_details - The details of the run step.
 * @property {Object} [last_error] - The last error associated with this run step.
 * @property {'server_error' | 'rate_limit_exceeded'} last_error.code - One of 'server_error' or 'rate_limit_exceeded'.
 * @property {string} last_error.message - A human-readable description of the error.
 * @property {number} [expired_at] - The Unix timestamp (in seconds) for when the run step expired.
 * @property {number} [cancelled_at] - The Unix timestamp (in seconds) for when the run step was cancelled.
 * @property {number} [failed_at] - The Unix timestamp (in seconds) for when the run step failed.
 * @property {number} [completed_at] - The Unix timestamp (in seconds) for when the run step completed.
 * @property {Object} [metadata] - Metadata associated with this run step, a map of up to 16 key-value pairs.
 * @memberof typedefs
 */

/**
 * @exports StepMessage
 * @typedef {Object} StepMessage
 * @property {Message} message - The complete message object created by the step.
 * @property {string} id - The identifier of the run step.
 * @property {string} object - The object type, always 'thread.run.step'.
 * @property {number} created_at - The Unix timestamp (in seconds) for when the run step was created.
 * @property {string} assistant_id - The ID of the assistant associated with the run step.
 * @property {string} thread_id - The ID of the thread that was run.
 * @property {string} run_id - The ID of the run that this run step is a part of.
 * @property {'message_creation'|'tool_calls'} type - The type of run step, either 'message_creation' or 'tool_calls'.
 * @property {'in_progress'|'cancelled'|'failed'|'completed'|'expired'} status - The status of the run step, can be 'in_progress', 'cancelled', 'failed', 'completed', or 'expired'.
 * @property {Object} step_details - The details of the run step.
 * @property {Object} [last_error] - The last error associated with this run step.
 * @property {string} last_error.code - One of 'server_error' or 'rate_limit_exceeded'.
 * @property {string} last_error.message - A human-readable description of the error.
 * @property {number} [expired_at] - The Unix timestamp (in seconds) for when the run step expired.
 * @property {number} [cancelled_at] - The Unix timestamp (in seconds) for when the run step was cancelled.
 * @property {number} [failed_at] - The Unix timestamp (in seconds) for when the run step failed.
 * @property {number} [completed_at] - The Unix timestamp (in seconds) for when the run step completed.
 * @property {Object} [metadata] - Metadata associated with this run step, a map of up to 16 key-value pairs.
 * @memberof typedefs
 */

/**
 * @exports AgentAction
 * @typedef {Object} AgentAction
 * @property {string} tool - The name of the tool used.
 * @property {string} toolInput - The input provided to the tool.
 * @property {string} log - A log or message associated with the action.
 * @memberof typedefs
 */

/**
 * @exports AgentFinish
 * @typedef {Object} AgentFinish
 * @property {Record<string, any>} returnValues - The return values of the agent's execution.
 * @property {string} log - A log or message associated with the finish.
 * @memberof typedefs
 */

/**
 * @exports OpenAIAssistantFinish
 * @typedef {AgentFinish & { run_id: string; thread_id: string; }} OpenAIAssistantFinish
 * @memberof typedefs
 */

/**
 * @exports OpenAIAssistantAction
 * @typedef {AgentAction & { toolCallId: string; run_id: string; thread_id: string; }} OpenAIAssistantAction
 * @memberof typedefs
 */

/**
 * @exports EndpointServiceConfig
 * @typedef {Object} EndpointServiceConfig
 * @property {string} openAIApiKey - The API key for OpenAI.
 * @property {string} azureOpenAIApiKey - The API key for Azure OpenAI.
 * @property {boolean} userProvidedOpenAI - Flag to indicate if OpenAI API key is user provided.
 * @property {string} googleKey - The Palm key.
 * @property {boolean|{userProvide: boolean}} [openAI] - Flag to indicate if OpenAI endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [assistant] - Flag to indicate if Assistant endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [azureOpenAI] - Flag to indicate if Azure OpenAI endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [anthropic] - Flag to indicate if Anthropic endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [google] - Flag to indicate if Google endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean, userProvideURL: boolean, name: string}} [custom] - Custom Endpoint configuration.
 * @memberof typedefs
 */

/**
 * @exports Plugin
 * @typedef {Object} Plugin
 * @property {string} pluginKey - The key of the plugin.
 * @property {string} name - The name of the plugin.
 * @memberof typedefs
 */

/**
 * @exports DefaultConfig
 * @typedef {Object} DefaultConfig
 * @property {boolean|{userProvide: boolean}} [openAI] - Flag to indicate if OpenAI endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [assistant] - Flag to indicate if Assistant endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [azureOpenAI] - Flag to indicate if Azure OpenAI endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [anthropic] - Flag to indicate if Anthropic endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean}} [google] - Flag to indicate if Google endpoint is user provided, or its configuration.
 * @property {boolean|{userProvide: boolean, userProvideURL: boolean, name: string}} [custom] - Custom Endpoint configuration.
 * @memberof typedefs
 */

/**
 * @exports EndpointConfig
 * @typedef {boolean|TConfig} EndpointConfig
 * @memberof typedefs
 */

/**
 * @exports EndpointWithOrder
 * @typedef {Object} EndpointWithOrder
 * @property {EndpointConfig} config - The configuration of the endpoint.
 * @property {number} order - The order of the endpoint.
 * @memberof typedefs
 */

/**
 * @exports RequiredAction
 * @typedef {Object} RequiredAction
 * @property {string} tool - The name of the function.
 * @property {Object} toolInput - The args to invoke the function with.
 * @property {string} toolCallId - The ID of the tool call.
 * @property {Run['id']} run_id - Run identifier.
 * @property {Thread['id']} thread_id - Thread identifier.
 * @memberof typedefs
 */

/**
 * @exports StructuredTool
 * @typedef {Object} StructuredTool
 * @property {string} name - The name of the function.
 * @property {string} description - The description of the function.
 * @property {import('zod').ZodTypeAny} schema - The structured zod schema.
 * @memberof typedefs
 */

/**
 * @exports ToolOutput
 * @typedef {Object} ToolOutput
 * @property {string} tool_call_id - The ID of the tool call.
 * @property {Object} output - The output of the tool, which can vary in structure.
 * @memberof typedefs
 */

/**
 * @exports ToolOutputs
 * @typedef {Object} ToolOutputs
 * @property {ToolOutput[]} tool_outputs - Array of tool outputs.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ModelOptions
 * @property {string} modelName - The name of the model.
 * @property {number} [temperature] - The temperature setting for the model.
 * @property {number} [presence_penalty] - The presence penalty setting.
 * @property {number} [frequency_penalty] - The frequency penalty setting.
 * @property {number} [max_tokens] - The maximum number of tokens to generate.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ConfigOptions
 * @property {string} [basePath] - The base path for the API requests.
 * @property {Object} [baseOptions] - Base options for the API requests, including headers.
 * @property {Object} [httpAgent] - The HTTP agent for the request.
 * @property {Object} [httpsAgent] - The HTTPS agent for the request.
 * @memberof typedefs
 */

/**
 * @typedef {Object} Callbacks
 * @property {Function} [handleChatModelStart] - A callback function for handleChatModelStart
 * @property {Function} [handleLLMEnd] - A callback function for handleLLMEnd
 * @property {Function} [handleLLMError] - A callback function for handleLLMError
 * @memberof typedefs
 */

/**
 * @typedef {Object} AzureOptions
 * @property {string} [azureOpenAIApiKey] - The Azure OpenAI API key.
 * @property {string} [azureOpenAIApiInstanceName] - The Azure OpenAI API instance name.
 * @property {string} [azureOpenAIApiDeploymentName] - The Azure OpenAI API deployment name.
 * @property {string} [azureOpenAIApiVersion] - The Azure OpenAI API version.
 * @memberof typedefs
 */

/**
 * @typedef {Object} TokenConfig
 * A configuration object mapping model keys to their respective prompt, completion rates, and context limit.
 * @property {number} prompt - The prompt rate
 * @property {number} completion - The completion rate
 * @property {number} context - The maximum context length supported by the model.
 * @memberof typedefs
 */

/**
 * @typedef {Record<string, TokenConfig>} EndpointTokenConfig
 * An endpoint's config object mapping model keys to their respective prompt, completion rates, and context limit.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ResponseMessage
 * @property {string} conversationId - The ID of the conversation.
 * @property {string} thread_id - The ID of the thread.
 * @property {string} messageId - The ID of the message (from LibreChat).
 * @property {string} parentMessageId - The ID of the parent message.
 * @property {string} user - The ID of the user.
 * @property {string} assistant_id - The ID of the assistant.
 * @property {string} role - The role of the response.
 * @property {string} model - The model used in the response.
 * @property {ContentPart[]} content - The content parts accumulated from the run.
 * @memberof typedefs
 */

/**
 * @typedef {Object} RunResponse
 * @property {Run} run - The detailed information about the run.
 * @property {RunStep[]} steps - An array of steps taken during the run.
 * @property {StepMessage[]} messages - An array of messages related to the run.
 * @property {ResponseMessage} finalMessage - The final response message, with all content parts.
 * @property {string} text - The final response text, accumulated from message parts
 * @memberof typedefs
 */

/**
 * @callback InProgressFunction
 * @param {Object} params - The parameters for the in progress step.
 * @param {RunStep} params.step - The step object with details about the message creation.
 * @returns {Promise<void>} - A promise that resolves when the step is processed.
 * @memberof typedefs
 */

/**
 * @typedef {Object} RunClient
 *
 * @property {ServerRequest} req - The Express request object.
 * @property {Express.Response} res - The Express response object.
 * @property {?import('https-proxy-agent').HttpsProxyAgent} httpAgent - An optional HTTP proxy agent for the request.

 * @property {() => string} getPartialText - Retrieves the current tokens accumulated by `progressCallback`.
 *
 * Note: not used until real streaming is implemented by OpenAI.
 *
 * @property {string} responseText -The accumulated text values for the current run.
 * @property {Set<string>} processedFileIds - A set of IDs for processed files.
 * @property {Map<string, number>} mappedOrder - A map to maintain the order of individual `tool_calls` and `steps`.
 * @property {Set<string>} [attachedFileIds] - A set of user attached file ids; necessary to track which files are downloadable.
 * @property {Set<string>} completeToolCallSteps - A set of completed tool call steps.
 * @property {Set<string>} seenCompletedMessages - A set of completed messages that have been seen/processed.
 * @property {Map<string, StepToolCall>} seenToolCalls - A map of tool calls that have been seen/processed.
 * @property {object | undefined} locals - Local variables for the request.
 * @property {AzureOptions} locals.azureOptions - Local Azure options for the request.
 * @property {(data: TContentData) => void} addContentData - Updates the response message's relevant
 * @property {InProgressFunction} in_progress - Updates the response message's relevant
 * content array with the part by index & sends intermediate SSE message with content data.
 *
 * Note: does not send intermediate SSE message for messages, which are streamed
 * (may soon be streamed) directly from OpenAI API.
 *
 * @property {ResponseMessage} responseMessage - A message object for responses.
 *
 * @typedef {OpenAI & RunClient} OpenAIClient
 */

/**
 * The body of the request to create a run, specifying the assistant, model,
 * instructions, and any additional parameters needed for the run.
 *
 * @typedef {Object} CreateRunBody
 * @property {string} assistant_id - The ID of the assistant to use for this run.
 * @property {string} [model] - Optional. The ID of the model to be used for this run.
 * @property {string} [instructions] - Optional. Override the default system message of the assistant.
 * @property {string} [additional_instructions] - Optional. Appends additional instructions
 * at the end of the instructions for the run. Useful for modifying behavior on a per-run basis without overriding other instructions.
 * @property {Object[]} [tools] - Optional. Override the tools the assistant can use for this run. Should include tool call ID and the type of tool call.
 * @property {string[]} [file_ids] - Optional. List of File IDs the assistant can use for this run.
 * **Note:** The API seems to prefer files added to messages, not runs.
 * @property {Object} [metadata] - Optional. Metadata for the run.
 * @memberof typedefs
 */

/**
 * @typedef {Object} StreamRunManager
 * Manages streaming and processing of run steps, messages, and tool calls within a thread.
 *
 * @property {number} index - Tracks the current index for step or message processing.
 * @property {Map<string, any>} steps - Stores run steps by their IDs.
 * @property {Map<string, number>} mappedOrder - Maps step or message IDs to their processing order index.
 * @property {Map<number, any>} orderedRunSteps - Stores run steps in order of processing.
 * @property {Set<string>} processedFileIds - Keeps track of file IDs that have been processed.
 * @property {Map<string, Function>} progressCallbacks - Stores callbacks for reporting progress on step or message processing.
 * @property {boolean} submittedToolOutputs - Indicates whether tool outputs have been submitted.
 * @property {Object|null} run - Holds the current run object.
 * @property {Object} req - The HTTP request object associated with the run.
 * @property {Object} res - The HTTP response object for sending back data.
 * @property {Object} openai - The OpenAI client instance.
 * @property {string} apiKey - The API key used for OpenAI requests.
 * @property {string} thread_id - The ID of the thread associated with the run.
 * @property {Object} initialRunBody - The initial body of the run request.
 * @property {Object.<string, Function>} clientHandlers - Custom handlers provided by the client.
 * @property {Object} streamOptions - Options for streaming the run.
 * @property {Object} finalMessage - The final message object to be constructed and sent.
 * @property {Array} messages - An array of messages processed during the run.
 * @property {string} text - Accumulated text from text content data.
 * @property {Object.<string, Function>} handlers - Internal event handlers for different types of streaming events.
 *
 * @method addContentData Adds content data to the final message or sends it immediately depending on type.
 * @method runAssistant Initializes and manages the streaming of a thread run.
 * @method handleEvent Dispatches streaming events to the appropriate handlers.
 * @method handleThreadCreated Handles the event when a thread is created.
 * @method handleRunEvent Handles various run state events.
 * @method handleRunStepEvent Handles events related to individual run steps.
 * @method handleCodeImageOutput Processes and handles code-generated image outputs.
 * @method createToolCallStream Initializes streaming for tool call outputs.
 * @method handleNewToolCall Handles the creation of a new tool call within a run step.
 * @method handleCompletedToolCall Handles the completion of tool call processing.
 * @method handleRunStepDeltaEvent Handles updates (deltas) for run steps.
 * @method handleMessageDeltaEvent Handles updates (deltas) for messages.
 * @method handleErrorEvent Handles error events during streaming.
 * @method getStepIndex Retrieves or assigns an index for a given step or message key.
 * @method generateToolCallKey Generates a unique key for a tool call within a step.
 * @method onRunRequiresAction Handles actions required by a run to proceed.
 * @method onRunStepCreated Handles the creation of a new run step.
 * @method onRunStepCompleted Handles the completion of a run step.
 * @method handleMessageEvent Handles events related to messages within the run.
 * @method messageCompleted Handles the completion of a message processing.
 */

/* TX Types */

/**
 * @typedef {object} txData - Transaction data.
 * @property {mongoose.Schema.Types.ObjectId} user - The user ID.
 * @property {String} conversationId - The ID of the conversation.
 * @property {String} model - The model name.
 * @property {String} context - The context in which the transaction is made.
 * @property {AppConfig['balance']} [balance] - The balance config
 * @property {EndpointTokenConfig} [endpointTokenConfig] - The current endpoint token config.
 * @property {String} [valueKey] - The value key (optional).
 * @memberof typedefs
 */

/**
 * https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing
 * @typedef {object} AnthropicStreamUsage - Stream usage for Anthropic
 * @property {number} [input_tokens] - The number of input tokens used.
 * @property {number} [cache_creation_input_tokens] - The number of cache creation input tokens used (write).
 * @property {number} [cache_read_input_tokens] - The number of cache input tokens used (read).
 * @property {number} [output_tokens] - The number of output tokens used.
 */

/**
 * @exports OpenAIUsageMetadata
 * @typedef {Object} OpenAIUsageMetadata -  Usage statistics related to the run. This value will be `null` if the run is not in a terminal state (i.e. `in_progress`, `queued`, etc.).
 * @property {number} [usage.completion_tokens] - Number of completion tokens used over the course of the run.
 * @property {number} [usage.prompt_tokens] - Number of prompt tokens used over the course of the run.
 * @property {number} [usage.total_tokens] - Total number of tokens used (prompt + completion).
 * @property {number} [usage.reasoning_tokens] - Total number of tokens used for reasoning (OpenAI o1 models).
 * @property {Object} [usage.completion_tokens_details] - Further details on the completion tokens used (OpenAI o1 models).
 * @property {number} [usage.completion_tokens_details.reasoning_tokens] - Total number of tokens used for reasoning (OpenAI o1 models).
 * @memberof typedefs
 */

/**
 * @typedef {AnthropicStreamUsage | OpenAIUsageMetadata | UsageMetadata} StreamUsage - Stream usage for all providers (currently only Anthropic, OpenAI, LangChain)
 */

/* Native app/client methods */

/**
 * Accumulates tokens and sends them to the client for processing.
 * @callback onTokenProgress
 * @param {string} token - The current token generated by the model.
 * @returns {Promise<void>}
 * @memberof typedefs
 */

/**
 * Main entrypoint for API completion calls
 * @callback sendCompletion
 * @param {Array<ChatCompletionMessage> | string} payload - The messages or prompt to send to the model
 * @param {object} opts - Options for the completion
 * @param {AppConfig} opts.appConfig - Callback function to handle token progress
 * @param {onTokenProgress} opts.onProgress - Callback function to handle token progress
 * @param {AbortController} opts.abortController - AbortController instance
 * @param {Record<string, Record<string, string>>} [opts.userMCPAuthMap]
 * @returns {Promise<{ content: Promise<MessageContentComplex[]>; metadata: Record<string, unknown>; }>}
 * @memberof typedefs
 */

/**
 * Legacy completion handler for OpenAI API.
 * @callback getCompletion
 * @param {Array<ChatCompletionMessage> | string} input - Array of messages or a single prompt string
 * @param {(event: object | string) => Promise<void>} onProgress - SSE progress handler
 * @param {onTokenProgress} onTokenProgress - Token progress handler
 * @param {AbortController} [abortController] - AbortController instance
 * @returns {Promise<Object | string>} - Completion response
 * @memberof typedefs
 */

/**
 * Cohere Stream handling. Note: abortController is not supported here.
 * @callback cohereChatCompletion
 * @param {object} params
 * @param {CohereChatStreamRequest | CohereChatRequest} params.payload
 * @param {onTokenProgress} params.onTokenProgress
 * @memberof typedefs
 */

/**
 * @typedef {Object} OllamaModelDetails
 * @property {string} parent_model - The identifier for the parent model, if any.
 * @property {string} format - The format of the model.
 * @property {string} family - The primary family to which the model belongs.
 * @property {string[]} families - An array of families that include the model.
 * @property {string} parameter_size - The size of the parameters of the model.
 * @property {string} quantization_level - The level of quantization of the model.
 * @memberof typedefs
 */

/**
 * @typedef {Object} OllamaModel
 * @property {string} name - The name of the model, including version tag.
 * @property {string} model - A redundant copy of the name, including version tag.
 * @property {string} modified_at - The ISO string representing the last modification date.
 * @property {number} size - The size of the model in bytes.
 * @property {string} digest - The digest hash of the model.
 * @property {OllamaModelDetails} details - Detailed information about the model.
 * @memberof typedefs
 */

/**
 * @typedef {Object} OllamaListResponse
 * @property {OllamaModel[]} models - the list of models available.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ChatGPTAuthor
 * @property {string} role - The role of the author (e.g., 'assistant', 'system', 'user').
 * @property {?string} name - The name of the author, if available.
 * @property {Object} metadata - Additional metadata related to the author.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ChatGPTContentPart
 * @property {string} content_type - The type of content (e.g., 'text').
 * @property {string[]} parts - The textual parts of the message.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ChatGPTMetadata
 * @property {boolean} is_visually_hidden_from_conversation - Indicates if the message should be hidden.
 * @property {?Array<Object>} citations - Potential citations included in the message.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ChatGPTMessage
 * @property {string} id - Unique identifier for the message.
 * @property {?ChatGPTAuthor} author - The author of the message.
 * @property {?number} create_time - Creation time as a Unix timestamp.
 * @property {?number} update_time - Last update time as a Unix timestamp.
 * @property {ChatGPTContentPart} content - Content of the message.
 * @property {string} status - Status of the message (e.g., 'finished_successfully').
 * @property {boolean} end_turn - Indicates if it's the end of a conversation turn.
 * @property {number} weight - A numerical value representing the weight/importance of the message.
 * @property {ChatGPTMetadata} metadata - Metadata associated with the message.
 * @property {string} recipient - Intended recipient of the message.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ChatGPTMapping
 * @property {ChatGPTMessage} message - Details of the message.
 * @property {string} id - Identifier of the message.
 * @property {?string} parent - Parent message ID.
 * @property {string[]} children - Child message IDs.
 * @memberof typedefs
 */

/**
 * @typedef {Object} ChatGPTConvo
 * @property {string} title - Title of the conversation.
 * @property {number} create_time - Creation time of the conversation as a Unix timestamp.
 * @property {number} update_time - Last update time of the conversation as a Unix timestamp.
 * @property {Object.<string, ChatGPTMapping>} mapping - Mapping of message nodes within the conversation.
 * @memberof typedefs
 */

/** Mutations */

/**
 * @exports TForkConvoResponse
 * @typedef {import('librechat-data-provider').TForkConvoResponse} TForkConvoResponse
 * @memberof typedefs
 */

/**
 * @exports TForkConvoRequest
 * @typedef {import('librechat-data-provider').TForkConvoRequest} TForkConvoRequest
 * @memberof typedefs
 */

/** Clients */

/**
 * @typedef {Promise<{ message: TMessage, conversation: TConversation }> | undefined} ClientDatabaseSavePromise
 * @memberof typedefs
 */

/**
 * @exports OCRImage
 * @typedef {Object} OCRImage
 * @property {string} id - The identifier of the image.
 * @property {number} top_left_x - X-coordinate of the top left corner of the image.
 * @property {number} top_left_y - Y-coordinate of the top left corner of the image.
 * @property {number} bottom_right_x - X-coordinate of the bottom right corner of the image.
 * @property {number} bottom_right_y - Y-coordinate of the bottom right corner of the image.
 * @property {string} image_base64 - Base64-encoded image data.
 * @memberof typedefs
 */

/**
 * @exports PageDimensions
 * @typedef {Object} PageDimensions
 * @property {number} dpi - The dots per inch resolution of the page.
 * @property {number} height - The height of the page in pixels.
 * @property {number} width - The width of the page in pixels.
 * @memberof typedefs
 */

/**
 * @exports OCRPage
 * @typedef {Object} OCRPage
 * @property {number} index - The index of the page in the document.
 * @property {string} markdown - The extracted text content of the page in markdown format.
 * @property {OCRImage[]} images - Array of images found on the page.
 * @property {PageDimensions} dimensions - The dimensions of the page.
 * @memberof typedefs
 */

/**
 * @exports OCRUsageInfo
 * @typedef {Object} OCRUsageInfo
 * @property {number} pages_processed - Number of pages processed in the document.
 * @property {number} doc_size_bytes - Size of the document in bytes.
 * @memberof typedefs
 */

/**
 * @exports OCRResult
 * @typedef {Object} OCRResult
 * @property {OCRPage[]} pages - Array of pages extracted from the document.
 * @property {string} model - The model used for OCR processing.
 * @property {OCRUsageInfo} usage_info - Usage information for the OCR operation.
 * @memberof typedefs
 */
