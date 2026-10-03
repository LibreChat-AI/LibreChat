const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const { ContentTypes, FileContext } = require('librechat-data-provider');
const {
  DEFAULT_API_VERSION,
  DEFAULT_DEPLOYMENT,
  buildJobSubmissionUrls,
  buildJobStatusUrl,
  buildVideoContentUrl,
} = require('./azureSoraUrls');

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const ALLOWED_SIZES = ['1280x720', '720x1280'];
const ALLOWED_SECONDS = ['4', '8', '12'];

const displayMessage =
  'The tool generated a video from the text prompt. The generated video is already plainly visible to the user, so do not repeat the prompt or describe the video contents in detail.';

const azureSoraJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 2000,
      description:
        'Detailed natural-language description of the video scene to generate, including subject, motion, camera movement and mood.',
    },
    size: {
      type: 'string',
      enum: ALLOWED_SIZES,
      description:
        'Resolution of the generated video. 1280x720 is landscape (default), 720x1280 is portrait.',
    },
    seconds: {
      type: 'string',
      enum: ALLOWED_SECONDS,
      description: 'Length of the generated video in seconds. One of 4 (default), 8 or 12.',
    },
  },
  required: ['prompt'],
};

class AzureSora extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;
    this.userId = fields.userId;
    this.req = fields.req;
    this.isAgent = fields.isAgent;
    if (this.isAgent) {
      this.responseFormat = 'content_and_artifact';
    }
    if (fields.processFileURL) {
      this.processFileURL = fields.processFileURL.bind(this);
    }
    this.fileStrategy = fields.fileStrategy;

    this.name = 'video_gen_sora_azure';
    this.description =
      'Generates a short video from a detailed text prompt using Azure OpenAI Sora. Use this when the user explicitly asks to create, generate or make a video.';
    this.schema = azureSoraJsonSchema;

    this.apiKey =
      fields.AZURE_SORA_API_KEY ||
      process.env.AZURE_SORA_API_KEY ||
      process.env.AZURE_API_KEY ||
      '';
    this.endpoint =
      fields.AZURE_SORA_ENDPOINT ||
      process.env.AZURE_SORA_ENDPOINT ||
      process.env.AZURE_OPENAI_ENDPOINT ||
      '';
    this.apiVersion = process.env.AZURE_SORA_API_VERSION || DEFAULT_API_VERSION;
    this.deploymentName = process.env.AZURE_SORA_DEPLOYMENT_NAME || DEFAULT_DEPLOYMENT;
    this.pollIntervalMs = Number(process.env.AZURE_SORA_POLL_INTERVAL_MS) || POLL_INTERVAL_MS;

    if (!this.override && (!this.apiKey || !this.endpoint)) {
      throw new Error(
        'Azure Sora is not configured. Set AZURE_SORA_API_KEY and AZURE_SORA_ENDPOINT (or AZURE_API_KEY / AZURE_OPENAI_ENDPOINT).',
      );
    }
  }

  async submitJob(prompt, size, seconds) {
    const payload = {
      model: this.deploymentName,
      prompt,
      size,
      seconds,
    };
    let lastError;
    for (const url of buildJobSubmissionUrls({
      endpoint: this.endpoint,
      apiVersion: this.apiVersion,
      deploymentName: this.deploymentName,
    })) {
      try {
        logger.debug(`[AzureSora] Submitting video generation job to ${url}`);
        const response = await axios.post(url, payload, {
          headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json' },
          timeout: 30000,
        });
        return response.data;
      } catch (error) {
        lastError = error;
        logger.warn(`[AzureSora] Job submission failed for ${url}: ${error.message}`);
      }
    }
    throw new Error(
      `Failed to submit the video generation job to Azure OpenAI: ${lastError?.message || 'unknown error'}`,
    );
  }

  async pollJobUntilComplete(jobId) {
    const statusUrl = buildJobStatusUrl({
      endpoint: this.endpoint,
      apiVersion: this.apiVersion,
      jobId,
    });
    const startTime = Date.now();
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      let data;
      try {
        const response = await axios.get(statusUrl, {
          headers: { 'api-key': this.apiKey },
          timeout: 15000,
        });
        data = response.data;
      } catch (error) {
        logger.warn(`[AzureSora] Poll request failed, retrying: ${error.message}`);
        continue;
      }
      const status = data?.status;
      logger.debug(`[AzureSora] Job ${jobId} status: ${status}`);
      if (status === 'succeeded') {
        return jobId;
      }
      if (status === 'failed' || status === 'cancelled') {
        const message =
          data?.error?.message || `Video generation ended with status "${status}"`;
        throw new Error(`Azure Sora generation failed: ${message}`);
      }
    }
    throw new Error('Azure Sora video generation timed out.');
  }

  async downloadVideo(jobId) {
    const contentUrl = buildVideoContentUrl({
      endpoint: this.endpoint,
      apiVersion: this.apiVersion,
      jobId,
    });
    const response = await axios.get(contentUrl, {
      headers: { 'api-key': this.apiKey },
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: MAX_VIDEO_BYTES,
      maxBodyLength: MAX_VIDEO_BYTES,
    });
    const videoBuffer = Buffer.from(response.data);
    if (videoBuffer.length > MAX_VIDEO_BYTES) {
      throw new Error(`Azure Sora video exceeds the ${MAX_VIDEO_BYTES} byte download limit.`);
    }
    return videoBuffer;
  }

  async _call({ prompt, size = '1280x720', seconds = '4' }) {
    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }
    if (!this.apiKey || !this.endpoint) {
      throw new Error(
        'Azure Sora is not configured. Set AZURE_SORA_API_KEY and AZURE_SORA_ENDPOINT (or AZURE_API_KEY / AZURE_OPENAI_ENDPOINT).',
      );
    }

    const job = await this.submitJob(prompt, size, seconds);
    const jobId = job?.id;
    if (!jobId) {
      throw new Error('Azure Sora did not return a job id.');
    }

    await this.pollJobUntilComplete(jobId);
    const videoBuffer = await this.downloadVideo(jobId);
    const dataUri = `data:video/mp4;base64,${videoBuffer.toString('base64')}`;

    if (this.processFileURL) {
      try {
        const fileRecord = await this.processFileURL({
          URL: dataUri,
          basePath: 'files',
          userId: this.userId,
          fileName: `vid-${jobId}.mp4`,
          fileStrategy: this.fileStrategy,
          context: FileContext.video_generation,
          req: this.req,
        });
        const file_id = fileRecord?.file_id;
        const content = [
          {
            type: ContentTypes.VIDEO_URL,
            video_url: { url: fileRecord?.filepath || dataUri },
          },
        ];
        const textResponse = [
          {
            type: ContentTypes.TEXT,
            text: `${displayMessage}\ngenerated_video_id: "${file_id || jobId}"`,
          },
        ];
        return [textResponse, { content, file_ids: file_id ? [file_id] : [] }];
      } catch (error) {
        logger.error('[AzureSora] Failed to save the video file:', error);
      }
    }

    const content = [
      {
        type: ContentTypes.VIDEO_URL,
        video_url: { url: dataUri },
      },
    ];
    const textResponse = [{ type: ContentTypes.TEXT, text: displayMessage }];
    return [textResponse, { content }];
  }
}

const createAzureSoraTool = (fields = {}) => new AzureSora(fields);

module.exports = AzureSora;
module.exports.AzureSora = AzureSora;
module.exports.createAzureSoraTool = createAzureSoraTool;
module.exports.buildJobSubmissionUrls = buildJobSubmissionUrls;
module.exports.buildJobStatusUrl = buildJobStatusUrl;
module.exports.buildVideoContentUrl = buildVideoContentUrl;
module.exports.azureSoraJsonSchema = azureSoraJsonSchema;
