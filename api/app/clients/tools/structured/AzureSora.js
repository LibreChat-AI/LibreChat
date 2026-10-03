const { v4: uuidv4 } = require('uuid');
const { fetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');
const { getEnvProxyDispatcher, createMinimalRetentionRequest } = require('@librechat/api');
const { FileContext, ContentTypes } = require('librechat-data-provider');

const DEFAULT_API_VERSION = 'preview';
const DEFAULT_DEPLOYMENT = 'sora';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 600000;
/** Terminal job states per the Azure OpenAI video generation jobs API. */
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

const azureSoraJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 4000,
      description:
        'A text description of the desired video scene, up to 4000 characters. Describe the subject, action, setting, lighting, and camera motion in concrete detail.',
    },
    size: {
      type: 'string',
      enum: [
        '480x480',
        '854x480',
        '480x854',
        '720x720',
        '1280x720',
        '720x1280',
        '1080x1080',
        '1920x1080',
        '1080x1920',
      ],
      description:
        'The resolution of the generated video as WIDTHxHEIGHT. Use 1280x720 (landscape) by default, 720x1280 for portrait, or 480x480/720x720/1080x1080 for square. Higher resolutions (1080x1080, 1920x1080, 1080x1920) take longer to generate.',
    },
    n_seconds: {
      type: 'number',
      minimum: 1,
      maximum: 20,
      description:
        'The duration of the generated video in seconds, between 1 and 20. Default to 5 unless the user asks for a specific length.',
    },
  },
  required: ['prompt'],
};

const displayMessage =
  "Sora displayed a generated video. The video is already plainly visible in the chat, so don't repeat the prompt or describe it in detail. Do not list download links as they are available in the UI already.";

class AzureSora extends Tool {
  constructor(fields = {}) {
    super();
    /** @type {boolean} Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;

    this.userId = fields.userId;
    this.tenantId = fields.req?.user?.tenantId;
    this.retentionRequest = createMinimalRetentionRequest(fields.req);
    /** @type {boolean} */
    this.isAgent = fields.isAgent ?? true;
    if (fields.saveBase64Video) {
      /** @type {saveBase64Video} Injected so agent-run persistence stays with the run callbacks. */
      this.saveBase64Video = fields.saveBase64Video.bind(this);
    }
    if (this.isAgent) {
      /** Ensures LangChain maps [content, artifact] tuple to ToolMessage fields instead of serializing it into content. */
      this.responseFormat = 'content_and_artifact';
    }

    this.apiKey = fields.AZURE_SORA_API_KEY ?? process.env.AZURE_SORA_API_KEY ?? '';
    this.endpoint = this.normalizeEndpoint(
      fields.AZURE_SORA_ENDPOINT ?? process.env.AZURE_SORA_ENDPOINT ?? '',
    );
    if (!this.override) {
      if (!this.apiKey) {
        throw new Error('Missing AZURE_SORA_API_KEY environment variable.');
      }
      if (!this.endpoint) {
        throw new Error('Missing AZURE_SORA_ENDPOINT environment variable.');
      }
    }

    this.deployment = process.env.AZURE_SORA_DEPLOYMENT || DEFAULT_DEPLOYMENT;
    this.apiVersion = process.env.AZURE_SORA_API_VERSION || DEFAULT_API_VERSION;
    this.pollIntervalMs =
      Number(process.env.AZURE_SORA_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = Number(process.env.AZURE_SORA_POLL_TIMEOUT_MS) || DEFAULT_POLL_TIMEOUT_MS;

    const dispatcher = getEnvProxyDispatcher();
    /** @type {import('undici').RequestInit} */
    this.fetchOptions = dispatcher ? { dispatcher } : {};

    this.name = 'azure_sora';
    this.description =
      'Use Sora on Azure OpenAI to generate short videos from text descriptions. Video generation is asynchronous and can take a few minutes.';
    this.description_for_model = `// Whenever the user asks for a video, a clip, an animation, or a moving scene, use azure_sora to generate it.
// 1. Write one detailed prompt describing the shot: subject, action, setting, lighting, and camera motion.
// 2. Pick the size that matches the requested orientation; default to 1280x720 landscape.
// 3. Default to 5 seconds unless the user asks for a specific duration (1-20 seconds).
// 4. Do not repeat or refer to the prompt before or after generating; the video is displayed in the chat automatically.`;
    this.schema = azureSoraJsonSchema;
  }

  static get jsonSchema() {
    return azureSoraJsonSchema;
  }

  normalizeEndpoint(endpoint) {
    return endpoint.replace(/\/+$/, '');
  }

  replaceUnwantedChars(inputString) {
    return inputString
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/"/g, '')
      .trim();
  }

  getHeaders() {
    return {
      'api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  getJobsUrl(jobId) {
    const base = `${this.endpoint}/openai/v1/video/generations/jobs`;
    const path = jobId ? `${base}/${jobId}` : base;
    return `${path}?api-version=${encodeURIComponent(this.apiVersion)}`;
  }

  getContentUrl(generationId) {
    return `${this.endpoint}/openai/v1/video/generations/${generationId}/content/video?api-version=${encodeURIComponent(this.apiVersion)}`;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    } else if (this.isAgent === true && typeof value === 'object') {
      return [displayMessage, value];
    }

    return value;
  }

  async submitJob({ prompt, width, height, n_seconds }) {
    const response = await fetch(this.getJobsUrl(), {
      ...this.fetchOptions,
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        prompt,
        width,
        height,
        n_seconds,
        model: this.deployment,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Job submission failed with status ${response.status}: ${errorText}`);
    }
    return response.json();
  }

  async pollJob(jobId) {
    const startedAt = Date.now();
    let status = '';
    let job = null;
    while (!TERMINAL_STATES.has(status)) {
      if (Date.now() - startedAt > this.pollTimeoutMs) {
        throw new Error(
          `Timed out waiting for video generation job "${jobId}" after ${Math.round(this.pollTimeoutMs / 1000)}s.`,
        );
      }
      await this.sleep(this.pollIntervalMs);
      const response = await fetch(this.getJobsUrl(jobId), {
        ...this.fetchOptions,
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        logger.warn(`[AzureSora] Polling job "${jobId}" returned status ${response.status}`);
        continue;
      }
      job = await response.json();
      status = job?.status ?? '';
    }
    return job;
  }

  async downloadVideo(generationId) {
    const response = await fetch(this.getContentUrl(generationId), {
      ...this.fetchOptions,
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Video download failed with status ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async _call(data) {
    const { prompt, size = '1280x720', n_seconds = 5 } = data;
    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }
    if (!azureSoraJsonSchema.properties.size.enum.includes(size)) {
      throw new Error(
        `Invalid size "${size}". Must be one of: ${azureSoraJsonSchema.properties.size.enum.join(', ')}.`,
      );
    }
    const seconds = Math.round(Number(n_seconds));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 20) {
      throw new Error('Invalid n_seconds. Must be an integer between 1 and 20.');
    }
    const [width, height] = size.split('x').map(Number);

    let job;
    try {
      job = await this.submitJob({
        prompt: this.replaceUnwantedChars(prompt),
        width,
        height,
        n_seconds: seconds,
      });
    } catch (error) {
      logger.error('[AzureSora] Problem submitting the video generation job:', error);
      return this.returnValue(
        `Something went wrong when trying to generate the video. The Azure OpenAI API may be unavailable:\nError Message: ${error.message}`,
      );
    }

    const jobId = job?.id;
    if (!jobId) {
      return this.returnValue(
        'No job ID returned from the Azure OpenAI API. There may be a problem with the API or your configuration.',
      );
    }

    let finishedJob;
    try {
      finishedJob = await this.pollJob(jobId);
    } catch (error) {
      logger.error('[AzureSora] Problem polling the video generation job:', error);
      return this.returnValue(
        `Something went wrong while waiting for the video to finish generating:\nError Message: ${error.message}`,
      );
    }

    if (finishedJob.status !== 'succeeded') {
      const reason = finishedJob.failure_reason ?? finishedJob.status;
      return this.returnValue(
        `The video generation job did not succeed (${finishedJob.status}). Reason: ${reason}. The prompt may have triggered content filtering; try rephrasing it.`,
      );
    }

    const generationId = finishedJob.generations?.[0]?.id;
    if (!generationId) {
      return this.returnValue(
        'The video generation job succeeded but returned no generations. There may be a problem with the API or your configuration.',
      );
    }

    let videoBuffer;
    try {
      videoBuffer = await this.downloadVideo(generationId);
    } catch (error) {
      logger.error('[AzureSora] Problem downloading the generated video:', error);
      return this.returnValue(
        `Something went wrong when downloading the generated video:\nError Message: ${error.message}`,
      );
    }

    const base64 = videoBuffer.toString('base64');
    const dataUri = `data:video/mp4;base64,${base64}`;

    if (this.isAgent) {
      const file_ids = [uuidv4()];
      const content = [
        {
          type: ContentTypes.VIDEO_URL,
          video_url: {
            url: dataUri,
          },
        },
      ];
      const response = [
        {
          type: ContentTypes.TEXT,
          text: displayMessage,
        },
      ];
      return [response, { content, file_ids }];
    }

    try {
      const file = await this.saveBase64Video(dataUri, {
        req: this.retentionRequest,
        filename: `${this.name}_${uuidv4()}.mp4`,
        context: FileContext.video_generation,
      });
      this.result = `[Generated video](${file.filepath})`;
    } catch (error) {
      logger.error('[AzureSora] Error while saving the video:', error);
      this.result = `Failed to save the generated video. ${error.message}`;
    }

    return this.returnValue(this.result);
  }
}

module.exports = AzureSora;
