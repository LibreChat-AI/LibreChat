import sharp from 'sharp';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { EImageOutputType, resolveMediaConfig } from 'librechat-data-provider';
import { createFFmpegMediaProcessor, createMediaDerivativeProcessor } from './derivatives';

const exec = promisify(execFile);
const ffmpeg = process.env.MEDIA_TEST_FFMPEG ?? 'ffmpeg';
const installed =
  spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
if (process.env.CI && !installed)
  throw new Error('FFmpeg is required in CI. Install it or set MEDIA_TEST_FFMPEG.');
const videoTests = installed ? describe : describe.skip;

describe('media derivative processing', () => {
  let directory: string;
  let original: string;
  let outputDirectory: string;
  const log = jest.fn();
  const config = resolveMediaConfig({ assets: { derivatives: { maxWidth: 320, maxHeight: 320 } } });
  const video = { render: jest.fn(async () => undefined) };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'media-derivatives-'));
    original = path.join(directory, 'original.png');
    outputDirectory = path.join(directory, 'derived');
    await mkdir(outputDirectory);
    await sharp({ create: { width: 1_200, height: 800, channels: 4, background: '#abcdef' } })
      .png()
      .toFile(original);
    log.mockClear();
    video.render.mockClear();
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it.each([EImageOutputType.PNG, EImageOutputType.JPEG, EImageOutputType.WEBP])(
    'creates a bounded %s thumbnail using the existing image output format',
    async (imageOutputType) => {
      const before = await readFile(original);
      const processor = createMediaDerivativeProcessor({ imageOutputType, video, log });
      const results = await processor.generate({
        path: original,
        type: 'image/png',
        config,
        outputDirectory,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'thumbnail',
        path: path.join(outputDirectory, `thumbnail.${imageOutputType}`),
        type: `image/${imageOutputType}`,
        width: 320,
        height: 213,
      });
      const bytes = await readFile(results[0].path);
      expect(results[0].bytes).toBe(bytes.length);
      expect(await sharp(bytes).metadata()).toMatchObject({
        format: imageOutputType,
        width: 320,
        height: 213,
      });
      expect(await readFile(original)).toEqual(before);
      expect(log).not.toHaveBeenCalled();
      expect(video.render).not.toHaveBeenCalled();
    },
  );

  it('leaves disabled generation and audio originals untouched without invoking processors', async () => {
    const processor = createMediaDerivativeProcessor({
      imageOutputType: EImageOutputType.PNG,
      video,
      log,
    });
    expect(
      await processor.generate({
        path: 'missing',
        type: 'image/png',
        outputDirectory,
        config: resolveMediaConfig({ assets: { derivatives: { enabled: false } } }),
      }),
    ).toEqual([]);
    expect(
      await processor.generate({ path: 'missing', type: 'audio/mpeg', outputDirectory, config }),
    ).toEqual([]);
    expect(video.render).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps the original when a derived image exceeds its byte budget', async () => {
    const before = await readFile(original);
    const processor = createMediaDerivativeProcessor({
      imageOutputType: EImageOutputType.PNG,
      video,
      log,
    });
    expect(
      await processor.generate({
        path: original,
        type: 'image/png',
        outputDirectory,
        config: resolveMediaConfig({ transfers: { maxImageBytes: 1 } }),
      }),
    ).toEqual([]);
    expect(await readFile(original)).toEqual(before);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('never replaces the original even when its name matches a derived file', async () => {
    const conflicting = path.join(outputDirectory, 'thumbnail.png');
    const before = await readFile(original);
    await writeFile(conflicting, before);
    const processor = createMediaDerivativeProcessor({
      imageOutputType: EImageOutputType.PNG,
      video,
      log,
    });
    expect(
      await processor.generate({ path: conflicting, type: 'image/png', outputDirectory, config }),
    ).toEqual([]);
    expect(await readFile(conflicting)).toEqual(before);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('omits unavailable ffmpeg output without making the original fail', async () => {
    const processor = createMediaDerivativeProcessor({
      imageOutputType: EImageOutputType.PNG,
      video: createFFmpegMediaProcessor(),
      log,
    });
    expect(
      await processor.generate({
        path: original,
        type: 'video/mp4',
        outputDirectory,
        config: resolveMediaConfig({
          assets: { derivatives: { ffmpegPath: path.join(directory, 'missing-ffmpeg') } },
        }),
      }),
    ).toEqual([]);
    await processor.prepare?.(
      resolveMediaConfig({
        assets: { derivatives: { ffmpegPath: path.join(directory, 'missing-ffmpeg') } },
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('media.assets.derivatives.ffmpegPath');
    expect(await readFile(original)).toBeInstanceOf(Buffer);
  });
});

videoTests('media derivatives with installed ffmpeg', () => {
  let directory: string;
  let original: string;
  let outputDirectory: string;
  const log = jest.fn();
  const processor = createMediaDerivativeProcessor({
    imageOutputType: EImageOutputType.WEBP,
    video: createFFmpegMediaProcessor(),
    log,
  });
  const config = resolveMediaConfig({
    assets: {
      derivatives: { ffmpegPath: ffmpeg, maxWidth: 64, maxHeight: 64, transcodeVideo: true },
    },
  });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'media-ffmpeg-'));
    original = path.join(directory, 'original.mp4');
    outputDirectory = path.join(directory, 'derived');
    await mkdir(outputDirectory);
    await exec(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x90:rate=5',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '1',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        original,
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    log.mockClear();
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('extracts a poster and a complete playable video while preserving original bytes', async () => {
    const before = await readFile(original);
    const results = await processor.generate({
      path: original,
      type: 'video/mp4',
      config,
      outputDirectory,
    });
    expect(log).not.toHaveBeenCalled();
    expect(results.map((result) => result.kind)).toEqual(['poster', 'playback']);
    expect(results[0]).toMatchObject({ type: 'image/webp', width: 64, height: 36 });
    expect(await sharp(await readFile(results[0].path)).metadata()).toMatchObject({
      format: 'webp',
      width: 64,
      height: 36,
    });
    const probe = path.join(path.dirname(ffmpeg), `ffprobe${path.extname(ffmpeg)}`);
    const { stdout } = await exec(
      probe,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type,width,height,duration',
        '-of',
        'json',
        results[1].path,
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    const streams = (
      JSON.parse(stdout) as {
        streams: Array<{
          codec_name: string;
          codec_type: string;
          width?: number;
          height?: number;
          duration?: string;
        }>;
      }
    ).streams;
    expect(streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_name: 'h264', codec_type: 'video', width: 64, height: 36 }),
        expect.objectContaining({ codec_name: 'aac', codec_type: 'audio' }),
      ]),
    );
    expect(
      Number(streams.find((stream) => stream.codec_type === 'video')?.duration),
    ).toBeGreaterThanOrEqual(1);
    expect(await readFile(original)).toEqual(before);
  });

  it('keeps a completed poster when the playback byte limit kills the encoder', async () => {
    const before = await readFile(original);
    const results = await processor.generate({
      path: original,
      type: 'video/mp4',
      outputDirectory,
      config: { ...config, transfers: { ...config.transfers, maxVideoBytes: 64 } },
    });
    expect(results.map((result) => result.kind)).toEqual(['poster']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await readFile(original)).toEqual(before);
  });

  it('kills timed-out processing and publishes no partial derivative', async () => {
    await processor.prepare?.(config);
    const results = await processor.generate({
      path: original,
      type: 'video/mp4',
      outputDirectory,
      config: {
        ...config,
        assets: { ...config.assets, derivatives: { ...config.assets.derivatives, timeoutMs: 1 } },
      },
    });
    expect(results).toEqual([]);
    expect(log).toHaveBeenCalled();
    expect(
      log.mock.calls.some(
        ([, error]) => error instanceof Error && error.message.includes('timeout'),
      ),
    ).toBe(true);
  });
});
