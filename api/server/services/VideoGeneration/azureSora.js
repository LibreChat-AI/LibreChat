const axios = require('axios');

const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 300000;

class AzureSoraClient {
  constructor({ resourceName, deploymentName, apiKey, apiVersion = '2025-04-01-preview' }) {
    this.baseUrl = `https://${resourceName}.openai.azure.com/openai/deployments/${deploymentName}`;
    this.apiKey = apiKey;
    this.apiVersion = apiVersion;
  }

  async createVideoGeneration({ prompt, n_seconds = 5, height = 480, width = 854 }) {
    const url = `${this.baseUrl}/videos/generations?api-version=${this.apiVersion}`;
    const response = await axios.post(
      url,
      { prompt, n_seconds, height, width },
      {
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  async getVideoGeneration(operationId) {
    const url = `${this.baseUrl}/videos/generations/${operationId}?api-version=${this.apiVersion}`;
    const response = await axios.get(url, {
      headers: { 'api-key': this.apiKey },
    });
    return response.data;
  }

  async deleteVideoGeneration(operationId) {
    const url = `${this.baseUrl}/videos/generations/${operationId}?api-version=${this.apiVersion}`;
    const response = await axios.delete(url, {
      headers: { 'api-key': this.apiKey },
    });
    return response.data;
  }

  async pollVideoGeneration(operationId, { interval = POLL_INTERVAL, timeout = POLL_TIMEOUT } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = await this.getVideoGeneration(operationId);
      if (result.status === 'succeeded') {
        return result;
      }
      if (result.status === 'failed' || result.status === 'cancelled') {
        const message = result.error?.message || 'Video generation failed';
        throw new Error(message);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('Video generation timed out');
  }
}

module.exports = AzureSoraClient;
