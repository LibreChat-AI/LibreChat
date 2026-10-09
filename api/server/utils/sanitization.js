const escapeHtml = require('escape-html');

/**
 * Sanitizes HTML content to prevent XSS attacks
 * @param {string} input - The input string to sanitize
 * @returns {string} - The sanitized string
 */
function sanitizeHtml(input) {
  if (typeof input !== 'string') {
    return '';
  }
  return escapeHtml(input).replace(/\//g, '&#x2F;');
}

/**
 * Sanitizes JSON data before sending as response
 * @param {any} data - The data to sanitize
 * @returns {any} - The sanitized data
 */
function sanitizeJsonResponse(data) {
  if (typeof data === 'string') {
    return sanitizeHtml(data);
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeJsonResponse);
  }

  if (data && typeof data === 'object') {
    if (data.constructor && data.constructor.name === 'ObjectId') {
      return data.toString();
    }
    if (Buffer.isBuffer(data)) {
      return data.toString();
    }
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[sanitizeHtml(key)] = sanitizeJsonResponse(value);
    }
    return sanitized;
  }

  return data;
}

module.exports = {
  sanitizeJsonResponse,
};
