const DEFAULT_API_VERSION = 'preview';
const DEFAULT_DEPLOYMENT = 'sora';

function cleanEndpoint(endpoint) {
  return String(endpoint || '').replace(/\/+$/, '');
}

function buildJobSubmissionUrls({ endpoint, apiVersion, deploymentName }) {
  const base = cleanEndpoint(endpoint);
  const version = apiVersion || DEFAULT_API_VERSION;
  const deployment = deploymentName || DEFAULT_DEPLOYMENT;
  return [
    `${base}/openai/v1/video/generations/jobs?api-version=${version}`,
    `${base}/openai/deployments/${deployment}/video/generations/jobs?api-version=${version}`,
  ];
}

function buildJobStatusUrl({ endpoint, apiVersion, jobId }) {
  const base = cleanEndpoint(endpoint);
  const version = apiVersion || DEFAULT_API_VERSION;
  return `${base}/openai/v1/video/generations/jobs/${jobId}?api-version=${version}`;
}

function buildVideoContentUrl({ endpoint, apiVersion, jobId }) {
  const base = cleanEndpoint(endpoint);
  const version = apiVersion || DEFAULT_API_VERSION;
  return `${base}/openai/v1/video/generations/${jobId}/content/video?api-version=${version}`;
}

module.exports = {
  DEFAULT_API_VERSION,
  DEFAULT_DEPLOYMENT,
  cleanEndpoint,
  buildJobSubmissionUrls,
  buildJobStatusUrl,
  buildVideoContentUrl,
};
