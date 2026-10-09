import { EToolResources, mergeFileConfig } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import {
  canInspectUploadExtractedTextAfterProcessing,
  canInspectUploadTranscriptAfterProcessing,
  getBlockedUploadTranscriptField,
  isFileFilterFieldEnabled,
  contentFilterUninspectableResponse,
  getBlockedOpaqueFileField,
  getBlockedUninspectableFileField,
  getBlockedUninspectableSkillFileField,
  getCanonicalFileInspectionCoverage,
  getUploadExtractedTextPlan,
  hasActiveFileFieldPolicy,
  hasActiveFilePolicy,
  omitResolvedCanonicalFileLocators,
  resolveCanonicalFileReferences,
  resolveCanonicalFileReferenceUnits,
  UPLOAD_EXTRACTED_TEXT_PLANS,
  UninspectableFileError,
} from './files';
import { ContentTraversalLimitError } from './adapters/nested';

describe('file content inspection policy', () => {
  it('defers extracted-text fail-close only to supported agent context extraction paths', () => {
    const noConfiguredExtraction = mergeFileConfig({
      ocr: { supportedMimeTypes: [] },
      text: { supportedMimeTypes: [] },
    });
    const baseInput = {
      endpoint: 'agents',
      toolResource: EToolResources.context,
      fileConfig: noConfiguredExtraction,
      ocrConfigured: false,
      ragConfigured: false,
    };

    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/pdf',
      }),
    ).toBe(true);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe(true);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        endpoint: 'assistants',
        mimeType: 'application/pdf',
      }),
    ).toBe(false);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        toolResource: EToolResources.file_search,
        mimeType: 'application/pdf',
      }),
    ).toBe(false);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/x-unsupported',
      }),
    ).toBe(false);

    /* An explicitly narrowed text list names types the built-in parser does not handle.
     * Processing sends those to RAG with native fallback off and passes the result
     * through extractInspectableFileText, so the extraction step exists and fail-closing
     * here would reject an upload that does get inspected. */
    const configuredNonDocumentText = mergeFileConfig({
      ocr: { supportedMimeTypes: [] },
      text: { supportedMimeTypes: ['application/x-rag-document'] },
    });
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/x-rag-document',
        fileConfig: configuredNonDocumentText,
        ragConfigured: true,
      }),
    ).toBe(true);
    /* Only when RAG is actually configured: without it nothing extracts the type. */
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/x-rag-document',
        fileConfig: configuredNonDocumentText,
        ragConfigured: false,
      }),
    ).toBe(false);

    const defaultExtraction = mergeFileConfig(undefined);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/octet-stream',
        fileConfig: defaultExtraction,
        ragConfigured: true,
      }),
    ).toBe(false);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'audio/mpeg',
        fileConfig: defaultExtraction,
        ragConfigured: true,
      }),
    ).toBe(false);

    const configuredDocumentRAG = mergeFileConfig({
      ocr: { supportedMimeTypes: [] },
      text: { supportedMimeTypes: ['application/pdf'] },
    });
    expect(
      getUploadExtractedTextPlan({
        ...baseInput,
        mimeType: 'application/pdf',
        fileConfig: configuredDocumentRAG,
        ragConfigured: true,
      }),
    ).toBe(UPLOAD_EXTRACTED_TEXT_PLANS.configuredRAG);
    expect(
      getUploadExtractedTextPlan({
        ...baseInput,
        mimeType: 'application/pdf',
        fileConfig: configuredDocumentRAG,
      }),
    ).toBe(UPLOAD_EXTRACTED_TEXT_PLANS.documentParser);

    const configuredOCR = mergeFileConfig({
      ocr: { supportedMimeTypes: ['application/x-ocr-document'] },
      text: { supportedMimeTypes: [] },
    });
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/x-ocr-document',
        fileConfig: configuredOCR,
      }),
    ).toBe(false);
    expect(
      canInspectUploadExtractedTextAfterProcessing({
        ...baseInput,
        mimeType: 'application/x-ocr-document',
        fileConfig: configuredOCR,
        ocrConfigured: true,
      }),
    ).toBe(true);
  });

  it('defers transcript fail-close only to STT-supported non-assistant context uploads', () => {
    expect(
      canInspectUploadTranscriptAfterProcessing({
        endpoint: 'agents',
        toolResource: EToolResources.context,
        mimeType: 'audio/webm',
        sttSupported: true,
      }),
    ).toBe(true);
    expect(
      canInspectUploadTranscriptAfterProcessing({
        endpoint: 'assistants',
        toolResource: EToolResources.context,
        mimeType: 'audio/webm',
        sttSupported: true,
      }),
    ).toBe(false);
    expect(
      canInspectUploadTranscriptAfterProcessing({
        endpoint: 'agents',
        toolResource: EToolResources.file_search,
        mimeType: 'audio/webm',
        sttSupported: true,
      }),
    ).toBe(false);
    expect(
      canInspectUploadTranscriptAfterProcessing({
        endpoint: 'agents',
        toolResource: EToolResources.context,
        mimeType: 'audio/webm',
        sttSupported: false,
      }),
    ).toBe(false);
    expect(
      canInspectUploadTranscriptAfterProcessing({
        endpoint: 'agents',
        toolResource: EToolResources.context,
        mimeType: 'text/plain',
        sttSupported: true,
      }),
    ).toBe(false);
  });

  it('treats a text-delivery audio file as carrying its own transcript', () => {
    const coverage = getCanonicalFileInspectionCoverage({
      type: 'audio/mpeg',
      source: 'local',
      llmDeliveryPath: 'text',
      text: 'spoken words',
    });

    expect(coverage.transcript).toBe('spoken words');
    expect(coverage.textProvidesTranscript).toBe(true);
  });

  it('still requires provenance before treating audio text as a transcript', () => {
    const coverage = getCanonicalFileInspectionCoverage({
      type: 'audio/mpeg',
      source: 'local',
      text: 'spoken words',
    });

    expect(coverage.transcript).toBeUndefined();
  });

  it('keeps recognizing the legacy text source as provenance', () => {
    const coverage = getCanonicalFileInspectionCoverage({
      type: 'audio/mpeg',
      source: 'text',
      text: 'spoken words',
    });

    expect(coverage.transcript).toBe('spoken words');
  });

  it('rejects applicable audio when no downstream transcript inspection is available', () => {
    const filters = {
      files: { pii: { fields: ['transcript'], uninspectable: 'block' } },
    } as FiltersConfig;
    const baseInput = {
      filters,
      endpoint: 'agents',
      toolResource: EToolResources.context,
    };

    expect(
      getBlockedUploadTranscriptField({
        ...baseInput,
        mimeType: 'audio/x-unsupported',
        sttSupported: false,
      }),
    ).toBe('transcript');
    expect(
      getBlockedUploadTranscriptField({
        ...baseInput,
        mimeType: 'application/ogg',
        sttSupported: false,
      }),
    ).toBe('transcript');
    expect(
      getBlockedUploadTranscriptField({
        ...baseInput,
        mimeType: 'audio/webm',
        sttSupported: true,
      }),
    ).toBeNull();
    expect(
      getBlockedUploadTranscriptField({
        ...baseInput,
        mimeType: 'text/plain',
        sttSupported: false,
      }),
    ).toBeNull();
  });

  it('activates canonical file work only for patterns or selected fail-close content', () => {
    expect(hasActiveFilePolicy(undefined)).toBe(false);
    expect(
      hasActiveFilePolicy({
        files: { pii: { starterPatterns: [] } },
      } as FiltersConfig),
    ).toBe(false);
    expect(
      hasActiveFilePolicy({
        files: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            uninspectable: 'block',
          },
        },
      } as FiltersConfig),
    ).toBe(false);
    expect(
      hasActiveFilePolicy({
        files: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE' }],
          },
        },
      } as FiltersConfig),
    ).toBe(true);
    expect(
      hasActiveFilePolicy({
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            uninspectable: 'block',
          },
        },
      } as FiltersConfig),
    ).toBe(true);
  });

  it('activates only the selected enforceable file fields', () => {
    const nameOnly = {
      files: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE' }],
        },
      },
    } as FiltersConfig;
    expect(hasActiveFileFieldPolicy(nameOnly, ['name'])).toBe(true);
    expect(hasActiveFileFieldPolicy(nameOnly, ['content'])).toBe(false);
    expect(
      hasActiveFileFieldPolicy(
        {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        } as FiltersConfig,
        ['extracted_text'],
      ),
    ).toBe(true);
  });

  it('does not resolve canonical files for an explicitly inactive file policy', async () => {
    const getFiles = jest.fn().mockResolvedValue([]);
    const input = { files: [{ file_id: 'owned-file' }] };

    await expect(
      resolveCanonicalFileReferences({
        filters: {
          files: { pii: { starterPatterns: [] } },
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE' }],
            },
          },
        },
        input,
        user: { id: 'user-1' },
        getFiles,
      }),
    ).resolves.toEqual({
      sanitizedInput: input,
      hydratedFiles: [],
      hydratedFilters: expect.any(Object),
    });
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('treats omitted fields as every registered file field', () => {
    const filters = {
      files: { pii: { uninspectable: 'block' } },
    } as FiltersConfig;

    expect(isFileFilterFieldEnabled(filters, 'content')).toBe(true);
    expect(getBlockedUninspectableFileField(filters, ['content', 'extracted_text'])).toBe(
      'content',
    );
  });

  it('honors field granularity and the default allow policy', () => {
    const filters = {
      files: {
        pii: {
          fields: ['name'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(isFileFilterFieldEnabled(filters, 'name')).toBe(true);
    expect(isFileFilterFieldEnabled(filters, 'content')).toBe(false);
    expect(getBlockedUninspectableFileField(filters, ['content', 'transcript'])).toBeNull();
    expect(
      getBlockedUninspectableFileField(
        { files: { pii: { fields: ['content'] } } } as FiltersConfig,
        ['content'],
      ),
    ).toBeNull();
  });

  it('fails closed for selected skill file text independently of file compatibility mode', () => {
    const filters = {
      skills: {
        pii: {
          fields: ['file_text'],
        },
      },
      files: {
        pii: {
          fields: ['content'],
          uninspectable: 'allow',
        },
      },
    } as FiltersConfig;

    expect(getBlockedUninspectableSkillFileField(filters)).toBe('content');
    expect(
      getBlockedUninspectableSkillFileField({
        skills: { pii: { fields: ['file_name'] } },
      } as FiltersConfig),
    ).toBeNull();
    expect(
      getBlockedUninspectableSkillFileField({
        skills: { pii: { fields: ['file_text'], starterPatterns: [] } },
      } as FiltersConfig),
    ).toBeNull();
    expect(
      getBlockedUninspectableSkillFileField({
        skills: { pii: { action: 'audit', fields: ['file_text'] } },
      } as FiltersConfig),
    ).toBeNull();
    expect(
      getBlockedUninspectableSkillFileField({
        skills: { pii: { action: 'audit', fields: ['file_text'] } },
        files: { pii: { fields: ['content'], uninspectable: 'block' } },
      } as FiltersConfig),
    ).toBe('content');
  });

  it('returns a stable raw-free block response', () => {
    expect(contentFilterUninspectableResponse('transcript')).toEqual({
      error: 'content_filter_uninspectable',
      message: 'Submitted file content could not be inspected before processing.',
      source: 'file',
      field: 'transcript',
    });
  });

  it.each([
    {
      name: 'inline image data',
      input: { image_url: { url: 'data:image/png;base64,SECRET-IMAGE' } },
      field: 'content',
    },
    {
      name: 'remote image',
      input: { type: 'input_image', image_url: 'https://example.test/private.png' },
      field: 'content',
    },
    {
      name: 'file identifier',
      input: { type: 'input_file', file_id: 'file-private' },
      field: 'content',
    },
    {
      name: 'inline file data',
      input: { type: 'input_file', file_data: 'private-file-data' },
      field: 'content',
    },
    {
      name: 'inline audio',
      input: { type: 'input_audio', input_audio: { data: 'private-audio', format: 'wav' } },
      field: 'content',
    },
    {
      name: 'base64 document source',
      input: {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'private-document' },
      },
      field: 'content',
    },
    {
      name: 'untyped encoded data',
      input: { payload: { data: 'a'.repeat(128) } },
      field: 'content',
    },
    {
      name: 'Google fileData URI',
      input: {
        fileData: {
          fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          mimeType: 'video/mp4',
        },
      },
      field: 'content',
    },
    {
      name: 'Google snake-case file_data URI',
      input: {
        file_data: {
          file_uri: 'gs://private-bucket/video',
          mime_type: 'video/mp4',
        },
      },
      field: 'content',
    },
    {
      name: 'Mistral document URL',
      input: { type: 'document_url', document_url: 'https://example.test/report.pdf' },
      field: 'content',
    },
    {
      name: 'nested Mistral document URL',
      input: {
        type: 'document_url',
        document_url: { url: 'https://example.test/report.pdf' },
      },
      field: 'content',
    },
    {
      name: 'short provider-native audio media',
      input: { type: 'media', mimeType: 'audio/wav', data: 'short-audio' },
      field: 'content',
    },
  ])('detects opaque $name', ({ input, field }) => {
    const filters = {
      files: { pii: { uninspectable: 'block' } },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, input)).toBe(field);
  });

  it.each([
    ['file_ids', { tool_resources: { code_interpreter: { file_ids: ['file-1'] } } }],
    [
      'vector_store_ids',
      { tool_resources: { file_search: { vector_store_ids: ['vector-store-1'] } } },
    ],
  ])('detects opaque %s arrays', (_field, input) => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, input)).toBe('extracted_text');
  });

  it('preserves default allow behavior and explicit file-field granularity', () => {
    const remoteImage = { type: 'input_image', image_url: 'https://example.test/image.png' };
    const imageFile = { type: 'input_image', file_id: 'image-file-id' };
    const fileData = { type: 'input_file', file_data: 'private-file-data' };
    const inputAudio = { type: 'input_audio', input_audio: { data: 'private-audio' } };

    expect(
      getBlockedOpaqueFileField(
        { files: { pii: { fields: ['content'] } } } as FiltersConfig,
        remoteImage,
      ),
    ).toBeNull();
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['transcript'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        imageFile,
      ),
    ).toBeNull();
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['extracted_text'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        remoteImage,
      ),
    ).toBeNull();
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['extracted_text'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        fileData,
      ),
    ).toBe('extracted_text');
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['transcript'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        { type: 'media', mimeType: 'audio/wav', data: 'short-audio' },
      ),
    ).toBe('transcript');
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['extracted_text'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        { fileData: { fileUri: 'gs://bucket/file' } },
      ),
    ).toBe('extracted_text');
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['transcript'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        { fileData: { fileUri: 'gs://bucket/video', mimeType: 'video/mp4' } },
      ),
    ).toBeNull();
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['transcript'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        { file_data: { file_uri: 'gs://bucket/video', MIMEType: 'video/mp4' } },
      ),
    ).toBeNull();
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['transcript'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        inputAudio,
      ),
    ).toBe('transcript');
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['transcript'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        'data:audio/wav;base64,opaque-root-audio',
      ),
    ).toBe('transcript');
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: { fields: ['extracted_text'], uninspectable: 'block' },
          },
        } as FiltersConfig,
        [
          { image_url: 'data:image/png;base64,irrelevant-for-extracted-text' },
          { file_data: 'opaque-file-data' },
        ],
      ),
    ).toBe('extracted_text');
  });

  it('is cycle-safe and keeps the thrown response raw-free', () => {
    const input: { file?: unknown; file_id?: string } = {};
    input.file = input;
    input.file_id = 'file-do-not-echo';
    const filters = {
      files: { pii: { fields: ['extracted_text'], uninspectable: 'block' } },
    } as FiltersConfig;

    const field = getBlockedOpaqueFileField(filters, input);
    expect(field).toBe('extracted_text');
    const error = new UninspectableFileError(field ?? 'content');
    expect(error.body).toEqual({
      error: 'content_filter_uninspectable',
      message: 'Submitted file content could not be inspected before processing.',
      source: 'file',
      field: 'extracted_text',
    });
    expect(JSON.stringify(error.body)).not.toContain('file-do-not-echo');
  });

  it('fails closed when an opaque-content traversal exceeds its depth budget', () => {
    const input: { nested?: unknown } = {};
    let cursor = input;
    for (let index = 0; index < 30; index++) {
      const nested: { nested?: unknown } = {};
      cursor.nested = nested;
      cursor = nested;
    }
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, input)).toBe('extracted_text');
  });

  it('fails closed without materializing or scheduling an over-wide opaque object', () => {
    const input: Record<string, unknown> = {};
    for (let index = 0; index < 4_200; index++) {
      input[`field_${index}`] = { value: index };
    }
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, input)).toBe('extracted_text');
  });

  it('does not read opaque file ID arrays beyond the traversal budget', () => {
    const fileIds: unknown[] = Array.from({ length: 4_200 }, () => null);
    let overflowValueRead = false;
    Object.defineProperty(fileIds, '4096', {
      enumerable: true,
      get() {
        overflowValueRead = true;
        return 'PRIVATE-OVERFLOW';
      },
    });
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, { file_ids: fileIds })).toBe('extracted_text');
    expect(overflowValueRead).toBe(false);
  });

  it('fails closed for invalid opaque file-array lengths without dispatching iterators', () => {
    let iteratorReads = 0;
    const fileIds = new Proxy(['unread-file'], {
      get(target, property, receiver) {
        if (property === 'length') {
          return Number.NaN;
        }
        if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('file iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, { file_ids: fileIds })).toBe('extracted_text');
    expect(iteratorReads).toBe(0);
  });

  it('reads canonical file arrays numerically without dispatching custom iterators', async () => {
    let iteratorReads = 0;
    let numericReads = 0;
    const fileIds = new Proxy(['owned-file'], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('file iterator must not run');
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { file_ids: fileIds },
        user: { id: 'user-1' },
        getFiles: jest
          .fn()
          .mockResolvedValue([{ file_id: 'owned-file', text: 'Safe extracted text' }]),
      }),
    ).resolves.toMatchObject({ sanitizedInput: {} });
    expect(iteratorReads).toBe(0);
    expect(numericReads).toBeLessThanOrEqual(2);
  });

  it('rejects invalid canonical file-reference lengths before owner lookup', async () => {
    const fileIds = new Proxy(['owned-file'], {
      get(target, property, receiver) {
        return property === 'length' ? -1 : Reflect.get(target, property, receiver);
      },
    });
    const getFiles = jest.fn();
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { file_ids: fileIds },
        user: { id: 'user-1' },
        getFiles,
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('rejects an over-wide canonical-reference input before an owner lookup', async () => {
    const files = Array.from({ length: 4_200 }, (_, index) => ({
      file_id: `file-${index}`,
    }));
    const getFiles = jest.fn().mockResolvedValue([]);
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files },
        user: { id: 'user-1' },
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(getFiles).not.toHaveBeenCalled();
  });

  it.each(['name', 'uri'] as const)(
    'does not let an oversized non-file subtree reject %s-only file policy',
    async (field) => {
      const input = {
        messages: Array.from({ length: 4_200 }, (_, index) => ({
          text: `ordinary message ${index}`,
        })),
      };
      const getFiles = jest.fn();
      const filters = {
        files: {
          pii: {
            fields: [field],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-file-field',
                label: 'private file field',
                regex: 'PRIVATE-FILE-[A-Z]+',
              },
            ],
            uninspectable: 'block',
          },
        },
      } as FiltersConfig;

      await expect(
        resolveCanonicalFileReferences({
          filters,
          input,
          user: { id: 'user-1' },
          getFiles,
        }),
      ).resolves.toMatchObject({
        sanitizedInput: input,
        hydratedFiles: [],
      });
      expect(getFiles).not.toHaveBeenCalled();
    },
  );

  it.each(['name', 'uri'] as const)(
    'fails closed when an actual file subtree exceeds %s-only inspection bounds',
    async (field) => {
      const getFiles = jest.fn();
      const filters = {
        files: {
          pii: {
            fields: [field],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-file-field',
                label: 'private file field',
                regex: 'PRIVATE-FILE-[A-Z]+',
              },
            ],
          },
        },
      } as FiltersConfig;

      await expect(
        resolveCanonicalFileReferences({
          filters,
          input: {
            files: Array.from({ length: 4_200 }, (_, index) => ({
              file_id: `file-${index}`,
            })),
          },
          user: { id: 'user-1' },
          getFiles,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: { source: 'file', field },
      });
      expect(getFiles).not.toHaveBeenCalled();
    },
  );

  it('allows an oversized canonical file subtree for an audit-only policy', async () => {
    const input = {
      files: Array.from({ length: 4_200 }, (_, index) => ({
        file_id: `file-${index}`,
      })),
    };
    const getFiles = jest.fn();

    await expect(
      resolveCanonicalFileReferences({
        filters: {
          files: {
            pii: {
              action: 'audit',
              fields: ['uri'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private-file-field',
                  label: 'private file field',
                  regex: 'PRIVATE-FILE-[A-Z]+',
                },
              ],
            },
          },
        },
        input,
        user: { id: 'user-1' },
        getFiles,
      }),
    ).resolves.toMatchObject({ sanitizedInput: input, hydratedFiles: [] });
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('hydrates discovered file names without rejecting an unrelated oversized subtree', async () => {
    const onTraversalFailure = jest.fn();
    const canonicalFile = {
      file_id: 'owned-file',
      filename: 'safe-report.txt',
    };
    const input = {
      files: [{ file_id: canonicalFile.file_id }],
      messages: Array.from({ length: 4_200 }, (_, index) => ({
        text: `ordinary message ${index}`,
      })),
    };
    const getFiles = jest.fn().mockResolvedValue([canonicalFile]);
    const filters = {
      files: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-name',
              label: 'private name',
              regex: 'PRIVATE-NAME-[A-Z]+',
            },
          ],
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input,
        user: { id: 'user-1' },
        getFiles,
        onTraversalFailure,
        messageCount: input.messages.length,
      }),
    ).resolves.toMatchObject({
      sanitizedInput: input,
      hydratedFiles: [canonicalFile],
    });
    expect(onTraversalFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'omit_resolved_file_locators',
        reason: 'array_length',
        messageCount: 4200,
        resolvedFileCount: 1,
      }),
    );
    expect(getFiles).toHaveBeenCalledWith(
      { file_id: { $in: ['owned-file'] }, user: 'user-1' },
      {},
      {},
    );
  });

  it('fails closed when opaque-content enumeration fails', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('blocked enumeration');
        },
      },
    );
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    expect(getBlockedOpaqueFileField(filters, { content: hostile })).toBe('extracted_text');
    expect(
      getBlockedOpaqueFileField(
        {
          files: {
            pii: {
              fields: ['name'],
              uninspectable: 'block',
            },
          },
        } as FiltersConfig,
        { content: hostile },
      ),
    ).toBeNull();
  });

  it('owner-scopes and hydrates durable file references before opaque checks', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'report.txt',
        filepath: '/uploads/report.txt',
        text: 'safe extracted text',
      },
    ]);

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input: {
        files: [
          {
            file_id: 'owned-file',
            filepath: '/uploads/report.txt',
            type: 'text/plain',
          },
        ],
      },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      getFiles,
    });

    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['owned-file'] },
        user: 'user-1',
        tenantId: 'tenant-1',
      },
      {},
      {},
    );
    expect(inspection.sanitizedInput).toEqual({
      files: [{ type: 'text/plain' }],
    });
    expect(inspection.hydratedFiles).toEqual([
      expect.objectContaining({
        file_id: 'owned-file',
        text: 'safe extracted text',
      }),
    ]);
    expect(inspection.hydratedFilters?.files?.pii?.uninspectable).toBe('allow');
    expect(getBlockedOpaqueFileField(filters, inspection.sanitizedInput)).toBeNull();
  });

  it('ignores owner-query rows that were not referenced by the inspected input', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const ownedFile = {
      file_id: 'owned-file',
      filename: 'report.txt',
      text: 'safe extracted text',
    };

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'owned-file' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          ownedFile,
          {
            file_id: 'unrequested-file',
            filename: 'unrequested.pdf',
          },
        ]),
      }),
    ).resolves.toMatchObject({
      hydratedFiles: [ownedFile],
    });
  });

  it('does not authorize an unresolved live file identifier', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const getFiles = jest.fn().mockResolvedValue([]);

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'foreign-file' }] },
        user: { id: 'user-1', tenantId: 'tenant-1' },
        trustedLiveFiles: [
          {
            file_id: 'foreign-file',
            filepath: '/uploads/foreign.txt',
            text: 'apparently inspectable text',
          },
        ],
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'extracted_text',
      },
    });
    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['foreign-file'] },
        user: 'user-1',
        tenantId: 'tenant-1',
      },
      {},
      {},
    );
  });

  it('keeps unresolved live identifiers visible in compatibility mode', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'allow',
        },
      },
    } as FiltersConfig;
    const input = { files: [{ file_id: 'foreign-file' }] };

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input,
      user: { id: 'user-1' },
      trustedLiveFiles: [{ file_id: 'foreign-file', text: 'untrusted supplemental text' }],
      getFiles: jest.fn().mockResolvedValue([]),
    });

    expect(inspection.sanitizedInput).toBe(input);
    expect(inspection.hydratedFiles).toEqual([]);
  });

  it('supplements only an owner-resolved row without trusting live identity or locators', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const canonicalFile = {
      file_id: 'owned-file',
      filename: 'canonical.pdf',
      filepath: '/uploads/canonical.pdf',
      uri: '/api/files/owned-file',
      url: 'https://cdn.example.test/canonical.pdf',
      type: 'application/pdf',
      source: 'local',
    };

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input: {
        files: [{ file_id: canonicalFile.file_id, filepath: canonicalFile.filepath }],
      },
      user: { id: 'user-1' },
      trustedLiveFiles: [
        {
          file_id: canonicalFile.file_id,
          filename: 'forged.txt',
          filepath: '/api/files/untrusted',
          uri: '/api/files/untrusted',
          url: '/api/files/untrusted',
          preview: '/api/files/untrusted',
          type: 'text/plain',
          source: 'text',
          extractedText: 'safe supplemental text',
        },
      ],
      getFiles: jest.fn().mockResolvedValue([canonicalFile]),
    });

    expect(inspection.sanitizedInput).toEqual({ files: [{}] });
    expect(inspection.hydratedFiles).toEqual([
      expect.objectContaining({
        ...canonicalFile,
        extractedText: 'safe supplemental text',
      }),
    ]);
    expect(inspection.hydratedFiles[0]).not.toHaveProperty('preview');
  });

  it('prefers trusted runtime extraction fields while keeping canonical identity and locators', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const canonicalFile = {
      file_id: 'owned-file',
      filename: 'canonical.pdf',
      filepath: '/uploads/canonical.pdf',
      type: 'application/pdf',
      source: 'local',
      extractedText: 'stale durable text',
    };

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input: { files: [{ file_id: canonicalFile.file_id }] },
      user: { id: 'user-1' },
      trustedLiveFiles: [
        {
          file_id: canonicalFile.file_id,
          filename: 'forged.txt',
          filepath: '/api/files/untrusted',
          type: 'text/plain',
          source: 'text',
          extractedText: 'new runtime text',
        },
      ],
      getFiles: jest.fn().mockResolvedValue([canonicalFile]),
    });

    expect(inspection.hydratedFiles).toEqual([
      {
        ...canonicalFile,
        extractedText: 'new runtime text',
      },
    ]);
  });

  it('lets trusted runtime nulls clear stale durable extraction coverage', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'owned-file' }] },
        user: { id: 'user-1' },
        trustedLiveFiles: [
          {
            file_id: 'owned-file',
            extractedText: null,
            text: null,
          },
        ],
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'owned-file',
            filename: 'report.pdf',
            type: 'application/pdf',
            extractedText: 'stale durable text',
          },
        ]),
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
  });

  it('keeps live files without identifiers inspectable', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const liveFile = {
      filename: 'pending.txt',
      type: 'text/plain',
      source: 'text',
      text: 'safe pending text',
    };

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: {},
        user: { id: 'user-1' },
        trustedLiveFiles: [liveFile],
        getFiles: jest.fn().mockResolvedValue([]),
      }),
    ).resolves.toMatchObject({
      hydratedFiles: [liveFile],
    });
  });

  it.each([
    [
      'max_depth',
      () => {
        let value: object = {};
        for (let i = 0; i < 26; i++) value = { child: value };
        return value;
      },
    ],
    ['max_nodes', () => [...Array.from({ length: 2047 }, () => ({ child: {} })), {}, {}]],
    ['array_length', () => new Array(4096)],
    [
      'object_entries',
      () => Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [i, 'safe'])),
    ],
    [
      'reflection_error',
      () =>
        Object.defineProperty({}, 'payload', {
          enumerable: true,
          get() {
            throw new Error('PRIVATE-CONTENT');
          },
        }),
    ],
    [
      'reflection_error',
      () =>
        Object.defineProperty([], '0', {
          get() {
            throw new Error('PRIVATE-CONTENT');
          },
        }),
    ],
    [
      'reflection_error',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
  ] as const)('reports safe %s diagnostics for locator sanitization', (reason, makeInput) => {
    const report = jest.fn();
    let failure: ContentTraversalLimitError | undefined;
    try {
      omitResolvedCanonicalFileLocators(makeInput(), new Map([['owned', { file_id: 'owned' }]]), {
        onTraversalFailure: report,
        messageCount: 58,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ContentTraversalLimitError);
      failure = error as ContentTraversalLimitError;
    }
    expect(failure).toBeDefined();
    expect(failure?.diagnostics).toEqual({
      operation: 'omit_resolved_file_locators',
      reason,
      visitedNodes: expect.any(Number),
      depth: expect.any(Number),
    });
    expect(failure?.body).not.toHaveProperty('diagnostics');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      ...failure?.diagnostics,
      messageCount: 58,
      resolvedFileCount: 1,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE-CONTENT');
  });

  it('preserves own __proto__ opaque payloads in a null-prototype inspection copy', () => {
    const input = JSON.parse('{"file_id":"owned","__proto__":{"file_id":"unresolved"}}');
    const sanitized = omitResolvedCanonicalFileLocators(
      input,
      new Map([['owned', { file_id: 'owned' }]]),
    );
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(sanitized, '__proto__')).toBe(true);
    expect(
      getBlockedOpaqueFileField({ files: { pii: { uninspectable: 'block' } } }, sanitized),
    ).not.toBeNull();
  });

  it('omits only locators that exactly match the resolved canonical row', () => {
    const canonicalFile = {
      file_id: 'owned-file',
      filepath: '/uploads/report.txt',
      uri: 'https://files.example.test/report.txt',
      url: 'https://cdn.example.test/report.txt',
      preview: '/api/files/owned-file/preview',
    };
    const input = {
      files: [
        {
          file_id: canonicalFile.file_id,
          filepath: canonicalFile.filepath,
          uri: canonicalFile.uri,
          url: canonicalFile.url,
          preview: canonicalFile.preview,
          type: 'text/plain',
        },
      ],
    };

    const sanitized = omitResolvedCanonicalFileLocators(
      input,
      new Map([[canonicalFile.file_id, canonicalFile]]),
    );

    expect(sanitized).toEqual({
      files: [{ type: 'text/plain' }],
    });
    expect(input.files[0]).toEqual({
      file_id: 'owned-file',
      filepath: '/uploads/report.txt',
      uri: 'https://files.example.test/report.txt',
      url: 'https://cdn.example.test/report.txt',
      preview: '/api/files/owned-file/preview',
      type: 'text/plain',
    });
  });

  it.each([
    ['uri alias for preview', { uri: '/api/files/owned-file/preview' }],
    ['url alias for preview', { url: '/api/files/owned-file/preview' }],
    ['filepath alias for preview', { filepath: '/api/files/owned-file/preview' }],
    ['preview alias', { preview: '/api/files/owned-file/preview' }],
  ])('omits an exact canonical preview through the %s', (_name, locator) => {
    const canonicalFile = {
      file_id: 'owned-file',
      preview: '/api/files/owned-file/preview',
    };
    const input = {
      files: [{ file_id: canonicalFile.file_id, ...locator }],
    };

    expect(
      omitResolvedCanonicalFileLocators(input, new Map([[canonicalFile.file_id, canonicalFile]])),
    ).toEqual({ files: [{}] });
  });

  it.each([
    ['remote uri', { uri: 'https://attacker.example/private.txt' }],
    ['remote url', { url: 'https://attacker.example/private.txt' }],
    ['relative url', { url: '/api/files/untrusted' }],
    ['remote filepath', { filepath: 'https://attacker.example/private.txt' }],
    ['remote preview', { preview: 'https://attacker.example/private.txt' }],
    ['data URI', { uri: 'data:text/plain;base64,U0VDUkVU' }],
  ])('keeps a conflicting sibling %s visible to fail-close', async (_name, locator) => {
    const filters = {
      files: {
        pii: {
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const canonicalFile = {
      file_id: 'owned-file',
      filename: 'report.txt',
      filepath: '/uploads/report.txt',
      type: 'text/plain',
      source: 'text',
      text: 'safe canonical content',
    };
    const input = {
      files: [{ file_id: canonicalFile.file_id, ...locator }],
    };

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input,
      user: { id: 'user-1' },
      getFiles: jest.fn().mockResolvedValue([canonicalFile]),
    });

    expect(inspection.sanitizedInput).toEqual({
      files: [locator],
    });
    expect(getBlockedOpaqueFileField(filters, inspection.sanitizedInput)).toBe('content');
    expect(input.files[0]).toEqual({ file_id: 'owned-file', ...locator });
  });

  it('preserves conflicting locators without resolving an inactive allow policy', async () => {
    const filters = {
      files: {
        pii: {
          starterPatterns: [],
        },
      },
    } as FiltersConfig;
    const canonicalFile = {
      file_id: 'owned-file',
      filename: 'report.txt',
      filepath: '/uploads/report.txt',
      text: 'safe canonical content',
    };
    const input = {
      files: [
        {
          file_id: canonicalFile.file_id,
          uri: 'https://attacker.example/private.txt',
        },
      ],
    };
    const getFiles = jest.fn().mockResolvedValue([canonicalFile]);

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input,
      user: { id: 'user-1' },
      getFiles,
    });

    expect(inspection.sanitizedInput).toBe(input);
    expect(getFiles).not.toHaveBeenCalled();
    expect(getBlockedOpaqueFileField(filters, inspection.sanitizedInput)).toBeNull();
  });

  it('remains cycle-safe and does not mutate locator-bearing input', () => {
    const file: {
      file_id: string;
      filepath: string;
      uri: string;
      self?: unknown;
    } = {
      file_id: 'owned-file',
      filepath: '/uploads/report.txt',
      uri: 'https://attacker.example/private.txt',
    };
    file.self = file;
    const input = { file };

    const sanitized = omitResolvedCanonicalFileLocators(
      input,
      new Map([
        [
          'owned-file',
          {
            file_id: 'owned-file',
            filepath: '/uploads/report.txt',
          },
        ],
      ]),
    );

    expect(sanitized).not.toBe(input);
    expect(sanitized.file).not.toBe(file);
    expect(sanitized.file).toMatchObject({
      uri: 'https://attacker.example/private.txt',
    });
    expect(sanitized.file.self).toBe(sanitized.file);
    expect(file).toMatchObject({
      file_id: 'owned-file',
      filepath: '/uploads/report.txt',
      uri: 'https://attacker.example/private.txt',
    });
    expect(file.self).toBe(file);
  });

  it('always omits resolved IDs from file_ids arrays while preserving unresolved IDs', () => {
    const input = {
      tool_resources: {
        file_search: {
          file_ids: ['owned-file', 'unresolved-file'],
        },
      },
    };

    expect(
      omitResolvedCanonicalFileLocators(
        input,
        new Map([['owned-file', { file_id: 'owned-file' }]]),
      ),
    ).toEqual({
      tool_resources: {
        file_search: {
          file_ids: ['unresolved-file'],
        },
      },
    });
    expect(input.tool_resources.file_search.file_ids).toEqual(['owned-file', 'unresolved-file']);
  });

  it('reuses an inspected text upload when every file field is enabled fail-closed', async () => {
    const filters = {
      files: {
        pii: {
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const canonicalTextFile = {
      file_id: 'owned-text-file',
      filename: 'notes.txt',
      filepath: '/uploads/notes.txt',
      type: 'text/plain',
      source: 'text',
      text: 'safe submitted text',
    };

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: {
          files: [{ file_id: canonicalTextFile.file_id }],
        },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([canonicalTextFile]),
      }),
    ).resolves.toMatchObject({
      sanitizedInput: { files: [{}] },
      hydratedFiles: [canonicalTextFile],
    });
  });

  it('keeps raw binary content fail-closed when a legacy preview text is present', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['content'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'legacy-binary-file' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'legacy-binary-file',
            filename: 'report.pdf',
            type: 'application/pdf',
            source: 'local',
            text: 'legacy preview text',
          },
        ]),
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'content',
      },
    });
  });

  it.each([
    ['empty canonical extracted text', { extractedText: '' }],
    ['whitespace-only canonical extracted text', { extractedText: ' \n\t' }],
    ['empty canonical text fallback', { text: '' }],
    ['whitespace-only canonical text fallback', { text: ' \n\t' }],
  ])('keeps %s fail-closed for persisted document reuse', async (_label, extractionFields) => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'blank-extraction-document' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'blank-extraction-document',
            filename: 'report.pdf',
            type: 'application/pdf',
            ...extractionFields,
          },
        ]),
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'extracted_text',
      },
    });
  });

  it('keeps audio transcripts fail-closed without text-extraction provenance', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'legacy-audio-file' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'legacy-audio-file',
            filename: 'recording.webm',
            type: 'audio/webm',
            source: 'local',
            text: 'unclassified legacy text',
          },
        ]),
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'transcript',
      },
    });
  });

  it.each([
    ['empty canonical transcript', { transcript: '' }],
    ['whitespace-only canonical transcript', { transcript: ' \n\t' }],
    ['empty canonical text fallback', { source: 'text', text: '' }],
    ['whitespace-only canonical text fallback', { source: 'text', text: ' \n\t' }],
  ])('keeps %s fail-closed for persisted audio reuse', async (_label, transcriptFields) => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'blank-transcript-audio' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'blank-transcript-audio',
            filename: 'recording.webm',
            type: 'audio/webm',
            ...transcriptFields,
          },
        ]),
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'transcript',
      },
    });
  });

  it('treats application/ogg text provenance as an inspectable audio transcript', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'ogg-audio-file' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'ogg-audio-file',
            filename: 'recording.ogg',
            type: 'application/ogg',
            source: 'text',
            text: 'safe transcript',
          },
        ]),
      }),
    ).resolves.toMatchObject({
      hydratedFiles: [expect.objectContaining({ text: 'safe transcript' })],
    });
  });

  it.each([undefined, '', 'not-a-mime'])(
    'keeps transcript policy fail-closed for unknown MIME %p',
    async (type) => {
      const filters = {
        files: {
          pii: {
            fields: ['transcript'],
            starterPatterns: [],
            uninspectable: 'block',
          },
        },
      } as FiltersConfig;

      await expect(
        resolveCanonicalFileReferences({
          filters,
          input: { files: [{ file_id: 'unknown-media' }] },
          user: { id: 'user-1' },
          getFiles: jest.fn().mockResolvedValue([
            {
              file_id: 'unknown-media',
              filename: 'media.bin',
              type,
            },
          ]),
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: { source: 'file', field: 'transcript' },
      });
    },
  );

  it('exempts a known non-audio MIME from transcript coverage', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: { files: [{ file_id: 'known-document' }] },
        user: { id: 'user-1' },
        getFiles: jest.fn().mockResolvedValue([
          {
            file_id: 'known-document',
            filename: 'report.pdf',
            type: 'application/pdf',
          },
        ]),
      }),
    ).resolves.toMatchObject({
      sanitizedInput: { files: [{}] },
    });
  });

  it('resolves canonical file_ids arrays but leaves unresolved opaque IDs fail-closed', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'report.txt',
        filepath: '/uploads/report.txt',
        text: 'safe extracted text',
      },
    ]);

    await expect(
      resolveCanonicalFileReferences({
        filters,
        input: {
          tool_resources: {
            file_search: {
              file_ids: ['owned-file', 'unresolved-file'],
            },
          },
        },
        user: { id: 'user-1' },
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'extracted_text',
      },
    });
  });

  it('does not let a resolved file ID hide a sibling opaque payload', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;

    const inspection = await resolveCanonicalFileReferences({
      filters,
      input: {
        files: [{ file_id: 'owned-file' }, { file_data: 'opaque-file-data' }],
      },
      user: { id: 'user-1' },
      getFiles: jest.fn().mockResolvedValue([
        {
          file_id: 'owned-file',
          filename: 'report.txt',
          filepath: '/uploads/report.txt',
          text: 'safe extracted text',
        },
      ]),
    });

    expect(getBlockedOpaqueFileField(filters, inspection.sanitizedInput)).toBe('extracted_text');
  });
});

describe('canonical file inspection units', () => {
  const filters: FiltersConfig = {
    files: {
      pii: {
        fields: ['extracted_text'],
        starterPatterns: [],
        uninspectable: 'block',
      },
    },
  };

  it('retains a single oversized-unit rejection before owner lookup', async () => {
    const getFiles = jest.fn(async () => [{ file_id: 'owned', text: 'safe' }]);
    await expect(
      resolveCanonicalFileReferenceUnits({
        filters,
        user: { id: 'owner' },
        getFiles,
        input: [
          {
            files: [{ file_id: 'owned' }],
            content: Array.from({ length: 4200 }, () => ({ text: 'safe' })),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('does not dispatch array map or iterators while sanitizing units', async () => {
    const units = [{ file_id: 'owned' }, { file_id: 'missing' }];
    const map = jest.fn(() => []);
    const iterator = jest.fn(() => {
      throw new Error('iterator must not execute');
    });
    Object.defineProperty(units, 'map', { value: map });
    Object.defineProperty(units, Symbol.iterator, { value: iterator });
    const input = {
      filters,
      input: units,
      user: { id: 'owner' },
      getFiles: jest.fn(async () => [{ file_id: 'owned', text: 'safe' }]),
    };
    await expect(resolveCanonicalFileReferenceUnits(input)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
    });
    units.pop();
    await expect(resolveCanonicalFileReferenceUnits(input)).resolves.toMatchObject({
      sanitizedInput: [{}],
    });
    expect(map).not.toHaveBeenCalled();
    expect(iterator).not.toHaveBeenCalled();
  });
});
