const { fetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const { Tool } = require('@librechat/agents/langchain/tools');

const azureOpenAIHostSuffixes = [
  '.openai.azure.com',
  '.openai.azure.us',
  '.openai.azure.cn',
  '.cognitiveservices.azure.com',
];

const isAzureOpenAIEndpoint = (endpoint) => {
  try {
    const parsed = new URL(endpoint);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return (
      parsed.protocol === 'https:' &&
      azureOpenAIHostSuffixes.some((suffix) => hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
};

const azureSoraJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 4000,
      description:
        'A detailed text description of the desired video scene, subjects, movements, camera angles, and visual style.',
    },
    resolution: {
      type: 'string',
      enum: ['1280x720', '720x1280', '1920x1080', '1080x1920'],
      description:
        'Resolution for the generated video. Default is 1280x720 (widescreen). Use 720x1280 for mobile/vertical.',
    },
    duration: {
      type: 'integer',
      enum: [5, 10],
      description: 'Duration of the generated video clip in seconds. Supported values: 5 or 10. Default: 5.',
    },
    fps: {
      type: 'integer',
      enum: [24, 30],
      description: 'Frame rate for the generated video (24 or 30 fps). Default: 24.',
    },
  },
  required: ['prompt'],
};

class AzureSora extends Tool {
  static DEFAULT_API_VERSION = '2025-05-02-preview';
  static DEFAULT_RESOLUTION = '1280x720';
  static DEFAULT_DURATION = 5;
  static DEFAULT_FPS = 24;
  static POLLING_INTERVAL_MS = 3000;
  static MAX_POLLING_ATTEMPTS = 60; // 3 minutes timeout

  static get jsonSchema() {
    return azureSoraJsonSchema;
  }

  _initializeField(field, envVar, defaultValue) {
    return field || process.env[envVar] || defaultValue;
  }

  constructor(fields = {}) {
    super();
    this.name = 'azure-sora';
    this.description =
      "Use 'azure-sora' to generate high-definition video scenes and animations from text descriptions using OpenAI's Sora model on Azure OpenAI.";
    this.override = fields.override ?? false;
    this.schema = azureSoraJsonSchema;

    this.serviceEndpoint = this._initializeField(
      fields.AZURE_OPENAI_ENDPOINT || fields.AZURE_SORA_ENDPOINT,
      'AZURE_OPENAI_ENDPOINT',
    );

    this.apiKey = this._initializeField(
      fields.AZURE_OPENAI_API_KEY || fields.AZURE_SORA_API_KEY,
      'AZURE_OPENAI_API_KEY',
    );

    this.deploymentName = this._initializeField(
      fields.AZURE_OPENAI_SORA_DEPLOYMENT_NAME || fields.AZURE_SORA_DEPLOYMENT,
      'AZURE_OPENAI_SORA_DEPLOYMENT_NAME',
      'sora',
    );

    this.apiVersion = this._initializeField(
      fields.AZURE_OPENAI_API_VERSION,
      'AZURE_OPENAI_API_VERSION',
      AzureSora.DEFAULT_API_VERSION,
    );

    if (fields.userProvidedAuthFields?.has('AZURE_OPENAI_ENDPOINT') || fields.userProvidedAuthFields?.has('AZURE_SORA_ENDPOINT')) {
      if (this.serviceEndpoint && !isAzureOpenAIEndpoint(this.serviceEndpoint)) {
        throw new Error('User-provided Azure OpenAI endpoints must use a trusted Azure host.');
      }
    }

    if (!this.override) {
      if (!this.serviceEndpoint) {
        throw new Error('Missing AZURE_OPENAI_ENDPOINT environment variable or configuration.');
      }
      if (!this.apiKey) {
        throw new Error('Missing AZURE_OPENAI_API_KEY environment variable or configuration.');
      }
      if (!this.deploymentName) {
        throw new Error('Missing AZURE_OPENAI_SORA_DEPLOYMENT_NAME environment variable or configuration.');
      }
    }
  }

  getCleanEndpoint() {
    return this.serviceEndpoint.replace(/\/+$/, '');
  }

  async _call(data) {
    const {
      prompt,
      resolution = AzureSora.DEFAULT_RESOLUTION,
      duration = AzureSora.DEFAULT_DURATION,
      fps = AzureSora.DEFAULT_FPS,
    } = data;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return 'Error: A valid text prompt is required to generate a video with Sora.';
    }

    try {
      const endpoint = this.getCleanEndpoint();
      const createUrl = `${endpoint}/openai/deployments/${this.deploymentName}/videos/generations?api-version=${this.apiVersion}`;

      const [width, height] = resolution.split('x').map((n) => parseInt(n, 10));

      const payload = {
        prompt: prompt.trim(),
        width,
        height,
        duration,
        fps,
      };

      const response = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[AzureSora] Error creating video generation job:', errorText);
        return `Error creating video generation job (HTTP ${response.status}): ${errorText}`;
      }

      const jobData = await response.json();
      const jobId = jobData.id || jobData.job_id;

      if (!jobId) {
        return 'Error: Azure OpenAI Sora did not return a valid generation job ID.';
      }

      logger.info(`[AzureSora] Video generation job submitted successfully (ID: ${jobId}). Polling status...`);

      const videoResult = await this.pollJobCompletion(jobId);
      return videoResult;
    } catch (err) {
      logger.error('[AzureSora] Failed to generate video:', err);
      return `Error generating video with Azure Sora: ${err.message}`;
    }
  }

  async pollJobCompletion(jobId) {
    const endpoint = this.getCleanEndpoint();
    const pollUrl = `${endpoint}/openai/deployments/${this.deploymentName}/videos/generations/${jobId}?api-version=${this.apiVersion}`;

    for (let attempt = 1; attempt <= AzureSora.MAX_POLLING_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, AzureSora.POLLING_INTERVAL_MS));

      const pollResponse = await fetch(pollUrl, {
        method: 'GET',
        headers: {
          'api-key': this.apiKey,
        },
      });

      if (!pollResponse.ok) {
        const errText = await pollResponse.text();
        logger.warn(`[AzureSora] Polling attempt ${attempt} failed (HTTP ${pollResponse.status}): ${errText}`);
        continue;
      }

      const statusData = await pollResponse.json();
      const status = (statusData.status || '').toLowerCase();

      if (status === 'succeeded' || status === 'completed') {
        const videoUrl = statusData.video_url || statusData.result?.video_url || statusData.output_url;
        if (!videoUrl) {
          return 'Video generation completed, but no downloadable video URL was returned.';
        }

        return `### 🎬 Video Generated with Azure Sora\n\n**Prompt:** *${statusData.prompt || 'Generated Scene'}*\n\n[▶ Download / View Video](${videoUrl})\n\n<video controls width="100%" src="${videoUrl}" preload="metadata">\n  Your browser does not support the video tag. [Click here to download](${videoUrl})\n</video>`;
      }

      if (status === 'failed' || status === 'cancelled') {
        const errorReason = statusData.error?.message || statusData.failure_reason || 'Unknown error occurred during generation.';
        return `Video generation ${status}: ${errorReason}`;
      }

      logger.debug(`[AzureSora] Job ${jobId} status: ${status} (attempt ${attempt}/${AzureSora.MAX_POLLING_ATTEMPTS})`);
    }

    return `Video generation timed out after ${AzureSora.MAX_POLLING_ATTEMPTS * (AzureSora.POLLING_INTERVAL_MS / 1000)} seconds. Job ID: ${jobId}`;
  }
}

module.exports = AzureSora;
