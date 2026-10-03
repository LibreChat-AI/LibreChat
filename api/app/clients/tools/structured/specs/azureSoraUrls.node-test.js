const assert = require('assert');
const {
  buildJobSubmissionUrls,
  buildJobStatusUrl,
  buildVideoContentUrl,
} = require('../azureSoraUrls');

const endpoint = 'https://demo.openai.azure.com/';
const urls = buildJobSubmissionUrls({
  endpoint,
  apiVersion: 'preview',
  deploymentName: 'sora',
});
assert.deepStrictEqual(urls, [
  'https://demo.openai.azure.com/openai/v1/video/generations/jobs?api-version=preview',
  'https://demo.openai.azure.com/openai/deployments/sora/video/generations/jobs?api-version=preview',
]);
assert.strictEqual(
  buildJobStatusUrl({ endpoint, apiVersion: 'preview', jobId: 'job-1' }),
  'https://demo.openai.azure.com/openai/v1/video/generations/jobs/job-1?api-version=preview',
);
assert.strictEqual(
  buildVideoContentUrl({ endpoint, apiVersion: 'preview', jobId: 'job-1' }),
  'https://demo.openai.azure.com/openai/v1/video/generations/job-1/content/video?api-version=preview',
);
console.log('azureSoraUrls.node-test ok');
