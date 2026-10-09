import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';
import { expect } from '@playwright/test';
import { configSchema } from 'librechat-data-provider';
import type { APIRequestContext } from '@playwright/test';
import type {
  FiltersConfig,
  MessageFilterConfig,
  MessageFilterPiiConfig,
} from 'librechat-data-provider';
import { getPrimaryE2EUser } from '../../setup/users.mock';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const GENERATED_CONFIG_ROOT = path.join(PROJECT_ROOT, 'e2e/.generated');
const RELOAD_SENTINEL = `e2e-content-filter-reload-${process.pid}-${randomUUID()}`;
const RELOAD_SENTINEL_PATH = `/api/admin/config/user/${encodeURIComponent(RELOAD_SENTINEL)}`;
const RELOAD_PRIORITY = 10;

type RequestFetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

type RuntimeConfig = {
  filters?: FiltersConfig;
  messageFilter?: MessageFilterConfig;
  [key: string]: unknown;
};

type BaselineState = {
  configPath: string;
  contents: Buffer;
  mode: number;
};

export type RequestResult = {
  ok: boolean;
  status: number;
  text: string;
  body: unknown;
};

export type RequestResultOptions = {
  path: string;
  token?: string;
  method?: string;
  data?: RequestFetchOptions['data'];
  multipart?: RequestFetchOptions['multipart'];
};

export type ContentFilterBlockExpectation = {
  source: string;
  field: string;
  marker: string;
};

let baselineState: BaselineState | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function getRuntimeConfigPath(): string {
  const configuredPath = process.env.CONFIG_PATH?.trim();
  if (!configuredPath) {
    throw new Error('CONFIG_PATH must be set for content-filter e2e tests');
  }

  const configPath = path.resolve(configuredPath);
  if (!isWithin(GENERATED_CONFIG_ROOT, configPath) || configPath === GENERATED_CONFIG_ROOT) {
    throw new Error(
      `Refusing to modify CONFIG_PATH outside ${GENERATED_CONFIG_ROOT}: ${configPath}`,
    );
  }

  const generatedRootStat = fs.lstatSync(GENERATED_CONFIG_ROOT);
  if (!generatedRootStat.isDirectory() || generatedRootStat.isSymbolicLink()) {
    throw new Error(`Expected a non-symlink generated config directory: ${GENERATED_CONFIG_ROOT}`);
  }

  const configStat = fs.lstatSync(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw new Error(`Expected a non-symlink generated config file: ${configPath}`);
  }

  const realGeneratedRoot = fs.realpathSync(GENERATED_CONFIG_ROOT);
  const realConfigDirectory = fs.realpathSync(path.dirname(configPath));
  if (!isWithin(realGeneratedRoot, realConfigDirectory)) {
    throw new Error(`Refusing to modify CONFIG_PATH through an external directory: ${configPath}`);
  }

  return configPath;
}

function parseRuntimeConfig(contents: Buffer): RuntimeConfig {
  const parsed = yaml.load(contents.toString('utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Generated LibreChat config must contain a YAML object');
  }
  return parsed as RuntimeConfig;
}

function captureBaseline(): BaselineState {
  const configPath = getRuntimeConfigPath();
  if (baselineState) {
    if (baselineState.configPath !== configPath) {
      throw new Error('CONFIG_PATH changed while a content-filter baseline was active');
    }
    return baselineState;
  }

  const contents = fs.readFileSync(configPath);
  const config = parseRuntimeConfig(contents);
  if (Object.prototype.hasOwnProperty.call(config, 'filters')) {
    throw new Error('Content-filter e2e baseline must not define filters');
  }

  baselineState = {
    configPath,
    contents,
    mode: fs.statSync(configPath).mode & 0o777,
  };
  return baselineState;
}

function validateRuntimeConfig(config: RuntimeConfig): void {
  const result = configSchema.strict().safeParse(config);
  if (result.success) {
    return;
  }

  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid generated LibreChat config: ${issues}`);
}

function atomicWrite(state: BaselineState, contents: string | Buffer): void {
  const currentPath = getRuntimeConfigPath();
  if (currentPath !== state.configPath) {
    throw new Error('CONFIG_PATH changed before the generated config write');
  }

  const temporaryPath = path.join(
    path.dirname(state.configPath),
    `.${path.basename(state.configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporaryPath, contents, { mode: state.mode });
    fs.renameSync(temporaryPath, state.configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getConfigFromResult(result: RequestResult): RuntimeConfig {
  expect(result.ok, `Expected base-config request to succeed: ${result.text}`).toBe(true);
  if (!isRecord(result.body) || !isRecord(result.body.config)) {
    throw new Error(`Expected base-config response to contain a config object: ${result.text}`);
  }
  return result.body.config as RuntimeConfig;
}

async function triggerConfigReload(request: APIRequestContext, token: string): Promise<void> {
  const result = await requestResult(request, {
    path: RELOAD_SENTINEL_PATH,
    token,
    method: 'PUT',
    data: { overrides: {}, priority: RELOAD_PRIORITY },
  });

  expect(result.ok, `Expected config reload trigger to succeed: ${result.text}`).toBe(true);
  expect(result.body, result.text).toEqual(
    expect.objectContaining({
      config: expect.objectContaining({ principalId: RELOAD_SENTINEL }),
    }),
  );
}

async function getLoadedConfig(
  request: APIRequestContext,
  token: string,
  baseOnly: boolean,
): Promise<RuntimeConfig> {
  const result = await requestResult(request, {
    path: `/api/admin/config/base${baseOnly ? '?baseOnly=true' : ''}`,
    token,
  });
  return getConfigFromResult(result);
}

async function getLoadedProtectionState(
  request: APIRequestContext,
  token: string,
): Promise<{
  base: Pick<RuntimeConfig, 'filters' | 'messageFilter'>;
  effective: Pick<RuntimeConfig, 'filters' | 'messageFilter'>;
}> {
  const [baseConfig, effectiveConfig] = await Promise.all([
    getLoadedConfig(request, token, true),
    getLoadedConfig(request, token, false),
  ]);
  return {
    base: { filters: baseConfig.filters, messageFilter: baseConfig.messageFilter },
    effective: {
      filters: effectiveConfig.filters,
      messageFilter: effectiveConfig.messageFilter,
    },
  };
}

async function deleteReloadSentinel(request: APIRequestContext, token: string): Promise<void> {
  const result = await requestResult(request, {
    path: RELOAD_SENTINEL_PATH,
    token,
    method: 'DELETE',
  });
  expect([200, 404], `Expected reload sentinel cleanup to succeed: ${result.text}`).toContain(
    result.status,
  );
}

export async function loginAdmin(request: APIRequestContext): Promise<string> {
  const { email, password } = getPrimaryE2EUser();
  const response = await request.post('/api/auth/login', {
    data: { email, password },
    failOnStatusCode: false,
  });
  const ok = response.ok();
  const status = response.status();
  const text = await response.text();
  await response.dispose();
  const body = parseResponseBody(text);

  if (!ok) {
    throw new Error(`Admin login failed with status ${status}`);
  }
  if (!isRecord(body) || typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('Admin login response did not include an access token');
  }
  return body.token;
}

export async function requestResult(
  request: APIRequestContext,
  options: RequestResultOptions,
): Promise<RequestResult> {
  if (options.data !== undefined && options.multipart !== undefined) {
    throw new Error('requestResult accepts either data or multipart, not both');
  }

  const fetchOptions: RequestFetchOptions = {
    method: options.method ?? 'GET',
    failOnStatusCode: false,
  };
  if (options.token?.trim()) {
    fetchOptions.headers = { Authorization: `Bearer ${options.token}` };
  }
  if (options.data !== undefined) {
    fetchOptions.data = options.data;
  }
  if (options.multipart !== undefined) {
    fetchOptions.multipart = options.multipart;
  }

  const response = await request.fetch(options.path, fetchOptions);
  const result: RequestResult = {
    ok: response.ok(),
    status: response.status(),
    text: await response.text(),
    body: null,
  };
  result.body = parseResponseBody(result.text);
  await response.dispose();
  return result;
}

export async function setRuntimeFilters(
  request: APIRequestContext,
  token: string,
  filters: FiltersConfig,
): Promise<void> {
  const baseline = captureBaseline();
  const config = { ...parseRuntimeConfig(baseline.contents), filters };
  validateRuntimeConfig(config);
  atomicWrite(baseline, yaml.dump(config, { noRefs: true, lineWidth: 120 }));

  await triggerConfigReload(request, token);
  await expect
    .poll(async () => getLoadedProtectionState(request, token), {
      timeout: 30000,
      intervals: [100, 250, 500, 1000],
    })
    .toEqual({
      base: { filters, messageFilter: config.messageFilter },
      effective: { filters, messageFilter: config.messageFilter },
    });
}

export async function setRuntimeMessageFilterPii(
  request: APIRequestContext,
  token: string,
  pii: MessageFilterPiiConfig,
): Promise<void> {
  const baseline = captureBaseline();
  const baselineConfig = parseRuntimeConfig(baseline.contents);
  const messageFilter = { ...baselineConfig.messageFilter, pii };
  const config = { ...baselineConfig, messageFilter };
  validateRuntimeConfig(config);
  atomicWrite(baseline, yaml.dump(config, { noRefs: true, lineWidth: 120 }));

  await triggerConfigReload(request, token);
  await expect
    .poll(async () => getLoadedProtectionState(request, token), {
      timeout: 30000,
      intervals: [100, 250, 500, 1000],
    })
    .toEqual({
      base: { filters: baselineConfig.filters, messageFilter },
      effective: { filters: baselineConfig.filters, messageFilter },
    });
}

export async function restoreRuntimeFilters(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const baseline = captureBaseline();
  const baselineConfig = parseRuntimeConfig(baseline.contents);
  atomicWrite(baseline, baseline.contents);

  try {
    await triggerConfigReload(request, token);
    await expect
      .poll(async () => getLoadedProtectionState(request, token), {
        timeout: 30000,
        intervals: [100, 250, 500, 1000],
      })
      .toEqual({
        base: {
          filters: baselineConfig.filters,
          messageFilter: baselineConfig.messageFilter,
        },
        effective: {
          filters: baselineConfig.filters,
          messageFilter: baselineConfig.messageFilter,
        },
      });
  } finally {
    await deleteReloadSentinel(request, token);
  }

  baselineState = undefined;
}

export function expectContentFilterBlock(
  result: RequestResult,
  expectation: ContentFilterBlockExpectation,
): void {
  expect(result.status).toBe(400);
  expect(result.body).toEqual(
    expect.objectContaining({
      error: 'content_filter_block',
      source: expectation.source,
      field: expectation.field,
    }),
  );
  expect(result.text).not.toContain(expectation.marker);
}
