import type { MimeUploadCapability } from './file-config';
import type { FileConfig } from './types/files';
import {
  fileConfig as baseFileConfig,
  fileConfigSchema,
  resolveEffectiveUseResponsesApi,
  isAnthropicTextDocumentType,
  getConfiguredMimeAccept,
  getDocumentFileExtension,
  bedrockDocumentMimeTypes,
  isAnthropicDocumentType,
  isPermissiveMimeConfig,
  isExplicitMimeConfig,
  convertStringsToRegex,
  setFileConfigRegexCompiler,
  documentParserMimeTypes,
  getEndpointFileConfig,
  applicationMimeTypes,
  defaultOCRMimeTypes,
  supportedMimeTypes,
  mergeFileConfig,
  inferMimeType,
  textMimeTypes,
} from './file-config';
import { resolveDefaultLLMDeliveryPath } from './resolve-llm-delivery-path';
import { EModelEndpoint } from './schemas';

describe('inferMimeType', () => {
  it('should normalize text/x-python-script to text/x-python', () => {
    expect(inferMimeType('test.py', 'text/x-python-script')).toBe('text/x-python');
  });

  it('should normalize text/x-markdown to text/markdown', () => {
    expect(inferMimeType('test.md', 'text/x-markdown')).toBe('text/markdown');
  });

  it('should normalize application/x-zip-compressed to application/zip', () => {
    expect(inferMimeType('archive.zip', 'application/x-zip-compressed')).toBe('application/zip');
  });

  it('should normalize application/x-shellscript to application/x-sh', () => {
    expect(inferMimeType('test.sh', 'application/x-shellscript')).toBe('application/x-sh');
  });

  it('should normalize text/x-shellscript to application/x-sh', () => {
    expect(inferMimeType('test.sh', 'text/x-shellscript')).toBe('application/x-sh');
  });

  it('should return a type that matches textMimeTypes after normalization', () => {
    const normalized = inferMimeType('test.py', 'text/x-python-script');
    expect(textMimeTypes.test(normalized)).toBe(true);
  });

  it('should pass through standard browser types unchanged', () => {
    expect(inferMimeType('test.py', 'text/x-python')).toBe('text/x-python');
    expect(inferMimeType('doc.pdf', 'application/pdf')).toBe('application/pdf');
  });

  it('should infer from extension when browser type is empty', () => {
    expect(inferMimeType('test.py', '')).toBe('text/x-python');
    expect(inferMimeType('code.js', '')).toBe('text/javascript');
    expect(inferMimeType('archive.zip', '')).toBe('application/zip');
    expect(inferMimeType('photo.heic', '')).toBe('image/heic');
    expect(inferMimeType('Main.java', '')).toBe('text/x-java');
  });

  it('should return empty string for unknown extension with no browser type', () => {
    expect(inferMimeType('file.xyz', '')).toBe('');
  });

  it('should produce a type accepted by checkType after normalizing text/x-python-script', () => {
    const normalized = inferMimeType('test.py', 'text/x-python-script');
    expect(baseFileConfig.checkType(normalized)).toBe(true);
  });

  it('should produce a type accepted by checkType after normalizing text/x-markdown', () => {
    const normalized = inferMimeType('test.md', 'text/x-markdown');
    expect(baseFileConfig.checkType(normalized)).toBe(true);
  });

  it.each(['application/x-shellscript', 'text/x-shellscript'])(
    'should produce a type accepted by checkType after normalizing %s',
    (browserType) => {
      expect(baseFileConfig.checkType(inferMimeType('test.sh', browserType))).toBe(true);
    },
  );

  it.each(['application/x-shellscript', 'text/x-shellscript'])(
    'should reject raw %s without normalization',
    (browserType) => {
      expect(baseFileConfig.checkType(browserType)).toBe(false);
    },
  );

  it('should reject raw text/x-python-script without normalization', () => {
    expect(baseFileConfig.checkType('text/x-python-script')).toBe(false);
  });

  it('should reject raw text/x-markdown without normalization', () => {
    expect(baseFileConfig.checkType('text/x-markdown')).toBe(false);
  });

  it('should infer message/rfc822 from extension when browser type is empty', () => {
    expect(inferMimeType('email.eml', '')).toBe('message/rfc822');
  });

  it('should pass through message/rfc822 when browser reports it', () => {
    expect(inferMimeType('email.eml', 'message/rfc822')).toBe('message/rfc822');
  });

  it('should produce a type accepted by checkType for .eml files', () => {
    const normalized = inferMimeType('test.eml', '');
    expect(baseFileConfig.checkType(normalized)).toBe(true);
  });

  it('infers Office MIME types from extension when the browser reports none', () => {
    expect(inferMimeType('legacy.doc', '')).toBe('application/msword');
    expect(inferMimeType('report.docx', '')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(inferMimeType('legacy.xls', '')).toBe('application/vnd.ms-excel');
    expect(inferMimeType('sheet.xlsx', '')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(inferMimeType('deck.pptx', '')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(inferMimeType('template.potx', '')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.template',
    );
  });

  it('produces Office types accepted by checkType after inference', () => {
    expect(baseFileConfig.checkType(inferMimeType('report.docx', ''))).toBe(true);
    expect(baseFileConfig.checkType(inferMimeType('sheet.xlsx', ''))).toBe(true);
    expect(baseFileConfig.checkType(inferMimeType('legacy.doc', ''))).toBe(true);
    expect(baseFileConfig.checkType(inferMimeType('template.potx', ''))).toBe(true);
  });
});

describe('applicationMimeTypes', () => {
  const odfTypes = [
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
  ];

  it.each(odfTypes)('matches ODF type: %s', (mimeType) => {
    expect(applicationMimeTypes.test(mimeType)).toBe(true);
  });

  const existingTypes = [
    'application/pdf',
    'application/json',
    'application/csv',
    'application/msword',
    'application/xml',
    'application/zip',
    'application/x-zip-compressed',
    'application/epub+zip',
    'application/x-tar',
    'application/x-sh',
    'application/typescript',
    'application/sql',
    'application/yaml',
    'application/x-parquet',
    'application/vnd.apache.parquet',
    'application/vnd.coffeescript',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  it.each(existingTypes)('matches existing type: %s', (mimeType) => {
    expect(applicationMimeTypes.test(mimeType)).toBe(true);
  });

  const invalidTypes = [
    'application/vnd.oasis.opendocument.text-template',
    'application/vnd.oasis.opendocument.texts',
    'application/vnd.oasis.opendocument.chart',
    'application/vnd.oasis.opendocument.formula',
    'application/vnd.oasis.opendocument.image',
    'application/vnd.oasis.opendocument.text-master',
    'text/plain',
    'image/png',
  ];

  it.each(invalidTypes)('does not match invalid type: %s', (mimeType) => {
    expect(applicationMimeTypes.test(mimeType)).toBe(false);
  });
});

describe('defaultOCRMimeTypes', () => {
  const checkOCRType = (mimeType: string): boolean =>
    defaultOCRMimeTypes.some((regex) => regex.test(mimeType));

  it.each([
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
    'application/vnd.openxmlformats-officedocument.presentationml.template',
  ])('matches configured OCR type: %s', (mimeType) => {
    expect(checkOCRType(mimeType)).toBe(true);
  });
});

describe('supportedMimeTypes', () => {
  const checkSupported = (mimeType: string): boolean =>
    supportedMimeTypes.some((regex) => regex.test(mimeType));

  it.each([
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
    'application/vnd.openxmlformats-officedocument.presentationml.template',
  ])('document type flows through supportedMimeTypes: %s', (mimeType) => {
    expect(checkSupported(mimeType)).toBe(true);
  });

  it('message/rfc822 (.eml) flows through supportedMimeTypes', () => {
    expect(checkSupported('message/rfc822')).toBe(true);
  });
});

describe('documentParserMimeTypes', () => {
  const check = (mimeType: string): boolean =>
    documentParserMimeTypes.some((regex) => regex.test(mimeType));

  it.each([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/msexcel',
    'application/x-msexcel',
    'application/x-ms-excel',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.text',
  ])('matches natively parseable type: %s', (mimeType) => {
    expect(check(mimeType)).toBe(true);
  });

  it.each([
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
    'text/plain',
    'image/png',
  ])('does not match OCR-only or unsupported type: %s', (mimeType) => {
    expect(check(mimeType)).toBe(false);
  });
});

describe('isAnthropicDocumentType', () => {
  it.each([
    'application/pdf',
    'text/plain',
    'text/html',
    'text/markdown',
    'text/csv',
    'text/x-python',
    'application/json',
    'application/xml',
    'application/yaml',
    'application/sql',
    'application/csv',
  ])('accepts type the Anthropic document path can send: %s', (mimeType) => {
    expect(isAnthropicDocumentType(mimeType)).toBe(true);
  });

  it.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.ms-excel',
    'application/epub+zip',
    'application/zip',
    'application/vnd.apache.parquet',
    'image/png',
    '',
  ])('rejects type Anthropic would 400 on: %s', (mimeType) => {
    expect(isAnthropicDocumentType(mimeType)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAnthropicDocumentType(undefined)).toBe(false);
  });

  it('excludes PDF from the plain-text subset', () => {
    expect(isAnthropicTextDocumentType('application/pdf')).toBe(false);
    expect(isAnthropicTextDocumentType('text/plain')).toBe(true);
  });
});

describe('getEndpointFileConfig', () => {
  describe('custom endpoint lookup', () => {
    it('should find custom endpoint by direct lookup', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          ollama: {
            disabled: true,
            fileLimit: 5,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(5);
    });

    it('should find custom endpoint by normalized lookup', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          ollama: {
            disabled: true,
            fileLimit: 7,
          },
        },
      };

      /** Test with non-normalized name */
      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'Ollama',
        endpointType: EModelEndpoint.custom,
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(7);
    });

    it('should fallback to generic custom config when specific endpoint not found', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.custom]: {
            disabled: false,
            fileLimit: 3,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'unknownCustomEndpoint',
        endpointType: EModelEndpoint.custom,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(3);
    });

    it('should fallback to agents config when custom and specific endpoint not found', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.agents]: {
            disabled: false,
            fileLimit: 8,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'unknownCustomEndpoint',
        endpointType: EModelEndpoint.custom,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(8);
    });

    it('should use base agents config when only default is dynamically configured', () => {
      const dynamicConfig = {
        endpoints: {
          default: {
            disabled: false,
            fileLimit: 12,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: 'unknownCustomEndpoint',
        endpointType: EModelEndpoint.custom,
      });

      /**
       * Should use base agents config (fileLimit: 10) since it exists in baseFileConfig
       * and custom endpoints fall back to agents
       */
      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(10); /** From baseFileConfig.endpoints.agents */
    });

    it('should prioritize specific custom endpoint over generic custom config', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.custom]: {
            disabled: false,
            fileLimit: 20,
          },
          ollama: {
            disabled: true,
            fileLimit: 3,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });

      /** Should use ollama config, not generic custom */
      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(3);
    });

    it('should skip standard endpoint keys in normalized lookup', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          default: {
            disabled: false,
            fileLimit: 99,
          },
        },
      };

      /** "default" should not match via normalized lookup for custom endpoints */
      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'default',
        endpointType: EModelEndpoint.custom,
      });

      /** Should not use direct lookup, should fall back to default */
      expect(result.fileLimit).toBe(99);
    });

    it('should handle complete fallback chain: specific -> custom -> agents -> default', () => {
      const customConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          myOllama: {
            disabled: true,
            fileLimit: 1,
          },
          [EModelEndpoint.custom]: {
            disabled: false,
            fileLimit: 2,
          },
          [EModelEndpoint.agents]: {
            disabled: false,
            fileLimit: 3,
          },
          default: {
            disabled: false,
            fileLimit: 4,
          },
        },
      };

      /** 1. Should find specific config */
      const specific = getEndpointFileConfig({
        fileConfig: customConfig,
        endpoint: 'myOllama',
        endpointType: EModelEndpoint.custom,
      });
      expect(specific.fileLimit).toBe(1);

      /** 2. Should fallback to custom when specific not found */
      const customOnlyConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.custom]: {
            disabled: false,
            fileLimit: 2,
          },
          [EModelEndpoint.agents]: {
            disabled: false,
            fileLimit: 3,
          },
          default: {
            disabled: false,
            fileLimit: 4,
          },
        },
      };
      const customFallback = getEndpointFileConfig({
        fileConfig: customOnlyConfig,
        endpoint: 'unknownCustom',
        endpointType: EModelEndpoint.custom,
      });
      expect(customFallback.fileLimit).toBe(2);

      /** 3. Should fallback to agents */
      const agentsFallback = getEndpointFileConfig({
        fileConfig: {
          ...baseFileConfig,
          endpoints: {
            ...baseFileConfig.endpoints,
            [EModelEndpoint.agents]: {
              disabled: false,
              fileLimit: 3,
            },
            default: {
              disabled: false,
              fileLimit: 4,
            },
          },
        },
        endpoint: 'unknownCustom',
        endpointType: EModelEndpoint.custom,
      });
      expect(agentsFallback.fileLimit).toBe(3);

      /**
       * 4. Should use agents even if disabled (caller decides based on disabled flag)
       * getEndpointFileConfig returns the config, doesn't filter based on disabled
       */
      const agentsDisabledConfig = mergeFileConfig({
        endpoints: {
          [EModelEndpoint.agents]: {
            disabled: true,
          },
          default: {
            disabled: false,
            fileLimit: 4,
          },
        },
      });
      const agentsDisabled = getEndpointFileConfig({
        fileConfig: agentsDisabledConfig,
        endpoint: 'unknownCustom',
        endpointType: EModelEndpoint.custom,
      });
      /** Should return agents config (disabled: true), not skip to default */
      expect(agentsDisabled.disabled).toBe(true);
      expect(agentsDisabled.fileLimit).toBe(0); /** disabled: true sets fileLimit to 0 */
    });
  });

  describe('standard endpoint lookup', () => {
    it('should find endpoint by endpointType', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.openAI]: {
            disabled: true,
            fileLimit: 15,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'someOtherName',
        endpointType: EModelEndpoint.openAI,
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(15);
    });

    it('should find endpoint by direct endpoint name', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.anthropic]: {
            disabled: false,
            fileLimit: 25,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.anthropic,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(25);
    });

    it('should find endpoint by normalized name', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          ollama: {
            disabled: true,
            fileLimit: 6,
          },
        },
      };

      /** Test normalization (Ollama -> ollama) */
      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'Ollama',
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(6);
    });

    it('should use agents fallback for explicitly agents endpoint', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.agents]: {
            disabled: false,
            fileLimit: 11,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.agents,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(11);
    });

    it('should use agents fallback for unconfigured non-standard endpoint', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.agents]: {
            disabled: false,
            fileLimit: 10,
          },
          default: {
            disabled: false,
            fileLimit: 100,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'unconfiguredEndpoint',
      });

      /**
       * With new logic, unconfigured endpoints are treated as custom
       * and fall back through: specific -> custom -> agents -> default
       * So this should use agents (fileLimit: 10), not default
       */
      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(10);
    });

    it('should prioritize endpointType over endpoint name', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.openAI]: {
            disabled: true,
            fileLimit: 5,
          },
          [EModelEndpoint.anthropic]: {
            disabled: false,
            fileLimit: 10,
          },
        },
      };

      /** endpointType should take priority */
      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.openAI,
        endpointType: EModelEndpoint.anthropic,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(10);
    });
  });

  describe('edge cases', () => {
    it('should return default when fileConfig is null', () => {
      const result = getEndpointFileConfig({
        fileConfig: null,
        endpoint: EModelEndpoint.openAI,
      });

      expect(result).toBeDefined();
      expect(result.disabled).toBe(false);
    });

    it('should return default when fileConfig is undefined', () => {
      const result = getEndpointFileConfig({
        fileConfig: undefined,
        endpoint: EModelEndpoint.openAI,
      });

      expect(result).toBeDefined();
      expect(result.disabled).toBe(false);
    });

    it('should handle empty endpoint gracefully', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          default: {
            disabled: false,
            fileLimit: 50,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: '',
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(50);
    });

    it('should handle null endpoint gracefully', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          default: {
            disabled: false,
            fileLimit: 50,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: null,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(50);
    });

    it('should handle undefined endpoint gracefully', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          default: {
            disabled: false,
            fileLimit: 50,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: undefined,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(50);
    });

    it('should not mutate the input fileConfig', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.openAI]: {
            disabled: false,
            fileLimit: 10,
          },
        },
      };

      const originalDisabled = fileConfig.endpoints[EModelEndpoint.openAI]!.disabled;

      getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.openAI,
      });

      /** Config should not be mutated */
      expect(fileConfig.endpoints[EModelEndpoint.openAI]!.disabled).toBe(originalDisabled);
    });
  });

  describe('assistants endpoint handling', () => {
    it('should find assistants endpoint config', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.assistants]: {
            disabled: false,
            fileLimit: 20,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.assistants,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(20);
    });

    it('should find azureAssistants endpoint config', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.azureAssistants]: {
            disabled: true,
            fileLimit: 15,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.azureAssistants,
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(15);
    });

    it('should not fallback to agents for assistants endpoints', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.agents]: {
            disabled: true,
            fileLimit: 5,
          },
          default: {
            disabled: false,
            fileLimit: 10,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'unknownAssistants',
        endpointType: EModelEndpoint.assistants,
      });

      /** Should use default, not agents */
      expect(result.fileLimit).toBe(10);
    });
  });

  describe('agents endpoint handling', () => {
    it('should find agents endpoint config', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.agents]: {
            disabled: false,
            fileLimit: 9,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.agents,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(9);
    });
  });

  describe('mergeFileConfig integration', () => {
    it('should work with mergeFileConfig output for disabled endpoint', () => {
      const dynamicConfig = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            disabled: true,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.openAI,
      });

      expect(result.disabled).toBe(true);
      /** When disabled: true, merge sets these to 0 */
      expect(result.fileLimit).toBe(0);
      expect(result.fileSizeLimit).toBe(0);
      expect(result.totalSizeLimit).toBe(0);
      expect(result.supportedMimeTypes).toEqual([]);
    });

    it('should work with mergeFileConfig output for enabled endpoint', () => {
      const dynamicConfig = {
        endpoints: {
          [EModelEndpoint.anthropic]: {
            disabled: false,
            fileLimit: 5,
            fileSizeLimit: 10,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.anthropic,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(5);
      /** Should convert MB to bytes */
      expect(result.fileSizeLimit).toBe(10 * 1024 * 1024);
    });

    it('should convert skills fileSizeLimit from MB to bytes', () => {
      const merged = mergeFileConfig({
        skills: {
          fileSizeLimit: 15,
        },
      });

      expect(merged.skills?.fileSizeLimit).toBe(15 * 1024 * 1024);
    });

    it('defaults skill rollback concurrency and preserves configured overrides', () => {
      expect(mergeFileConfig(undefined).skills?.importCleanupConcurrency).toBe(8);
      const parsed = fileConfigSchema.parse({ skills: { importCleanupConcurrency: 3 } });
      const merged = mergeFileConfig(parsed);
      expect(merged.skills?.importCleanupConcurrency).toBe(3);
      expect(merged.skills?.fileSizeLimit).toBe(50 * 1024 * 1024);
    });

    it.each([0, -1, 1.5])('rejects invalid rollback concurrency %s', (concurrency) => {
      expect(
        fileConfigSchema.safeParse({ skills: { importCleanupConcurrency: concurrency } }).success,
      ).toBe(false);
    });

    it('should default skills fileSizeLimit to 50 MB', () => {
      const merged = mergeFileConfig(undefined);

      expect(merged.skills?.fileSizeLimit).toBe(50 * 1024 * 1024);
    });

    it('should preserve disabled: false in merged config', () => {
      const dynamicConfig = {
        endpoints: {
          [EModelEndpoint.anthropic]: {
            disabled: false,
            fileLimit: 8,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.anthropic,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(8);
    });

    it('should not mutate base fileConfig during merge', () => {
      const originalBaseAgentsConfig = { ...baseFileConfig.endpoints.agents };

      const dynamicConfig = {
        endpoints: {
          [EModelEndpoint.agents]: {
            disabled: true,
            fileLimit: 1,
          },
        },
      };

      mergeFileConfig(dynamicConfig);

      /** Base config should not be mutated */
      expect(baseFileConfig.endpoints.agents).toEqual(originalBaseAgentsConfig);
    });
  });

  describe('lookup priority verification', () => {
    it('should check endpointType before endpoint for standard endpoints', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.openAI]: {
            disabled: true,
            fileLimit: 1,
          },
          wrongEndpoint: {
            disabled: false,
            fileLimit: 99,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'wrongEndpoint',
        endpointType: EModelEndpoint.openAI,
      });

      /** Should use endpointType config, not endpoint */
      expect(result.fileLimit).toBe(1);
    });

    it('should check endpoint when endpointType not found', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          myCustomEndpoint: {
            disabled: true,
            fileLimit: 7,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: 'myCustomEndpoint',
        endpointType: 'notFound',
      });

      expect(result.fileLimit).toBe(7);
    });
  });

  describe('disabled handling', () => {
    it('should properly handle disabled: true', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.openAI]: {
            disabled: true,
            fileLimit: 0,
            fileSizeLimit: 0,
            totalSizeLimit: 0,
            supportedMimeTypes: [],
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.openAI,
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(0);
      expect(result.fileSizeLimit).toBe(0);
      expect(result.totalSizeLimit).toBe(0);
      expect(result.supportedMimeTypes).toEqual([]);
    });

    it('should properly handle disabled: false', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.anthropic]: {
            disabled: false,
            fileLimit: 10,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.anthropic,
      });

      expect(result.disabled).toBe(false);
      expect(result.fileLimit).toBe(10);
    });

    it('should treat undefined disabled as enabled', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.google]: {
            fileLimit: 10,
          },
        },
      };

      const result = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.google,
      });

      /** disabled should not be explicitly true */
      expect(result.disabled).not.toBe(true);
    });
  });

  describe('partial config merging', () => {
    it('should merge partial endpoint config with default config', () => {
      const dynamicConfig = {
        endpoints: {
          google: {
            fileSizeLimit: 500,
            /** Note: supportedMimeTypes not configured */
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.google,
      });

      /** Should have the configured fileSizeLimit */
      expect(result.fileSizeLimit).toBe(500 * 1024 * 1024);
      /** Should have supportedMimeTypes from default config */
      expect(result.supportedMimeTypes).toBeDefined();
      expect(Array.isArray(result.supportedMimeTypes)).toBe(true);
      expect(result.supportedMimeTypes!.length).toBeGreaterThan(0);
      /** Should have other fields from default */
      expect(result.fileLimit).toBeDefined();
      expect(result.totalSizeLimit).toBeDefined();
    });

    it('should not override explicitly set fields with default', () => {
      const dynamicConfig = {
        endpoints: {
          anthropic: {
            disabled: true,
            fileLimit: 3,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.anthropic,
      });

      /** Should keep explicitly configured values */
      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(0); /** disabled: true sets to 0 in merge */
      /** But still get supportedMimeTypes from... wait, disabled: true clears this */
      expect(result.supportedMimeTypes).toEqual([]);
    });

    it('should handle endpoint with only fileSizeLimit configured', () => {
      const dynamicConfig = {
        endpoints: {
          openAI: {
            fileSizeLimit: 100,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.openAI,
      });

      expect(result.fileSizeLimit).toBe(100 * 1024 * 1024);
      /** Should get these from default */
      expect(result.supportedMimeTypes).toBeDefined();
      expect(result.fileLimit).toBeDefined();
      expect(result.disabled).not.toBe(true);
    });

    it('should merge supportedMimeTypes from default when only fileSizeLimit is configured', () => {
      /** This tests the exact scenario from the issue */
      const dynamicConfig = {
        endpoints: {
          google: {
            fileSizeLimit: 1000000024,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.google,
      });

      /** Should have the massive fileSizeLimit configured */
      expect(result.fileSizeLimit).toBe(1000000024 * 1024 * 1024);
      /** CRITICAL: Should have supportedMimeTypes from default, not undefined or [] */
      expect(result.supportedMimeTypes).toBeDefined();
      expect(Array.isArray(result.supportedMimeTypes)).toBe(true);
      expect(result.supportedMimeTypes!.length).toBeGreaterThan(0);
      /** Should have other default fields */
      expect(result.fileLimit).toBe(10);
      expect(result.disabled).toBe(false);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle multi-provider custom endpoint configuration', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          ollama: {
            disabled: false,
            fileLimit: 5,
          },
          lmstudio: {
            disabled: true,
            fileLimit: 3,
          },
          [EModelEndpoint.custom]: {
            disabled: false,
            fileLimit: 10,
          },
        },
      };

      const ollamaResult = getEndpointFileConfig({
        fileConfig,
        endpoint: 'ollama',
        endpointType: EModelEndpoint.custom,
      });
      expect(ollamaResult.fileLimit).toBe(5);

      const lmstudioResult = getEndpointFileConfig({
        fileConfig,
        endpoint: 'lmstudio',
        endpointType: EModelEndpoint.custom,
      });
      expect(lmstudioResult.disabled).toBe(true);
      expect(lmstudioResult.fileLimit).toBe(3);

      const unknownResult = getEndpointFileConfig({
        fileConfig,
        endpoint: 'unknownProvider',
        endpointType: EModelEndpoint.custom,
      });
      expect(unknownResult.fileLimit).toBe(10);
    });

    it('should handle switching between endpoints correctly', () => {
      const fileConfig: FileConfig = {
        ...baseFileConfig,
        endpoints: {
          ...baseFileConfig.endpoints,
          [EModelEndpoint.openAI]: {
            disabled: true,
          },
          [EModelEndpoint.anthropic]: {
            disabled: false,
            fileLimit: 15,
          },
        },
      };

      const openaiResult = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.openAI,
      });
      expect(openaiResult.disabled).toBe(true);

      const anthropicResult = getEndpointFileConfig({
        fileConfig,
        endpoint: EModelEndpoint.anthropic,
      });
      expect(anthropicResult.disabled).toBe(false);
      expect(anthropicResult.fileLimit).toBe(15);
    });
  });

  describe('user-configured default behavior', () => {
    it('should use user-configured default as effective default when endpoint not found', () => {
      const dynamicConfig = {
        endpoints: {
          default: {
            fileLimit: 7,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.google,
      });

      expect(result.fileLimit).toBe(7);
      expect(result.disabled).toBe(false);
      expect(result.supportedMimeTypes).toBeDefined();
      expect(Array.isArray(result.supportedMimeTypes)).toBe(true);
      expect(result.supportedMimeTypes!.length).toBeGreaterThan(0);
    });

    it('should merge endpoint config against user default (not base default)', () => {
      const dynamicConfig = {
        endpoints: {
          default: {
            fileLimit: 7,
          },
          google: {
            fileSizeLimit: 123,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.google,
      });

      /** fileLimit should come from user default */
      expect(result.fileLimit).toBe(7);
      /** fileSizeLimit should come from endpoint (converted to bytes) */
      expect(result.fileSizeLimit).toBe(123 * 1024 * 1024);
    });

    it('should respect user-configured default supportedMimeTypes override', () => {
      const dynamicConfig = {
        endpoints: {
          default: {
            supportedMimeTypes: ['^text\\/plain$'],
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
      });

      /** Only text/plain should be allowed */
      expect(result.supportedMimeTypes).toBeDefined();
      expect(result.supportedMimeTypes!.length).toBe(1);
      const [onlyRegex] = result.supportedMimeTypes as RegExp[];
      expect(onlyRegex.test('text/plain')).toBe(true);
      expect(onlyRegex.test('image/png')).toBe(false);
    });

    it('should propagate disabled from user default across fallbacks', () => {
      const dynamicConfig = {
        endpoints: {
          default: {
            disabled: true,
          },
        },
      };

      const merged = mergeFileConfig(dynamicConfig);
      const result = getEndpointFileConfig({
        fileConfig: merged,
        endpoint: EModelEndpoint.google,
      });

      expect(result.disabled).toBe(true);
      expect(result.fileLimit).toBe(0);
      expect(result.fileSizeLimit).toBe(0);
      expect(result.totalSizeLimit).toBe(0);
      expect(result.supportedMimeTypes).toEqual([]);
    });
  });
});

describe('isExplicitMimeConfig', () => {
  it('is false for undefined or empty lists', () => {
    expect(isExplicitMimeConfig(undefined)).toBe(false);
    expect(isExplicitMimeConfig([])).toBe(false);
  });

  it('is false for the built-in default list (inherited, not configured)', () => {
    expect(isExplicitMimeConfig(supportedMimeTypes)).toBe(false);
    const endpointConfig = getEndpointFileConfig({
      fileConfig: mergeFileConfig({ endpoints: { Other: { fileLimit: 1 } } }),
      endpoint: 'MyGateway',
      endpointType: 'custom',
    });
    expect(isExplicitMimeConfig(endpointConfig.supportedMimeTypes)).toBe(false);
  });

  it('is true for an admin-configured list, permissive or not', () => {
    const endpointConfig = getEndpointFileConfig({
      fileConfig: mergeFileConfig({
        endpoints: { MyGateway: { supportedMimeTypes: ['image/.*', 'video/.*'] } },
      }),
      endpoint: 'MyGateway',
      endpointType: 'custom',
    });
    expect(isExplicitMimeConfig(endpointConfig.supportedMimeTypes)).toBe(true);
    expect(isExplicitMimeConfig([/.*/])).toBe(true);
  });
});

describe('isPermissiveMimeConfig', () => {
  it('returns true for wildcard .* pattern', () => {
    expect(isPermissiveMimeConfig([/.*/])).toBe(true);
  });

  it('returns true for .+ pattern', () => {
    expect(isPermissiveMimeConfig([/.+/])).toBe(true);
  });

  it('returns true for anchored ^.*$ pattern', () => {
    expect(isPermissiveMimeConfig([/^.*$/])).toBe(true);
  });

  it('returns true for anchored ^.+$ pattern', () => {
    expect(isPermissiveMimeConfig([/^.+$/])).toBe(true);
  });

  it('returns true when at least one pattern is permissive', () => {
    expect(isPermissiveMimeConfig([/^image\/.*$/, /.*/])).toBe(true);
  });

  it('returns false for image-only patterns', () => {
    expect(isPermissiveMimeConfig([/^image\/(jpeg|png)$/])).toBe(false);
  });

  it('returns false for category patterns', () => {
    expect(isPermissiveMimeConfig([/^image\/.*$/, /^text\/.*$/])).toBe(false);
  });

  it('returns false for specific MIME type patterns', () => {
    expect(isPermissiveMimeConfig([/^application\/pdf$/])).toBe(false);
  });

  it('returns false for broad application category pattern', () => {
    expect(isPermissiveMimeConfig([/^application\/.*$/])).toBe(false);
  });

  it('returns false for multi-category pattern', () => {
    expect(isPermissiveMimeConfig([/^(application|text)\/.*$/])).toBe(false);
  });

  it('returns false for default supportedMimeTypes', () => {
    expect(isPermissiveMimeConfig(supportedMimeTypes)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPermissiveMimeConfig(undefined)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(isPermissiveMimeConfig([])).toBe(false);
  });

  it('returns true for regex produced by convertStringsToRegex with .*', () => {
    const converted = convertStringsToRegex(['.*']);
    expect(isPermissiveMimeConfig(converted)).toBe(true);
  });
});

describe('getConfiguredMimeAccept', () => {
  const toSet = (accept?: string) => new Set((accept ?? '').split(',').filter(Boolean));

  /** Provider capability tiers: image-only, document providers, Google/OpenRouter, and Bedrock. */
  const IMAGE_ONLY: MimeUploadCapability = { categories: ['image'] };
  const IMAGE_DOC: MimeUploadCapability = { categories: ['image', 'document'] };
  const ALL: MimeUploadCapability = { categories: ['image', 'document', 'audio', 'video'] };
  const BEDROCK: MimeUploadCapability = {
    categories: ['image', 'document'],
    documentMimeTypes: bedrockDocumentMimeTypes,
  };
  const GOOGLE: MimeUploadCapability = {
    categories: ['image', 'document', 'audio', 'video'],
    documentMimeTypes: ['application/pdf'],
  };

  it('returns undefined for undefined', () => {
    expect(getConfiguredMimeAccept(undefined, ALL)).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(getConfiguredMimeAccept([], ALL)).toBeUndefined();
  });

  it('returns undefined for the built-in default supportedMimeTypes (keep provider filter)', () => {
    expect(getConfiguredMimeAccept(supportedMimeTypes, ALL)).toBeUndefined();
  });

  it("returns '' for permissive configs so the picker stays unrestricted", () => {
    expect(getConfiguredMimeAccept(convertStringsToRegex(['.*']), ALL)).toBe('');
    expect(getConfiguredMimeAccept([/^.+$/], ALL)).toBe('');
  });

  it('translates the finite Office + image allowlist from issue #14162', () => {
    const config = convertStringsToRegex([
      '^image/.*',
      '^application/pdf$',
      '^application/msword$',
      '^application/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document$',
      '^application/vnd\\.ms-excel$',
      '^application/vnd\\.openxmlformats-officedocument\\.spreadsheetml\\.sheet$',
    ]);
    const accept = toSet(getConfiguredMimeAccept(config, IMAGE_DOC));

    for (const token of [
      'image/*',
      '.pdf',
      'application/pdf',
      '.doc',
      'application/msword',
      '.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls',
      'application/vnd.ms-excel',
      '.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(accept.has(token)).toBe(true);
    }
    expect(accept.has('.pptx')).toBe(false);
    expect(accept.has('audio/*')).toBe(false);
    expect(accept.has('video/*')).toBe(false);
  });

  it('translates a PowerPoint template allowlist to the template extension and MIME', () => {
    const templateMime = 'application/vnd.openxmlformats-officedocument.presentationml.template';
    const accept = toSet(
      getConfiguredMimeAccept(
        convertStringsToRegex([
          '^application/vnd\\.openxmlformats-officedocument\\.presentationml\\.template$',
        ]),
        IMAGE_DOC,
      ),
    );

    expect(accept).toEqual(new Set(['.potx', templateMime]));
  });

  it('emits image/* for an image-only allowlist', () => {
    const accept = toSet(getConfiguredMimeAccept([/^image\/(jpeg|png)$/], IMAGE_DOC));
    expect(accept.has('image/*')).toBe(true);
    expect(accept.has('.pdf')).toBe(false);
  });

  it('emits media wildcards for audio and video allowlists on a media-capable path', () => {
    const accept = toSet(getConfiguredMimeAccept([/^audio\/.*$/, /^video\/.*$/], ALL));
    expect(accept.has('audio/*')).toBe(true);
    expect(accept.has('video/*')).toBe(true);
  });

  it('returns undefined for a finite config with no recognized types (fall back to provider filter)', () => {
    expect(getConfiguredMimeAccept([/^application\/x-librechat-unknown$/], ALL)).toBeUndefined();
  });

  it('falls back when any configured type is unrepresentable, rather than emitting a partial accept', () => {
    expect(
      getConfiguredMimeAccept([/^application\/pdf$/, /^text\/x-python$/], IMAGE_DOC),
    ).toBeUndefined();
  });

  it('translates a fully-representable mixed pdf + audio allowlist on a media-capable path', () => {
    const accept = toSet(getConfiguredMimeAccept([/^application\/pdf$/, /^audio\/mp3$/], ALL));
    expect(accept.has('.pdf')).toBe(true);
    expect(accept.has('application/pdf')).toBe(true);
    expect(accept.has('audio/*')).toBe(true);
    expect(accept.has('video/*')).toBe(false);
    expect(accept.has('image/*')).toBe(false);
  });

  it('keeps the image upload path image-only even when the allowlist adds documents', () => {
    const config = convertStringsToRegex([
      '^image/.*',
      '^application/pdf$',
      '^application/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document$',
    ]);
    const accept = toSet(getConfiguredMimeAccept(config, IMAGE_ONLY));
    expect(accept.has('image/*')).toBe(true);
    expect(accept.has('.pdf')).toBe(false);
    expect(accept.has('.docx')).toBe(false);
  });

  it('excludes audio/video for document providers that cannot send them', () => {
    const accept = toSet(
      getConfiguredMimeAccept([/^image\/.*$/, /^application\/pdf$/, /^audio\/mp3$/], IMAGE_DOC),
    );
    expect(accept.has('image/*')).toBe(true);
    expect(accept.has('.pdf')).toBe(true);
    expect(accept.has('audio/*')).toBe(false);
  });

  it('falls back for a broad application/.* regex that reaches unrepresentable types', () => {
    expect(getConfiguredMimeAccept([/^application\/.*$/], IMAGE_DOC)).toBeUndefined();
  });

  it('restricts Bedrock document accepts to Bedrock-supported formats', () => {
    const config = convertStringsToRegex([
      '^application/pdf$',
      '^application/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document$',
      '^application/vnd\\.openxmlformats-officedocument\\.presentationml\\.presentation$',
    ]);
    const accept = toSet(getConfiguredMimeAccept(config, BEDROCK));
    expect(accept.has('.pdf')).toBe(true);
    expect(accept.has('.docx')).toBe(true);
    expect(accept.has('.pptx')).toBe(false);
    expect(
      accept.has('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe(false);
  });

  it('includes both .html and .htm when translating text/html', () => {
    const accept = toSet(getConfiguredMimeAccept([/^text\/html$/], BEDROCK));
    expect(accept.has('.html')).toBe(true);
    expect(accept.has('.htm')).toBe(true);
    expect(accept.has('text/html')).toBe(true);
  });

  it('restricts Google/OpenRouter documents to PDF while keeping media categories', () => {
    const config = convertStringsToRegex([
      '^image/.*$',
      '^application/pdf$',
      '^application/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document$',
      '^audio/.*$',
    ]);
    const accept = toSet(getConfiguredMimeAccept(config, GOOGLE));
    expect(accept.has('image/*')).toBe(true);
    expect(accept.has('.pdf')).toBe(true);
    expect(accept.has('audio/*')).toBe(true);
    expect(accept.has('.docx')).toBe(false);
  });

  it('translates a sampled audio subtype (audio/webm) rather than hiding it', () => {
    const accept = toSet(getConfiguredMimeAccept([/^image\/.*$/, /^audio\/webm$/], GOOGLE));
    expect(accept.has('image/*')).toBe(true);
    expect(accept.has('audio/*')).toBe(true);
  });

  it('falls back when a configured pattern matches no known MIME type', () => {
    expect(
      getConfiguredMimeAccept([/^image\/.*$/, /^audio\/x-librechat-unknown$/], GOOGLE),
    ).toBeUndefined();
  });

  it('translates a finite Excel allowlist that includes legacy MIME aliases', () => {
    const config = convertStringsToRegex([
      '^application/(vnd\\.ms-excel|msexcel|x-msexcel|x-ms-excel|x-excel|x-dos_ms_excel|xls|x-xls|vnd\\.openxmlformats-officedocument\\.spreadsheetml\\.sheet)$',
    ]);
    const accept = toSet(getConfiguredMimeAccept(config, IMAGE_DOC));
    expect(accept.has('.xls')).toBe(true);
    expect(accept.has('.xlsx')).toBe(true);
  });

  it('translates finite epub and parquet document allowlists', () => {
    const accept = toSet(
      getConfiguredMimeAccept(
        [/^application\/epub\+zip$/, /^application\/vnd\.apache\.parquet$/],
        IMAGE_DOC,
      ),
    );
    expect(accept.has('.epub')).toBe(true);
    expect(accept.has('.parquet')).toBe(true);
  });
});

describe('setFileConfigRegexCompiler (MIME pattern compiler seam)', () => {
  afterEach(() => {
    setFileConfigRegexCompiler((pattern) => new RegExp(pattern));
  });

  it('defaults to a native RegExp compiler', () => {
    const [regex] = convertStringsToRegex(['^text/']);
    expect(regex.test('text/csv')).toBe(true);
    expect(regex.test('image/png')).toBe(false);
  });

  it('routes patterns through an injected compiler', () => {
    const seen: string[] = [];
    setFileConfigRegexCompiler((pattern) => {
      seen.push(pattern);
      return { test: () => false };
    });
    const compiled = convertStringsToRegex(['application/pdf', 'text/*']);
    expect(seen).toEqual(['application/pdf', 'text/*']);
    expect(compiled.every((matcher) => matcher.test('anything') === false)).toBe(true);
  });

  it('returns a single reject-all matcher when every pattern fails to compile', () => {
    setFileConfigRegexCompiler(() => {
      throw new Error('unsupported pattern');
    });
    const compiled = convertStringsToRegex(['application/pdf', 'text/*']);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].test('application/pdf')).toBe(false);
    expect(compiled[0].test('anything')).toBe(false);
  });
});

describe('mergeFileConfig clientImageResize', () => {
  it('leaves the user in control when no dynamic config is provided', () => {
    const merged = mergeFileConfig(undefined);
    expect(merged.clientImageResize?.enabled).toBe(false);
    expect(merged.clientImageResize?.enforced).toBe(false);
  });

  it('leaves the user in control when the admin config omits clientImageResize', () => {
    const merged = mergeFileConfig({ serverFileSizeLimit: 100 });
    expect(merged.clientImageResize?.enforced).toBe(false);
  });

  it('enforces an admin-enabled value', () => {
    const merged = mergeFileConfig({ clientImageResize: { enabled: true } });
    expect(merged.clientImageResize?.enabled).toBe(true);
    expect(merged.clientImageResize?.enforced).toBe(true);
  });

  it('enforces an admin-disabled value', () => {
    const merged = mergeFileConfig({ clientImageResize: { enabled: false } });
    expect(merged.clientImageResize?.enabled).toBe(false);
    expect(merged.clientImageResize?.enforced).toBe(true);
  });

  it('applies admin resize parameters without enforcing the toggle', () => {
    const merged = mergeFileConfig({
      clientImageResize: { maxWidth: 1024, maxHeight: 1024, quality: 0.8 },
    });
    expect(merged.clientImageResize?.maxWidth).toBe(1024);
    expect(merged.clientImageResize?.maxHeight).toBe(1024);
    expect(merged.clientImageResize?.quality).toBe(0.8);
    expect(merged.clientImageResize?.enforced).toBe(false);
  });
});

describe('fileConfigSchema clientImageResize', () => {
  it.each(['maxWidth', 'maxHeight'] as const)('rejects a non-positive %s', (dimension) => {
    const result = fileConfigSchema.safeParse({
      clientImageResize: { [dimension]: 0 },
    });

    expect(result.success).toBe(false);
  });
});

describe('defaultLLMDeliveryPath config merging', () => {
  it('should include defaultLLMDeliveryPath and legacyFileUploadUX in merged endpoint config', () => {
    const merged = mergeFileConfig({
      endpoints: {
        [EModelEndpoint.agents]: {
          defaultLLMDeliveryPath: {
            fallback: 'none',
            overrides: { 'image/*': 'text' },
          },
          legacyFileUploadUX: true,
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.agents,
    });
    expect(endpointConfig.defaultLLMDeliveryPath).toEqual({
      fallback: 'none',
      overrides: { 'image/*': 'text' },
    });
    expect(endpointConfig.legacyFileUploadUX).toBe(true);
  });

  it('inherits the global fallback when an endpoint supplies only overrides', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: { fallback: 'none' },
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { overrides: { 'image/*': 'provider' } },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(endpointConfig.defaultLLMDeliveryPath).toEqual({
      fallback: 'none',
      overrides: { 'image/*': 'provider' },
    });
  });

  it('lets an endpoint wildcard outrank a global exact override', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: {
        fallback: 'text',
        overrides: { 'image/png': 'text', 'audio/mpeg': 'none' },
      },
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { overrides: { 'image/*': 'provider' } },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(
      resolveDefaultLLMDeliveryPath(
        'image/png',
        endpointConfig.defaultLLMDeliveryPath,
        merged.defaultLLMDeliveryPath,
        EModelEndpoint.openAI,
      ),
    ).toBe('provider');
    expect(
      resolveDefaultLLMDeliveryPath(
        'audio/mpeg',
        endpointConfig.defaultLLMDeliveryPath,
        merged.defaultLLMDeliveryPath,
        EModelEndpoint.openAI,
      ),
    ).toBe('none');
  });

  it('keeps a global exact override the endpoint wildcard does not cover', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: { overrides: { 'image/png': 'text' } },
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { overrides: { 'audio/*': 'none' } },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(endpointConfig.defaultLLMDeliveryPath?.overrides?.['image/png']).toBe('text');
  });

  it('lets an endpoint exact override win inside its own wildcard family', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: { overrides: { 'image/png': 'none' } },
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { overrides: { 'image/*': 'provider', 'image/png': 'text' } },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(
      resolveDefaultLLMDeliveryPath(
        'image/png',
        endpointConfig.defaultLLMDeliveryPath,
        merged.defaultLLMDeliveryPath,
        EModelEndpoint.openAI,
      ),
    ).toBe('text');
  });

  it('merges override maps with the endpoint winning per key', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: {
        fallback: 'text',
        overrides: { 'image/*': 'provider', 'audio/*': 'none' },
      },
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { overrides: { 'audio/*': 'text' } },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(endpointConfig.defaultLLMDeliveryPath).toEqual({
      fallback: 'text',
      overrides: { 'image/*': 'provider', 'audio/*': 'text' },
    });
  });

  it('keeps an endpoint fallback ahead of inherited default overrides', () => {
    const merged = mergeFileConfig({
      endpoints: {
        default: { defaultLLMDeliveryPath: { overrides: { 'image/*': 'text' } } },
        [EModelEndpoint.openAI]: { defaultLLMDeliveryPath: { fallback: 'provider' } },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(endpointConfig.defaultLLMDeliveryPath?.overrides?.['image/*']).toBeUndefined();
    expect(endpointConfig.defaultLLMDeliveryPath?.fallback).toBe('provider');
  });

  it('lets an endpoint fallback override the global fallback', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: { fallback: 'none' },
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { fallback: 'text' },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });

    expect(endpointConfig.defaultLLMDeliveryPath?.fallback).toBe('text');
  });

  it('should merge global defaultLLMDeliveryPath into mergedConfig', () => {
    const merged = mergeFileConfig({
      defaultLLMDeliveryPath: {
        fallback: 'provider',
        overrides: { 'audio/*': 'none' },
      },
      legacyFileUploadUX: true,
    });
    expect(merged.defaultLLMDeliveryPath).toEqual({
      fallback: 'provider',
      overrides: { 'audio/*': 'none' },
    });
    expect(merged.legacyFileUploadUX).toBe(true);
  });

  it('should inherit global legacyFileUploadUX into endpoint config', () => {
    const merged = mergeFileConfig({
      legacyFileUploadUX: true,
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });
    expect(endpointConfig.legacyFileUploadUX).toBe(true);
  });

  it('should allow endpoint legacyFileUploadUX to override global legacyFileUploadUX', () => {
    const merged = mergeFileConfig({
      legacyFileUploadUX: true,
      endpoints: {
        [EModelEndpoint.openAI]: {
          legacyFileUploadUX: false,
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });
    expect(endpointConfig.legacyFileUploadUX).toBe(false);
  });

  it('should pass through endpoint defaultLLMDeliveryPath in mergeWithDefault', () => {
    const merged = mergeFileConfig({
      endpoints: {
        [EModelEndpoint.openAI]: {
          defaultLLMDeliveryPath: { overrides: { 'application/pdf': 'text' } },
        },
      },
    });
    const endpointConfig = getEndpointFileConfig({
      fileConfig: merged,
      endpoint: EModelEndpoint.openAI,
    });
    expect(endpointConfig.defaultLLMDeliveryPath?.overrides?.['application/pdf']).toBe('text');
  });

  it('should default legacyFileUploadUX to undefined when not set', () => {
    const merged = mergeFileConfig(undefined);
    expect(merged.legacyFileUploadUX).toBeUndefined();
  });
});

describe('textFallbackWithoutTools config merging', () => {
  const resolveFor = (dynamic: Parameters<typeof mergeFileConfig>[0], endpoint: string) =>
    getEndpointFileConfig({ fileConfig: mergeFileConfig(dynamic), endpoint })
      .textFallbackWithoutTools;

  it('is off unless configured', () => {
    expect(mergeFileConfig(undefined).textFallbackWithoutTools).toBeUndefined();
    expect(resolveFor(undefined, EModelEndpoint.openAI)).toBeUndefined();
    expect(resolveFor({ endpoints: { default: {} } }, EModelEndpoint.openAI)).toBeUndefined();
  });

  it('accepts the setting at the top level and on an endpoint', () => {
    expect(
      fileConfigSchema.safeParse({
        textFallbackWithoutTools: true,
        endpoints: { openAI: { textFallbackWithoutTools: false } },
      }).success,
    ).toBe(true);
    expect(fileConfigSchema.safeParse({ textFallbackWithoutTools: 'yes' }).success).toBe(false);
  });

  it('reaches an endpoint configured for it', () => {
    expect(
      resolveFor(
        { endpoints: { [EModelEndpoint.openAI]: { textFallbackWithoutTools: true } } },
        EModelEndpoint.openAI,
      ),
    ).toBe(true);
  });

  it('is inherited from the top level and from the default endpoint', () => {
    expect(resolveFor({ textFallbackWithoutTools: true }, EModelEndpoint.anthropic)).toBe(true);
    expect(
      resolveFor({ endpoints: { default: { textFallbackWithoutTools: true } } }, 'MyGateway'),
    ).toBe(true);
  });

  it('lets an endpoint turn off what it would inherit', () => {
    expect(
      resolveFor(
        {
          endpoints: {
            default: { textFallbackWithoutTools: true },
            [EModelEndpoint.openAI]: { textFallbackWithoutTools: false },
          },
        },
        EModelEndpoint.openAI,
      ),
    ).toBe(false);
  });
});

describe('agent attachment context limits', () => {
  it('keeps the turn-memory ceiling separate from agent upload storage', () => {
    expect(baseFileConfig.fileContextSizeLimit).toBe(128 * 1024 * 1024);
    expect(baseFileConfig.endpoints[EModelEndpoint.agents].totalSizeLimit).toBe(512 * 1024 * 1024);
  });

  it('validates and merges an aggregate model-context size limit in MB', () => {
    expect(fileConfigSchema.safeParse({ fileContextSizeLimit: 64 }).success).toBe(true);
    expect(mergeFileConfig({ fileContextSizeLimit: 64 }).fileContextSizeLimit).toBe(
      64 * 1024 * 1024,
    );
  });

  it('validates and merges an aggregate extracted-text character limit', () => {
    expect(fileConfigSchema.safeParse({ fileContextCharLimit: 250_000 }).success).toBe(true);
    expect(mergeFileConfig({ fileContextCharLimit: 250_000 }).fileContextCharLimit).toBe(250_000);
  });
});

describe('getDocumentFileExtension', () => {
  it.each([
    ['text/markdown', '.md'],
    [' TEXT/PLAIN; charset=UTF-8', '.txt'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ['application/vnd.oasis.opendocument.text', '.odt'],
    ['text/csv', '.csv'],
    ['application/csv', '.csv'],
    ['text/comma-separated-values', '.csv'],
    [' TEXT/COMMA-SEPARATED-VALUES; charset=utf-8', '.csv'],
    ['application/vnd.ms-excel', '.xls'],
    ['application/msexcel', '.xls'],
    ['application/x-msexcel', '.xls'],
    ['application/x-ms-excel', '.xls'],
    ['application/x-excel', '.xls'],
    ['application/x-dos_ms_excel', '.xls'],
    ['application/xls', '.xls'],
    ['application/x-xls', '.xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.template', '.potx'],
    ['application/unknown', undefined],
    [undefined, undefined],
  ])('resolves %s', (mimeType, expected) => {
    expect(getDocumentFileExtension(mimeType)).toBe(expected);
  });
});

describe('server-effective Responses routing', () => {
  const enabled = { default: true, on: true, off: false };
  const disabled = { default: false, on: false, off: false };
  it('does not assume model defaults before policy arrives or against an older server', () => {
    expect(
      resolveEffectiveUseResponsesApi({ endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-6-sol' }),
    ).toBeUndefined();
  });
  it('uses native snapshot policy but does not invent an Azure deployment', () => {
    const routing = { 'gpt-6-sol': enabled, 'gpt-6-sol-*': enabled, '*': disabled };
    expect(
      resolveEffectiveUseResponsesApi({
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-6-sol-2026-09-22',
        routing,
      }),
    ).toBe(true);
    expect(
      resolveEffectiveUseResponsesApi({
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'gpt-6-sol-2026-09-22',
        routing: { 'gpt-6-sol': enabled, '*': disabled },
      }),
    ).toBe(false);
  });
  it('leaves custom provider selections alone rather than inferring native support', () => {
    expect(
      resolveEffectiveUseResponsesApi({
        endpoint: EModelEndpoint.custom,
        model: 'gpt-6-sol',
        routing: { 'gpt-6-sol': enabled },
      }),
    ).toBeUndefined();
  });
});

it('inherits environment-based Azure snapshot policy only when the server advertises a family wildcard', () => {
  const routing = { 'gpt-6-sol-*': { default: true, on: true, off: false } };
  expect(
    resolveEffectiveUseResponsesApi({
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-6-sol-2026-09-22',
      routing,
    }),
  ).toBe(true);
});
it('selects web-search routing without changing stored route selection', () => {
  const routing = {
    'gpt-6-sol': {
      default: false,
      on: true,
      off: false,
      withWebSearch: { default: true, on: true, off: true },
    },
  };
  expect(
    resolveEffectiveUseResponsesApi({
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-6-sol',
      value: false,
      webSearch: true,
      routing,
    }),
  ).toBe(true);
  expect(
    resolveEffectiveUseResponsesApi({
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-6-sol',
      value: false,
      routing,
    }),
  ).toBe(false);
});
