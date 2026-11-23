#!/usr/bin/env node
/**
 * Fails when the Click UI pin in the ClickHouse theme lags the latest stable
 * `@clickhouse/click-ui` release. Needs the npm registry, so it is a manual
 * check and not part of `static-checks`; the pin's shape is covered offline by
 * `clickui.spec.ts`.
 *
 *   npm run clickui:drift
 *
 * To re-pin, follow the refresh steps in `clickui.spec.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pinPath = fileURLToPath(
  new URL('../packages/client/src/theme/themes/clickui.json', import.meta.url),
);
const registry = 'https://registry.npmjs.org/@clickhouse%2fclick-ui/latest';

const { tag } = JSON.parse(readFileSync(pinPath, 'utf8')) as { tag: string };
const response = await fetch(registry);
if (!response.ok) {
  console.error(`Registry request failed: ${response.status}`);
  process.exit(2);
}
const { version } = (await response.json()) as { version: string };

if (tag !== `v${version}`) {
  console.error(`clickui.json is pinned to ${tag}; latest stable is v${version}.`);
  process.exit(1);
}
console.log(`clickui.json is current at ${tag}.`);
