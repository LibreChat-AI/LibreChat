const path = require('path');
const express = require('express');
const expressStaticGzip = require('express-static-gzip');

const oneDayInSeconds = 24 * 60 * 60;

const sMaxAge = process.env.STATIC_CACHE_S_MAX_AGE || oneDayInSeconds;
const maxAge = process.env.STATIC_CACHE_MAX_AGE || oneDayInSeconds * 2;
const isEnabled = (value) => value === true || String(value).toLowerCase() === 'true';

/**
 * Creates an Express static middleware with optional precompressed asset serving and configurable caching
 *
 * @param {string} staticPath - The file system path to serve static files from
 * @param {Object} [options={}] - Configuration options
 * @param {boolean} [options.noCache=false] - If true, disables caching entirely for all files
 * @param {boolean} [options.skipGzipScan=false] - If true, skips expressStaticGzip middleware
 * @returns {ReturnType<expressStaticGzip>|ReturnType<express.static>} Express middleware function for serving static files
 */
function staticCache(staticPath, options = {}) {
  const { noCache = false, skipGzipScan = false } = options;
  const enableBrotli = isEnabled(process.env.ENABLE_STATIC_ASSET_BROTLI);

  const setHeaders = (res, filePath) => {
    if (res.locals?.privateImageCache) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Vary', 'Cookie');
      return;
    }
    if (process.env.NODE_ENV?.toLowerCase() !== 'production') {
      return;
    }
    if (noCache) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return;
    }
    if (filePath && filePath.includes('/dist/images/')) {
      return;
    }
    const fileName = filePath ? path.basename(filePath) : '';

    if (
      fileName === 'index.html' ||
      fileName.endsWith('.webmanifest') ||
      fileName === 'manifest.json' ||
      fileName === 'sw.js' ||
      fileName === 'sw-heal.js'
    ) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', `public, max-age=${maxAge}, s-maxage=${sMaxAge}`);
    }
  };

  if (skipGzipScan) {
    return express.static(staticPath, {
      setHeaders,
      index: false,
    });
  } else {
    return expressStaticGzip(staticPath, {
      enableBrotli,
      orderPreference: enableBrotli ? ['br', 'gz'] : ['gz'],
      setHeaders,
      index: false,
    });
  }
}

module.exports = staticCache;
