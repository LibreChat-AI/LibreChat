const axios = require('axios');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const {
  applyAxiosProxyConfig,
  createMinimalRetentionRequest,
  filterFluxPropertiesForProvider,
  fluxImageIdsSchema,
  getHttpsProxyAgent,
} = require('@librechat/api');
const { FileContext, ContentTypes } = require('librechat-data-provider');

const fluxApiJsonSchema = {
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

const displayMessage =
  "Flux displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";

/** Endpoints that require a `finetune_id`, regardless of which `action` the caller selected. */
const FINETUNED_ENDPOINTS = ['/v1/flux-pro-finetuned', '/v1/flux-pro-1.1-ultra-finetuned'];

/**
 * FluxAPI - A tool for generating high-quality images from text prompts using the Flux API.
 * Each call generates one image. If multiple images are needed, make multiple consecutive calls with the same or varied prompts.
 */
class FluxAPI extends Tool {
  // Pricing constants in USD per image
  static PRICING = {
    FLUX_PRO_1_1_ULTRA: -0.06, // /v1/flux-pro-1.1-ultra
    FLUX_PRO_1_1: -0.04, // /v1/flux-pro-1.1
    FLUX_PRO: -0.05, // /v1/flux-pro
    FLUX_DEV: -0.025, // /v1/flux-dev
    FLUX_PRO_FINETUNED: -0.06, // /v1/flux-pro-finetuned
    FLUX_PRO_1_1_ULTRA_FINETUNED: -0.07, // /v1/flux-pro-1.1-ultra-finetuned
  };

  constructor(fields = {}) {
    super();

    /** @type {boolean} Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;

    this.userId = fields.userId;
    this.tenantId = fields.req?.user?.tenantId;
    this.retentionRequest = createMinimalRetentionRequest(fields.req);
    this.fileStrategy = fields.fileStrategy;
    /** @type {MongoFile[]} Reference images attached to the current request. */
    this.imageFiles = Array.isArray(fields.imageFiles) ? fields.imageFiles : [];
    /** Reads stored files by ID; injected by the caller like processFileURL. */
    this.getFiles = fields.getFiles;
    /** Resolves storage strategy helpers; injected by the caller. */
    this.getStrategyFunctions = fields.getStrategyFunctions;
    this.imageUploadRequest = fields.req
      ? {
          ...this.retentionRequest,
          config: {
            ...this.retentionRequest?.config,
            fileStrategy: fields.req.config?.fileStrategy ?? this.fileStrategy,
            fileStrategies: fields.req.config?.fileStrategies,
          },
        }
      : undefined;

    /** @type {boolean} **/
    this.isAgent = fields.isAgent;
    if (this.isAgent) {
      /** Ensures LangChain maps [content, artifact] tuple to ToolMessage fields instead of serializing it into content. */
      this.responseFormat = 'content_and_artifact';
    }
    this.returnMetadata = fields.returnMetadata ?? false;

    if (fields.processFileURL) {
      /** @type {processFileURL} Necessary for output to contain all image metadata. */
      this.processFileURL = fields.processFileURL.bind(this);
    }
    if (fields.uploadImageBuffer) {
      /** @type {uploadImageBuffer} Necessary for saving base64 image results. */
      this.uploadImageBuffer = fields.uploadImageBuffer.bind(this);
    }

    this.apiKey = fields.FLUX_API_KEY || this.getApiKey();
    this.provider = process.env.FLUX_API_PROVIDER || 'bfl';
    if (!['bfl', 'azure-foundry', 'azure-foundry-images'].includes(this.provider)) {
      throw new Error(`Unsupported FLUX_API_PROVIDER: ${this.provider}`);
    }
    this.foundryModelPath = process.env.FLUX_API_MODEL_PATH || '';
    this.foundryModel = process.env.FLUX_API_MODEL || '';
    this.foundryApiVersion = process.env.FLUX_API_VERSION || 'preview';
    const providerInfo = {
      bfl: {
        description: ' and list available finetunes',
        instructions:
          "// Use action: 'list_finetunes' to see available custom models. When using finetunes, use endpoint: '/v1/flux-pro-finetuned' (default) or '/v1/flux-pro-1.1-ultra-finetuned' for higher quality and aspect ratio.",
      },
      'azure-foundry': {
        description: ' and edit attached images using the Microsoft Foundry BFL provider API',
        instructions:
          '// Generate images using the configured Microsoft Foundry FLUX model. Use action "image_edit" with image_ids to edit images attached to the message or a generated_image_id from a previous result.',
      },
      'azure-foundry-images': {
        description: ' using the Microsoft Foundry Images API (FLUX-1.1-pro or FLUX.1-Kontext-pro)',
        instructions:
          '// Generate images using the Microsoft Foundry Images API. This API supports FLUX-1.1-pro and FLUX.1-Kontext-pro deployments.',
      },
    }[this.provider];

    this.name = 'flux';
    this.description = `Use Flux to generate images from text descriptions${providerInfo.description}. Each generate call creates one image. For multiple images, make multiple consecutive calls.`;

    this.description_for_model = `// Transform any image description into a detailed, high-quality prompt. Never submit a prompt under 3 sentences. Follow these core rules:
    // 1. ALWAYS enhance basic prompts into 5-10 detailed sentences (e.g., "a cat" becomes: "A close-up photo of a sleek Siamese cat with piercing blue eyes. The cat sits elegantly on a vintage leather armchair, its tail curled gracefully around its paws. Warm afternoon sunlight streams through a nearby window, casting gentle shadows across its face and highlighting the subtle variations in its cream and chocolate-point fur. The background is softly blurred, creating a shallow depth of field that draws attention to the cat's expressive features. The overall composition has a peaceful, contemplative mood with a professional photography style.")
    // 2. Each prompt MUST be 3-6 descriptive sentences minimum, focusing on visual elements: lighting, composition, mood, and style
    ${providerInfo.instructions}`;

    // Add base URL from environment variable with fallback
    this.baseUrl =
      process.env.FLUX_API_BASE_URL || (this.provider === 'bfl' ? 'https://api.us1.bfl.ai' : '');
    const baseHostname = this.baseUrl ? new URL(this.baseUrl).hostname : '';
    const pointsToFoundry = baseHostname.endsWith('.services.ai.azure.com');
    const pointsToBfl = baseHostname.endsWith('.bfl.ai');
    if (this.provider === 'bfl' && pointsToFoundry) {
      throw new Error(
        'FLUX_API_BASE_URL points to a Microsoft Foundry endpoint, but FLUX_API_PROVIDER is not set. Set FLUX_API_PROVIDER=azure-foundry for the BFL provider API or azure-foundry-images for the OpenAI-compatible Images API.',
      );
    }
    if (this.provider !== 'bfl' && !this.baseUrl) {
      throw new Error(
        `FLUX_API_PROVIDER=${this.provider} requires FLUX_API_BASE_URL pointing to the resource endpoint ending in .services.ai.azure.com.`,
      );
    }
    if (this.provider !== 'bfl' && pointsToBfl) {
      throw new Error(
        `FLUX_API_PROVIDER=${this.provider} is set, but FLUX_API_BASE_URL points to the BFL endpoint. Use the Foundry resource endpoint or set FLUX_API_PROVIDER=bfl.`,
      );
    }

    // Foundry modes serve a filtered view of the BFL contract: the OpenAI-
    // compatible Images API only accepts prompt arguments, while the BFL
    // provider route also edits images through reference file IDs. The shared
    // filter keeps this instance schema in step with the registry definition
    // and advertises only inputs the Foundry payloads actually forward.
    const supportsEditing = this.provider === 'azure-foundry';
    /** Whether the configured route accepts reference images, so callers can
     *  build the matching tool context without re-deriving the provider. */
    this.supportsEditing = supportsEditing;
    const foundryProperties = filterFluxPropertiesForProvider(
      fluxApiJsonSchema.properties,
      this.provider,
    );
    if (supportsEditing) {
      foundryProperties.image_ids = fluxImageIdsSchema;
    }
    this.schema =
      this.provider === 'bfl'
        ? fluxApiJsonSchema
        : {
            ...fluxApiJsonSchema,
            properties: {
              ...foundryProperties,
              action: {
                ...fluxApiJsonSchema.properties.action,
                enum: supportsEditing ? ['generate', 'image_edit'] : ['generate'],
                description: supportsEditing
                  ? 'Action to perform: "generate" for image generation, "image_edit" to edit attached images or a previous result.'
                  : 'Generate an image using the configured Microsoft Foundry model.',
              },
            },
          };
  }

  static get jsonSchema() {
    return fluxApiJsonSchema;
  }

  getAxiosConfig() {
    const config = {};
    return applyAxiosProxyConfig(config, this.baseUrl);
  }

  /** @param {Object|string} value */
  getDetails(value) {
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value, null, 2);
  }

  getApiKey() {
    const apiKey = process.env.FLUX_API_KEY || '';
    if (!apiKey && !this.override) {
      throw new Error('Missing FLUX_API_KEY environment variable.');
    }
    return apiKey;
  }

  wrapInMarkdown(imageUrl) {
    const serverDomain = process.env.DOMAIN_SERVER || 'http://localhost:3080';
    return `![generated image](${serverDomain}${imageUrl})`;
  }

  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    } else if (this.isAgent === true && typeof value === 'object') {
      if (Array.isArray(value)) {
        return value;
      }
      return [displayMessage, value];
    }
    return value;
  }

  async _call(data) {
    const { action = 'generate', ...imageData } = data;

    // Use provided API key for this request if available, otherwise use default
    const requestApiKey = this.apiKey || this.getApiKey();

    // Handle list_finetunes action
    if (action === 'list_finetunes') {
      if (this.provider !== 'bfl') {
        throw new Error('The list_finetunes action is only available with the direct BFL API.');
      }
      return this.getMyFinetunes(requestApiKey);
    }

    // Handle finetuned generation. Route by endpoint too, since a finetuned
    // endpoint requires finetune_id regardless of which action was selected.
    if (action === 'generate_finetuned' || FINETUNED_ENDPOINTS.includes(imageData.endpoint)) {
      if (this.provider !== 'bfl') {
        throw new Error('Finetuned image generation is only available with the direct BFL API.');
      }
      return this.generateFinetunedImage(imageData, requestApiKey);
    }

    // Generate and image_edit both turn a text prompt into an image
    if (!imageData.prompt) {
      throw new Error('Missing required field: prompt');
    }

    if (action === 'image_edit' && this.provider !== 'azure-foundry') {
      throw new Error(
        'The image_edit action is only available with the Microsoft Foundry BFL provider API.',
      );
    }

    if (this.provider === 'azure-foundry') {
      if (action === 'image_edit') {
        return this.editFoundryImage(imageData, requestApiKey);
      }
      return this.generateFoundryImage(imageData, requestApiKey);
    }
    if (this.provider === 'azure-foundry-images') {
      return this.generateFoundryOpenAIImage(imageData, requestApiKey);
    }

    let payload = {
      prompt: imageData.prompt,
      prompt_upsampling: imageData.prompt_upsampling || false,
      safety_tolerance: imageData.safety_tolerance || 6,
      output_format: imageData.output_format || 'png',
    };

    // Add optional parameters if provided
    if (imageData.width) {
      payload.width = imageData.width;
    }
    if (imageData.height) {
      payload.height = imageData.height;
    }
    if (imageData.steps) {
      payload.steps = imageData.steps;
    }
    if (imageData.seed !== undefined) {
      payload.seed = imageData.seed;
    }
    if (imageData.raw) {
      payload.raw = imageData.raw;
    }

    const generateUrl = `${this.baseUrl}${imageData.endpoint || '/v1/flux-pro'}`;
    const resultUrl = `${this.baseUrl}/v1/get_result`;

    logger.debug('[FluxAPI] Generating image with payload:', payload);
    logger.debug('[FluxAPI] Using endpoint:', generateUrl);

    let taskResponse;
    try {
      taskResponse = await axios.post(generateUrl, payload, {
        headers: {
          'x-key': requestApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...this.getAxiosConfig(),
      });
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while submitting task:', details);

      return this.returnValue(
        `Something went wrong when trying to generate the image. The Flux API may be unavailable:
        Error Message: ${details}`,
      );
    }

    const taskId = taskResponse.data.id;

    // Polling for the result
    let status = 'Pending';
    let resultData = null;
    while (status !== 'Ready' && status !== 'Error') {
      try {
        // Wait 2 seconds between polls
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const resultResponse = await axios.get(resultUrl, {
          headers: {
            'x-key': requestApiKey,
            Accept: 'application/json',
          },
          params: { id: taskId },
          ...this.getAxiosConfig(),
        });
        status = resultResponse.data.status;

        if (status === 'Ready') {
          resultData = resultResponse.data.result;
          break;
        } else if (status === 'Error') {
          logger.error('[FluxAPI] Error in task:', resultResponse.data);
          return this.returnValue('An error occurred during image generation.');
        }
      } catch (error) {
        const details = this.getDetails(error?.response?.data || error.message);
        logger.error('[FluxAPI] Error while getting result:', details);
        return this.returnValue('An error occurred while retrieving the image.');
      }
    }

    // If no result data
    if (!resultData || !resultData.sample) {
      logger.error('[FluxAPI] No image data received from API. Response:', resultData);
      return this.returnValue('No image data received from Flux API.');
    }

    return this.processImageResult({ imageUrl: resultData.sample });
  }

  async generateFoundryImage(imageData, requestApiKey) {
    if (!this.baseUrl || !this.foundryModelPath || !this.foundryModel) {
      throw new Error(
        'Azure Foundry requires FLUX_API_BASE_URL, FLUX_API_MODEL_PATH, and FLUX_API_MODEL.',
      );
    }

    const endpoint = new URL(
      `/providers/blackforestlabs/v1/${this.foundryModelPath}`,
      this.baseUrl,
    );
    endpoint.searchParams.set('api-version', this.foundryApiVersion);
    const payload = {
      model: this.foundryModel,
      prompt: imageData.prompt,
      num_images: 1,
      output_format: imageData.output_format || 'png',
      safety_tolerance: imageData.safety_tolerance ?? 6,
    };
    for (const key of ['width', 'height', 'seed']) {
      if (imageData[key] !== undefined) {
        payload[key] = imageData[key];
      }
    }

    let response;
    try {
      response = await axios.post(endpoint.toString(), payload, {
        headers: {
          // Foundry documents api-key and Authorization: Bearer for the FLUX provider route.
          Authorization: `Bearer ${requestApiKey}`,
          'api-key': requestApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...this.getAxiosConfig(),
      });
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while generating image with Azure Foundry:', details);
      return this.returnValue(
        `Something went wrong when trying to generate the image with Azure Foundry:\nError Message: ${
          error?.response?.data?.error?.message || error.message
        }`,
      );
    }

    const imageResult = response.data?.data?.[0];
    if (!imageResult?.b64_json && !imageResult?.url) {
      logger.error('[FluxAPI] No image data received from Azure Foundry:', response.data);
      return this.returnValue('No image data received from Azure Foundry.');
    }
    return this.processImageResult({
      imageUrl: imageResult.url,
      imageBuffer: imageResult.b64_json ? Buffer.from(imageResult.b64_json, 'base64') : undefined,
      imageMimeType: imageResult.mime_type || `image/${payload.output_format}`,
    });
  }

  /**
   * Edits reference images on the Foundry BFL provider route. FLUX.2 accepts up
   * to eight base64-encoded references: the first travels as `input_image`,
   * the rest as `input_image_2` … `input_image_8`, alongside the same payload
   * fields as generation.
   * @param {Object} imageData - Tool call data with `image_ids`
   * @param {string} requestApiKey
   */
  async editFoundryImage(imageData, requestApiKey) {
    if (!this.baseUrl || !this.foundryModelPath || !this.foundryModel) {
      throw new Error(
        'Azure Foundry requires FLUX_API_BASE_URL, FLUX_API_MODEL_PATH, and FLUX_API_MODEL.',
      );
    }

    const imageIds = Array.isArray(imageData.image_ids) ? imageData.image_ids : [];
    if (!imageIds.length) {
      const recentHint = await this.buildRecentImagesHint();
      return this.returnValue(
        'No reference images were provided for image editing. Retry with the `generated_image_id` of a previous Flux result in the `image_ids` array' +
          `${recentHint}, or ask the user to attach an image to edit.`,
      );
    }
    if (imageIds.length > 8) {
      return this.returnValue(
        'FLUX.2 image editing supports at most 8 reference images. Ask the user which images to prioritize.',
      );
    }

    let response;
    let payload;
    try {
      const orderedFiles = await this.resolveImageFiles(imageIds);
      if (orderedFiles.some((file) => !file)) {
        const missingIds = imageIds.filter((_, index) => !orderedFiles[index]);
        const recentHint = await this.buildRecentImagesHint();
        return this.returnValue(
          `The following reference images could not be found for editing: ${missingIds.join(', ')}.` +
            `${recentHint} Otherwise, ask the user to attach the image again.`,
        );
      }
      const endpoint = new URL(
        `/providers/blackforestlabs/v1/${this.foundryModelPath}`,
        this.baseUrl,
      );
      endpoint.searchParams.set('api-version', this.foundryApiVersion);
      payload = {
        model: this.foundryModel,
        prompt: imageData.prompt,
        num_images: 1,
        output_format: imageData.output_format || 'png',
        safety_tolerance: imageData.safety_tolerance ?? 6,
      };
      for (const key of ['width', 'height', 'seed']) {
        if (imageData[key] !== undefined) {
          payload[key] = imageData[key];
        }
      }
      for (let index = 0; index < orderedFiles.length; index++) {
        const imageBuffer = await this.loadImageBuffer(orderedFiles[index]);
        payload[index === 0 ? 'input_image' : `input_image_${index + 1}`] =
          imageBuffer.toString('base64');
      }
      response = await axios.post(endpoint.toString(), payload, {
        headers: {
          // Foundry documents api-key and Authorization: Bearer for the FLUX provider route.
          Authorization: `Bearer ${requestApiKey}`,
          'api-key': requestApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...this.getAxiosConfig(),
      });
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while editing image with Azure Foundry:', details);
      return this.returnValue(
        `Something went wrong when trying to edit the image with Azure Foundry:\nError Message: ${
          error?.response?.data?.error?.message || error.message
        }`,
      );
    }

    const imageResult = response.data?.data?.[0];
    if (!imageResult?.b64_json && !imageResult?.url) {
      logger.error('[FluxAPI] No image data received from Azure Foundry:', response.data);
      return this.returnValue('No image data received from Azure Foundry.');
    }
    return this.processImageResult({
      imageUrl: imageResult.url,
      imageBuffer: imageResult.b64_json ? Buffer.from(imageResult.b64_json, 'base64') : undefined,
      imageMimeType: imageResult.mime_type || `image/${payload.output_format}`,
      metadataText: `referenced_image_ids: ["${imageIds.join('", "')}"]`,
    });
  }

  /**
   * The user's most recently generated images, so an edit call whose
   * `image_ids` are missing or unresolvable can name usable IDs instead of
   * dead-ending the turn. Best-effort: a failed lookup degrades to the
   * plain guidance message.
   * @param {number} limit - Maximum number of image IDs to return
   * @returns {Promise<string[]>}
   */
  async getRecentImageIds(limit = 5) {
    if (!this.userId || !this.getFiles) {
      return [];
    }
    try {
      const files = await this.getFiles(
        { user: this.userId, context: FileContext.image_generation },
        {},
        {},
        limit,
      );
      return (files ?? []).filter((file) => file?.file_id).map((file) => file.file_id);
    } catch (error) {
      logger.warn(
        '[FluxAPI] Failed to look up recently generated images:',
        error?.message ?? error,
      );
      return [];
    }
  }

  /**
   * Guidance listing the user's recent results, appended to edit failures so
   * the model can retry with a correct ID without user intervention.
   * @returns {Promise<string>}
   */
  async buildRecentImagesHint() {
    const recentIds = await this.getRecentImageIds();
    if (recentIds.length === 0) {
      return '';
    }
    return ` The user's most recently generated images are: ${recentIds
      .map((id) => `"${id}"`)
      .join(', ')}. Retry with one of these IDs.`;
  }

  /**
   * Resolves reference images by file ID: files attached to the current
   * request win, remaining IDs are looked up among the user's own files.
   * Mirrors the resolution order of the OpenAI image edit tool, including the
   * dimensions filter so only image-like files match.
   * @param {string[]} imageIds
   * @returns {Promise<Array<MongoFile | undefined>>} Files aligned to `imageIds`; unresolved slots stay `undefined`.
   */
  async resolveImageFiles(imageIds) {
    const attachedFiles = new Map(this.imageFiles.map((file) => [file.file_id, { ...file }]));
    // Dense array: a sparse one would hide unresolved slots from Array#some.
    const orderedFiles = imageIds.map(() => undefined);
    const idsToFetch = [];
    const indexOfMissing = new Map();
    imageIds.forEach((fileId, index) => {
      const file = attachedFiles.get(fileId);
      if (file) {
        orderedFiles[index] = file;
      } else {
        idsToFetch.push(fileId);
        indexOfMissing.set(fileId, index);
      }
    });
    // Without a user context or the injected file reader the lookup stays
    // unset: unresolved slots surface as a clear "not found" message instead
    // of a weakened user filter.
    if (idsToFetch.length && this.userId && this.getFiles) {
      const fetchedFiles = await this.getFiles(
        {
          user: this.userId,
          file_id: { $in: idsToFetch },
          height: { $exists: true },
          width: { $exists: true },
        },
        {},
        {},
      );
      for (const file of fetchedFiles) {
        const index = indexOfMissing.get(file.file_id);
        if (index !== undefined) {
          orderedFiles[index] = { ...file };
        }
      }
    }
    return orderedFiles;
  }

  /**
   * Reads a stored image into memory. The Foundry edit contract sends
   * references as base64 inside a JSON body, unlike the multipart transport
   * of the OpenAI edit tool.
   * @param {MongoFile} imageFile
   * @returns {Promise<Buffer>}
   */
  async loadImageBuffer(imageFile) {
    const source = imageFile.source || this.fileStrategy;
    if (!source) {
      throw new Error('No source found for image file');
    }
    if (!this.getStrategyFunctions) {
      throw new Error('File strategy functions are unavailable for image editing.');
    }
    const { getDownloadStream } = this.getStrategyFunctions(source);
    if (!getDownloadStream) {
      throw new Error(`No download stream method found for source: ${source}`);
    }
    const stream = await getDownloadStream(this.retentionRequest, imageFile.filepath);
    if (!stream) {
      throw new Error('Failed to get download stream for image file');
    }
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async generateFoundryOpenAIImage(imageData, requestApiKey) {
    if (!this.baseUrl || !this.foundryModel) {
      throw new Error(
        'Microsoft Foundry Images API requires FLUX_API_BASE_URL and FLUX_API_MODEL.',
      );
    }

    const endpoint = new URL('/openai/v1/images/generations', this.baseUrl);
    endpoint.searchParams.set('api-version', this.foundryApiVersion);
    const responsePayload = {
      model: this.foundryModel,
      prompt: imageData.prompt,
      n: 1,
      size: '1024x1024',
    };

    let response;
    try {
      response = await axios.post(endpoint.toString(), responsePayload, {
        headers: {
          'api-key': requestApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...this.getAxiosConfig(),
      });
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error(
        '[FluxAPI] Error while generating image with Microsoft Foundry Images API:',
        details,
      );
      return this.returnValue(
        `Something went wrong when trying to generate the image with the Microsoft Foundry Images API:\nError Message: ${
          error?.response?.data?.error?.message || error.message
        }`,
      );
    }

    const imageResult = response.data?.data?.[0];
    if (!imageResult?.b64_json && !imageResult?.url) {
      logger.error(
        '[FluxAPI] No image data received from Microsoft Foundry Images API:',
        response.data,
      );
      return this.returnValue('No image data received from Microsoft Foundry Images API.');
    }
    return this.processImageResult({
      imageUrl: imageResult.url,
      imageBuffer: imageResult.b64_json ? Buffer.from(imageResult.b64_json, 'base64') : undefined,
      imageMimeType: imageResult.mime_type || 'image/png',
    });
  }

  async processImageResult({ imageUrl, imageBuffer, imageMimeType = 'image/png', metadataText }) {
    const fileId = uuidv4();
    const extension = imageMimeType === 'image/jpeg' ? 'jpg' : imageMimeType.split('/')[1];
    const imageName = `img-${fileId}.${extension}`;

    if (this.isAgent) {
      try {
        if (!imageBuffer) {
          const fetchOptions = {};
          const agent = getHttpsProxyAgent(imageUrl);
          if (agent) {
            fetchOptions.agent = agent;
          }
          const imageResponse = await fetch(imageUrl, fetchOptions);
          if (imageResponse.ok === false) {
            throw new Error(`Image download failed with status ${imageResponse.status}.`);
          }
          imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        }
        const content = [
          {
            type: ContentTypes.IMAGE_URL,
            image_url: {
              url: `data:${imageMimeType};base64,${imageBuffer.toString('base64')}`,
            },
          },
        ];

        const response = [
          {
            type: ContentTypes.TEXT,
            // The generated file ID lets the next image_edit call reference
            // this result without the user re-uploading it.
            text:
              `${displayMessage}\n\ngenerated_image_id: "${fileId}"` +
              (metadataText ? `\n${metadataText}` : ''),
          },
        ];
        return [response, { content, file_ids: [fileId] }];
      } catch (error) {
        logger.error('Error processing image for agent:', error);
        return this.returnValue(`Failed to process the image. ${error.message}`);
      }
    }

    try {
      if (imageBuffer) {
        if (!this.uploadImageBuffer || !this.imageUploadRequest) {
          throw new Error('Image upload is unavailable for the generated image.');
        }
        const { width, height } = await sharp(imageBuffer).metadata();
        if (!width || !height) {
          throw new Error('Unable to determine dimensions of the generated image.');
        }
        const result = await this.uploadImageBuffer({
          req: this.imageUploadRequest,
          context: FileContext.image_generation,
          resize: false,
          metadata: {
            buffer: imageBuffer,
            width,
            height,
            bytes: imageBuffer.length,
            filename: imageName,
            type: imageMimeType,
            file_id: fileId,
          },
        });
        this.result = this.returnMetadata ? result : this.wrapInMarkdown(result.filepath);
        return this.returnValue(this.result);
      }

      logger.debug('[FluxAPI] Saving image:', imageUrl);
      const result = await this.processFileURL({
        fileStrategy: this.fileStrategy,
        userId: this.userId,
        URL: imageUrl,
        fileName: imageName,
        basePath: 'images',
        context: FileContext.image_generation,
        tenantId: this.tenantId,
        req: this.retentionRequest,
      });

      logger.debug('[FluxAPI] Image saved to path:', result.filepath);

      // Calculate cost based on endpoint
      /**
       * TODO: Cost handling
      const endpoint = imageData.endpoint || '/v1/flux-pro';
      const endpointKey = Object.entries(FluxAPI.PRICING).find(([key, _]) =>
        endpoint.includes(key.toLowerCase().replace(/_/g, '-')),
      )?.[0];
      const cost = FluxAPI.PRICING[endpointKey] || 0;
       */
      this.result = this.returnMetadata ? result : this.wrapInMarkdown(result.filepath);
      return this.returnValue(this.result);
    } catch (error) {
      const details = this.getDetails(error?.message ?? 'No additional error details.');
      logger.error('Error while saving the image:', details);
      return this.returnValue(`Failed to save the image locally. ${details}`);
    }
  }

  async getMyFinetunes(apiKey = null) {
    const finetunesUrl = `${this.baseUrl}/v1/my_finetunes`;
    const detailsUrl = `${this.baseUrl}/v1/finetune_details`;

    try {
      const headers = {
        'x-key': apiKey || this.getApiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Get list of finetunes
      const response = await axios.get(finetunesUrl, {
        headers,
        ...this.getAxiosConfig(),
      });
      const finetunes = response.data.finetunes;

      // Fetch details for each finetune
      const finetuneDetails = await Promise.all(
        finetunes.map(async (finetuneId) => {
          try {
            const detailResponse = await axios.get(`${detailsUrl}?finetune_id=${finetuneId}`, {
              headers,
              ...this.getAxiosConfig(),
            });
            return {
              id: finetuneId,
              ...detailResponse.data,
            };
          } catch (error) {
            logger.error(`[FluxAPI] Error fetching details for finetune ${finetuneId}:`, error);
            return {
              id: finetuneId,
              error: 'Failed to fetch details',
            };
          }
        }),
      );

      if (this.isAgent) {
        const formattedDetails = JSON.stringify(finetuneDetails, null, 2);
        return [`Here are the available finetunes:\n${formattedDetails}`, null];
      }
      return JSON.stringify(finetuneDetails);
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while getting finetunes:', details);
      const errorMsg = `Failed to get finetunes: ${details}`;
      return this.isAgent ? this.returnValue([errorMsg, {}]) : new Error(errorMsg);
    }
  }

  async generateFinetunedImage(imageData, requestApiKey) {
    if (!imageData.prompt) {
      throw new Error('Missing required field: prompt');
    }

    if (!imageData.finetune_id) {
      throw new Error(
        'Missing required field: finetune_id for finetuned generation. Please supply a finetune_id!',
      );
    }

    // Validate endpoint is appropriate for finetuned generation
    const endpoint = imageData.endpoint || '/v1/flux-pro-finetuned';

    if (!FINETUNED_ENDPOINTS.includes(endpoint)) {
      throw new Error(
        `Invalid endpoint for finetuned generation. Must be one of: ${FINETUNED_ENDPOINTS.join(', ')}`,
      );
    }

    let payload = {
      prompt: imageData.prompt,
      prompt_upsampling: imageData.prompt_upsampling || false,
      safety_tolerance: imageData.safety_tolerance || 6,
      output_format: imageData.output_format || 'png',
      finetune_id: imageData.finetune_id,
      finetune_strength: imageData.finetune_strength || 1.0,
      guidance: imageData.guidance || 2.5,
    };

    // Add optional parameters if provided
    if (imageData.width) {
      payload.width = imageData.width;
    }
    if (imageData.height) {
      payload.height = imageData.height;
    }
    if (imageData.steps) {
      payload.steps = imageData.steps;
    }
    if (imageData.seed !== undefined) {
      payload.seed = imageData.seed;
    }
    if (imageData.raw) {
      payload.raw = imageData.raw;
    }

    const generateUrl = `${this.baseUrl}${endpoint}`;
    const resultUrl = `${this.baseUrl}/v1/get_result`;

    logger.debug('[FluxAPI] Generating finetuned image with payload:', payload);
    logger.debug('[FluxAPI] Using endpoint:', generateUrl);

    let taskResponse;
    try {
      taskResponse = await axios.post(generateUrl, payload, {
        headers: {
          'x-key': requestApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...this.getAxiosConfig(),
      });
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while submitting finetuned task:', details);
      return this.returnValue(
        `Something went wrong when trying to generate the finetuned image. The Flux API may be unavailable:
        Error Message: ${details}`,
      );
    }

    const taskId = taskResponse.data.id;

    // Polling for the result
    let status = 'Pending';
    let resultData = null;
    while (status !== 'Ready' && status !== 'Error') {
      try {
        // Wait 2 seconds between polls
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const resultResponse = await axios.get(resultUrl, {
          headers: {
            'x-key': requestApiKey,
            Accept: 'application/json',
          },
          params: { id: taskId },
          ...this.getAxiosConfig(),
        });
        status = resultResponse.data.status;

        if (status === 'Ready') {
          resultData = resultResponse.data.result;
          break;
        } else if (status === 'Error') {
          logger.error('[FluxAPI] Error in finetuned task:', resultResponse.data);
          return this.returnValue('An error occurred during finetuned image generation.');
        }
      } catch (error) {
        const details = this.getDetails(error?.response?.data || error.message);
        logger.error('[FluxAPI] Error while getting finetuned result:', details);
        return this.returnValue('An error occurred while retrieving the finetuned image.');
      }
    }

    // If no result data
    if (!resultData || !resultData.sample) {
      logger.error('[FluxAPI] No image data received from API. Response:', resultData);
      return this.returnValue('No image data received from Flux API.');
    }

    const imageUrl = resultData.sample;
    const imageName = `img-${uuidv4()}.png`;

    if (this.isAgent) {
      try {
        const fetchOptions = {};
        const agent = getHttpsProxyAgent(imageUrl);
        if (agent) {
          fetchOptions.agent = agent;
        }
        const imageResponse = await fetch(imageUrl, fetchOptions);
        const arrayBuffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const content = [
          {
            type: ContentTypes.IMAGE_URL,
            image_url: {
              url: `data:image/png;base64,${base64}`,
            },
          },
        ];

        const response = [
          {
            type: ContentTypes.TEXT,
            text: displayMessage,
          },
        ];
        return [response, { content }];
      } catch (error) {
        logger.error('[FluxAPI] Error processing finetuned image for agent:', error);
        return this.returnValue(`Failed to process the finetuned image. ${error.message}`);
      }
    }

    try {
      logger.debug('[FluxAPI] Saving finetuned image:', imageUrl);
      const result = await this.processFileURL({
        fileStrategy: this.fileStrategy,
        userId: this.userId,
        URL: imageUrl,
        fileName: imageName,
        basePath: 'images',
        context: FileContext.image_generation,
        tenantId: this.tenantId,
        req: this.retentionRequest,
      });

      logger.debug('[FluxAPI] Finetuned image saved to path:', result.filepath);

      this.result = this.returnMetadata ? result : this.wrapInMarkdown(result.filepath);
      return this.returnValue(this.result);
    } catch (error) {
      const details = this.getDetails(error?.message ?? 'No additional error details.');
      logger.error('Error while saving the finetuned image:', details);
      return this.returnValue(`Failed to save the finetuned image locally. ${details}`);
    }
  }
}

module.exports = FluxAPI;
