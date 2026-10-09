const path = require('path');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const { fetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const {
  getImageBasename,
  extractBaseURL,
  getProxyDispatcher,
  getEnvProxyDispatcher,
  createMinimalRetentionRequest,
} = require('@librechat/api');
const { FileContext, ContentTypes } = require('librechat-data-provider');

const dalle3JsonSchema = {
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

const displayMessage =
  "DALL-E displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";
class DALLE3 extends Tool {
  constructor(fields = {}) {
    super();
    /** @type {boolean} Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;
    /** @type {boolean} Necessary for output to contain all image metadata. */
    this.returnMetadata = fields.returnMetadata ?? false;

    this.userId = fields.userId;
    this.tenantId = fields.req?.user?.tenantId;
    this.retentionRequest = createMinimalRetentionRequest(fields.req);
    this.fileStrategy = fields.fileStrategy;
    /** @type {boolean} */
    this.isAgent = fields.isAgent;
    if (this.isAgent) {
      /** Ensures LangChain maps [content, artifact] tuple to ToolMessage fields instead of serializing it into content. */
      this.responseFormat = 'content_and_artifact';
    }
    if (fields.processFileURL) {
      /** @type {processFileURL} Necessary for output to contain all image metadata. */
      this.processFileURL = fields.processFileURL.bind(this);
    }

    let apiKey = fields.DALLE3_API_KEY ?? fields.DALLE_API_KEY ?? this.getApiKey();
    const config = { apiKey };
    if (process.env.DALLE_REVERSE_PROXY) {
      config.baseURL = extractBaseURL(process.env.DALLE_REVERSE_PROXY);
    }

    if (process.env.DALLE3_AZURE_API_VERSION && process.env.DALLE3_BASEURL) {
      config.baseURL = process.env.DALLE3_BASEURL;
      config.defaultQuery = { 'api-version': process.env.DALLE3_AZURE_API_VERSION };
      config.defaultHeaders = {
        'api-key': process.env.DALLE3_API_KEY,
        'Content-Type': 'application/json',
      };
      config.apiKey = process.env.DALLE3_API_KEY;
    }

    const proxyDispatcher = getProxyDispatcher();
    if (proxyDispatcher) {
      config.fetchOptions = {
        dispatcher: proxyDispatcher,
      };
    }

    /** @type {OpenAI} */
    this.openai = new OpenAI(config);
    this.name = 'dalle';
    this.description = `Use DALLE to create images from text descriptions.
    - It requires prompts to be in English, detailed, and to specify image type and human features for diversity.
    - Create only one image, without repeating or listing descriptions outside the "prompts" field.
    - Maintains the original intent of the description, with parameters for image style, quality, and size to tailor the output.`;
    this.description_for_model =
      process.env.DALLE3_SYSTEM_PROMPT ??
      `// Whenever a description of an image is given, generate prompts (following these rules), and use dalle to create the image. If the user does not ask for a specific number of images, default to creating 2 prompts to send to dalle that are written to be as diverse as possible. All prompts sent to dalle must abide by the following policies:
    // 1. Prompts must be in English. Translate to English if needed.
    // 2. One image per function call. Create only 1 image per request unless explicitly told to generate more than 1 image.
    // 3. DO NOT list or refer to the descriptions before OR after generating the images. They should ONLY ever be written out ONCE, in the \`"prompts"\` field of the request. You do not need to ask for permission to generate, just do it!
    // 4. Always mention the image type (photo, oil painting, watercolor painting, illustration, cartoon, drawing, vector, render, etc.) at the beginning of the caption. Unless the captions suggests otherwise, make one of the images a photo.
    // 5. Diversify depictions of ALL images with people to always include always DESCENT and GENDER for EACH person using direct terms. Adjust only human descriptions.
    // - EXPLICITLY specify these attributes, not abstractly reference them. The attributes should be specified in a minimal way and should directly describe their physical form.
    // - Your choices should be grounded in reality. For example, all of a given OCCUPATION should not be the same gender or race. Additionally, focus on creating diverse, inclusive, and exploratory scenes via the properties you choose during rewrites.  Make choices that may be insightful or unique sometimes.
    // - Use "various" or "diverse" ONLY IF the description refers to groups of more than 3 people. Do not change the number of people requested in the original description.
    // - Don't alter memes, fictional character origins, or unseen people. Maintain the original prompt's intent and prioritize quality.
    // The prompt must intricately describe every part of the image in concrete, objective detail. THINK about what the end goal of the description is, and extrapolate that to what would make satisfying images.
    // All descriptions sent to dalle should be a paragraph of text that is extremely descriptive and detailed. Each should be more than 3 sentences long.
    // - The "vivid" style is HIGHLY preferred, but "natural" is also supported.`;
    this.schema = dalle3JsonSchema;
  }

  static get jsonSchema() {
    return dalle3JsonSchema;
  }

  getApiKey() {
    const apiKey = process.env.DALLE3_API_KEY ?? process.env.DALLE_API_KEY ?? '';
    if (!apiKey && !this.override) {
      throw new Error('Missing DALLE_API_KEY environment variable.');
    }
    return apiKey;
  }

  replaceUnwantedChars(inputString) {
    return inputString
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/"/g, '')
      .trim();
  }

  wrapInMarkdown(imageUrl) {
    return `![generated image](${imageUrl})`;
  }

  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    } else if (this.isAgent === true && typeof value === 'object') {
      return [displayMessage, value];
    }

    return value;
  }

  async _call(data) {
    const { prompt, quality = 'standard', size = '1024x1024', style = 'vivid' } = data;
    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }

    let resp;
    try {
      resp = await this.openai.images.generate({
        model: 'dall-e-3',
        quality,
        style,
        size,
        prompt: this.replaceUnwantedChars(prompt),
        n: 1,
      });
    } catch (error) {
      logger.error('[DALL-E-3] Problem generating the image:', error);
      return this
        .returnValue(`Something went wrong when trying to generate the image. The DALL-E API may be unavailable:
Error Message: ${error.message}`);
    }

    if (!resp) {
      return this.returnValue(
        'Something went wrong when trying to generate the image. The DALL-E API may be unavailable',
      );
    }

    const theImageUrl = resp.data[0].url;

    if (!theImageUrl) {
      return this.returnValue(
        'No image URL returned from OpenAI API. There may be a problem with the API or your configuration.',
      );
    }

    if (this.isAgent) {
      let fetchOptions = {};
      const dispatcher = getEnvProxyDispatcher();
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
      }
      const imageResponse = await fetch(theImageUrl, fetchOptions);
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
    }

    const imageBasename = getImageBasename(theImageUrl);
    const imageExt = path.extname(imageBasename);

    const extension = imageExt.startsWith('.') ? imageExt.slice(1) : imageExt;
    const imageName = `img-${uuidv4()}.${extension}`;

    logger.debug('[DALL-E-3]', {
      imageName,
      imageBasename,
      imageExt,
      extension,
      theImageUrl,
      data: resp.data[0],
    });

    try {
      const result = await this.processFileURL({
        URL: theImageUrl,
        basePath: 'images',
        userId: this.userId,
        fileName: imageName,
        fileStrategy: this.fileStrategy,
        context: FileContext.image_generation,
        tenantId: this.tenantId,
        req: this.retentionRequest,
      });

      if (this.returnMetadata) {
        this.result = result;
      } else {
        this.result = this.wrapInMarkdown(result.filepath);
      }
    } catch (error) {
      logger.error('Error while saving the image:', error);
      this.result = `Failed to save the image locally. ${error.message}`;
    }

    return this.returnValue(this.result);
  }
}

module.exports = DALLE3;
