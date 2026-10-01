const axios = require('axios');
const { v4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { ContentTypes } = require('librechat-data-provider');
const { logAxiosError, oaiToolkit } = require('@librechat/api');

const displayMessage =
  "The tool displayed a video. The generated video is already plainly visible, so don't repeat the description in detail. Do not list download links as they are available in the UI already.";

function createAzureSoraTools(fields = {}) {
  const {
    AZURE_SORA_API_KEY,
    AZURE_SORA_ENDPOINT,
    isAgent,
    req,
    fileStrategy,
    processFileURL,
  } = fields;

  const apiKey = AZURE_SORA_API_KEY || process.env.AZURE_SORA_API_KEY || process.env.AZURE_API_KEY;
  const endpoint = AZURE_SORA_ENDPOINT || process.env.AZURE_SORA_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_BASEURL;
  const apiVersion = process.env.AZURE_SORA_API_VERSION || '2024-04-01-preview';
  const deploymentName = process.env.AZURE_SORA_DEPLOYMENT_NAME || 'sora-2';

  const videoGenTool = tool(
    async ({ prompt, duration = 5, resolution = '1080p', aspect_ratio = '16:9', fps = 30 }) => {
      if (!prompt) {
        throw new Error('Missing required field: prompt');
      }

      if (!apiKey || !endpoint) {
        throw new Error('Azure Sora credentials (API Key or Endpoint) are not configured.');
      }

      const cleanEndpoint = endpoint.replace(/\/+$/, '');
      const urlsToTry = [];
      if (cleanEndpoint.endsWith('/videos') || cleanEndpoint.endsWith('/videos/submissions')) {
        urlsToTry.push(cleanEndpoint);
      } else {
        urlsToTry.push(`${cleanEndpoint}/openai/deployments/${deploymentName}/videos/submissions?api-version=${apiVersion}`);
        urlsToTry.push(`${cleanEndpoint}/openai/deployments/${deploymentName}/videos?api-version=${apiVersion}`);
        urlsToTry.push(`${cleanEndpoint}/videos/submissions?api-version=${apiVersion}`);
        urlsToTry.push(`${cleanEndpoint}/videos?api-version=${apiVersion}`);
      }

      let response;
      let lastError;
      for (const url of urlsToTry) {
        try {
          logger.debug(`[AzureSora] Submitting video generation job to: ${url}`);
          response = await axios.post(
            url,
            {
              model: deploymentName,
              prompt,
              size: aspect_ratio === '16:9' ? '1280x720' : (aspect_ratio === '9:16' ? '720x1280' : '1024x1024'),
              seconds: duration.toString(),
            },
            {
              headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
              },
              timeout: 15000,
            }
          );
          break;
        } catch (error) {
          lastError = error;
          logAxiosError({ error, message: `[AzureSora] Failed submission attempt for URL: ${url}` });
        }
      }

      if (!response) {
        throw new Error(`Failed to submit video generation job to Azure: ${lastError?.message || 'Unknown error'}`);
      }

      let pollUrl = response.headers['operation-location'] || response.headers['Operation-Location'];
      const jobId = response.data?.id || response.data?.job_id || response.data?.jobId;

      if (!pollUrl && jobId) {
        pollUrl = cleanEndpoint.endsWith('/videos') || cleanEndpoint.endsWith('/videos/submissions')
          ? `${cleanEndpoint}/${jobId}?api-version=${apiVersion}`
          : `${cleanEndpoint}/openai/deployments/${deploymentName}/videos/${jobId}?api-version=${apiVersion}`;
      }

      if (!pollUrl) {
        throw new Error('Azure Sora response did not return an operation location or job ID.');
      }

      logger.debug(`[AzureSora] Polling status from: ${pollUrl}`);
      let status = 'pending';
      let videoUrl;
      const startTime = Date.now();
      const timeoutMs = 180000;

      while (status !== 'succeeded' && status !== 'failed') {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error('Video generation request timed out after 3 minutes.');
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));

        try {
          const pollResponse = await axios.get(pollUrl, {
            headers: {
              'api-key': apiKey,
            },
            timeout: 10000,
          });

          status = pollResponse.data?.status || 'pending';
          logger.debug(`[AzureSora] Polling status: ${status}`);

          if (status === 'succeeded') {
            videoUrl = pollResponse.data?.output?.video_url || pollResponse.data?.output?.url || pollResponse.data?.video_url || pollResponse.data?.url;
          } else if (status === 'failed') {
            const errorMsg = pollResponse.data?.error?.message || 'Unknown error during video generation';
            throw new Error(`Azure Sora generation failed: ${errorMsg}`);
          }
        } catch (error) {
          logger.error('[AzureSora] Error polling job status:', error);
          if (error.message.includes('failed')) {
            throw error;
          }
        }
      }

      if (!videoUrl) {
        throw new Error('Video generation succeeded but no video URL was returned.');
      }

      const videoName = `vid-${v4()}.mp4`;
      logger.debug(`[AzureSora] Saving video from: ${videoUrl} as ${videoName}`);

      let fileRecord;
      try {
        fileRecord = await processFileURL({
          URL: videoUrl,
          basePath: 'files',
          userId: fields.userId,
          fileName: videoName,
          fileStrategy,
          context: 'image_generation',
          req,
        });
      } catch (error) {
        logger.error('[AzureSora] Error saving the video file:', error);
        throw new Error(`Failed to save the video file: ${error.message}`);
      }

      const file_ids = [fileRecord.file_id];
      const content = [
        {
          type: ContentTypes.TEXT,
          text: `[Video generated successfully](${fileRecord.filepath})`,
        },
      ];

      const textResponse = [
        {
          type: ContentTypes.TEXT,
          text: displayMessage + `\n\ngenerated_video_id: "${file_ids[0]}"`,
        },
      ];

      return [textResponse, { content, file_ids }];
    },
    oaiToolkit.video_gen_sora_azure
  );

  return [videoGenTool];
}

module.exports = createAzureSoraTools;
