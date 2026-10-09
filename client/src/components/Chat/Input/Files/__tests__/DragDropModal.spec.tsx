import {
  EModelEndpoint,
  isDocumentSupportedProvider,
  inferMimeType,
} from 'librechat-data-provider';

describe('DragDropModal - Provider Detection', () => {
  describe('endpointType priority over currentProvider', () => {
    it('should show upload option for LiteLLM with OpenAI endpointType', () => {
      const currentProvider = 'litellm'; // NOT in documentSupportedProviders
      const endpointType = EModelEndpoint.openAI; // IS in documentSupportedProviders

      // With fix: endpointType checked
      const withFix =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(withFix).toBe(true);

      // Without fix: only currentProvider checked = false
      const withoutFix = isDocumentSupportedProvider(currentProvider || endpointType);
      expect(withoutFix).toBe(false);
    });

    it('should show upload option for any custom gateway with OpenAI endpointType', () => {
      const currentProvider = 'my-custom-gateway';
      const endpointType = EModelEndpoint.openAI;

      const result =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(true);
    });

    it('should fallback to currentProvider when endpointType is undefined', () => {
      const currentProvider = EModelEndpoint.openAI;
      const endpointType = undefined;

      const result =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(true);
    });

    it('should fallback to currentProvider when endpointType is null', () => {
      const currentProvider = EModelEndpoint.anthropic;
      const endpointType = null;

      const result =
        isDocumentSupportedProvider(endpointType as any) ||
        isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(true);
    });

    it('should return false when neither provider supports documents', () => {
      const currentProvider = 'unsupported-provider';
      const endpointType = 'unsupported-endpoint' as any;

      const result =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(false);
    });
  });

  describe('supported providers', () => {
    const supportedProviders = [
      { name: 'OpenAI', value: EModelEndpoint.openAI },
      { name: 'Anthropic', value: EModelEndpoint.anthropic },
      { name: 'Google', value: EModelEndpoint.google },
      { name: 'Custom', value: EModelEndpoint.custom },
    ];

    supportedProviders.forEach(({ name, value }) => {
      it(`should recognize ${name} as supported`, () => {
        expect(isDocumentSupportedProvider(value)).toBe(true);
      });
    });

    it('should NOT recognize Azure OpenAI as supported (requires useResponsesApi)', () => {
      expect(isDocumentSupportedProvider(EModelEndpoint.azureOpenAI)).toBe(false);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle LiteLLM gateway pointing to OpenAI', () => {
      const scenario = {
        currentProvider: 'litellm',
        endpointType: EModelEndpoint.openAI,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(true);
    });

    it('should handle direct OpenAI connection', () => {
      const scenario = {
        currentProvider: EModelEndpoint.openAI,
        endpointType: EModelEndpoint.openAI,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(true);
    });

    it('should handle unsupported custom endpoint without override', () => {
      const scenario = {
        currentProvider: 'my-unsupported-endpoint',
        endpointType: undefined,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(false);
    });
    it('should handle agents endpoints with document supported providers', () => {
      const scenario = {
        currentProvider: EModelEndpoint.google,
        endpointType: EModelEndpoint.agents,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(true);
    });

    it('should handle Azure OpenAI endpointType when Responses API is enabled', () => {
      const scenario = {
        currentProvider: EModelEndpoint.agents,
        endpointType: EModelEndpoint.azureOpenAI,
        useResponsesApi: true,
      };

      const isAzureWithResponsesApi =
        (scenario.currentProvider === EModelEndpoint.azureOpenAI ||
          scenario.endpointType === EModelEndpoint.azureOpenAI) &&
        scenario.useResponsesApi === true;

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider) ||
          isAzureWithResponsesApi,
      ).toBe(true);
    });
  });

  describe('HEIC/HEIF file type inference', () => {
    it('should infer image/heic for .heic files when browser returns empty type', () => {
      const fileName = 'photo.heic';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/heic');
    });

    it('should infer image/heif for .heif files when browser returns empty type', () => {
      const fileName = 'photo.heif';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/heif');
    });

    it('should handle uppercase .HEIC extension', () => {
      const fileName = 'IMG_1234.HEIC';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/heic');
    });

    it('should preserve browser-provided type when available', () => {
      const fileName = 'photo.jpg';
      const browserType = 'image/jpeg';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/jpeg');
    });

    it('should not override browser type even if extension differs', () => {
      const fileName = 'renamed.heic';
      const browserType = 'image/png';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/png');
    });

    it('should correctly identify HEIC as image type for upload options', () => {
      const heicType = inferMimeType('photo.heic', '');
      expect(heicType.startsWith('image/')).toBe(true);
    });

    it('should return empty string for unknown extension with no browser type', () => {
      const fileName = 'file.xyz';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('');
    });
  });
});
