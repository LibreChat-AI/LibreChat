import path from 'node:path';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import type { MediaConfig, MediaRendition, MediaRenditionKind } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createRemoteFileByteLimitTransform } from '~/storage/url';
import { createImageTransform } from '~/files/resize';

export interface MediaDerivative extends Omit<MediaRendition, 'filepath'> {
  kind: MediaRenditionKind;
  path: string;
}

export interface MediaDerivativeProcessor {
  prepare?(config: MediaConfig): Promise<void>;
  generate(input: {
    path: string;
    type: string;
    config: MediaConfig;
    outputDirectory: string;
  }): Promise<MediaDerivative[]>;
}

export interface MediaVideoProcessor {
  available?(config: MediaConfig): Promise<boolean>;
  render(input: {
    path: string;
    type: string;
    outputPath: string;
    kind: 'poster' | 'playback';
    config: MediaConfig;
    timeoutMs: number;
  }): Promise<void>;
}

/** FFmpeg writes bounded output through stdout, so a size limit cannot publish a truncated movie. */
export function createFFmpegMediaProcessor(): MediaVideoProcessor {
  const availability = new Map<string, Promise<boolean>>();
  return {
    available(config) {
      const { ffmpegPath, timeoutMs } = config.assets.derivatives;
      let pending = availability.get(ffmpegPath);
      if (!pending) {
        pending = new Promise<boolean>((resolve) => {
          const child = spawn(ffmpegPath, ['-version'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
          const finish = (available: boolean) => {
            clearTimeout(timeout);
            resolve(available);
          };
          child.once('error', () => finish(false));
          child.once('close', (code) => finish(code === 0));
        });
        availability.set(ffmpegPath, pending);
      }
      return pending;
    },
    async render(input) {
      const { maxWidth, maxHeight, ffmpegPath } = input.config.assets.derivatives;
      const playback = input.kind === 'playback';
      const width = playback ? Math.max(2, maxWidth - (maxWidth % 2)) : maxWidth;
      const height = playback ? Math.max(2, maxHeight - (maxHeight % 2)) : maxHeight;
      const scale = `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease${playback ? ':force_divisible_by=2' : ''}`;
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-threads',
        '1',
        '-f',
        input.type === 'video/mp4' ? 'mov' : 'matroska',
        '-i',
        path.resolve(input.path),
        '-map',
        '0:v:0',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-filter_threads',
        '1',
        '-vf',
        scale,
        '-threads',
        '1',
        ...(playback
          ? [
              '-map',
              '0:a:0?',
              '-c:v',
              'libx264',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-movflags',
              'frag_keyframe+empty_moov+default_base_moof',
              '-f',
              'mp4',
            ]
          : ['-an', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe']),
        'pipe:1',
      ];
      const child = spawn(ffmpegPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (diagnostic.length < 4_096)
          diagnostic += chunk.toString('utf8').slice(0, 4_096 - diagnostic.length);
      });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, input.timeoutMs);
      const closed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg media derivative failed (${code}): ${diagnostic.trim()}`));
        });
      });
      const copied = pipeline(
        child.stdout,
        createRemoteFileByteLimitTransform(
          playback ? input.config.transfers.maxVideoBytes : input.config.transfers.maxImageBytes,
        ),
        createWriteStream(input.outputPath, { flags: 'wx', mode: 0o600 }),
      );
      try {
        await Promise.all([closed, copied]);
      } catch (error) {
        child.kill('SIGKILL');
        await Promise.allSettled([closed, copied]);
        if (timedOut) throw new Error('FFmpeg media derivative exceeded its configured timeout.');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Derived files are optional; the caller owns their staging directory and immutable original. */
export function createMediaDerivativeProcessor({
  imageOutputType,
  video,
  log,
}: {
  imageOutputType: AppConfig['imageOutputType'];
  video: MediaVideoProcessor;
  log(message: string, error?: Error): void;
}): MediaDerivativeProcessor {
  const format = imageOutputType === 'jpeg' || imageOutputType === 'webp' ? imageOutputType : 'png';
  const type = `image/${format}`;
  const unavailable = new Set<string>();
  const checkVideo = async (config: MediaConfig): Promise<boolean> => {
    if (!video.available || (await video.available(config))) return true;
    const { ffmpegPath } = config.assets.derivatives;
    if (!unavailable.has(ffmpegPath)) {
      unavailable.add(ffmpegPath);
      log(
        '[media] FFmpeg is unavailable. Install FFmpeg or configure media.assets.derivatives.ffmpegPath; video originals remain available without posters or playback derivatives.',
      );
    }
    return false;
  };

  async function image(
    input: string,
    destination: string,
    config: MediaConfig,
    timeoutMs: number,
  ): Promise<Omit<MediaDerivative, 'kind'>> {
    const { maxWidth, maxHeight } = config.assets.derivatives;
    const dimensions: Pick<MediaRendition, 'width' | 'height'> = {};
    const transform = createImageTransform({
      rotate: true,
      resize: { width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true },
      timeoutMs,
      format,
    });
    transform.once('info', (info) => {
      dimensions.width = info.width;
      dimensions.height = info.height;
    });
    await pipeline(
      createReadStream(input),
      transform,
      createRemoteFileByteLimitTransform(config.transfers.maxImageBytes),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const file = await stat(destination);
    return { path: destination, type, bytes: file.size, ...dimensions };
  }

  return {
    async prepare(config) {
      if (config.assets.derivatives.enabled) await checkVideo(config);
    },
    async generate(input) {
      const { config } = input;
      const settings = config.assets.derivatives;
      if (!settings.enabled) return [];
      const outputDirectory = path.resolve(input.outputDirectory);
      const original = path.resolve(input.path);
      const output = (name: string) => {
        const destination = path.join(outputDirectory, name);
        if (destination === original)
          throw new Error('Media derivatives cannot replace the original.');
        return destination;
      };
      const deadline = Date.now() + settings.timeoutMs;
      const remaining = () => {
        const milliseconds = deadline - Date.now();
        if (milliseconds <= 0)
          throw new Error('Media derivatives exceeded their configured timeout.');
        return milliseconds;
      };
      const results: MediaDerivative[] = [];
      const attempt = async (work: () => Promise<MediaDerivative>) => {
        try {
          results.push(await work());
        } catch (error) {
          log('[media] Derivative creation failed.', error instanceof Error ? error : undefined);
        }
      };
      if (input.type.startsWith('image/')) {
        await attempt(async () => ({
          kind: 'thumbnail',
          ...(await image(original, output(`thumbnail.${format}`), config, remaining())),
        }));
        return results;
      }
      if (!['video/mp4', 'video/webm'].includes(input.type) || !(await checkVideo(config)))
        return results;
      await attempt(async () => {
        const frame = output('poster-frame.png');
        await video.render({
          path: original,
          type: input.type,
          outputPath: frame,
          kind: 'poster',
          config,
          timeoutMs: remaining(),
        });
        return {
          kind: 'poster',
          ...(await image(frame, output(`poster.${format}`), config, remaining())),
        };
      });
      if (settings.transcodeVideo) {
        await attempt(async () => {
          const destination = output('playback.mp4');
          await video.render({
            path: original,
            type: input.type,
            outputPath: destination,
            kind: 'playback',
            config,
            timeoutMs: remaining(),
          });
          const { size } = await stat(destination);
          if (size === 0 || size > config.transfers.maxVideoBytes) {
            throw new Error('The derived video exceeds the configured video transfer limit.');
          }
          return { kind: 'playback', path: destination, type: 'video/mp4', bytes: size };
        });
      }
      return results;
    },
  };
}
