const path = require('path');
const fs = require('fs').promises;
const paths = require('~/config/paths');

/**
 * Validates and sanitizes file paths to prevent path traversal attacks
 * @param {string} filePath - The file path to validate
 * @returns {string} - The validated and normalized path
 * @throws {Error} - If the path is invalid or outside uploads directory
 */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path provided');
  }

  // Normalize the path to resolve any .. or . segments
  const normalizedPath = path.normalize(filePath);
  const resolvedPath = path.resolve(normalizedPath);
  const resolvedAllowedDir = path.resolve(paths.uploads);

  // Check if the resolved path is within the allowed directory
  if (!resolvedPath.startsWith(resolvedAllowedDir)) {
    throw new Error('Path traversal attempt detected - file path outside allowed directory');
  }

  // Additional checks for suspicious patterns
  if (normalizedPath.includes('..') || normalizedPath.includes('~')) {
    throw new Error('Suspicious path pattern detected');
  }
  return resolvedPath;
}

/**
 * Safely reads a file with path validation
 * @param {string} filePath - The file path to read
 * @returns {Promise<Buffer>} - The file contents
 */
async function safeReadFile(filePath) {
  const validatedPath = validateFilePath(filePath, paths.uploads);
  return await fs.readFile(validatedPath);
}

/**
 * Safely deletes a file with path validation
 * @param {string} filePath - The file path to delete
 * @returns {Promise<void>}
 */
async function safeUnlink(filePath) {
  const validatedPath = validateFilePath(filePath, paths.uploads);
  return await fs.unlink(validatedPath);
}

module.exports = {
  validateFilePath,
  safeReadFile,
  safeUnlink,
};
