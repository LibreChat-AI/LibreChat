const { createFileProvisionRecovery } = require('@librechat/api');
const db = require('~/models');

let storage;
const getFileStorage = () =>
  (storage ??= {
    recovery: createFileProvisionRecovery(),
    acquireFileProvision: db.acquireFileProvision,
    releaseFileProvision: db.releaseFileProvision,
    commitFileProvision: db.commitFileProvision,
    acquireFileDeletion: db.acquireFileDeletion,
    releaseFileDeletion: db.releaseFileDeletion,
  });

module.exports = { getFileStorage };
