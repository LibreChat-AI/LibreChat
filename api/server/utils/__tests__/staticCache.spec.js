const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const zlib = require('zlib');
const staticCache = require('../staticCache');

const binaryParser = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('staticCache', () => {
  let app;
  let testDir;
  let testFile;
  let indexFile;
  let manifestFile;
  let swFile;

  beforeAll(() => {
    // Create a test directory and files
    testDir = path.join(__dirname, 'test-static');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Create test files
    testFile = path.join(testDir, 'test.js');
    indexFile = path.join(testDir, 'index.html');
    manifestFile = path.join(testDir, 'manifest.json');
    swFile = path.join(testDir, 'sw.js');

    const jsContent = 'console.log("test");';
    const htmlContent = '<html><body>Test</body></html>';
    const jsonContent = '{"name": "test"}';
    const swContent = 'self.addEventListener("install", () => {});';

    fs.writeFileSync(testFile, jsContent);
    fs.writeFileSync(indexFile, htmlContent);
    fs.writeFileSync(manifestFile, jsonContent);
    fs.writeFileSync(swFile, swContent);

    // Create precompressed versions of some files
    fs.writeFileSync(testFile + '.gz', zlib.gzipSync(jsContent));
    fs.writeFileSync(testFile + '.br', zlib.brotliCompressSync(jsContent));
    fs.writeFileSync(path.join(testDir, 'test.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(testDir, 'test.css.gz'), zlib.gzipSync('body { color: red; }'));
    fs.writeFileSync(
      path.join(testDir, 'test.css.br'),
      zlib.brotliCompressSync('body { color: red; }'),
    );

    // Create a file that only exists in gzipped form
    fs.writeFileSync(
      path.join(testDir, 'only-gzipped.js.gz'),
      zlib.gzipSync('console.log("only gzipped");'),
    );

    // Create a subdirectory for dist/images testing
    const distImagesDir = path.join(testDir, 'dist', 'images');
    fs.mkdirSync(distImagesDir, { recursive: true });
    fs.writeFileSync(path.join(distImagesDir, 'logo.png'), 'fake-png-data');
  });

  afterAll(() => {
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    app = express();

    // Clear environment variables
    delete process.env.NODE_ENV;
    delete process.env.STATIC_CACHE_S_MAX_AGE;
    delete process.env.STATIC_CACHE_MAX_AGE;
    delete process.env.ENABLE_STATIC_ASSET_BROTLI;
  });
  describe('cache headers in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should set standard cache headers for regular files', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
    });

    it('should set no-cache headers for index.html', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/index.html').expect(200);

      expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    });

    it('should set no-cache headers for manifest.json', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/manifest.json').expect(200);

      expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    });

    it('should set no-cache headers for sw.js', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/sw.js').expect(200);

      expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    });

    it('should not set cache headers for /dist/images/ files', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/dist/images/logo.png').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=0');
    });

    it('should set no-cache headers when noCache option is true', async () => {
      app.use(staticCache(testDir, { noCache: true }));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    });

    it('should prevent shared caching when authorization marks an image private', async () => {
      app.use((_req, res, next) => {
        res.locals.privateImageCache = true;
        next();
      });
      app.use(staticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.vary).toBe('Cookie');
    });
  });

  describe('cache headers in non-production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('should not set cache headers in development', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      // Our middleware should not set cache-control in non-production
      // Express static might set its own default headers
      const cacheControl = response.headers['cache-control'];
      expect(cacheControl).toBe('public, max-age=0');
    });
  });

  describe('environment variable configuration', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should use custom s-maxage from environment', async () => {
      process.env.STATIC_CACHE_S_MAX_AGE = '3600';

      // Need to re-require to pick up new env vars
      jest.resetModules();
      const freshStaticCache = require('../staticCache');

      app.use(freshStaticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=3600');
    });

    it('should use custom max-age from environment', async () => {
      process.env.STATIC_CACHE_MAX_AGE = '7200';

      // Need to re-require to pick up new env vars
      jest.resetModules();
      const freshStaticCache = require('../staticCache');

      app.use(freshStaticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=7200, s-maxage=86400');
    });

    it('should use both custom values from environment', async () => {
      process.env.STATIC_CACHE_S_MAX_AGE = '1800';
      process.env.STATIC_CACHE_MAX_AGE = '3600';

      // Need to re-require to pick up new env vars
      jest.resetModules();
      const freshStaticCache = require('../staticCache');

      app.use(freshStaticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=3600, s-maxage=1800');
    });
  });

  describe('express-static-gzip behavior', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should serve Brotli files when client accepts Brotli encoding', async () => {
      process.env.ENABLE_STATIC_ASSET_BROTLI = 'true';
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'br, gzip, deflate')
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(response.headers['content-encoding']).toBe('br');
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
      expect(zlib.brotliDecompressSync(response.body).toString()).toBe('console.log("test");');
    });

    it('should prefer Brotli over gzip when both encodings are accepted', async () => {
      process.env.ENABLE_STATIC_ASSET_BROTLI = 'true';
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.css')
        .set('Accept-Encoding', 'gzip, br')
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(response.headers['content-encoding']).toBe('br');
      expect(response.headers['content-type']).toMatch(/css/);
      expect(zlib.brotliDecompressSync(response.body).toString()).toBe('body { color: red; }');
    });

    it('should keep serving gzip when Brotli is not enabled', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'br, gzip, deflate')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.text).toBe('console.log("test");');
    });

    it('should serve gzipped files when client accepts gzip encoding', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'gzip, deflate')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
      // Content should be decompressed by supertest
      expect(response.text).toBe('console.log("test");');
    });

    it('should fall back to uncompressed files when client does not accept gzip', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'identity')
        .expect(200);

      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(response.text).toBe('console.log("test");');
    });

    it('should serve gzipped CSS files with correct content-type', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.css')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['content-type']).toMatch(/css/);
      expect(response.text).toBe('body { color: red; }');
    });

    it('should serve uncompressed files when no gzipped version exists', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/manifest.json')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.text).toBe('{"name": "test"}');
    });

    it('should handle files that only exist in gzipped form', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/only-gzipped.js')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(response.text).toBe('console.log("only gzipped");');
    });

    it('should return 404 for gzip-only files when client does not accept gzip', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/only-gzipped.js')
        .set('Accept-Encoding', 'identity');
      expect(response.status).toBe(404);
    });

    it('should handle cache headers correctly for gzipped content', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
      expect(response.headers['content-type']).toMatch(/javascript/);
    });

    it('should preserve original MIME types for gzipped files', async () => {
      app.use(staticCache(testDir, { skipGzipScan: false }));

      const jsResponse = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      const cssResponse = await request(app)
        .get('/test.css')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(jsResponse.headers['content-type']).toMatch(/javascript/);
      expect(cssResponse.headers['content-type']).toMatch(/css/);
      expect(jsResponse.headers['content-encoding']).toBe('gzip');
      expect(cssResponse.headers['content-encoding']).toBe('gzip');
    });
  });

  describe('skipGzipScan option comparison', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should use express.static (no gzip) when skipGzipScan is true', async () => {
      app.use(staticCache(testDir, { skipGzipScan: true }));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      // Should NOT serve gzipped version even though client accepts it
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
      expect(response.text).toBe('console.log("test");');
    });

    it('should use expressStaticGzip when skipGzipScan is false', async () => {
      app.use(staticCache(testDir));

      const response = await request(app)
        .get('/test.js')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      // Should serve gzipped version when client accepts it
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
      expect(response.text).toBe('console.log("test");');
    });
  });

  describe('file serving', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should serve files correctly', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/test.js').expect(200);

      expect(response.text).toBe('console.log("test");');
      expect(response.headers['content-type']).toMatch(/javascript|text/);
    });

    it('should return 404 for non-existent files', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/nonexistent.js');
      expect(response.status).toBe(404);
    });

    it('should serve HTML files', async () => {
      app.use(staticCache(testDir));

      const response = await request(app).get('/index.html').expect(200);

      expect(response.text).toBe('<html><body>Test</body></html>');
      expect(response.headers['content-type']).toMatch(/html/);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should handle webmanifest files', async () => {
      // Create a webmanifest file
      const webmanifestFile = path.join(testDir, 'site.webmanifest');
      fs.writeFileSync(webmanifestFile, '{"name": "test app"}');

      app.use(staticCache(testDir));

      const response = await request(app).get('/site.webmanifest').expect(200);

      expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');

      // Clean up
      fs.unlinkSync(webmanifestFile);
    });

    it('should handle files in subdirectories', async () => {
      const subDir = path.join(testDir, 'subdir');
      fs.mkdirSync(subDir, { recursive: true });
      const subFile = path.join(subDir, 'nested.js');
      fs.writeFileSync(subFile, 'console.log("nested");');

      app.use(staticCache(testDir));

      const response = await request(app).get('/subdir/nested.js').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=172800, s-maxage=86400');
      expect(response.text).toBe('console.log("nested");');

      // Clean up
      fs.rmSync(subDir, { recursive: true, force: true });
    });
  });
});
