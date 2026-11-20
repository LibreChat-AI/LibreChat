import fs from 'fs';
import path from 'path';
import { buildAgentsOpenApiDocument } from './document';

/** Run from the package root (`npm run -w @librechat/api openapi:...`), so cwd is packages/api. */
const SPEC_PATH = path.resolve(process.cwd(), 'openapi', 'agents.openapi.json');

function render(): string {
  return JSON.stringify(buildAgentsOpenApiDocument(), null, 2) + '\n';
}

function write(): void {
  const json = render();
  fs.mkdirSync(path.dirname(SPEC_PATH), { recursive: true });
  fs.writeFileSync(SPEC_PATH, json);
  console.log(`Wrote ${SPEC_PATH}`);
}

function check(): void {
  const json = render();
  const existing = fs.existsSync(SPEC_PATH) ? fs.readFileSync(SPEC_PATH, 'utf8') : '';
  if (existing !== json) {
    console.error(
      'The committed OpenAPI spec does not match the code. Run: npm run -w @librechat/api openapi:generate',
    );
    process.exit(1);
  }
  console.log('The committed OpenAPI spec matches the code.');
}

if (process.argv.includes('--write')) {
  write();
} else if (process.argv.includes('--check')) {
  check();
} else {
  console.error('Pass --write or --check.');
  process.exit(2);
}
