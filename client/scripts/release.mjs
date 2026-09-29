import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const placeholder = '__LC_ASSET_BUILD_ID__';

async function assetPaths(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(prefix, entry.name);
      return entry.isDirectory()
        ? assetPaths(path.join(directory, entry.name), relative)
        : /\.(?:gz|br|map)$/.test(entry.name)
          ? []
          : [relative];
    }),
  );
  return paths.flat();
}

export async function writeRelease(directory = dist) {
  const assetsDirectory = path.join(directory, 'assets');
  const files = (await assetPaths(assetsDirectory, 'assets')).sort();
  if (files.length === 0 || !files.some((file) => /\/index[.-][\w-]+\.js$/.test(file))) {
    throw new Error('A frontend release requires a built entry and its assets');
  }
  const manifest = createHash('sha256');
  for (const file of files) {
    const contents = await readFile(path.join(directory, file));
    manifest
      .update(file)
      .update('\0')
      .update(createHash('sha256').update(contents).digest('hex'))
      .update('\n');
  }
  const assetManifestHash = manifest.digest('hex');
  const buildId = `assets-${assetManifestHash}`;
  const htmlPath = path.join(directory, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes(placeholder)) {
    throw new Error('The built index is missing the frontend release placeholder');
  }
  const stampedHtml = html.replace(placeholder, buildId);
  await writeFile(htmlPath, stampedHtml);
  // A compressed shell, when emitted, must contain the same build ID as the plain HTML.
  for (const [suffix, compress] of [
    ['.gz', gzipSync],
    ['.br', brotliCompressSync],
  ]) {
    const compressedPath = `${htmlPath}${suffix}`;
    try {
      await readFile(compressedPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    await writeFile(compressedPath, compress(stampedHtml));
  }
  const release = { schemaVersion: 1, buildId, assetManifestHash };
  await writeFile(path.join(directory, 'version.json'), `${JSON.stringify(release)}\n`);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeRelease().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
