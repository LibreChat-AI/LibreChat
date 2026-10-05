import sharp from 'sharp';
import path from 'node:path';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { resolveMediaConfig } from 'librechat-data-provider';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createModels, createMethods, createMediaMethods } from '@librechat/data-schemas';
import type { MediaMethods, MediaOwnerScope } from '@librechat/data-schemas';
import {
  detectMediaReferenceType,
  mediaContentByteLimit,
  mediaContentExtension,
  mediaInputByteLimit,
  normalizeMediaContentType,
  prepareMediaInputContent,
  validateMediaAudio,
  validateMediaSvg,
} from './content';
import { mp4ReferenceFixture, webmReferenceFixture } from './__fixtures__/reference-content';
import { createMediaDerivativeProcessor, createFFmpegMediaProcessor } from './derivatives';
import { deleteMediaAwareFile } from './deletion';
import { createMediaStorage } from './storage';

const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24" viewBox="0 0 32 24">
  <!-- Keep the source and local definitions unchanged. -->
  <defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
  <path id="shape" d="M0 0H32V24H0Z"/></defs>
  <use href="#shape" fill="url(#paint)"/>
</svg>`);

const provenanceSvg = Buffer.from(`<svg version="1.1" xmlns="http://www.w3.org/2000/svg"
  xmlns:c2pa="http://c2pa.org/manifest" style="display: block;"
  width="32" height="24" viewBox="0 0 32 24" preserveAspectRatio="none">
  <metadata><c2pa:manifest>AAAEAGp1bWI=</c2pa:manifest></metadata>
  <path fill="red" d="M0 0H32V24H0Z"/>
</svg>`);

function wav(): Buffer {
  const data = Buffer.alloc(44 + 1600);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(1600, 40);
  return data;
}

function mp3(): Buffer {
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0]).copy(frame);
  return Buffer.concat([Buffer.from('49443303000000000000', 'hex'), frame, frame]);
}

function oggPage(packet: Buffer, sequence: number, flags: number): Buffer {
  const page = Buffer.alloc(28 + packet.length);
  page.write('OggS');
  page[5] = flags;
  page.writeUInt32LE(flags & 4 ? 960 : 0, 6);
  page.writeUInt32LE(1, 14);
  page.writeUInt32LE(sequence, 18);
  page[26] = 1;
  page[27] = packet.length;
  packet.copy(page, 28);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  page.writeUInt32LE(crc >>> 0, 22);
  return page;
}

function ogg(): Buffer {
  const identification = Buffer.alloc(19);
  identification.write('OpusHead');
  identification[8] = 1;
  identification[9] = 1;
  identification.writeUInt32LE(48000, 12);
  const comments = Buffer.alloc(16);
  comments.write('OpusTags');
  return Buffer.concat([
    oggPage(identification, 0, 2),
    oggPage(comments, 1, 0),
    oggPage(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4),
  ]);
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, content]);
}

function m4a(handler = 'soun'): Buffer {
  const trackHandler = Buffer.alloc(24);
  trackHandler.write(handler, 8);
  const sample = Buffer.alloc(28);
  sample.writeUInt16BE(1, 6);
  sample.writeUInt16BE(2, 16);
  sample.writeUInt16BE(16, 18);
  sample.writeUInt32BE(44100 * 65536, 24);
  const description = Buffer.alloc(8);
  description.writeUInt32BE(1, 4);
  const sizes = Buffer.alloc(12);
  sizes.writeUInt32BE(6, 4);
  sizes.writeUInt32BE(1, 8);
  return Buffer.concat([
    box('ftyp', Buffer.from('4d3441200000000069736f6d4d344120', 'hex')),
    box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box('hdlr', trackHandler),
          box(
            'minf',
            box('stbl', box('stsd', description, box('mp4a', sample)), box('stsz', sizes)),
          ),
        ),
      ),
    ),
    box('mdat', Buffer.from('211004608c1c', 'hex')),
  ]);
}

const audio = [
  { type: 'audio/wav', extension: 'wav', data: wav() },
  { type: 'audio/mpeg', extension: 'mp3', data: mp3() },
  { type: 'audio/ogg', extension: 'ogg', data: ogg() },
  { type: 'audio/mp4', extension: 'm4a', data: m4a() },
];

describe('Media original content validation', () => {
  it.each(audio)(
    'identifies validated $type reference bytes without a MIME hint',
    ({ data, type }) => {
      expect(detectMediaReferenceType(data, 'audio')).toBe(type);
      expect(() => detectMediaReferenceType(data, 'video')).toThrow();
    },
  );

  it.each([
    { type: 'video/mp4', data: mp4ReferenceFixture() },
    { type: 'video/webm', data: webmReferenceFixture() },
  ])(
    'identifies $type by its video track and rejects incomplete or audio claims',
    ({ type, data }) => {
      expect(detectMediaReferenceType(data, 'video')).toBe(type);
      expect(() => detectMediaReferenceType(data, 'audio')).toThrow();
      expect(() => detectMediaReferenceType(data.subarray(0, data.length - 1), 'video')).toThrow();
    },
  );

  it('rejects signatures without media tracks, forged audio tracks and non-media content', () => {
    for (const data of [
      mp4ReferenceFixture().subarray(0, 24),
      Buffer.from('1a45dfa300000000', 'hex'),
      webmReferenceFixture(2),
      m4a('vide'),
      Buffer.from('<html>Not a video</html>'),
    ]) {
      expect(() => detectMediaReferenceType(data, 'video')).toThrow();
    }
    expect(() => detectMediaReferenceType(Buffer.from('RIFF'), 'audio')).toThrow();
  });

  it('requires exact container identifiers without discarding high bits', () => {
    const mp4 = mp4ReferenceFixture();
    mp4[4] |= 128;
    expect(() => detectMediaReferenceType(mp4, 'video')).toThrow();
    const webm = webmReferenceFixture();
    webm[webm.indexOf(Buffer.from('webm'))] |= 128;
    expect(() => detectMediaReferenceType(webm, 'video')).toThrow();
  });

  it.each([
    '<script>alert(1)</script>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>',
    '<rect width="10" height="10" onload="alert(1)"/>',
    '<use href="https://example.test/remote.svg#shape"/>',
    '<rect fill="url(https://example.test/paint.svg#color)"/>',
    '<rect fill="u\\72l(https://example.test/paint.svg)"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zz4="/>',
    '<style>@import url(https://example.test/style.css);</style>',
    '<rect style="fill:red"/>',
    '<animate attributeName="href" to="https://example.test/external.svg"/>',
    '<?xml-stylesheet href="https://example.test/style.css"?>',
    '<use xml:base="https://example.test/" href="#shape"/>',
  ])('rejects active or externally referenced SVG: %s', (content) => {
    const data = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`);
    expect(() => validateMediaSvg(data)).toThrow('Unsupported SVG content');
  });

  it.each([
    '<!DOCTYPE svg SYSTEM "https://example.test/remote.dtd"><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<!DOCTYPE svg [<!ENTITY image "entity">]><svg xmlns="http://www.w3.org/2000/svg">&image;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>',
    '<svg><rect/></svg>',
    '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
    '<?xml version="1.0" encoding="UTF-7"?><svg xmlns="http://www.w3.org/2000/svg"/>',
  ])('rejects invalid SVG XML: %s', (value) => {
    expect(() => validateMediaSvg(Buffer.from(value))).toThrow('Unsupported SVG content');
  });

  it.each([
    '<metadata><c2pa:manifest onload="alert(1)">AAAA</c2pa:manifest></metadata>',
    '<metadata><c2pa:manifest><script>alert(1)</script></c2pa:manifest></metadata>',
    '<metadata><c2pa:manifest>not base64!</c2pa:manifest></metadata>',
    '<c2pa:manifest>AAAA</c2pa:manifest>',
    '<metadata><c2pa:manifest xmlns:c2pa="https://example.test/namespace">AAAA</c2pa:manifest></metadata>',
  ])('rejects active or invalid provenance metadata: %s', (content) => {
    const data = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:c2pa="http://c2pa.org/manifest">${content}</svg>`,
    );
    expect(() => validateMediaSvg(data)).toThrow('Unsupported SVG content');
  });

  it('rejects external CSS appended to a provider display style', () => {
    const data = Buffer.from(
      provenanceSvg
        .toString()
        .replace(
          'display: block;',
          'display: block; fill: url(https://example.test/external.svg);',
        ),
    );
    expect(() => validateMediaSvg(data)).toThrow('Unsupported SVG content');
  });

  it.each(audio)('rejects incomplete $type and an incompatible MIME claim', ({ data, type }) => {
    expect(() => validateMediaAudio(data.subarray(0, data.length - 1), type)).toThrow();
    expect(() =>
      validateMediaAudio(data, type === 'audio/wav' ? 'audio/mpeg' : 'audio/wav'),
    ).toThrow();
  });

  it('rejects an Ogg page whose bytes changed and an MP4 carrying a video track', () => {
    const corrupted = Buffer.from(ogg());
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => validateMediaAudio(corrupted, 'audio/ogg')).toThrow('Unsupported Ogg audio');
    expect(() => validateMediaAudio(m4a('vide'), 'audio/mp4')).toThrow('Unsupported M4A audio');
  });

  it('recognizes only declared media types and selects independent transfer limits', () => {
    const config = resolveMediaConfig({
      transfers: { maxImageBytes: 100, maxVideoBytes: 200, maxAudioBytes: 300 },
    });
    expect(mediaContentExtension('image/svg+xml')).toBe('svg');
    expect(mediaContentExtension('audio/x-arbitrary')).toBeUndefined();
    expect(mediaContentExtension('constructor')).toBeUndefined();
    expect(mediaContentByteLimit('image/svg+xml', config)).toBe(100);
    expect(mediaContentByteLimit('video/mp4', config)).toBe(200);
    expect(mediaContentByteLimit('audio/wav', config)).toBe(300);
    expect(mediaInputByteLimit('audio', config)).toBe(300);
    expect(mediaInputByteLimit('video', config)).toBe(200);
    expect(mediaInputByteLimit('end_frame', config)).toBe(100);
    expect(normalizeMediaContentType('Audio/X-M4A')).toBe('audio/mp4');
    expect(normalizeMediaContentType('audio/x-wav')).toBe('audio/wav');
    expect(mediaContentExtension('audio/x-m4a')).toBe('m4a');
  });

  it('rasterizes provider references while keeping the SVG original unchanged', async () => {
    const before = Buffer.from(svg);
    const input = await prepareMediaInputContent(
      'reference',
      'image/svg+xml',
      svg,
      resolveMediaConfig(),
    );
    expect(input.type).toBe('image/png');
    expect(await sharp(input.data).metadata()).toMatchObject({
      format: 'png',
      width: 32,
      height: 24,
    });
    expect(svg).toEqual(before);
  });

  it.each([
    ['audio', 'image/png'],
    ['video', 'audio/wav'],
    ['reference', 'video/mp4'],
    ['mask', 'audio/mpeg'],
    ['start_frame', 'video/webm'],
    ['end_frame', 'audio/ogg'],
  ] as const)('rejects %s inputs with MIME %s', async (role, type) => {
    await expect(
      prepareMediaInputContent(role, type, Buffer.from('input'), resolveMediaConfig()),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('Media original storage', () => {
  let mongo: MongoMemoryServer;
  let repository: MediaMethods;
  let directory: string;
  let scope: MediaOwnerScope;

  async function expectNoOwnerFiles(): Promise<void> {
    for (const location of [
      path.join(directory, 'images', scope.ownerId),
      path.join(directory, 'uploads', 'temp', scope.ownerId, 'media'),
    ]) {
      const entries = await readdir(location, { recursive: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      expect(entries).toEqual([]);
    }
  }
  let storage: ReturnType<typeof createMediaStorage>;
  const config = resolveMediaConfig();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    repository = createMediaMethods(mongoose, { ownerExists: async () => true });
    await repository.ensureMediaIndexes();
    directory = await mkdtemp(path.join(tmpdir(), 'librechat-media-storage-'));
    storage = createMediaStorage({
      repository,
      imageDirectory: path.join(directory, 'images'),
      uploadDirectory: path.join(directory, 'uploads'),
      now: Date.now,
    });
  }, 60000);

  beforeEach(() => {
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
  });

  it('sanitizes provider filenames before saving or returning the asset', async () => {
    const asset = await storage.publish({
      scope,
      outputKey: 'provider-filename',
      config,
      stream: Readable.from(svg),
      filename: '../../日本語\r\n"bad.svg',
      type: 'image/svg+xml',
    });
    expect(asset.filename).toBe('日本語___bad.svg');
    expect((await repository.getMediaAssetContent(scope, asset.file_id))?.filename).toBe(
      asset.filename,
    );
  });

  it('deletes physical originals and thumbnails through the shared Files entry point', async () => {
    const original = await sharp({
      create: { width: 24, height: 16, channels: 4, background: '#cde' },
    })
      .png()
      .toBuffer();
    const paths = {
      imageOutput: path.join(directory, 'images'),
      uploads: path.join(directory, 'uploads'),
    };
    const withDerivatives = createMediaStorage({
      repository,
      imageDirectory: paths.imageOutput,
      uploadDirectory: paths.uploads,
      now: Date.now,
      derivatives: createMediaDerivativeProcessor({
        imageOutputType: 'png',
        video: createFFmpegMediaProcessor(),
        log: () => undefined,
      }),
    });
    const asset = await withDerivatives.publish({
      scope,
      outputKey: 'legacy-delete',
      config,
      stream: Readable.from(original),
      filename: 'original.png',
      type: 'image/png',
    });
    const content = await repository.getMediaAssetContent(scope, asset.file_id);
    const locations = [content!.filepath, content!.mediaRenditions!.thumbnail!.filepath].map(
      (filepath) => path.join(directory, filepath.slice(1)),
    );
    for (const location of locations) expect((await readFile(location)).length).toBeGreaterThan(0);
    const legacyDelete = jest.fn();
    await deleteMediaAwareFile({
      request: { user: { id: scope.ownerId }, config: { paths } },
      file: asset,
      repository,
      deleteFile: legacyDelete,
      resolveStrategy: () => {
        throw new Error('Local deletion must not require cloud configuration');
      },
    });
    expect(legacyDelete).not.toHaveBeenCalled();
    for (const location of locations)
      await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repository.getMediaAssetContent(scope, asset.file_id)).toBeNull();
  });

  it('reads the same original after Studio releases it and deletes bytes only after the final chat reference', async () => {
    const asset = await storage.publish({
      scope,
      outputKey: 'chat-retained',
      config,
      stream: Readable.from(svg),
      filename: 'original.svg',
      type: 'image/svg+xml',
    });
    await repository.retainMediaAsset({
      scope,
      fileId: asset.file_id,
      retainer: 'thread:studio:1',
      maxRetainers: 4,
    });
    const messages = createMethods(mongoose);
    const conversationId = randomUUID();
    await messages.saveMessage(
      { userId: scope.ownerId },
      {
        conversationId,
        messageId: randomUUID(),
        files: [{ file_id: asset.file_id }],
      },
    );
    await repository.releaseMediaAsset({
      scope,
      fileId: asset.file_id,
      retainer: 'thread:studio:1',
    });
    const original = await repository.getMediaAssetContent(scope, asset.file_id);
    const location = path.join(directory, original!.filepath.slice(1));
    const remove = () =>
      deleteMediaAwareFile({
        request: {
          user: { id: scope.ownerId },
          config: {
            paths: {
              imageOutput: path.join(directory, 'images'),
              uploads: path.join(directory, 'uploads'),
            },
          },
        },
        file: asset,
        repository,
        deleteFile: jest.fn(),
        resolveStrategy: () => {
          throw new Error('Local original');
        },
      });
    await expect(remove()).rejects.toMatchObject({ status: 409 });
    expect((await storage.read(scope, asset.file_id, svg.length)).data).toEqual(svg);
    expect(await readFile(location)).toEqual(svg);
    await messages.deleteMessages({ user: scope.ownerId, conversationId });
    await remove();
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { type: 'image/svg+xml', extension: 'svg', data: svg },
    { type: 'image/svg+xml', extension: 'svg', data: provenanceSvg },
    ...audio,
    { type: 'audio/x-wav', extension: 'wav', data: wav() },
    { type: 'audio/x-m4a', extension: 'm4a', data: m4a() },
  ])(
    'publishes and reads an immutable $type original with its own digest and file extension',
    async ({ type, data, extension }) => {
      const input = {
        scope,
        type,
        config,
        outputKey: 'original',
        filename: `original.${extension}`,
      };
      const asset = await storage.publish({ ...input, stream: Readable.from(data) });
      expect(asset).toMatchObject({ type: normalizeMediaContentType(type), bytes: data.length });
      expect(asset.filepath).toBe(`/api/media/assets/${asset.file_id}/content`);
      if (type === 'image/svg+xml') expect(asset).toMatchObject({ width: 32, height: 24 });
      const original = await repository.getMediaAssetContent(scope, asset.file_id);
      expect(original?.filepath.endsWith(`.${extension}`)).toBe(true);
      expect(original?.contentDigest).toBe(createHash('sha256').update(data).digest('hex'));
      expect((await storage.read(scope, asset.file_id, data.length)).data).toEqual(data);
      const location = path.join(directory, original!.filepath.slice(1));
      expect(await readFile(location)).toEqual(data);
      const repeated = await storage.publish({ ...input, stream: Readable.from(data) });
      expect(repeated.file_id).toBe(asset.file_id);
      expect(await readdir(path.dirname(location))).toHaveLength(1);
      const changed = Buffer.from(data);
      changed[changed.length - 1] ^= 1;
      await writeFile(location, changed);
      await expect(storage.read(scope, asset.file_id, data.length)).rejects.toThrow(
        'The media original changed',
      );
    },
  );

  it.each(['image/svg+xml', 'image/png'])(
    'retires and removes unsafe SVG uploaded as %s before publication',
    async (type) => {
      const outputKey = 'unsafe';
      await expect(
        storage.publish({
          scope,
          outputKey,
          type,
          config,
          filename: 'unsafe.svg',
          stream: Readable.from(
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          ),
        }),
      ).rejects.toThrow();
      expect(
        await repository.getPublishedMediaAsset({ scope, outputKey, rendition: 'original' }),
      ).toBeNull();
      await expectNoOwnerFiles();
    },
  );

  it('bounds audio bytes while streaming and removes cancelled or oversized originals', async () => {
    const input = {
      scope,
      outputKey: 'bounded',
      type: 'audio/wav',
      filename: 'audio.wav',
      config: resolveMediaConfig({ transfers: { maxAudioBytes: 32 } }),
    };
    await expect(
      storage.publish({ ...input, stream: Readable.from([wav().subarray(0, 32), wav()]) }),
    ).rejects.toMatchObject({ status: 413 });
    await expectNoOwnerFiles();
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from('RIFF');
        throw new Error('Upload cancelled');
      })(),
    );
    await expect(storage.publish({ ...input, outputKey: 'cancelled', stream })).rejects.toThrow(
      'Upload cancelled',
    );
    await expectNoOwnerFiles();
    expect(
      await repository.getPublishedMediaAsset({
        scope,
        outputKey: 'cancelled',
        rendition: 'original',
      }),
    ).toBeNull();
  });
});
