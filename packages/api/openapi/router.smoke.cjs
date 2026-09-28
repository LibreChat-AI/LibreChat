const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const swaggerUiDist = require('swagger-ui-dist');

const packageRoot = path.resolve(__dirname, '..');
const bundlePath = path.join(packageRoot, 'dist', 'index.cjs');
const specPath = path.join(packageRoot, 'dist', 'agents.openapi.json');

assert.ok(fs.existsSync(bundlePath), 'Build packages/api before running this smoke test');
assert.ok(fs.existsSync(specPath), 'The packages/api build must include agents.openapi.json');

const { createOpenApiRouter } = require(bundlePath);
const swaggerAssetsPath = swaggerUiDist.getAbsoluteFSPath();
const expectedSpec = fs.readFileSync(specPath);

function createApp(openapi) {
  const app = express();
  const getAppConfig = async (options) => {
    assert.deepEqual(options, { baseOnly: true });
    return openapi === undefined ? { config: {} } : { config: { openapi } };
  };

  for (const prefix of ['/api', '/chat/api']) {
    app.use(prefix, createOpenApiRouter({ getAppConfig, swaggerAssetsPath }));
  }

  return app;
}

async function withServer(openapi, run) {
  const server = http.createServer(createApp(openapi));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error == null ? resolve() : reject(error)));
    });
  }
}

async function assertNotFound(baseUrl, pathname) {
  const response = await fetch(baseUrl + pathname);
  assert.equal(response.status, 404, `${pathname} should be disabled`);
  assert.deepEqual(await response.json(), { message: 'Not Found' });
}

function runInitializer(html, pathname) {
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, 'Docs HTML should include an inline initializer');

  let onDOMContentLoaded;
  let swaggerOptions;
  const appended = [];
  const document = {
    createElement(tagName) {
      return { tagName };
    },
    head: {
      appendChild(element) {
        appended.push(element);
      },
    },
    body: {
      appendChild(element) {
        appended.push(element);
        element.onload?.();
      },
    },
  };
  const window = {
    addEventListener(eventName, listener) {
      assert.equal(eventName, 'DOMContentLoaded');
      onDOMContentLoaded = listener;
    },
  };
  const SwaggerUIBundle = (options) => {
    swaggerOptions = options;
    return { options };
  };

  vm.runInNewContext(inlineScript, {
    document,
    location: { pathname },
    SwaggerUIBundle,
    window,
  });
  assert.equal(typeof onDOMContentLoaded, 'function');
  onDOMContentLoaded();

  return { appended, swaggerOptions };
}

async function assertEnabled(baseUrl, prefix) {
  const specResponse = await fetch(`${baseUrl}${prefix}/openapi.json`);
  assert.equal(specResponse.status, 200);
  assert.match(specResponse.headers.get('content-type') ?? '', /^application\/json\b/);
  assert.deepEqual(Buffer.from(await specResponse.arrayBuffer()), expectedSpec);

  for (const suffix of ['/docs', '/docs/']) {
    const pathname = prefix + suffix;
    const docsResponse = await fetch(baseUrl + pathname);
    assert.equal(docsResponse.status, 200);
    assert.match(docsResponse.headers.get('content-type') ?? '', /^text\/html\b/);

    const { appended, swaggerOptions } = runInitializer(await docsResponse.text(), pathname);
    assert.equal(appended.length, 2);
    assert.deepEqual(
      { rel: appended[0].rel, href: appended[0].href },
      { rel: 'stylesheet', href: `${prefix}/docs/assets/swagger-ui.css` },
    );
    assert.equal(appended[1].src, `${prefix}/docs/assets/swagger-ui-bundle.js`);
    assert.deepEqual(Object.keys(swaggerOptions).sort(), ['dom_id', 'url', 'validatorUrl']);
    assert.equal(swaggerOptions.url, `${prefix}/openapi.json`);
    assert.equal(swaggerOptions.dom_id, '#swagger-ui');
    assert.equal(swaggerOptions.validatorUrl, null);
  }

  for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
    const assetResponse = await fetch(`${baseUrl}${prefix}/docs/assets/${asset}`);
    assert.equal(assetResponse.status, 200);
    assert.deepEqual(
      Buffer.from(await assetResponse.arrayBuffer()),
      fs.readFileSync(path.join(swaggerAssetsPath, asset)),
    );
  }
}

async function main() {
  for (const openapi of [undefined, { enabled: false }]) {
    await withServer(openapi, async (baseUrl) => {
      for (const prefix of ['/api', '/chat/api']) {
        await assertNotFound(baseUrl, `${prefix}/openapi.json`);
        await assertNotFound(baseUrl, `${prefix}/docs`);
        await assertNotFound(baseUrl, `${prefix}/docs/assets/swagger-ui.css`);
      }
    });
  }

  await withServer({ enabled: true }, async (baseUrl) => {
    for (const prefix of ['/api', '/chat/api']) {
      await assertEnabled(baseUrl, prefix);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
