const axios = require('axios');
const {
  generateShortLivedToken,
  createVectorFileDeleter,
  createVectorFileUploader,
} = require('@librechat/api');

const deleteVectors = (req, file) =>
  createVectorFileDeleter({
    baseUrl: process.env.RAG_API_URL,
    httpClient: axios,
    generateToken: generateShortLivedToken,
    ownershipTrackingStart: req.config?.fileConfig?.vectorOwnershipTrackingStart,
    namespaceConcurrency: req.config?.fileConfig?.vectorDeletionConcurrency,
  })(req, file);

const uploadVectors = (params) =>
  createVectorFileUploader({
    baseUrl: process.env.RAG_API_URL,
    httpClient: axios,
    generateToken: generateShortLivedToken,
  })(params);

module.exports = {
  deleteVectors,
  uploadVectors,
};
