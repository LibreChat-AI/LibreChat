import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRelease } from './release.mjs';

const placeholder = '__LC_ASSET_BUILD_ID__';

test('stamps HTML and a matching release pointer only after the assets exist', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'frontend-release-'));
  try {
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'assets/index.abcd1234.js'), 'first build');
    await writeFile(
      path.join(directory, 'index.html'),
      `<meta name="lc-asset-build-id" content="${placeholder}">`,
    );
    const first = await writeRelease(directory);
    assert.match(first.buildId, /^assets-[a-f0-9]{64}$/);
    assert.equal(first.assetManifestHash, first.buildId.slice('assets-'.length));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, 'version.json'), 'utf8')),
      first,
    );
    assert.match(
      await readFile(path.join(directory, 'index.html'), 'utf8'),
      new RegExp(first.buildId),
    );

    await writeFile(path.join(directory, 'assets/logo.svg'), '<svg>updated logo</svg>');
    await writeFile(path.join(directory, 'assets/index.abcd1234.js'), 'second build');
    await writeFile(
      path.join(directory, 'index.html'),
      `<meta name="lc-asset-build-id" content="${placeholder}">`,
    );
    const second = await writeRelease(directory);
    assert.notEqual(second.buildId, first.buildId);
    await assert.rejects(() => writeRelease(directory), /missing the frontend release placeholder/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
