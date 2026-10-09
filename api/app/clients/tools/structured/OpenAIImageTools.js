const axios = require('axios');
const { v4 } = require('uuid');
const OpenAI = require('openai');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { ContentTypes, EImageOutputType } = require('librechat-data-provider');
const {
  logAxiosError,
  oaiToolkit,
  extractBaseURL,
  getProxyDispatcher,
  applyAxiosProxyConfig,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFiles } = require('~/models');

const displayMessage =
  "The tool displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";

/**
 * Replaces unwanted characters from the input string
 * @param {string} inputString - The input string to process
 * @returns {string} - The processed string
 */
function replaceUnwantedChars(inputString) {
  return inputString
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/"/g, '')
    .trim();
}

function returnValue(value) {
  if (typeof value === 'string') {
    return [value, {}];
  } else if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value;
    }
    return [displayMessage, value];
  }
  return value;
}

function createAbortHandler() {
  return function () {
    logger.debug('[ImageGenOAI] Image generation aborted');
  };
}

/**
 * Creates OpenAI Image tools (generation and editing)
 * @param {Object} fields - Configuration fields
 * @param {ServerRequest} fields.req - Whether the tool is being used in an agent context
 * @param {boolean} fields.isAgent - Whether the tool is being used in an agent context
 * @param {string} fields.IMAGE_GEN_OAI_API_KEY - The OpenAI API key
 * @param {boolean} [fields.override] - Whether to override the API key check, necessary for app initialization
 * @param {MongoFile[]} [fields.imageFiles] - The images to be used for editing
 * @param {string} [fields.imageOutputType] - The image output type configuration
 * @param {string} [fields.fileStrategy] - The file storage strategy
 * @returns {Array<ReturnType<tool>>} - Array of image tools
 */
function createOpenAIImageTools(fields = {}) {
  /** @type {boolean} Used to initialize the Tool without necessary variables. */
  const override = fields.override ?? false;
  /** @type {boolean} */
  if (!override && !fields.isAgent) {
    throw new Error('This tool is only available for agents.');
  }
  const { req } = fields;
  const imageOutputType = fields.imageOutputType || EImageOutputType.PNG;
  const appFileStrategy = fields.fileStrategy;

  const getApiKey = () => {
    const apiKey = process.env.IMAGE_GEN_OAI_API_KEY ?? '';
    if (!apiKey && !override) {
      throw new Error('Missing IMAGE_GEN_OAI_API_KEY environment variable.');
    }
    return apiKey;
  };

  let apiKey = fields.IMAGE_GEN_OAI_API_KEY ?? getApiKey();
  const closureConfig = { apiKey };

  const imageModel = process.env.IMAGE_GEN_OAI_MODEL || 'gpt-image-1';

  let baseURL = 'https://api.openai.com/v1/';
  if (!override && process.env.IMAGE_GEN_OAI_BASEURL) {
    baseURL = extractBaseURL(process.env.IMAGE_GEN_OAI_BASEURL);
    closureConfig.baseURL = baseURL;
  }

  // Note: Azure may not yet support the latest image generation models
  if (
    !override &&
    process.env.IMAGE_GEN_OAI_AZURE_API_VERSION &&
    process.env.IMAGE_GEN_OAI_BASEURL
  ) {
    baseURL = process.env.IMAGE_GEN_OAI_BASEURL;
    closureConfig.baseURL = baseURL;
    closureConfig.defaultQuery = { 'api-version': process.env.IMAGE_GEN_OAI_AZURE_API_VERSION };
    closureConfig.defaultHeaders = {
      'api-key': process.env.IMAGE_GEN_OAI_API_KEY,
      'Content-Type': 'application/json',
    };
    closureConfig.apiKey = process.env.IMAGE_GEN_OAI_API_KEY;
  }

  const imageFiles = fields.imageFiles ?? [];

  /**
   * Image Generation Tool
   */
  const imageGenTool = tool(
    async (
      {
        prompt,
        background = 'auto',
        n = 1,
        output_compression = 100,
        quality = 'auto',
        size = 'auto',
      },
      runnableConfig,
    ) => {
      if (!prompt) {
        throw new Error('Missing required field: prompt');
      }
      const clientConfig = { ...closureConfig };
      const proxyDispatcher = getProxyDispatcher();
      if (proxyDispatcher) {
        clientConfig.fetchOptions = {
          dispatcher: proxyDispatcher,
        };
      }

      /** @type {OpenAI} */
      const openai = new OpenAI(clientConfig);
      let output_format = imageOutputType;
      if (
        background === 'transparent' &&
        output_format !== EImageOutputType.PNG &&
        output_format !== EImageOutputType.WEBP
      ) {
        logger.warn(
          '[ImageGenOAI] Transparent background requires PNG or WebP format, defaulting to PNG',
        );
        output_format = EImageOutputType.PNG;
      }

      let resp;
      /** @type {AbortSignal} */
      let derivedSignal = null;
      /** @type {() => void} */
      let abortHandler = null;

      try {
        if (runnableConfig?.signal) {
          derivedSignal = AbortSignal.any([runnableConfig.signal]);
          abortHandler = createAbortHandler();
          derivedSignal.addEventListener('abort', abortHandler, { once: true });
        }

        resp = await openai.images.generate(
          {
            model: imageModel,
            prompt: replaceUnwantedChars(prompt),
            n: Math.min(Math.max(1, n), 10),
            background,
            output_format,
            output_compression:
              output_format === EImageOutputType.WEBP || output_format === EImageOutputType.JPEG
                ? output_compression
                : undefined,
            quality,
            size,
          },
          {
            signal: derivedSignal,
          },
        );
      } catch (error) {
        const message = '[image_gen_oai] Problem generating the image:';
        logAxiosError({ error, message });
        return returnValue(`Something went wrong when trying to generate the image. The OpenAI API may be unavailable:
Error Message: ${error.message}`);
      } finally {
        if (abortHandler && derivedSignal) {
          derivedSignal.removeEventListener('abort', abortHandler);
        }
      }

      if (!resp) {
        return returnValue(
          'Something went wrong when trying to generate the image. The OpenAI API may be unavailable',
        );
      }

      // For gpt-image-1, the response contains base64-encoded images
      // TODO: handle cost in `resp.usage`
      const base64Image = resp.data[0].b64_json;

      if (!base64Image) {
        return returnValue(
          'No image data returned from OpenAI API. There may be a problem with the API or your configuration.',
        );
      }

      const content = [
        {
          type: ContentTypes.IMAGE_URL,
          image_url: {
            url: `data:image/${output_format};base64,${base64Image}`,
          },
        },
      ];

      const file_ids = [v4()];
      const response = [
        {
          type: ContentTypes.TEXT,
          text: displayMessage + `\n\ngenerated_image_id: "${file_ids[0]}"`,
        },
      ];
      return [response, { content, file_ids }];
    },
    oaiToolkit.image_gen_oai,
  );

  /**
   * Image Editing Tool
   */
  const imageEditTool = tool(
    async ({ prompt, image_ids, quality = 'auto', size = 'auto' }, runnableConfig) => {
      if (!prompt) {
        throw new Error('Missing required field: prompt');
      }

      const clientConfig = { ...closureConfig };
      const proxyDispatcher = getProxyDispatcher();
      if (proxyDispatcher) {
        clientConfig.fetchOptions = {
          dispatcher: proxyDispatcher,
        };
      }

      const formData = new FormData();
      formData.append('model', imageModel);
      formData.append('prompt', replaceUnwantedChars(prompt));
      // TODO: `mask` support
      // TODO: more than 1 image support
      // formData.append('n', n.toString());
      formData.append('quality', quality);
      formData.append('size', size);

      /** @type {Record<FileSources, undefined | NodeStreamDownloader<File>>} */
      const streamMethods = {};

      const requestFilesMap = Object.fromEntries(imageFiles.map((f) => [f.file_id, { ...f }]));

      const orderedFiles = new Array(image_ids.length);
      const idsToFetch = [];
      const indexOfMissing = Object.create(null);

      for (let i = 0; i < image_ids.length; i++) {
        const id = image_ids[i];
        const file = requestFilesMap[id];

        if (file) {
          orderedFiles[i] = file;
        } else {
          idsToFetch.push(id);
          indexOfMissing[id] = i;
        }
      }

      if (idsToFetch.length) {
        const fetchedFiles = await getFiles(
          {
            user: req.user.id,
            file_id: { $in: idsToFetch },
            height: { $exists: true },
            width: { $exists: true },
          },
          {},
          {},
        );

        for (const file of fetchedFiles) {
          requestFilesMap[file.file_id] = file;
          orderedFiles[indexOfMissing[file.file_id]] = file;
        }
      }
      for (const imageFile of orderedFiles) {
        if (!imageFile) {
          continue;
        }
        /** @type {NodeStream<File>} */
        let stream;
        /** @type {NodeStreamDownloader<File>} */
        let getDownloadStream;
        const source = imageFile.source || appFileStrategy;
        if (!source) {
          throw new Error('No source found for image file');
        }
        if (streamMethods[source]) {
          getDownloadStream = streamMethods[source];
        } else {
          ({ getDownloadStream } = getStrategyFunctions(source));
          streamMethods[source] = getDownloadStream;
        }
        if (!getDownloadStream) {
          throw new Error(`No download stream method found for source: ${source}`);
        }
        stream = await getDownloadStream(req, imageFile.filepath);
        if (!stream) {
          throw new Error('Failed to get download stream for image file');
        }
        formData.append('image[]', stream, {
          filename: imageFile.filename,
          contentType: imageFile.type,
        });
      }

      /** @type {import('axios').RawAxiosHeaders} */
      let headers = {
        ...formData.getHeaders(),
      };

      if (process.env.IMAGE_GEN_OAI_AZURE_API_VERSION && process.env.IMAGE_GEN_OAI_BASEURL) {
        headers['api-key'] = apiKey;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      /** @type {AbortSignal} */
      let derivedSignal = null;
      /** @type {() => void} */
      let abortHandler = null;

      try {
        if (runnableConfig?.signal) {
          derivedSignal = AbortSignal.any([runnableConfig.signal]);
          abortHandler = createAbortHandler();
          derivedSignal.addEventListener('abort', abortHandler, { once: true });
        }

        /** @type {import('axios').AxiosRequestConfig} */
        const axiosConfig = {
          headers,
          ...clientConfig,
          signal: derivedSignal,
          baseURL,
        };

        applyAxiosProxyConfig(axiosConfig, baseURL);

        if (process.env.IMAGE_GEN_OAI_AZURE_API_VERSION && process.env.IMAGE_GEN_OAI_BASEURL) {
          axiosConfig.params = {
            'api-version': process.env.IMAGE_GEN_OAI_AZURE_API_VERSION,
            ...axiosConfig.params,
          };
        }
        const response = await axios.post('/images/edits', formData, axiosConfig);

        if (!response.data || !response.data.data || !response.data.data.length) {
          return returnValue(
            'No image data returned from OpenAI API. There may be a problem with the API or your configuration.',
          );
        }

        const base64Image = response.data.data[0].b64_json;
        if (!base64Image) {
          return returnValue(
            'No image data returned from OpenAI API. There may be a problem with the API or your configuration.',
          );
        }

        const content = [
          {
            type: ContentTypes.IMAGE_URL,
            image_url: {
              url: `data:image/${imageOutputType};base64,${base64Image}`,
            },
          },
        ];

        const file_ids = [v4()];
        const textResponse = [
          {
            type: ContentTypes.TEXT,
            text:
              displayMessage +
              `\n\ngenerated_image_id: "${file_ids[0]}"\nreferenced_image_ids: ["${image_ids.join('", "')}"]`,
          },
        ];
        return [textResponse, { content, file_ids }];
      } catch (error) {
        const message = '[image_edit_oai] Problem editing the image:';
        logAxiosError({ error, message });
        return returnValue(`Something went wrong when trying to edit the image. The OpenAI API may be unavailable:
Error Message: ${error.message || 'Unknown error'}`);
      } finally {
        if (abortHandler && derivedSignal) {
          derivedSignal.removeEventListener('abort', abortHandler);
        }
      }
    },
    oaiToolkit.image_edit_oai,
  );

  return [imageGenTool, imageEditTool];
}

module.exports = createOpenAIImageTools;
