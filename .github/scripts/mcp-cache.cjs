// TEMPORARY post-failure capture; remove before merge. Never runs a source transform.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const out = path.join(process.env.RUNNER_TEMP, 'mcp-transform-capture');
const report = { actualWorkerKeys: null, resolution: 'post-failure Node only', entries: [] };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
fs.mkdirSync(out, { recursive: true });
async function capture() {
  const spec = fs.realpathSync('src/hooks/MCP/__tests__/useMCPServerManager.spec.tsx');
  const results =
    process.env.MCP_RESULTS_PATH ?? path.resolve('../jest-results/jest-results-client-2.json');
  report.status = 'missing-results';
  if (!fs.existsSync(results)) return;
  report.status = 'target-did-not-fail';
  if (!json(results).testResults.some((r) => r.name === spec && r.status === 'failed')) return;
  report.provenance = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    cacheKey: process.env.MCP_CACHE_KEY,
    cacheHit: process.env.MCP_CACHE_HIT,
    lockSha256: sha(fs.readFileSync('../package-lock.json')),
  };
  const client = createRequire(path.resolve('package.json'));
  const jest = createRequire(client.resolve('jest'));
  const runtime = createRequire(jest.resolve('jest-runtime'));
  const { configs, globalConfig } = await jest('jest-config').readConfigs(
    { _: [], $0: 'jest', ci: true },
    [process.cwd()],
  );
  const [config] = configs;
  const babel = createRequire(config.transform[0][1]);
  report.packages = ['jest', 'babel-jest', '@babel/core'].map((name) => {
    const from = name === 'jest' ? client : babel;
    const file = from.resolve(name);
    return {
      name,
      file,
      version: from(`${name}/package.json`).version,
      entrySha256: sha(fs.readFileSync(file)),
    };
  });
  report.transformVersion = runtime('@jest/transform/package.json').version;
  report.transformEntry = runtime.resolve('@jest/transform');
  report.transformEntrySha256 = sha(fs.readFileSync(report.transformEntry));
  report.status = 'unsupported-Jest-version';
  if (report.transformVersion !== '30.2.0' || report.packages[0].version !== '30.2.0') return;
  const { createScriptTransformer, shouldInstrument } = runtime('@jest/transform');
  const transformer = await createScriptTransformer(config);
  for (const [name, file] of [
    ['spec', spec],
    ['hook', fs.realpathSync('src/hooks/MCP/useMCPServerManager.ts')],
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    const options = {
      instrument:
        globalConfig.coverageProvider === 'babel' && shouldInstrument(file, globalConfig, config),
      supportsDynamicImport: typeof require('node:vm').SourceTextModule === 'function',
      supportsExportNamespaceFrom: false,
      supportsStaticESM: false,
      supportsTopLevelAwait: false,
    };
    const row = { name, file, sourceSha256: sha(source), options, status: 'reconstructed-only' };
    report.entries.push(row);
    const cache = transformer._getFileCachePath(file, source, options);
    row.cache = cache;
    row.status = 'missing-cache-or-map';
    if (!fs.existsSync(cache) || !fs.existsSync(`${cache}.map`)) continue;
    row.status = 'size-limit';
    if ([cache, `${cache}.map`].some((p) => fs.statSync(p).size > 2097152)) continue;
    const code = fs.readFileSync(cache);
    const map = fs.readFileSync(`${cache}.map`);
    row.codeSha256 = sha(code);
    row.mapSha256 = sha(map);
    const checksum = createHash('sha1').update(code.subarray(33)).digest('hex').slice(0, 32);
    row.checksumValid = code[32] === 10 && code.toString('utf8', 0, 32) === checksum;
    const content = JSON.parse(map).sourcesContent;
    row.mapMatchesSource = content?.length === 1 && sha(content[0]) === sha(source);
    row.status = 'checksum-or-source-mismatch';
    if (!row.checksumValid || !row.mapMatchesSource) continue;
    fs.copyFileSync(cache, path.join(out, `${name}.cache`));
    fs.copyFileSync(`${cache}.map`, path.join(out, `${name}.cache.map`));
    row.status = 'copied-reconstructed-entry';
  }
  report.status = 'root-reconstruction-not-worker-witness';
}
capture()
  .catch(() => {
    report.status = 'collector-error';
    process.exitCode = 1;
  })
  .finally(() => {
    fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  });
