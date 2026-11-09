import { test } from 'node:test';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
// js-yaml is a dependency of packages/api, not of the root manifest.
const { load } = createRequire(new URL('../packages/api/package.json', import.meta.url))('js-yaml');

/**
 * Podman has no default registry, so a name without a registry host ("mongo:8.0.20",
 * "pgvector/pgvector:0.8.0") is a short name and fails to resolve unless the host
 * configures `unqualified-search-registries`. Docker applies the same host test and
 * then falls back to Docker Hub, which is why only Podman users see the error.
 */
const hasRegistry = (ref) => /^([^/]*[.:][^/]*|localhost)\//.test(ref);

/** The image Compose uses when `${VAR:-default}` is unset, or null when it cannot be known. */
function resolve(value) {
  const withDefault = /^\$\{\w+:?-(.*)\}$/.exec(value);
  if (withDefault) return withDefault[1];
  return value.includes('$') ? null : value;
}

/** Images a compose file pulls. A service with `build` only names the tag it builds. */
function composeImages(text) {
  const services = load(text)?.services ?? {};
  return Object.entries(services).flatMap(([name, service]) => {
    const local = service?.build != null;
    const ref = typeof service?.image === 'string' && !local ? resolve(service.image) : null;
    return ref == null ? [] : [{ at: name, ref }];
  });
}

/** `# image:` lines in a template users copy from. A `build:` on the next line marks a local tag. */
function commentedImages(text) {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const match = /^#(\s+)image:\s*(\S+)\s*$/.exec(line);
    if (!match || lines[i + 1]?.startsWith(`#${match[1]}build:`)) return [];
    return [{ at: 'commented', ref: match[2].replace(/^["']|["']$/g, '') }];
  });
}

/** External images a Dockerfile pulls: FROM and COPY --from, minus stages, scratch and build args. */
function dockerfileImages(text) {
  const stages = new Set();
  const refs = [];
  const pull = (at, ref) => {
    const name = ref.toLowerCase();
    if (stages.has(name) || name === 'scratch' || /^\d+$/.test(name) || ref.includes('$')) return;
    refs.push({ at, ref });
  };
  for (const line of text.split('\n')) {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      pull('FROM', from[1]);
      if (from[2]) stages.add(from[2].toLowerCase());
      continue;
    }
    const copy = /^\s*COPY\s.*?--from=(\S+)/i.exec(line);
    if (copy) pull('COPY --from', copy[1]);
  }
  return refs;
}

test('hasRegistry applies the host rule Docker and Podman share', () => {
  const qualified = [
    'docker.io/library/mongo:8.0.20',
    'docker.io/pgvector/pgvector:0.8.0-pg15-trixie',
    'docker.io/library/golang:1.26.10-alpine3.24@sha256:abc',
    'registry.librechat.ai/librechat-ai/librechat:latest',
    'ghcr.io/astral-sh/uv:0.9.5',
    'localhost/librechat:local',
    'localhost:5000/librechat',
  ];
  const short = [
    'mongo',
    'mongo:8.0.20',
    'getmeili/meilisearch:v1.35.1',
    'pgvector/pgvector:0.8.0-pg15-trixie',
    'node:24.22.1-alpine',
  ];
  for (const ref of qualified) assert.ok(hasRegistry(ref), ref);
  for (const ref of short) assert.ok(!hasRegistry(ref), ref);
});

test('composeImages skips local builds and judges the default of an unset variable', () => {
  const text = [
    'services:',
    '  db:',
    '    image: mongo:8.0.20',
    '  search:',
    '    image: docker.io/getmeili/meilisearch:v1.35.1',
    '  api:',
    '    image: librechat:local',
    '    build: .',
    '  cache:',
    '    image: ${CACHE_IMAGE:-redis:7-alpine}',
    '  proxy:',
    '    image: ${PROXY_IMAGE}',
    '  bare:',
  ].join('\n');
  assert.deepEqual(composeImages(text), [
    { at: 'db', ref: 'mongo:8.0.20' },
    { at: 'search', ref: 'docker.io/getmeili/meilisearch:v1.35.1' },
    { at: 'cache', ref: 'redis:7-alpine' },
  ]);
});

test('commentedImages reads template snippets and exempts a local build tag', () => {
  const text = [
    '# # ADD OLLAMA',
    '#  ollama:',
    '#    image: ollama/ollama:latest',
    '',
    '# # LOCAL BUILD',
    '#   api:',
    '#     image: librechat',
    '#     build:',
    '#       context: .',
    '',
    '#   rag_api:',
    '#     image: "registry.librechat.ai/librechat-ai/librechat-rag-api-dev:latest"',
  ].join('\n');
  assert.deepEqual(commentedImages(text), [
    { at: 'commented', ref: 'ollama/ollama:latest' },
    { at: 'commented', ref: 'registry.librechat.ai/librechat-ai/librechat-rag-api-dev:latest' },
  ]);
});

test('dockerfileImages ignores stages, scratch, stage indexes and build args', () => {
  const text = [
    'FROM node:24-alpine AS base',
    'FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26 AS build',
    'FROM base AS dev',
    'FROM ${RUNTIME}',
    'FROM scratch',
    'COPY --from=base /a /b',
    'COPY --chown=1:1 --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv',
    'COPY --from=pgvector/pgvector:0.8.0 /x /y',
    'COPY --from=0 /c /d',
    '# FROM redis:7',
  ].join('\n');
  assert.deepEqual(dockerfileImages(text), [
    { at: 'FROM', ref: 'node:24-alpine' },
    { at: 'FROM', ref: 'docker.io/library/golang:1.26' },
    { at: 'COPY --from', ref: 'ghcr.io/astral-sh/uv:0.9' },
    { at: 'COPY --from', ref: 'pgvector/pgvector:0.8.0' },
  ]);
});

test('every image the repo pulls in a compose file or Dockerfile names its registry', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  const read = (file) => readFileSync(`${root}${file}`, 'utf8');

  const dockerfiles = tracked.filter(
    (file) => /(^|\/)(Docker|Container)file[^/]*$/.test(file) && !file.endsWith('.dockerignore'),
  );
  const composeFiles = tracked
    .filter((file) => /\.ya?ml(\.example)?$/.test(file))
    .filter((file) => /compose/i.test(basename(file)) || /^services:/m.test(read(file)));
  assert.ok(dockerfiles.length > 0, 'found no Dockerfiles');
  assert.ok(composeFiles.length > 0, 'found no compose files');

  const found = [];
  for (const file of composeFiles) {
    const text = read(file);
    const live = /^services:/m.test(text) ? composeImages(text) : [];
    for (const image of [...live, ...commentedImages(text)]) found.push({ file, ...image });
  }
  for (const file of dockerfiles) {
    for (const image of dockerfileImages(read(file))) found.push({ file, ...image });
  }

  const shortNames = found
    .filter(({ ref }) => !hasRegistry(ref))
    .map(({ file, at, ref }) => `${file}: ${at}: ${ref}`);
  assert.deepEqual(
    shortNames,
    [],
    'Podman cannot resolve these short names; add the registry host',
  );
});
