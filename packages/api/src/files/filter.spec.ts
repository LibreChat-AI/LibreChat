import { Types } from 'mongoose';
import { Providers } from '@librechat/agents';
import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { filterFilesByEndpointConfig, filterFilesByEndpointRuntimeConfig } from './filter';

describe('filterFilesByEndpointRuntimeConfig', () => {
  const sizedFile = (filename: string, bytes: number): IMongoFile =>
    ({
      _id: new Types.ObjectId(),
      user: new Types.ObjectId(),
      file_id: new Types.ObjectId().toString(),
      filename,
      type: 'application/pdf',
      bytes,
      object: 'file',
      usage: 0,
      source: 'test',
      filepath: `/test/${filename}`,
    }) as unknown as IMongoFile;

  /** Endpoint limits are configured in megabytes; 1 MB is 1_048_576 bytes. */
  const appConfig = {
    fileConfig: {
      endpoints: {
        default: { disabled: false, fileLimit: 10, fileSizeLimit: 1, totalSizeLimit: 1 },
      },
    },
  } as unknown as AppConfig;

  it('spends one total-size allowance across two filtered sets', () => {
    const delivery = filterFilesByEndpointRuntimeConfig(appConfig, {
      files: [sizedFile('delivered.pdf', 900_000)],
      endpoint: 'default',
    });
    const deliveredBytes = delivery.reduce((sum, file) => sum + file.bytes, 0);

    const deferred = filterFilesByEndpointRuntimeConfig(appConfig, {
      files: [sizedFile('deferred.pdf', 900_000)],
      endpoint: 'default',
      consumedBytes: deliveredBytes,
    });

    expect(delivery).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });

  it('still admits a second set that fits in the remaining allowance', () => {
    const deferred = filterFilesByEndpointRuntimeConfig(appConfig, {
      files: [sizedFile('deferred.pdf', 100_000)],
      endpoint: 'default',
      consumedBytes: 900_000,
    });

    expect(deferred).toHaveLength(1);
  });

  it('screens a converted image by the type it was accepted as', () => {
    /* The allowlist admitted a png, conversion rewrote the stored type, and screening it
     * by that drops a file the same allowlist accepted minutes earlier. */
    const narrowConfig = {
      fileConfig: {
        endpoints: { default: { disabled: false, supportedMimeTypes: ['^image/png$'] } },
      },
    } as unknown as AppConfig;
    const converted = {
      ...sizedFile('photo.png', 1000),
      type: 'image/webp',
      metadata: { routingMimeType: 'image/png' },
    } as unknown as IMongoFile;

    expect(
      filterFilesByEndpointRuntimeConfig(narrowConfig, { files: [converted], endpoint: 'default' }),
    ).toHaveLength(1);
  });

  it('still screens an unconverted file by its own type', () => {
    const narrowConfig = {
      fileConfig: {
        endpoints: { default: { disabled: false, supportedMimeTypes: ['^image/png$'] } },
      },
    } as unknown as AppConfig;
    const webp = { ...sizedFile('photo.webp', 1000), type: 'image/webp' } as unknown as IMongoFile;

    expect(
      filterFilesByEndpointRuntimeConfig(narrowConfig, { files: [webp], endpoint: 'default' }),
    ).toHaveLength(0);
  });
});

describe('filterFilesByEndpointConfig', () => {
  /** Helper to create a mock file */
  const createMockFile = (filename: string): IMongoFile =>
    ({
      _id: new Types.ObjectId(),
      user: new Types.ObjectId(),
      file_id: new Types.ObjectId().toString(),
      filename,
      type: 'application/pdf',
      bytes: 1024,
      object: 'file',
      usage: 0,
      source: 'test',
      filepath: `/test/${filename}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as IMongoFile;

  describe('when files are disabled for endpoint', () => {
    it('should return empty array when endpoint has disabled: true', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test1.pdf'), createMockFile('test2.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should return empty array when default endpoint has disabled: true and provider not found', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              default: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should return empty array for disabled Anthropic endpoint', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.ANTHROPIC]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('doc.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.ANTHROPIC,
      });

      expect(result).toEqual([]);
    });

    it('should return empty array for disabled Google endpoint', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.GOOGLE]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('video.mp4')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.GOOGLE,
      });

      expect(result).toEqual([]);
    });
  });

  describe('when files are enabled for endpoint', () => {
    it('should return all files when endpoint has disabled: false', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test1.pdf'), createMockFile('test2.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });

    it('should return all files when endpoint config exists but disabled is not set', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                fileSizeLimit: 10,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });

    it('should return all files when no fileConfig exists', () => {
      const req = {} as ServerRequest;

      const files = [createMockFile('test1.pdf'), createMockFile('test2.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });

    it('should return all files when endpoint not in config and no default', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.ANTHROPIC]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /** OpenAI not configured, should use base defaults which allow files */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });
  });

  describe('custom endpoint configuration', () => {
    it('should use direct endpoint lookup when endpointType is custom', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              ollama: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual([]);
    });

    it('should use normalized endpoint lookup for custom endpoints', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              ollama: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /** Test with non-normalized endpoint name (e.g., "Ollama" vs "ollama") */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'Ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual([]);
    });

    it('should fallback to "custom" config when specific custom endpoint not found', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [EModelEndpoint.custom]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'unknownCustomEndpoint',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual([]);
    });

    it('should return files when custom endpoint has disabled: false', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              ollama: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test1.pdf'), createMockFile('test2.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual(files);
    });

    it('should use agents config as fallback for custom endpoints', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [EModelEndpoint.agents]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /**
       * Lookup order for custom endpoint: explicitConfig -> custom -> agents -> default
       * Should find and use agents config
       */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual(files);
    });

    it('should fallback to default when agents is not configured for custom endpoint', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              /** Only default configured, no agents or custom */
              default: {
                disabled: false,
                fileLimit: 10,
                fileSizeLimit: 20,
                totalSizeLimit: 50,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /**
       * Lookup order: explicitConfig -> custom -> agents -> default
       * Since none of first three exist, should fall back to default
       */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual(files);
    });

    it('should use default when agents is not configured for custom endpoint', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              /** NO agents config - should skip to default */
              default: {
                disabled: false,
                fileLimit: 15,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /**
       * Lookup order: explicitConfig -> custom -> agents -> default
       * Since agents is not configured, should fall back to default
       */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual(files);
    });

    it('should block files when agents is disabled for unconfigured custom endpoint', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              agents: {
                disabled: true,
              },
              default: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /**
       * Lookup order: explicitConfig -> custom -> agents -> default
       * Should use agents config which is disabled: true
       */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual([]);
    });

    it('should prioritize specific custom endpoint over generic custom config', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [EModelEndpoint.custom]: {
                disabled: false,
              },
              ollama: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /** Should use ollama config (disabled: true), not custom config (disabled: false) */
      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual([]);
    });

    it('should handle case-insensitive custom endpoint names', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              ollama: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /** Test various case combinations */
      const result1 = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'OLLAMA',
        endpointType: EModelEndpoint.custom,
      });

      const result2 = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'OlLaMa',
        endpointType: EModelEndpoint.custom,
      });

      expect(result1).toEqual([]);
      expect(result2).toEqual([]);
    });

    it('should work without endpointType for standard endpoints but require it for custom', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: true,
              },
              ollama: {
                disabled: true,
              },
              default: {
                disabled: false,
                fileLimit: 10,
                fileSizeLimit: 20,
                totalSizeLimit: 50,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      /** Standard endpoint works without endpointType */
      const openaiResult = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });
      expect(openaiResult).toEqual([]);

      /** Custom endpoint with endpointType uses specific config */
      const customWithTypeResult = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });
      expect(customWithTypeResult).toEqual([]);

      /** Custom endpoint without endpointType tries direct lookup, falls back to default */
      const customWithoutTypeResult = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'unknownCustom',
      });
      expect(customWithoutTypeResult).toEqual(files);
    });
  });

  describe('edge cases', () => {
    it('should return empty array when files input is undefined', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const result = filterFilesByEndpointConfig(req, {
        files: undefined,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should return empty array when files input is empty array', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const result = filterFilesByEndpointConfig(req, {
        files: [],
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should handle custom provider strings', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              customProvider: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('test.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: 'customProvider',
        endpointType: EModelEndpoint.custom,
      });

      expect(result).toEqual([]);
    });
  });

  describe('bypass scenarios from bug report', () => {
    it('should block files when switching from enabled to disabled endpoint', () => {
      /**
       * Scenario: User attaches files under Anthropic (enabled),
       * then switches to OpenAI (disabled)
       */
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: true,
              },
              [Providers.ANTHROPIC]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [createMockFile('document.pdf')];

      /** Files were attached under Anthropic */
      const anthropicResult = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.ANTHROPIC,
      });
      expect(anthropicResult).toEqual(files);

      /** User switches to OpenAI - files should be filtered out */
      const openaiResult = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });
      expect(openaiResult).toEqual([]);
    });

    it('should prevent drag-and-drop bypass by filtering at agent initialization', () => {
      /**
       * Scenario: User drags file into disabled endpoint
       * Server processes it but filter should remove it
       */
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const draggedFiles = [createMockFile('dragged.pdf')];

      const result = filterFilesByEndpointConfig(req, {
        files: draggedFiles,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should filter multiple files when endpoint disabled', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: true,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        createMockFile('file1.pdf'),
        createMockFile('file2.pdf'),
        createMockFile('file3.pdf'),
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });
  });

  describe('file size filtering', () => {
    it('should filter out files exceeding fileSizeLimit', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                fileSizeLimit: 5 /** 5 MB in config (gets converted to bytes) */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const smallFile = {
        ...createMockFile('small.pdf'),
        bytes: 1024 * 1024 * 3 /** 3 MB */,
      } as IMongoFile;

      const largeFile = {
        ...createMockFile('large.pdf'),
        bytes: 1024 * 1024 * 10 /** 10 MB */,
      } as IMongoFile;

      const files = [smallFile, largeFile];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** Only small file should pass */
      expect(result).toEqual([smallFile]);
    });

    it('should keep all files when no fileSizeLimit is set', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('file1.pdf'), bytes: 1024 * 1024 * 100 } as IMongoFile,
        { ...createMockFile('file2.pdf'), bytes: 1024 * 1024 * 200 } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });

    it('should filter all files if all exceed fileSizeLimit', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                fileSizeLimit: 1 /** 1 MB */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('file1.pdf'), bytes: 1024 * 1024 * 5 } as IMongoFile,
        { ...createMockFile('file2.pdf'), bytes: 1024 * 1024 * 10 } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should handle fileSizeLimit of 0 as unlimited', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                fileSizeLimit: 0,
                totalSizeLimit: 0 /** Also set total limit to 0 for unlimited */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [{ ...createMockFile('huge.pdf'), bytes: 1024 * 1024 * 1000 } as IMongoFile];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** 0 means no limit, so file should pass */
      expect(result).toEqual(files);
    });
  });

  describe('MIME type filtering', () => {
    it('should filter out files with unsupported MIME types', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                supportedMimeTypes: ['^application/pdf$', '^image/png$'],
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const pdfFile = {
        ...createMockFile('doc.pdf'),
        type: 'application/pdf',
      } as IMongoFile;

      const pngFile = {
        ...createMockFile('image.png'),
        type: 'image/png',
      } as IMongoFile;

      const videoFile = {
        ...createMockFile('video.mp4'),
        type: 'video/mp4',
      } as IMongoFile;

      const files = [pdfFile, pngFile, videoFile];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** Only PDF and PNG should pass */
      expect(result).toEqual([pdfFile, pngFile]);
    });

    it('can preserve extracted-text sources that bypass provider MIME encoding', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: { supportedMimeTypes: ['^application/pdf$'] },
            },
          },
        },
      } as unknown as ServerRequest;
      const extractedText = {
        ...createMockFile('notes.txt'),
        source: FileSources.text,
        type: 'text/plain',
      } as IMongoFile;

      expect(
        filterFilesByEndpointConfig(req, {
          files: [extractedText],
          endpoint: Providers.OPENAI,
          preserveTextSources: true,
        }),
      ).toEqual([extractedText]);
    });

    it('should keep all files when supportedMimeTypes is not set', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('doc.pdf'), type: 'application/pdf' } as IMongoFile,
        { ...createMockFile('video.mp4'), type: 'video/mp4' } as IMongoFile,
        { ...createMockFile('audio.mp3'), type: 'audio/mp3' } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });

    it('should handle regex patterns for MIME type matching', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                supportedMimeTypes: ['^image/.*$'] /** All image types */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const jpegFile = {
        ...createMockFile('photo.jpg'),
        type: 'image/jpeg',
      } as IMongoFile;

      const pngFile = {
        ...createMockFile('graphic.png'),
        type: 'image/png',
      } as IMongoFile;

      const gifFile = {
        ...createMockFile('animation.gif'),
        type: 'image/gif',
      } as IMongoFile;

      const pdfFile = {
        ...createMockFile('doc.pdf'),
        type: 'application/pdf',
      } as IMongoFile;

      const files = [jpegFile, pngFile, gifFile, pdfFile];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** Only image files should pass */
      expect(result).toEqual([jpegFile, pngFile, gifFile]);
    });

    it('should filter all files if none match supported MIME types', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                supportedMimeTypes: ['^application/pdf$'],
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('video.mp4'), type: 'video/mp4' } as IMongoFile,
        { ...createMockFile('audio.mp3'), type: 'audio/mp3' } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual([]);
    });

    it('should handle empty supportedMimeTypes array', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                supportedMimeTypes: [],
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [{ ...createMockFile('doc.pdf'), type: 'application/pdf' } as IMongoFile];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** Empty array means allow all */
      expect(result).toEqual(files);
    });
  });

  describe('total size limit filtering', () => {
    it('can preserve aggregate survivors for explicit admission checks', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: { totalSizeLimit: 1 },
            },
          },
        },
      } as unknown as ServerRequest;
      const files = [
        { ...createMockFile('first.pdf'), bytes: 600_000 } as IMongoFile,
        { ...createMockFile('second.pdf'), bytes: 600_000 } as IMongoFile,
      ];

      expect(
        filterFilesByEndpointConfig(req, {
          files,
          endpoint: Providers.OPENAI,
          skipTotalSizeLimit: true,
        }),
      ).toEqual(files);
    });

    it('should filter files when total size exceeds totalSizeLimit', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                totalSizeLimit: 10 /** 10 MB total */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const file1 = {
        ...createMockFile('file1.pdf'),
        bytes: 1024 * 1024 * 4 /** 4 MB */,
      } as IMongoFile;

      const file2 = {
        ...createMockFile('file2.pdf'),
        bytes: 1024 * 1024 * 4 /** 4 MB */,
      } as IMongoFile;

      const file3 = {
        ...createMockFile('file3.pdf'),
        bytes: 1024 * 1024 * 4 /** 4 MB */,
      } as IMongoFile;

      const files = [file1, file2, file3];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** Only first two files should pass (8 MB total) */
      expect(result).toEqual([file1, file2]);
    });

    it('should keep all files when totalSizeLimit is not exceeded', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                totalSizeLimit: 20 /** 20 MB total */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('file1.pdf'), bytes: 1024 * 1024 * 5 } as IMongoFile,
        { ...createMockFile('file2.pdf'), bytes: 1024 * 1024 * 5 } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      expect(result).toEqual(files);
    });

    it('should handle totalSizeLimit of 0 as unlimited', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                totalSizeLimit: 0,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('file1.pdf'), bytes: 1024 * 1024 * 100 } as IMongoFile,
        { ...createMockFile('file2.pdf'), bytes: 1024 * 1024 * 100 } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** 0 means no limit */
      expect(result).toEqual(files);
    });

    it('should skip files that exceed totalSizeLimit and continue with remaining files', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                totalSizeLimit: 5 /** 5 MB total */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const files = [
        { ...createMockFile('large.pdf'), bytes: 1024 * 1024 * 10 } as IMongoFile,
        { ...createMockFile('small.pdf'), bytes: 1024 * 1024 * 1 } as IMongoFile,
      ];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** First file exceeds total limit, so it's skipped. Small file fits and is included. */
      expect(result).toEqual([files[1]]);
    });

    it('should keep files in order until total size limit is reached', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                totalSizeLimit: 7 /** 7 MB total */,
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const file1 = {
        ...createMockFile('file1.pdf'),
        bytes: 1024 * 1024 * 2 /** 2 MB */,
      } as IMongoFile;

      const file2 = {
        ...createMockFile('file2.pdf'),
        bytes: 1024 * 1024 * 3 /** 3 MB */,
      } as IMongoFile;

      const file3 = {
        ...createMockFile('file3.pdf'),
        bytes: 1024 * 1024 * 2 /** 2 MB */,
      } as IMongoFile;

      const file4 = {
        ...createMockFile('file4.pdf'),
        bytes: 1024 * 1024 * 1 /** 1 MB */,
      } as IMongoFile;

      const files = [file1, file2, file3, file4];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** file1 (2MB) + file2 (3MB) = 5MB ✓, + file3 (2MB) = 7MB ✓, + file4 would exceed */
      expect(result).toEqual([file1, file2, file3]);
    });
  });

  describe('combined filtering scenarios', () => {
    it('should apply size and MIME type filters together', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                fileSizeLimit: 5 /** 5 MB per file */,
                supportedMimeTypes: ['^application/pdf$', '^image/.*$'],
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const validPdf = {
        ...createMockFile('valid.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 3 /** 3 MB */,
      } as IMongoFile;

      const validImage = {
        ...createMockFile('valid.png'),
        type: 'image/png',
        bytes: 1024 * 1024 * 2 /** 2 MB */,
      } as IMongoFile;

      const tooLargePdf = {
        ...createMockFile('large.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 10 /** 10 MB - exceeds size limit */,
      } as IMongoFile;

      const wrongTypeVideo = {
        ...createMockFile('video.mp4'),
        type: 'video/mp4',
        bytes: 1024 * 1024 * 2 /** 2 MB - wrong MIME type */,
      } as IMongoFile;

      const files = [validPdf, validImage, tooLargePdf, wrongTypeVideo];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /** Only validPdf and validImage should pass both filters */
      expect(result).toEqual([validPdf, validImage]);
    });

    it('should apply all three filters together', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.OPENAI]: {
                disabled: false,
                fileSizeLimit: 5 /** 5 MB per file */,
                totalSizeLimit: 8 /** 8 MB total */,
                supportedMimeTypes: ['^application/pdf$'],
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const pdf1 = {
        ...createMockFile('pdf1.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 3 /** 3 MB */,
      } as IMongoFile;

      const pdf2 = {
        ...createMockFile('pdf2.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 4 /** 4 MB */,
      } as IMongoFile;

      const pdf3 = {
        ...createMockFile('pdf3.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 2 /** 2 MB */,
      } as IMongoFile;

      const largePdf = {
        ...createMockFile('large.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 10 /** 10 MB - exceeds individual size limit */,
      } as IMongoFile;

      const wrongType = {
        ...createMockFile('image.png'),
        type: 'image/png',
        bytes: 1024 * 1024 * 1 /** Wrong type */,
      } as IMongoFile;

      const files = [pdf1, pdf2, pdf3, largePdf, wrongType];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.OPENAI,
      });

      /**
       * largePdf filtered by size (10MB > 5MB limit)
       * wrongType filtered by MIME type
       * Remaining: pdf1 (3MB) + pdf2 (4MB) = 7MB ✓
       * pdf3 (2MB) would make total 9MB > 8MB limit, so filtered by total
       */
      expect(result).toEqual([pdf1, pdf2]);
    });

    it('should handle mixed validation with some files passing all checks', () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.ANTHROPIC]: {
                disabled: false,
                fileSizeLimit: 10,
                totalSizeLimit: 20,
                supportedMimeTypes: ['^application/.*$', '^text/.*$'],
              },
            },
          },
        },
      } as unknown as ServerRequest;

      const file1 = {
        ...createMockFile('doc.pdf'),
        type: 'application/pdf',
        bytes: 1024 * 1024 * 5,
      } as IMongoFile;

      const file2 = {
        ...createMockFile('text.txt'),
        type: 'text/plain',
        bytes: 1024 * 1024 * 8,
      } as IMongoFile;

      const file3 = {
        ...createMockFile('data.json'),
        type: 'application/json',
        bytes: 1024 * 1024 * 6,
      } as IMongoFile;

      const file4 = {
        ...createMockFile('video.mp4'),
        type: 'video/mp4',
        bytes: 1024 * 1024 * 3 /** Wrong MIME type */,
      } as IMongoFile;

      const files = [file1, file2, file3, file4];

      const result = filterFilesByEndpointConfig(req, {
        files,
        endpoint: Providers.ANTHROPIC,
      });

      /**
       * file4 filtered by MIME type
       * file1 (5MB) + file2 (8MB) = 13MB ✓
       * file3 (6MB) would make 19MB < 20MB ✓
       */
      expect(result).toEqual([file1, file2, file3]);
    });
  });
});
