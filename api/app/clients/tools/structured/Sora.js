const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fetch = globalThis.fetch ?? require('undici').fetch;
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const {
  extractBaseURL,
  getProxyDispatcher,
  getEnvProxyDispatcher,
  createMinimalRetentionRequest,
} = require('@librechat/api');
const { FileContext, ContentTypes } = require('librechat-data-provider');

const soraJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 4000,
      description:
        'A detailed natural language description of the video scene to generate.',
    },
    size: {
      type: 'string',
      enum: ['1280x720', '720x1280', '1920x1080', '1080x1920'],
      description:
        'Resolution of the video. Default is 1280x720 (landscape). Use 720x1280 for portrait.',
    },
    duration: {
      type: 'number',
      enum: [5, 10],
      description: 'Duration of the generated video in seconds (5 or 10). Default is 5.',
    },
  },
  required: ['prompt'],
};

const displayMessage =
  "Sora generated a video. The video is displayed directly in the chat preview. Do not repeat the prompt description in detail.";

class Sora extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;
    this.returnMetadata = fields.returnMetadata ?? false;
    this.userId = fields.userId;
    this.tenantId = fields.req?.user?.tenantId;
    this.retentionRequest = createMinimalRetentionRequest(fields.req);
    this.fileStrategy = fields.fileStrategy;
    this.isAgent = fields.isAgent;

    if (this.isAgent) {
      this.responseFormat = 'content_and_artifact';
    }
    if (fields.processFileURL) {
      this.processFileURL = fields.processFileURL.bind(this);
    }

    this.apiKey =
      fields.SORA_API_KEY ??
      fields.AZURE_OPENAI_API_KEY ??
      process.env.SORA_API_KEY ??
      process.env.AZURE_OPENAI_API_KEY ??
      process.env.OPENAI_API_KEY ??
      '';

    if (!this.apiKey && !this.override) {
      throw new Error('Missing SORA_API_KEY or AZURE_OPENAI_API_KEY environment variable.');
    }

    this.baseURL =
      fields.SORA_BASEURL ??
      process.env.SORA_BASEURL ??
      process.env.AZURE_OPENAI_BASEURL ??
      (process.env.SORA_REVERSE_PROXY ? extractBaseURL(process.env.SORA_REVERSE_PROXY) : 'https://api.openai.com/v1');

    this.apiVersion =
      fields.SORA_AZURE_API_VERSION ??
      process.env.SORA_AZURE_API_VERSION ??
      process.env.AZURE_OPENAI_API_VERSION ??
      '2025-05-01-preview';

    this.model = fields.model ?? process.env.SORA_MODEL ?? 'sora';
    this.pollInterval = fields.pollInterval ?? 2500;
    this.pollTimeout = fields.pollTimeout ?? 180000;

    this.name = 'sora';
    this.description = `Use Sora to generate video scenes from detailed natural language descriptions via Azure OpenAI or OpenAI.
    - Specify scene details, motion, lighting, and camera movement in the prompt.
    - Optional parameters include size ('1280x720', '720x1280', '1920x1080', '1080x1920') and duration in seconds (5 or 10).`;
    this.schema = soraJsonSchema;
  }

  static get jsonSchema() {
    return soraJsonSchema;
  }

  replaceUnwantedChars(inputString) {
    return inputString
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/"/g, '')
      .trim();
  }

  wrapInMarkdown(videoUrl) {
    return `[Generated Video](${videoUrl})\n\n<video controls src="${videoUrl}" width="100%"></video>`;
  }

  getHeaders() {
    const isAzure = Boolean(this.apiVersion && this.baseURL.includes('openai.azure.com'));
    const headers = {
      'Content-Type': 'application/json',
    };
    if (isAzure) {
      headers['api-key'] = this.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  getJobUrl(jobId) {
    const isAzure = Boolean(this.apiVersion && this.baseURL.includes('openai.azure.com'));
    const base = this.baseURL.replace(/\/+$/, '');
    if (jobId) {
      return isAzure
        ? `${base}/openai/v1/video/generations/jobs/${jobId}?api-version=${this.apiVersion}`
        : `${base}/video/generations/jobs/${jobId}`;
    }
    return isAzure
      ? `${base}/openai/v1/video/generations/jobs?api-version=${this.apiVersion}`
      : `${base}/video/generations/jobs`;
  }

  async pollJob(jobId, fetchOptions = {}) {
    const startTime = Date.now();
    const pollUrl = this.getJobUrl(jobId);

    while (Date.now() - startTime < this.pollTimeout) {
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));

      const res = await fetch(pollUrl, {
        method: 'GET',
        headers: this.getHeaders(),
        ...fetchOptions,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to check video generation job status: ${res.status} ${errorText}`);
      }

      const data = await res.json();
      const status = data.status?.toLowerCase();

      if (status === 'succeeded' || status === 'completed') {
        const videoUrl =
          data.generations?.[0]?.url ??
          data.output?.url ??
          data.result?.url ??
          data.url;
        if (!videoUrl) {
          throw new Error('Video generation succeeded but no download URL was returned.');
        }
        return videoUrl;
      }

      if (status === 'failed' || status === 'cancelled') {
        const errorMsg = data.error?.message ?? data.failure_reason ?? 'Video generation failed.';
        throw new Error(errorMsg);
      }
    }

    throw new Error(`Video generation timed out after ${this.pollTimeout / 1000} seconds.`);
  }

  async _call(data) {
    const { prompt, size = '1280x720', duration = 5 } = data;
    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }

    const fetchOptions = {};
    const proxyDispatcher = getProxyDispatcher() || getEnvProxyDispatcher();
    if (proxyDispatcher) {
      fetchOptions.dispatcher = proxyDispatcher;
    }

    const payload = {
      prompt: this.replaceUnwantedChars(prompt),
      model: this.model,
      size,
      duration: Number(duration),
    };

    let startRes;
    try {
      startRes = await fetch(this.getJobUrl(), {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        ...fetchOptions,
      });
    } catch (error) {
      logger.error('[Sora] Error initiating video generation job:', error);
      return this.returnValue(
        `Failed to connect to video generation service: ${error.message}`,
      );
    }

    if (!startRes.ok) {
      const errText = await startRes.text();
      logger.error('[Sora] Video job creation failed:', { status: startRes.status, errText });
      return this.returnValue(
        `Video generation request failed (${startRes.status}): ${errText}`,
      );
    }

    const jobData = await startRes.json();
    const jobId = jobData.id;

    if (!jobId) {
      // In case synchronous URL was returned directly
      const directUrl = jobData.generations?.[0]?.url || jobData.url;
      if (directUrl) {
        return this.handleCompletedVideo(directUrl, fetchOptions);
      }
      return this.returnValue('No job ID returned from video generation service.');
    }

    let theVideoUrl;
    try {
      theVideoUrl = await this.pollJob(jobId, fetchOptions);
    } catch (pollError) {
      logger.error('[Sora] Error during video generation polling:', pollError);
      return this.returnValue(`Error generating video: ${pollError.message}`);
    }

    return this.handleCompletedVideo(theVideoUrl, fetchOptions);
  }

  async handleCompletedVideo(theVideoUrl, fetchOptions = {}) {
    if (this.isAgent) {
      const content = [
        {
          type: ContentTypes.VIDEO_URL,
          video_url: {
            url: theVideoUrl,
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

    const videoName = `video-${uuidv4()}.mp4`;

    if (this.processFileURL) {
      try {
        const result = await this.processFileURL({
          URL: theVideoUrl,
          basePath: 'videos',
          userId: this.userId,
          fileName: videoName,
          fileStrategy: this.fileStrategy,
          context: FileContext.video_generation ?? 'video_generation',
          tenantId: this.tenantId,
          req: this.retentionRequest,
        });

        if (this.returnMetadata) {
          this.result = result;
        } else {
          this.result = this.wrapInMarkdown(result.filepath ?? theVideoUrl);
        }
      } catch (saveError) {
        logger.error('[Sora] Error saving video file locally:', saveError);
        this.result = this.wrapInMarkdown(theVideoUrl);
      }
    } else {
      this.result = this.wrapInMarkdown(theVideoUrl);
    }

    return this.returnValue(this.result);
  }
}

module.exports = Sora;
