import {
  FileSources,
  mergeFileConfig,
  EModelEndpoint,
  getEndpointFileConfig,
  isBedrockDocumentType,
} from 'librechat-data-provider';
import type { FileConfig, EndpointFileConfig } from 'librechat-data-provider';
import { isProviderDocumentCandidate } from './utils';

/**
 * Mirrors the categorization logic from BaseClient.processAttachments.
 * Extracted here for testability since the /api workspace test setup is broken.
 */
function categorizeFile(
  file: {
    type?: string | null;
    source?: string;
    embedded?: boolean;
    metadata?: { fileIdentifier?: string; codeEnvRef?: unknown };
    llmDeliveryPath?: 'provider' | 'text' | 'none';
  },
  isBedrock: boolean,
  mergedFileConfig: FileConfig | undefined,
  endpointFileConfig: EndpointFileConfig | undefined,
): 'images' | 'documents' | 'videos' | 'audios' | 'skipped' {
  const source = file.source ?? FileSources.local;
  if (source === FileSources.text) {
    return 'skipped';
  }
  if (file.llmDeliveryPath === 'text' || file.llmDeliveryPath === 'none') {
    return 'skipped';
  }
  if (
    file.embedded === true ||
    file.metadata?.codeEnvRef != null ||
    file.metadata?.fileIdentifier != null
  ) {
    return 'skipped';
  }

  if (file.type?.startsWith('image/')) {
    return 'images';
  } else if (file.type === 'application/pdf') {
    return 'documents';
  } else if (isBedrock && file.type && isBedrockDocumentType(file.type)) {
    return 'documents';
  } else if (file.type?.startsWith('video/')) {
    return 'videos';
  } else if (file.type?.startsWith('audio/')) {
    return 'audios';
  } else if (
    isProviderDocumentCandidate(file.type, mergedFileConfig, endpointFileConfig?.supportedMimeTypes)
  ) {
    return 'documents';
  }

  return 'skipped';
}

describe('processAttachments — supportedMimeTypes routing logic', () => {
  const endpoint = EModelEndpoint.openAI;

  function resolveConfig(mimePatterns: string[]) {
    const merged = mergeFileConfig({
      endpoints: {
        [endpoint]: { supportedMimeTypes: mimePatterns },
      },
    });
    const epConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint,
    });
    return { merged, epConfig };
  }

  it('should route text/csv to documents when supportedMimeTypes includes it', () => {
    const { merged, epConfig } = resolveConfig(['text/csv']);
    const result = categorizeFile({ type: 'text/csv' }, false, merged, epConfig);
    expect(result).toBe('documents');
  });

  it('should route text/plain to documents when supportedMimeTypes uses wildcard', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile({ type: 'text/plain' }, false, merged, epConfig);
    expect(result).toBe('documents');
  });

  it('should skip application/zip when supportedMimeTypes only allows text types', () => {
    const { merged, epConfig } = resolveConfig(['text/csv', 'text/plain']);
    const result = categorizeFile({ type: 'application/zip' }, false, merged, epConfig);
    expect(result).toBe('skipped');
  });

  it('should skip files when no fileConfig is provided', () => {
    const result = categorizeFile({ type: 'text/csv' }, false, undefined, undefined);
    expect(result).toBe('skipped');
  });

  it('should skip files with null type even with permissive config', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile({ type: null }, false, merged, epConfig);
    expect(result).toBe('skipped');
  });

  it('should skip files with undefined type even with permissive config', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile({ type: undefined }, false, merged, epConfig);
    expect(result).toBe('skipped');
  });

  it('should still route image types through images category (not documents)', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    expect(categorizeFile({ type: 'image/png' }, false, merged, epConfig)).toBe('images');
  });

  it('should still route PDF through documents (dedicated branch)', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    expect(categorizeFile({ type: 'application/pdf' }, false, merged, epConfig)).toBe('documents');
  });

  it('should still route video types through videos category', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    expect(categorizeFile({ type: 'video/mp4' }, false, merged, epConfig)).toBe('videos');
  });

  it('should still route audio types through audios category', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    expect(categorizeFile({ type: 'audio/mp3' }, false, merged, epConfig)).toBe('audios');
  });

  it('should route Bedrock document types through documents for Bedrock provider', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    expect(categorizeFile({ type: 'text/csv' }, true, merged, epConfig)).toBe('documents');
  });

  it('should route non-Bedrock-document types for Bedrock when config allows them', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    expect(categorizeFile({ type: 'application/zip' }, true, merged, epConfig)).toBe('documents');
  });

  it('should route xlsx to documents with matching config', () => {
    const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const { merged, epConfig } = resolveConfig([xlsxType]);
    expect(categorizeFile({ type: xlsxType }, false, merged, epConfig)).toBe('documents');
  });

  it('should skip text source files regardless of config', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile(
      { type: 'text/csv', source: FileSources.text },
      false,
      merged,
      epConfig,
    );
    expect(result).toBe('skipped');
  });

  it('should skip text-delivery markdown files regardless of config', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile(
      { type: 'text/markdown', llmDeliveryPath: 'text' },
      false,
      merged,
      epConfig,
    );
    expect(result).toBe('skipped');
  });

  it('should skip none-delivery markdown files regardless of config', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile(
      { type: 'text/markdown', llmDeliveryPath: 'none' },
      false,
      merged,
      epConfig,
    );
    expect(result).toBe('skipped');
  });

  it('should skip embedded files regardless of config', () => {
    const { merged, epConfig } = resolveConfig(['.*']);
    const result = categorizeFile({ type: 'text/csv', embedded: true }, false, merged, epConfig);
    expect(result).toBe('skipped');
  });

  describe('inherited default supportedMimeTypes', () => {
    /** An endpoint with no `supportedMimeTypes` of its own inherits the built-in list. */
    const inherited = () => {
      const merged = mergeFileConfig({ endpoints: { [endpoint]: { fileLimit: 5 } } });
      return { merged, epConfig: getEndpointFileConfig({ fileConfig: merged, endpoint }) };
    };

    it.each([
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/epub+zip',
    ])('does not opt archive %s into the provider document path', (type) => {
      const { merged, epConfig } = inherited();
      expect(merged.checkType?.(type, epConfig?.supportedMimeTypes ?? [])).toBe(true);
      expect(categorizeFile({ type }, false, merged, epConfig)).toBe('skipped');
    });

    it.each([
      'application/sql',
      'application/x-sh',
      'application/json',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ])('keeps routing %s to documents', (type) => {
      const { merged, epConfig } = inherited();
      expect(categorizeFile({ type }, false, merged, epConfig)).toBe('documents');
    });

    it('keeps images, PDF, audio and video on their own branches', () => {
      const { merged, epConfig } = inherited();
      expect(categorizeFile({ type: 'image/png' }, false, merged, epConfig)).toBe('images');
      expect(categorizeFile({ type: 'application/pdf' }, false, merged, epConfig)).toBe(
        'documents',
      );
      expect(categorizeFile({ type: 'audio/mp3' }, false, merged, epConfig)).toBe('audios');
      expect(categorizeFile({ type: 'video/mp4' }, false, merged, epConfig)).toBe('videos');
    });

    it('keeps Bedrock document types for Bedrock', () => {
      const { merged, epConfig } = inherited();
      const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      expect(categorizeFile({ type: docx }, true, merged, epConfig)).toBe('documents');
    });
  });

  it('should skip textual types an explicit allowlist leaves out', () => {
    const { merged, epConfig } = resolveConfig(['^image/.*', '^application/pdf$']);
    expect(categorizeFile({ type: 'application/sql' }, false, merged, epConfig)).toBe('skipped');
  });

  it('should route zip to documents when an explicit allowlist lists it', () => {
    const { merged, epConfig } = resolveConfig(['^application/zip$']);
    expect(categorizeFile({ type: 'application/zip' }, false, merged, epConfig)).toBe('documents');
  });
});
