const librechatApi = require('@librechat/api');
const { GenerationJobManager } = librechatApi;
const {
  acquireSubagentThreadLease,
  renewSubagentThreadLease,
  releaseSubagentThreadLease,
} = require('~/models');

let acquireLease;

function acquireEventChildGenerationLease(input) {
  acquireLease ??= librechatApi.createEventChildGenerationLeaseAcquirer({
    methods: {
      acquireSubagentThreadLease,
      renewSubagentThreadLease,
      releaseSubagentThreadLease,
    },
    abortGeneration: (streamId, options) => GenerationJobManager.abortJob(streamId, options),
  });

  return acquireLease(input);
}

module.exports = { acquireEventChildGenerationLease };
