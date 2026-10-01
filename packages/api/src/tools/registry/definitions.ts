import { WebSearchToolDefinition, CalculatorToolDefinition } from '@librechat/agents';
import type { ExtendedJsonSchema } from './schema';
import { AskUserQuestionToolDefinition } from '~/agents/hitl/askUserQuestionTool';
import { geminiToolkit } from '~/tools/toolkits/gemini';
import { oaiToolkit } from '~/tools/toolkits/oai';

export type { ExtendedJsonSchema } from './schema';

export interface ToolRegistryDefinition {
  name: string;
  description: string;
  schema: ExtendedJsonSchema;
  description_for_model?: string;
  responseFormat?: 'content_and_artifact' | 'content';
  toolType: 'builtin' | 'mcp' | 'action' | 'custom';
}

/** Google Search tool JSON schema */
export const googleSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query string.',
    },
    max_results: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'The maximum number of search results to return. Defaults to 5.',
    },
  },
  required: ['query'],
};

/** DALL-E 3 tool JSON schema */
export const dalle3Schema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 4000,
      description:
        'A text description of the desired image, following the rules, up to 4000 characters.',
    },
    style: {
      type: 'string',
      enum: ['vivid', 'natural'],
      description:
        'Must be one of `vivid` or `natural`. `vivid` generates hyper-real and dramatic images, `natural` produces more natural, less hyper-real looking images',
    },
    quality: {
      type: 'string',
      enum: ['hd', 'standard'],
      description: 'The quality of the generated image. Only `hd` and `standard` are supported.',
    },
    size: {
      type: 'string',
      enum: ['1024x1024', '1792x1024', '1024x1792'],
      description:
        'The size of the requested image. Use 1024x1024 (square) as the default, 1792x1024 if the user requests a wide image, and 1024x1792 for full-body portraits. Always include this parameter in the request.',
    },
  },
  required: ['prompt', 'style', 'quality', 'size'],
};

/** Azure OpenAI Sora Video Generation tool JSON schema */
export const soraVideoGenSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 4000,
      description: 'A detailed text prompt describing the video scene to generate.',
    },
    duration: {
      type: 'integer',
      enum: [5, 10, 15, 20],
      description: 'The length of the video in seconds.',
    },
    resolution: {
      type: 'string',
      enum: ['1080p', '720p', '480p'],
      description: 'The output resolution of the generated video.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description: 'The aspect ratio for the video.',
    },
    fps: {
      type: 'integer',
      enum: [24, 30, 60],
      description: 'Frames per second.',
    },
  },
  required: ['prompt'],
};

/** Flux API tool JSON schema */
export const fluxApiSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['generate', 'list_finetunes', 'generate_finetuned'],
      description:
        'Action to perform: "generate" for image generation, "generate_finetuned" for finetuned model generation, "list_finetunes" to get available custom models',
    },
    prompt: {
      type: 'string',
      description:
        'Text prompt for image generation. Required when action is "generate". Not used for list_finetunes.',
    },
    width: {
      type: 'number',
      description:
        'Width of the generated image in pixels. Must be a multiple of 32. Default is 1024.',
    },
    height: {
      type: 'number',
      description:
        'Height of the generated image in pixels. Must be a multiple of 32. Default is 768.',
    },
    prompt_upsampling: {
      type: 'boolean',
      description: 'Whether to perform upsampling on the prompt.',
    },
    steps: {
      type: 'integer',
      description: 'Number of steps to run the model for, a number from 1 to 50. Default is 40.',
    },
    seed: {
      type: 'number',
      description: 'Optional seed for reproducibility.',
    },
    safety_tolerance: {
      type: 'number',
      description:
        'Tolerance level for input and output moderation. Between 0 and 6, 0 being most strict, 6 being least strict.',
    },
    endpoint: {
      type: 'string',
      enum: [
        '/v1/flux-pro-1.1',
        '/v1/flux-pro',
        '/v1/flux-dev',
        '/v1/flux-pro-1.1-ultra',
        '/v1/flux-pro-finetuned',
        '/v1/flux-pro-1.1-ultra-finetuned',
      ],
      description: 'Endpoint to use for image generation.',
    },
    raw: {
      type: 'boolean',
      description:
        'Generate less processed, more natural-looking images. Only works for /v1/flux-pro-1.1-ultra.',
    },
    finetune_id: {
      type: 'string',
      description: 'ID of the finetuned model to use',
    },
    finetune_strength: {
      type: 'number',
      description: 'Strength of the finetuning effect (typically between 0.1 and 1.2)',
    },
    guidance: {
      type: 'number',
      description: 'Guidance scale for finetuned models',
    },
    aspect_ratio: {
      type: 'string',
      description: 'Aspect ratio for ultra models (e.g., "16:9")',
    },
  },
  required: [],
};

/** OpenWeather tool JSON schema */
export const openWeatherSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['help', 'current_forecast', 'timestamp', 'daily_aggregation', 'overview'],
      description: 'The action to perform',
    },
    city: {
      type: 'string',
      description: 'City name for geocoding if lat/lon not provided',
    },
    lat: {
      type: 'number',
      description: 'Latitude coordinate',
    },
    lon: {
      type: 'number',
      description: 'Longitude coordinate',
    },
    exclude: {
      type: 'string',
      description: 'Parts to exclude from the response',
    },
    units: {
      type: 'string',
      enum: ['Celsius', 'Kelvin', 'Fahrenheit'],
      description: 'Temperature units',
    },
    lang: {
      type: 'string',
      description: 'Language code',
    },
    date: {
      type: 'string',
      description: 'Date in YYYY-MM-DD format for timestamp and daily_aggregation',
    },
    tz: {
      type: 'string',
      description: 'Timezone',
    },
  },
  required: ['action'],
};

/** Wolfram Alpha tool JSON schema */
export const wolframSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description: 'Natural language query to WolframAlpha following the guidelines',
    },
  },
  required: ['input'],
};

/** Stable Diffusion tool JSON schema */
export const stableDiffusionSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'Detailed keywords to describe the subject, using at least 7 keywords to accurately describe the image, separated by comma',
    },
    negative_prompt: {
      type: 'string',
      description:
        'Keywords we want to exclude from the final image, using at least 7 keywords to accurately describe the image, separated by comma',
    },
  },
  required: ['prompt', 'negative_prompt'],
};

/** Azure AI Search tool JSON schema */
export const azureAISearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search word or phrase to Azure AI Search',
    },
  },
  required: ['query'],
};

/** Traversaal Search tool JSON schema */
export const traversaalSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A properly written sentence to be interpreted by an AI to search the web according to the user's request.",
    },
  },
  required: ['query'],
};

/** Tavily Search Results tool JSON schema */
export const tavilySearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query string.',
    },
    max_results: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: 'The maximum number of search results to return. Defaults to 5.',
    },
    search_depth: {
      type: 'string',
      enum: ['basic', 'advanced'],
      description:
        'The depth of the search, affecting result quality and response time (`basic` or `advanced`). Default is basic for quick results and advanced for indepth high quality results but longer response time. Advanced calls equals 2 requests.',
    },
    include_images: {
      type: 'boolean',
      description:
        'Whether to include a list of query-related images in the response. Default is False.',
    },
    include_answer: {
      type: 'boolean',
      description: 'Whether to include answers in the search results. Default is False.',
    },
    include_raw_content: {
      type: 'boolean',
      description: 'Whether to include raw content in the search results. Default is False.',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'A list of domains to specifically include in the search results.',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'A list of domains to specifically exclude from the search results.',
    },
    topic: {
      type: 'string',
      enum: ['general', 'news', 'finance'],
      description:
        'The category of the search. Use news ONLY if query SPECIFCALLY mentions the word "news".',
    },
    time_range: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'],
      description: 'The time range back from the current date to filter results.',
    },
    days: {
      type: 'number',
      minimum: 1,
      description: 'Number of days back from the current date to include. Only if topic is news.',
    },
    include_image_descriptions: {
      type: 'boolean',
      description:
        'When include_images is true, also add a descriptive text for each image. Default is false.',
    },
  },
  required: ['query'],
};

/** File Search tool JSON schema */
export const fileSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
    },
  },
  required: ['query'],
};

/** Tool definitions registry - maps tool names to their definitions */
export const toolDefinitions: Record<string, ToolRegistryDefinition> = {
  google: {
    name: 'google',
    description:
      'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.',
    schema: googleSearchSchema,
    toolType: 'builtin',
  },
  dalle: {
    name: 'dalle',
    description: `Use DALLE to create images from text descriptions.
    - It requires prompts to be in English, detailed, and to specify image type and human features for diversity.
    - Create only one image, without repeating or listing descriptions outside the "prompts" field.
    - Maintains the original intent of the description, with parameters for image style, quality, and size to tailor the output.`,
    schema: dalle3Schema,
    toolType: 'builtin',
  },
  flux: {
    name: 'flux',
    description:
      'Use Flux to generate images from text descriptions. This tool can generate images and list available finetunes. Each generate call creates one image. For multiple images, make multiple consecutive calls.',
    schema: fluxApiSchema,
    toolType: 'builtin',
  },
  open_weather: {
    name: 'open_weather',
    description:
      'Provides weather data from OpenWeather One Call API 3.0. Actions: help, current_forecast, timestamp, daily_aggregation, overview. If lat/lon not provided, specify "city" for geocoding. Units: "Celsius", "Kelvin", or "Fahrenheit" (default: Celsius). For timestamp action, use "date" in YYYY-MM-DD format.',
    schema: openWeatherSchema,
    toolType: 'builtin',
  },
  wolfram: {
    name: 'wolfram',
    description:
      'WolframAlpha offers computation, math, curated knowledge, and real-time data. It handles natural language queries and performs complex calculations. Follow the guidelines to get the best results.',
    schema: wolframSchema,
    toolType: 'builtin',
  },
  'stable-diffusion': {
    name: 'stable-diffusion',
    description:
      "You can generate images using text with 'stable-diffusion'. This tool is exclusively for visual content.",
    schema: stableDiffusionSchema,
    toolType: 'builtin',
  },
  'azure-ai-search': {
    name: 'azure-ai-search',
    description: "Use the 'azure-ai-search' tool to retrieve search results relevant to your input",
    schema: azureAISearchSchema,
    toolType: 'builtin',
  },
  traversaal_search: {
    name: 'traversaal_search',
    description:
      'An AI search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events. Input should be a search query.',
    schema: traversaalSearchSchema,
    toolType: 'builtin',
  },
  tavily_search_results_json: {
    name: 'tavily_search_results_json',
    description:
      'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.',
    schema: tavilySearchSchema,
    toolType: 'builtin',
  },
  file_search: {
    name: 'file_search',
    description:
      'Performs semantic search across attached "file_search" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query.',
    schema: fileSearchSchema,
    toolType: 'builtin',
    responseFormat: 'content_and_artifact',
  },
  image_gen_oai: {
    name: oaiToolkit.image_gen_oai.name,
    description: oaiToolkit.image_gen_oai.description,
    schema: oaiToolkit.image_gen_oai.schema,
    toolType: 'builtin',
    responseFormat: oaiToolkit.image_gen_oai.responseFormat,
  },
  image_edit_oai: {
    name: oaiToolkit.image_edit_oai.name,
    description: oaiToolkit.image_edit_oai.description,
    schema: oaiToolkit.image_edit_oai.schema,
    toolType: 'builtin',
    responseFormat: oaiToolkit.image_edit_oai.responseFormat,
  },
  gemini_image_gen: {
    name: geminiToolkit.gemini_image_gen.name,
    description: geminiToolkit.gemini_image_gen.description,
    schema: geminiToolkit.gemini_image_gen.schema,
    toolType: 'builtin',
    responseFormat: geminiToolkit.gemini_image_gen.responseFormat,
  },
  video_gen_sora_azure: {
    name: oaiToolkit.video_gen_sora_azure.name,
    description: oaiToolkit.video_gen_sora_azure.description,
    schema: oaiToolkit.video_gen_sora_azure.schema,
    toolType: 'builtin',
    responseFormat: oaiToolkit.video_gen_sora_azure.responseFormat,
  },
};

/**
 * Tool definitions from @librechat/agents.
 *
 * `CodeExecutionToolDefinition` (the legacy `execute_code` tool) is
 * intentionally absent — the `execute_code` capability now expands into
 * the skill-flavored `bash_tool` + `read_file` pair, registered at
 * initialize-time by `registerCodeExecutionTools`. Agents whose `tools`
 * array contains the literal string `execute_code` continue to work:
 * the capability gate still filters on that string, and the runtime
 * registers the tool pair on match.
 */
const agentToolDefinitions: Record<string, ToolRegistryDefinition> = {
  [CalculatorToolDefinition.name]: {
    name: CalculatorToolDefinition.name,
    description: CalculatorToolDefinition.description,
    schema: CalculatorToolDefinition.schema as unknown as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  [WebSearchToolDefinition.name]: {
    name: WebSearchToolDefinition.name,
    description: WebSearchToolDefinition.description,
    schema: WebSearchToolDefinition.schema as unknown as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  [AskUserQuestionToolDefinition.name]: {
    name: AskUserQuestionToolDefinition.name,
    description: AskUserQuestionToolDefinition.description,
    schema: AskUserQuestionToolDefinition.schema as ExtendedJsonSchema,
    toolType: 'builtin',
  },
};

export function getToolDefinition(toolName: string): ToolRegistryDefinition | undefined {
  return toolDefinitions[toolName] ?? agentToolDefinitions[toolName];
}

export function getAllToolDefinitions(): ToolRegistryDefinition[] {
  return [...Object.values(toolDefinitions), ...Object.values(agentToolDefinitions)];
}

export function getToolSchema(toolName: string): ExtendedJsonSchema | undefined {
  return getToolDefinition(toolName)?.schema;
}
