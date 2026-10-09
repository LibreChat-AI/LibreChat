import type {
  UploadReading,
  TurnFileConsumers,
  TurnDeliveryFile,
  UploadReadingInput,
  TurnDeliveryRouting,
} from './resolve-llm-delivery-path';
import type {
  ReaderKind,
  FileReading,
  ClassicReason,
  BuiltInTextPlan,
  ReadingEvidence,
  TurnReadingInputs,
} from './reading';
import type { TDefaultLLMDeliveryPathConfig } from './file-config';
import type { EndpointFileConfig } from './types/files';
import type { TEndpoint } from './config';
import {
  hasTurnFileConsumer,
  isNativelyReadableText,
  hasToolResourceProvisioning,
  canToolResourceConsume,
  resolveUploadDestination,
  getCustomEndpointProvider,
  resolveTurnLLMDeliveryPath as resolveStoredTurnPath,
  hasInferredLLMDeliveryPath,
  resolveDefaultLLMDeliveryPath,
  resolveUploadLLMDeliveryPath,
  SYSTEM_LLM_DELIVERY_DEFAULTS,
  decideFileReading,
  decideUploadReading,
  judgeCodeEligibility,
  selectBuiltInTextPlan,
  isAutomaticReadingRecord,
  resolveClassicTurnLLMDeliveryPath,
} from './resolve-llm-delivery-path';
import {
  excelFileTypes,
  mergeFileConfig,
  supportedMimeTypes,
  getEndpointFileConfig,
} from './file-config';
import { EToolResources } from './types/tools';

function resolveTurnLLMDeliveryPath({
  file,
  consumers,
  ...routing
}: {
  file: TurnDeliveryFile;
  consumers?: TurnFileConsumers;
} & Partial<TurnDeliveryRouting>) {
  return resolveStoredTurnPath(routing, file, consumers);
}

describe('resolveDefaultLLMDeliveryPath', () => {
  it('should return system default for images when no config provided', () => {
    expect(resolveDefaultLLMDeliveryPath('image/png')).toBe('provider');
  });

  it('should return system default for PDFs when no config provided', () => {
    expect(resolveDefaultLLMDeliveryPath('application/pdf')).toBe('provider');
  });

  it('should return system default for videos when no config provided', () => {
    expect(resolveDefaultLLMDeliveryPath('video/mp4')).toBe('provider');
  });

  it('should return system default for audio when no config provided', () => {
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg')).toBe('provider');
  });

  it('should return system fallback for unknown mime types', () => {
    expect(resolveDefaultLLMDeliveryPath('text/plain')).toBe('text');
  });

  it('should match exact mime type before wildcard', () => {
    const config: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'image/png': 'text', 'image/*': 'provider' },
    };
    expect(resolveDefaultLLMDeliveryPath('image/png', config)).toBe('text');
  });

  it('should match wildcard when no exact match', () => {
    const config: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'image/*': 'none' },
    };
    expect(resolveDefaultLLMDeliveryPath('image/jpeg', config)).toBe('none');
  });

  it('should use config fallback when no override matches', () => {
    const config: TDefaultLLMDeliveryPathConfig = {
      fallback: 'none',
      overrides: { 'image/*': 'provider' },
    };
    expect(resolveDefaultLLMDeliveryPath('text/plain', config)).toBe('none');
  });

  it('should resolve endpoint config before global config', () => {
    const endpointConfig: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'image/*': 'text' },
    };
    const globalConfig: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'image/*': 'provider' },
    };
    expect(resolveDefaultLLMDeliveryPath('image/png', endpointConfig, globalConfig)).toBe('text');
  });

  it('should fall through to global config when endpoint has no match', () => {
    const endpointConfig: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'audio/*': 'none' },
    };
    const globalConfig: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'image/*': 'text' },
    };
    expect(resolveDefaultLLMDeliveryPath('image/png', endpointConfig, globalConfig)).toBe('text');
  });

  it('should use endpoint fallback before global overrides', () => {
    const endpointConfig: TDefaultLLMDeliveryPathConfig = {
      fallback: 'none',
    };
    const globalConfig: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'text/*': 'provider' },
    };
    expect(resolveDefaultLLMDeliveryPath('text/plain', endpointConfig, globalConfig)).toBe('none');
  });

  it('should fall through entire chain to system defaults', () => {
    const endpointConfig: TDefaultLLMDeliveryPathConfig = {};
    const globalConfig: TDefaultLLMDeliveryPathConfig = {};
    expect(resolveDefaultLLMDeliveryPath('image/png', endpointConfig, globalConfig)).toBe(
      'provider',
    );
    expect(resolveDefaultLLMDeliveryPath('application/pdf', endpointConfig, globalConfig)).toBe(
      'provider',
    );
    expect(resolveDefaultLLMDeliveryPath('text/csv', endpointConfig, globalConfig)).toBe('text');
  });

  it('should resolve none destination correctly', () => {
    const config: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'audio/*': 'none' },
    };
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', config)).toBe('none');
  });

  it('should prefer exact match over wildcard in the same config', () => {
    const config: TDefaultLLMDeliveryPathConfig = {
      overrides: { 'image/*': 'provider', 'image/svg+xml': 'text' },
    };
    expect(resolveDefaultLLMDeliveryPath('image/svg+xml', config)).toBe('text');
    expect(resolveDefaultLLMDeliveryPath('image/png', config)).toBe('provider');
  });

  it('should handle undefined configs gracefully', () => {
    expect(resolveDefaultLLMDeliveryPath('text/plain', undefined, undefined)).toBe('text');
  });

  it('routes PDFs to text for a known endpoint without native document support', () => {
    expect(
      resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'azureOpenAI'),
    ).toBe('text');
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'azureOpenAI')).toBe(
      'text',
    );
  });

  it('keeps unsupported video off the model path rather than parsing it as text', () => {
    /* Nothing extracts text from video: speech-to-text covers audio only, and the default
     * text matcher accepts any well-formed type, so a downgrade to text ends in raw bytes
     * decoded as UTF-8. */
    expect(resolveDefaultLLMDeliveryPath('video/mp4', undefined, undefined, 'azureOpenAI')).toBe(
      'none',
    );
    expect(resolveDefaultLLMDeliveryPath('video/mp4', undefined, undefined, 'anthropic')).toBe(
      'none',
    );
  });

  it('normalizes a known provider name before gating native media', () => {
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'OpenRouter')).toBe(
      'provider',
    );
  });

  it('normalizes a known provider name before gating native PDFs', () => {
    expect(
      resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'OpenRouter'),
    ).toBe('provider');
  });

  it('keeps archives and columnar data off the text fallback', () => {
    /* These land on the text fallback rather than the capability gate, and the default
     * text matcher accepts them, so they would be decoded as UTF-8 into the prompt. */
    for (const mimeType of [
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/epub+zip',
      'application/vnd.apache.parquet',
      /* No built-in parser handles presentations or drawings, so without OCR they would
       * reach the same raw-bytes fallback. */
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
      'application/vnd.oasis.opendocument.graphics',
      /* Legacy DOC is absent from documentParserMimeTypes, so it has no parser either. */
      'application/msword',
    ]) {
      expect(resolveDefaultLLMDeliveryPath(mimeType, undefined, undefined, 'openAI')).toBe('none');
    }
  });

  it('keeps recoverable types on the text fallback', () => {
    for (const mimeType of [
      'text/plain',
      'text/csv',
      'application/json',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'message/rfc822',
    ]) {
      expect(resolveDefaultLLMDeliveryPath(mimeType, undefined, undefined, 'openAI')).toBe('text');
    }
  });

  it('still honors an explicit override for an unparsable type', () => {
    expect(
      resolveDefaultLLMDeliveryPath(
        'application/zip',
        { overrides: { 'application/zip': 'text' } },
        undefined,
        'openAI',
      ),
    ).toBe('text');
  });

  it('still honors an explicit override for video', () => {
    /* Capability gating applies to the system default only; an admin who configures a
     * destination has made the decision. */
    expect(
      resolveDefaultLLMDeliveryPath(
        'video/mp4',
        { overrides: { 'video/*': 'text' } },
        undefined,
        'anthropic',
      ),
    ).toBe('text');
  });

  it('keeps provider delivery for endpoints that do support documents', () => {
    expect(resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'google')).toBe(
      'provider',
    );
  });

  it('routes transcribable media to text for providers without media encoders', () => {
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'openAI')).toBe(
      'text',
    );
    expect(resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'openAI')).toBe(
      'provider',
    );
  });

  it('keeps provider delivery for endpoints with real media encoders', () => {
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'google')).toBe(
      'provider',
    );
    expect(resolveDefaultLLMDeliveryPath('video/mp4', undefined, undefined, 'openrouter')).toBe(
      'provider',
    );
  });

  it('keeps images on the provider path regardless of document support', () => {
    expect(resolveDefaultLLMDeliveryPath('image/png', undefined, undefined, 'azureOpenAI')).toBe(
      'provider',
    );
  });

  it('does not downgrade when the endpoint is unknown', () => {
    expect(resolveDefaultLLMDeliveryPath('application/pdf')).toBe('provider');
  });

  it('lets explicit config override the capability gate', () => {
    expect(
      resolveDefaultLLMDeliveryPath(
        'application/pdf',
        { overrides: { 'application/pdf': 'provider' } },
        undefined,
        'azureOpenAI',
      ),
    ).toBe('provider');
  });

  it('routes Bedrock document types through the provider on bedrock', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(resolveDefaultLLMDeliveryPath(docx, undefined, undefined, 'bedrock')).toBe('provider');
    expect(
      resolveDefaultLLMDeliveryPath('application/msword', undefined, undefined, 'bedrock'),
    ).toBe('provider');
  });

  it('keeps Bedrock document types on text for other endpoints', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(resolveDefaultLLMDeliveryPath(docx, undefined, undefined, 'openAI')).toBe('text');
    expect(resolveDefaultLLMDeliveryPath(docx)).toBe('text');
  });

  it('lets explicit config override the Bedrock document default', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(resolveDefaultLLMDeliveryPath(docx, { fallback: 'text' }, undefined, 'bedrock')).toBe(
      'text',
    );
  });

  it('keeps the system default when the provider is unresolved (agents container)', () => {
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'agents')).toBe(
      'provider',
    );
    expect(resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'agents')).toBe(
      'provider',
    );
  });

  it('keeps documents on the provider path for a custom endpoint name', () => {
    /* A custom endpoint is usually OpenAI- or Anthropic-compatible, and both carry
     * documents, so judging capability from a name we cannot identify would downgrade
     * something the real provider delivers. */
    expect(resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'MyOpenAI')).toBe(
      'provider',
    );
  });

  it('downgrades media for a custom endpoint name', () => {
    /* Media is different: the encoders emit a payload only for the providers they name,
     * so a custom endpoint receives nothing whatever it proxies to. Left on the provider
     * path the model gets neither the media nor a transcript. */
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'MyOpenAI')).toBe(
      'text',
    );
    expect(resolveDefaultLLMDeliveryPath('video/mp4', undefined, undefined, 'MyOpenAI')).toBe(
      'none',
    );
  });

  describe('media a custom endpoint opted into', () => {
    /* The encoders emit OpenAI-format media parts for an OpenAI-compatible endpoint only
     * when the admin listed the type in its `supportedMimeTypes`, so the route has to
     * agree: an explicit match is provider-capable, the inherited default list is not. */
    const explicit = [/^image\/.*$/, /^application\/pdf$/, /^video\/.*$/, /^audio\/wav$/];
    const resolve = (mimeType: string, endpoint: string, types?: RegExp[]) =>
      resolveDefaultLLMDeliveryPath(
        mimeType,
        undefined,
        undefined,
        endpoint,
        undefined,
        true,
        types,
      );

    it('keeps an explicitly allowed type on the provider path for a custom endpoint', () => {
      expect(resolve('video/mp4', 'MyGateway', explicit)).toBe('provider');
      expect(resolve('audio/wav', 'MyGateway', explicit)).toBe('provider');
    });

    it('still downgrades a media type the allowlist does not name', () => {
      expect(resolve('audio/mpeg', 'MyGateway', explicit)).toBe('text');
    });

    it('does not read the inherited default list as an opt-in', () => {
      expect(resolve('video/mp4', 'MyGateway', supportedMimeTypes)).toBe('none');
      expect(resolve('video/mp4', 'MyGateway', [])).toBe('none');
    });

    it('does not opt in a built-in endpoint, which the client offers no media for', () => {
      /* Anthropic and Bedrock encoders have no media branch at all, and OpenAI/Azure are
       * left out because the picker and drag-drop only open media for custom endpoints:
       * a route the client cannot send to is a capability with no entry point. */
      expect(resolve('video/mp4', 'openAI', explicit)).toBe('none');
      expect(resolve('video/mp4', 'azureOpenAI', explicit)).toBe('none');
      expect(resolve('video/mp4', 'anthropic', explicit)).toBe('none');
      expect(resolve('video/mp4', 'bedrock', explicit)).toBe('none');
    });

    it('keeps a custom endpoint that runs as Anthropic on its previous route', () => {
      /* A custom endpoint may declare `provider: anthropic`, and the encoders emit
       * OpenAI-format parts only, so the opt-in would deliver nothing there. Audio keeps
       * its transcription route and video stays off the model path. */
      const endpointConfig = { supportedMimeTypes: explicit };
      const anthropic = { mimeType: 'video/mp4', endpointConfig, endpoint: 'MyClaude' };
      expect(resolveUploadLLMDeliveryPath({ ...anthropic, endpointProvider: 'anthropic' })).toBe(
        'none',
      );
      expect(
        resolveUploadLLMDeliveryPath({
          ...anthropic,
          mimeType: 'audio/wav',
          endpointProvider: 'anthropic',
          sttConfigured: true,
        }),
      ).toBe('text');
      expect(resolveUploadLLMDeliveryPath({ ...anthropic, endpointProvider: 'openAI' })).toBe(
        'provider',
      );
      expect(resolveUploadLLMDeliveryPath(anthropic)).toBe('provider');
    });

    it('reaches the upload resolver through the merged endpoint config', () => {
      /* The real merge, so the identity check that separates a configured list from the
       * inherited default is exercised the way the upload route exercises it. */
      const fileConfig = mergeFileConfig({
        endpoints: { MyGateway: { supportedMimeTypes: ['image/.*', 'video/.*'] } },
      });
      const configured = getEndpointFileConfig({ fileConfig, endpoint: 'MyGateway' });
      const inherited = getEndpointFileConfig({ fileConfig, endpoint: 'OtherGateway' });

      expect(
        resolveUploadLLMDeliveryPath({
          mimeType: 'video/mp4',
          endpointConfig: configured,
          fileConfig,
          endpoint: 'MyGateway',
        }),
      ).toBe('provider');
      expect(
        resolveUploadLLMDeliveryPath({
          mimeType: 'video/mp4',
          endpointConfig: inherited,
          fileConfig,
          endpoint: 'OtherGateway',
        }),
      ).toBe('none');
    });
  });

  it('leaves media alone when no endpoint is resolved at all', () => {
    /* An ephemeral agent reports no usable endpoint, which is not the same as naming one
     * we cannot identify. */
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg')).toBe('provider');
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'agents')).toBe(
      'provider',
    );
  });

  it('keeps audio off the text path where nothing transcribes it', () => {
    /* Audio's text path is speech to text, so with no provider configured routing it
     * there sends the upload to a service that is not running and fails it. */
    expect(
      resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'openAI', undefined, false),
    ).toBe('none');
    expect(
      resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'openAI', undefined, true),
    ).toBe('text');
    /* Unknown is not absent: a caller that does not say keeps the existing answer. */
    expect(resolveDefaultLLMDeliveryPath('audio/mpeg', undefined, undefined, 'openAI')).toBe(
      'text',
    );
  });

  it('honors the Responses API when routing Azure documents', () => {
    /* Azure is out of the document set because native documents need Responses, so the
     * encoder's own condition decides rather than the endpoint alone. */
    expect(
      resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'azureOpenAI'),
    ).toBe('text');
    expect(
      resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'azureOpenAI', true),
    ).toBe('provider');
  });

  it('should export SYSTEM_LLM_DELIVERY_DEFAULTS with correct shape', () => {
    expect(SYSTEM_LLM_DELIVERY_DEFAULTS.fallback).toBe('text');
    expect(SYSTEM_LLM_DELIVERY_DEFAULTS.overrides).toEqual({
      'image/*': 'provider',
      'video/*': 'provider',
      'audio/*': 'provider',
      'application/pdf': 'provider',
    });
  });
});

describe('resolveUploadDestination', () => {
  const base = { mimeType: 'application/zip', hasAgent: true, isMessageAttachment: false };

  it('keeps an explicit resource and normalizes ocr to context', () => {
    expect(
      resolveUploadDestination({ ...base, toolResource: 'ocr', deliveryPath: 'text' }).toolResource,
    ).toBe('context');
    expect(
      resolveUploadDestination({ ...base, toolResource: 'file_search', deliveryPath: 'none' })
        .toolResource,
    ).toBe('file_search');
  });

  it('promotes a text-routed upload to context', () => {
    expect(resolveUploadDestination({ ...base, deliveryPath: 'text' }).toolResource).toBe(
      'context',
    );
  });

  it('does not refuse an upload for having no consumer on the agent record', () => {
    /* A skill can contribute file search or code execution for the turn without appearing
     * in agent.tools, so an empty list is not evidence that nothing will read the file. */
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'none',
        agentTools: [],
        isMessageAttachment: true,
        allowUnknownMessageConsumer: true,
      }).rejection,
    ).toBeUndefined();
  });

  it('does not judge an unknown tool set', () => {
    /* An ephemeral agent has no record, so its tools are unknown rather than absent. */
    expect(resolveUploadDestination({ ...base, deliveryPath: 'none' }).rejection).toBe(
      'no-agent-resource',
    );
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'none',
        isMessageAttachment: true,
        allowUnknownMessageConsumer: true,
      }).rejection,
    ).toBeUndefined();
  });

  it('passes over a tool that cannot read the type, whatever order they are listed in', () => {
    /* An archive: only code execution can take it, so search listed first must not win. */
    for (const agentTools of [
      ['file_search', 'execute_code'],
      ['execute_code', 'file_search'],
    ]) {
      expect(
        resolveUploadDestination({
          ...base,
          mimeType: 'application/zip',
          deliveryPath: 'none',
          agentTools,
        }).toolResource,
      ).toBe('execute_code');
    }
  });

  it('picks a consumer that can read the type, whatever order the tools are listed in', () => {
    /* file_search indexes extracted text and has nothing to do with an image, so choosing
     * it would make the upload fail on a rule the agent's tool order decided. */
    for (const agentTools of [
      ['file_search', 'execute_code'],
      ['execute_code', 'file_search'],
    ]) {
      expect(
        resolveUploadDestination({
          ...base,
          mimeType: 'image/png',
          deliveryPath: 'none',
          agentTools,
        }).toolResource,
      ).toBe('execute_code');
    }
  });

  it('files a permanent upload under the tool that will consume it', () => {
    expect(
      resolveUploadDestination({ ...base, deliveryPath: 'none', agentTools: ['execute_code'] })
        .toolResource,
    ).toBe('execute_code');
  });

  it('refuses a permanent text upload when the context capability is off', () => {
    /* Priming skips context ids entirely when the capability is off, so storing one
     * reports success and leaves the agent a file it can never open. */
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'text',
        contextEnabled: false,
      }).rejection,
    ).toBe('context-disabled');
    expect(
      resolveUploadDestination({
        ...base,
        toolResource: 'ocr',
        deliveryPath: 'text',
        contextEnabled: false,
      }).rejection,
    ).toBe('context-disabled');
  });

  it('leaves message attachments and unknown capability alone', () => {
    /* A message attachment is delivered with the turn rather than stored on the agent,
     * and an unlooked-up capability is not judged. */
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'text',
        isMessageAttachment: true,
        contextEnabled: false,
      }).toolResource,
    ).toBe('context');
    expect(resolveUploadDestination({ ...base, deliveryPath: 'text' }).toolResource).toBe(
      'context',
    );
  });

  it('refuses a permanent upload that would land on no agent resource', () => {
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'provider',
        agentTools: [],
      }).rejection,
    ).toBe('no-agent-resource');
  });

  it('accepts a none-routed message attachment with no agent record behind it', () => {
    /* The ephemeral agent that runs the turn takes its tools from per-turn state the
     * upload cannot see, so refusing here rejects the file a user just enabled the code
     * interpreter for. Storing it is what lets provisioning reach it when the tool runs. */
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'none',
        hasAgent: false,
        isMessageAttachment: true,
        allowUnknownMessageConsumer: true,
      }),
    ).toEqual({});
  });

  it('refuses a none-routed upload with no turn and no agent behind it', () => {
    /* Nothing provisions this: no agent to file it under and no message to carry it. */
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'none',
        hasAgent: false,
        isMessageAttachment: false,
      }).rejection,
    ).toBe('no-consumer');
  });

  it('does not judge an agent conversation the same way', () => {
    /* An agent's tool set is not knowable at upload: a skill can contribute file search
     * or code execution for the turn without appearing in agent.tools. */
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'none',
        agentTools: [],
        isMessageAttachment: true,
        allowUnknownMessageConsumer: true,
      }).rejection,
    ).toBeUndefined();
  });

  it('leaves a message attachment unclaimed', () => {
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'provider',
        isMessageAttachment: true,
      }),
    ).toEqual({});
  });

  it('refuses a none-routed ordinary chat attachment', () => {
    expect(
      resolveUploadDestination({
        ...base,
        deliveryPath: 'none',
        hasAgent: false,
        isMessageAttachment: true,
      }).rejection,
    ).toBe('no-consumer');
  });
});

describe('getCustomEndpointProvider', () => {
  const custom = [
    { name: 'My Claude', provider: 'anthropic' },
    { name: 'Ollama', provider: 'anthropic' },
    { name: 'MyGateway' },
  ] as Array<Partial<Pick<TEndpoint, 'name' | 'provider'>>>;

  it('returns the declared dialect for a custom endpoint, matching the normalized name', () => {
    expect(getCustomEndpointProvider(custom, 'My Claude')).toBe('anthropic');
    /* The same normalization the file config lookup applies to endpoint names. */
    expect(getCustomEndpointProvider(custom, 'ollama')).toBe('anthropic');
  });

  it('returns nothing for an endpoint without a dialect, an unknown one, or no config', () => {
    expect(getCustomEndpointProvider(custom, 'MyGateway')).toBeUndefined();
    expect(getCustomEndpointProvider(custom, 'Other')).toBeUndefined();
    expect(getCustomEndpointProvider(undefined, 'My Claude')).toBeUndefined();
    expect(getCustomEndpointProvider(custom, undefined)).toBeUndefined();
  });
});

describe('isNativelyReadableText', () => {
  it('admits the application types whose payload is text', () => {
    /* Kept in step with the textual set in the content-protection code. Missing one sends
     * a readable file down the extractor path, where no parser claims it and it is lost. */
    for (const mimeType of [
      'application/json',
      'application/javascript',
      'application/sql',
      'application/xml',
      'application/x-yaml',
      'application/yaml',
      'text/markdown',
      'message/rfc822',
    ]) {
      expect(isNativelyReadableText(mimeType)).toBe(true);
    }
  });

  it('rejects types whose bytes are not text', () => {
    for (const mimeType of ['application/zip', 'application/pdf', 'image/png']) {
      expect(isNativelyReadableText(mimeType)).toBe(false);
    }
  });

  it('ignores parameters and case, as browsers send both', () => {
    expect(isNativelyReadableText('text/plain; charset=utf-8')).toBe(true);
    expect(isNativelyReadableText('Application/JSON')).toBe(true);
  });
});

describe('canToolResourceConsume', () => {
  it('accepts a presentation for file search, which RAG handles', () => {
    /* The chooser offers file search for pptx from the retrieval set, so refusing it
     * here rejects the destination the user was just given. The extraction set omits
     * presentations because the document parser cannot read them, which is a different
     * question from what the vector service can index. */
    expect(
      canToolResourceConsume(
        'file_search',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe(true);
    expect(
      canToolResourceConsume(
        'file_search',
        'application/vnd.openxmlformats-officedocument.presentationml.template',
      ),
    ).toBe(true);
  });

  it('still accepts csv for file search, which the retrieval set omits', () => {
    expect(canToolResourceConsume('file_search', 'text/csv')).toBe(true);
    expect(canToolResourceConsume('file_search', 'application/vnd.ms-excel')).toBe(true);
  });

  it('judges each tool by the list the client offers it from', () => {
    /* An archive is readable by the code interpreter and not by the vector store, so
     * treating everything non-image as searchable sent it to RAG to be rejected. */
    expect(canToolResourceConsume('file_search', 'image/png')).toBe(false);
    expect(canToolResourceConsume('file_search', 'application/zip')).toBe(false);
    expect(canToolResourceConsume('file_search', 'video/mp4')).toBe(false);
    expect(canToolResourceConsume('file_search', 'audio/mpeg')).toBe(false);
    expect(canToolResourceConsume('file_search', 'application/pdf')).toBe(true);
    /* The vector store handles more than the historical retrieval list, and a data file
     * is a normal thing to search. */
    expect(canToolResourceConsume('file_search', 'text/csv')).toBe(true);
    expect(canToolResourceConsume('execute_code', 'application/zip')).toBe(true);
    expect(canToolResourceConsume('execute_code', 'image/png')).toBe(true);
  });
});

describe('provider document capability', () => {
  it('keeps Bedrock documents on the provider path', () => {
    /* Bedrock is in documentSupportedProviders, so the capability downgrade does not
     * apply to it. Pinned because the Converse document path handles more than PDF and a
     * downgrade here would silently flatten it through extraction. */
    expect(resolveDefaultLLMDeliveryPath('application/pdf', undefined, undefined, 'bedrock')).toBe(
      'provider',
    );
    expect(
      resolveDefaultLLMDeliveryPath(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        undefined,
        undefined,
        'bedrock',
      ),
    ).toBe('provider');
  });
});

const codeRef = {
  kind: 'user' as const,
  id: 'user_1',
  storage_session_id: 'session_1',
  file_id: 'sandbox_file_1',
};
/** File search reads an email export and the code interpreter's list does not offer it. */
const eml = 'message/rfc822';

describe('hasTurnFileConsumer', () => {
  it('finds a reader only among the tools this turn runs', () => {
    expect(hasTurnFileConsumer('text/csv', { executeCode: false, fileSearch: false })).toBe(false);
    expect(hasTurnFileConsumer('text/csv', { executeCode: true, fileSearch: false })).toBe(true);
    expect(hasTurnFileConsumer('text/csv', { executeCode: false, fileSearch: true })).toBe(true);
  });

  it('does not count a tool that cannot read the type', () => {
    expect(hasTurnFileConsumer('video/mp4', { executeCode: false, fileSearch: true })).toBe(false);
  });

  it('counts File Search only where the record shows the vector store holds the file', () => {
    const consumers = { executeCode: false, fileSearch: true };
    expect(hasTurnFileConsumer('text/csv', consumers, { embedded: true })).toBe(true);
    expect(hasTurnFileConsumer('text/csv', consumers, { embedded: false })).toBe(false);
    expect(hasTurnFileConsumer('text/csv', consumers, {})).toBe(false);
  });

  it('counts an enabled Run Code as a reader before the sandbox holds a copy', () => {
    /* Its first call uploads the file, so no reference is needed in advance. The tool still
     * has to be able to read the type. */
    const consumers = { executeCode: true, fileSearch: false };
    expect(hasTurnFileConsumer('text/csv', consumers, {})).toBe(true);
    expect(hasTurnFileConsumer('text/csv', consumers, { metadata: {} })).toBe(true);
    expect(hasTurnFileConsumer(eml, consumers, {})).toBe(false);
  });

  it('pairs the evidence with the tool that can read the type', () => {
    /* Only the sandbox holds this file, so the tool that can read an email export is the one
     * without a copy of it, while csv is served by the tool that has one. */
    const held = { metadata: { codeEnvRef: codeRef } };
    const both = { executeCode: true, fileSearch: true };
    expect(hasTurnFileConsumer(eml, both, held)).toBe(false);
    expect(hasTurnFileConsumer('text/csv', both, held)).toBe(true);
  });
});

describe('hasToolResourceProvisioning', () => {
  it('reads vectors for file search and a sandbox pointer for code', () => {
    expect(hasToolResourceProvisioning({ embedded: true }, EToolResources.file_search)).toBe(true);
    expect(
      hasToolResourceProvisioning(
        { metadata: { embeddedEntities: ['agent_1'] } },
        EToolResources.file_search,
      ),
    ).toBe(true);
    expect(
      hasToolResourceProvisioning(
        { metadata: { codeEnvRef: codeRef } },
        EToolResources.execute_code,
      ),
    ).toBe(true);
    expect(
      hasToolResourceProvisioning(
        { metadata: { codeEnvRefs: { default: codeRef } } },
        EToolResources.execute_code,
      ),
    ).toBe(true);
  });

  it("does not read one tool's store as the other's", () => {
    expect(hasToolResourceProvisioning({ embedded: true }, EToolResources.execute_code)).toBe(
      false,
    );
    expect(
      hasToolResourceProvisioning(
        { metadata: { codeEnvRef: codeRef } },
        EToolResources.file_search,
      ),
    ).toBe(false);
  });

  it('treats a record with neither as unprovisioned', () => {
    expect(hasToolResourceProvisioning({}, EToolResources.file_search)).toBe(false);
    expect(hasToolResourceProvisioning({ embedded: false }, EToolResources.file_search)).toBe(
      false,
    );
    expect(
      hasToolResourceProvisioning(
        { metadata: { embeddedEntities: [] } },
        EToolResources.file_search,
      ),
    ).toBe(false);
    expect(hasToolResourceProvisioning({ metadata: {} }, EToolResources.execute_code)).toBe(false);
  });
});

describe('hasInferredLLMDeliveryPath', () => {
  it('re-resolves only a route upload inferred', () => {
    expect(hasInferredLLMDeliveryPath({ llmDeliveryPath: 'none' })).toBe(true);
    expect(
      hasInferredLLMDeliveryPath({
        llmDeliveryPath: 'text',
        metadata: { destinationChosen: false },
      }),
    ).toBe(true);
    expect(
      hasInferredLLMDeliveryPath({
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: true },
      }),
    ).toBe(false);
    expect(hasInferredLLMDeliveryPath({ type: 'text/csv' })).toBe(false);
  });
});

describe('resolveTurnLLMDeliveryPath', () => {
  const endpointConfig: EndpointFileConfig = {
    defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
    textFallbackWithoutTools: true,
  };
  const noReader: TurnFileConsumers = { executeCode: false, fileSearch: false };
  const routedCsv = {
    type: 'text/csv',
    text: 'region,total\nwest,4',
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false },
  };

  it('delivers stored text when the turn runs no tool that can read the file', () => {
    expect(
      resolveTurnLLMDeliveryPath({ file: routedCsv, consumers: noReader, endpointConfig }),
    ).toBe('text');
  });

  it('keeps the tool route on an endpoint that has not enabled the fallback', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: routedCsv,
        consumers: noReader,
        endpointConfig: { ...endpointConfig, textFallbackWithoutTools: undefined },
      }),
    ).toBe('none');
    expect(
      resolveTurnLLMDeliveryPath({
        file: routedCsv,
        consumers: noReader,
        endpointConfig: { ...endpointConfig, textFallbackWithoutTools: false },
      }),
    ).toBe('none');
  });

  it('leaves the file to Run Code when the sandbox it runs on holds the file', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, metadata: { ...routedCsv.metadata, codeEnvRef: codeRef } },
        consumers: { executeCode: true, fileSearch: false },
        endpointConfig,
      }),
    ).toBe('none');
  });

  it('leaves the file to File Search once the vector store holds it', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, embedded: true },
        consumers: { executeCode: false, fileSearch: true },
        endpointConfig,
      }),
    ).toBe('none');
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, metadata: { ...routedCsv.metadata, embeddedEntities: ['agent_1'] } },
        consumers: { executeCode: false, fileSearch: true },
        endpointConfig,
      }),
    ).toBe('none');
  });

  it('delivers text when File Search is on but never received the file', () => {
    /* The plain-chat File Search toggle: the upload names no destination, so nothing files it
     * under a tool resource and it is never embedded. Withholding the text on the strength of
     * the toggle alone left the attachment readable by nothing at all. */
    expect(
      resolveTurnLLMDeliveryPath({
        file: routedCsv,
        consumers: { executeCode: false, fileSearch: true },
        endpointConfig,
      }),
    ).toBe('text');
  });

  it('leaves a file Run Code can read with Run Code before the sandbox holds it', () => {
    /* Delivered text counts toward the turn's attachment limits. A turn those limits refuse
     * never runs code, so the file would never become held and every later turn would carry
     * the same text and be refused the same way. Run Code uploads the file on its first call. */
    expect(
      resolveTurnLLMDeliveryPath({
        file: routedCsv,
        consumers: { executeCode: true, fileSearch: false },
        endpointConfig,
      }),
    ).toBe('none');
  });

  it('delivers text where the tool holding the file cannot read this type', () => {
    /* The vectors belong to file search, which this turn does not run, and code execution both
     * lacks a copy and cannot read an email export, so nothing here serves the file. */
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, type: eml, embedded: true },
        consumers: { executeCode: true, fileSearch: false },
        endpointConfig: {
          ...endpointConfig,
          defaultLLMDeliveryPath: { overrides: { [eml]: 'none' } },
        },
      }),
    ).toBe('text');
  });

  it('does not judge a turn whose tools are unknown', () => {
    expect(resolveTurnLLMDeliveryPath({ file: routedCsv, endpointConfig })).toBe('none');
  });

  it('keeps the tool route when upload stored no text to fall back to', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, text: undefined },
        consumers: noReader,
        endpointConfig,
      }),
    ).toBe('none');
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, text: '' },
        consumers: noReader,
        endpointConfig,
      }),
    ).toBe('none');
  });

  it('keeps a destination the user chose even when nothing this turn can read it', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: { ...routedCsv, metadata: { destinationChosen: true } },
        consumers: noReader,
        endpointConfig,
      }),
    ).toBe('none');
  });

  it('leaves a record predating routing to its legacy handling', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: { type: 'text/csv', text: 'region,total' },
        consumers: noReader,
        endpointConfig,
      }),
    ).toBeUndefined();
  });

  it('does not fall back from a route that already reaches the model', () => {
    expect(
      resolveTurnLLMDeliveryPath({
        file: routedCsv,
        consumers: noReader,
        endpointConfig: { defaultLLMDeliveryPath: { overrides: { 'text/csv': 'provider' } } },
      }),
    ).toBe('provider');
  });

  it('re-resolves media against the provider the endpoint runs as', () => {
    /* A custom endpoint whose admin listed video receives it only while it speaks OpenAI's
     * format, so the turn route has to see the declared provider the upload route saw. */
    const video = {
      type: 'video/mp4',
      llmDeliveryPath: 'provider',
      metadata: { destinationChosen: false },
    };
    const gateway = {
      file: video,
      consumers: noReader,
      endpoint: 'MyGateway',
      endpointConfig: { supportedMimeTypes: [/^video\/mp4$/] },
    };

    expect(resolveTurnLLMDeliveryPath({ ...gateway, endpointProvider: 'openAI' })).toBe('provider');
    expect(resolveTurnLLMDeliveryPath({ ...gateway, endpointProvider: 'anthropic' })).toBe('none');
  });

  it('judges readers against the type routing saw before conversion', () => {
    /* File Search reads the original CSV but not the converted image type, so checking the
     * stored type here would wrongly find no reader and paste the file into the prompt. */
    const converted = {
      ...routedCsv,
      type: 'image/png',
      embedded: true,
      metadata: { destinationChosen: false, routingMimeType: 'text/csv' },
    };

    expect(
      resolveTurnLLMDeliveryPath({
        file: converted,
        consumers: { executeCode: false, fileSearch: true },
        endpointConfig,
      }),
    ).toBe('none');
  });
});

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';
const TSV = 'text/tab-separated-values';
const PARQUET = 'application/vnd.apache.parquet';
const MSWORD = 'application/msword';
const PDF = 'application/pdf';
const ZIP = 'application/zip';

const NO_TOOLS: TurnFileConsumers = { executeCode: false, fileSearch: false };
const CODE_ONLY: TurnFileConsumers = { executeCode: true, fileSearch: false };
const SEARCH_ONLY: TurnFileConsumers = { executeCode: false, fileSearch: true };
const BOTH_TOOLS: TurnFileConsumers = { executeCode: true, fileSearch: true };

const automaticConfig: EndpointFileConfig = { llmDeliveryPolicy: 'automatic' };

function automaticRouting(
  endpoint: string,
  overrides: Partial<TurnDeliveryRouting> = {},
): Partial<TurnDeliveryRouting> {
  return {
    endpoint,
    endpointConfig: automaticConfig,
    fileConfig: mergeFileConfig(undefined),
    sttConfigured: true,
    ...overrides,
  };
}

const withEvidence = (evidence: ReadingEvidence = {}, canDerive = false): TurnReadingInputs => ({
  judge: () => evidence,
  canDerive,
});

function attachment(type: string, overrides: Partial<TurnDeliveryFile> = {}): TurnDeliveryFile {
  return {
    file_id: 'file_1',
    type,
    bytes: 2048,
    source: 'local',
    context: 'message_attachment',
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false },
    ...overrides,
  };
}

const decide = (
  file: TurnDeliveryFile,
  consumers: TurnFileConsumers | undefined,
  routing: Partial<TurnDeliveryRouting> | undefined = automaticRouting('openAI'),
): FileReading => decideFileReading({ routing, file, consumers });

const skippedReaders = (reading: FileReading): ReaderKind[] =>
  reading.skipped.map(({ reader }) => reader);

describe('judgeCodeEligibility', () => {
  const file = attachment(XLSX);

  it('names the first reason Run Code cannot read the record', () => {
    expect(judgeCodeEligibility(file, undefined)).toBe('no_run_code');
    expect(judgeCodeEligibility(file, SEARCH_ONLY)).toBe('no_run_code');
    expect(judgeCodeEligibility({ ...file, source: 'text' }, CODE_ONLY)).toBe('text_only_record');
    expect(judgeCodeEligibility({ ...file, type: 'audio/mpeg' }, CODE_ONLY)).toBe('incompatible');
    expect(judgeCodeEligibility({ ...file, type: eml }, CODE_ONLY)).toBe('incompatible');
    expect(judgeCodeEligibility({ ...file, source: 'openai' }, CODE_ONLY)).toBe('unstreamable');
    expect(
      judgeCodeEligibility({ ...file, metadata: { destinationChosen: true } }, CODE_ONLY),
    ).toBe('declined');
  });

  it('counts an enabled Run Code before the sandbox holds a copy', () => {
    expect(judgeCodeEligibility(file, CODE_ONLY)).toBe('eligible');
    expect(judgeCodeEligibility({ ...file, source: undefined }, BOTH_TOOLS)).toBe('eligible');
    expect(
      judgeCodeEligibility(
        { ...file, metadata: { destinationChosen: true, codeEnvRef: codeRef } },
        CODE_ONLY,
      ),
    ).toBe('eligible');
  });

  it('judges the stored type the sandbox receives', () => {
    const converted = { ...file, type: 'audio/mpeg', metadata: { routingMimeType: XLSX } };
    expect(judgeCodeEligibility(converted, CODE_ONLY)).toBe('incompatible');
  });
});

describe('decideFileReading', () => {
  describe('eligibility gate', () => {
    const eligible = attachment(XLSX, { text: 'region,total' });
    const withConfig = (endpointConfig: EndpointFileConfig) =>
      automaticRouting('openAI', { endpointConfig: { ...automaticConfig, ...endpointConfig } });
    const cases: Array<
      [
        ClassicReason,
        Partial<TurnDeliveryRouting> | undefined,
        TurnDeliveryFile,
        TurnFileConsumers | undefined,
      ]
    > = [
      ['legacy_record', undefined, eligible, CODE_ONLY],
      [
        'legacy_record',
        automaticRouting('openAI'),
        { ...eligible, llmDeliveryPath: null },
        CODE_ONLY,
      ],
      ['classic_policy', automaticRouting('openAI', { endpointConfig: {} }), eligible, CODE_ONLY],
      ['classic_policy', withConfig({ llmDeliveryPolicy: 'classic' }), eligible, CODE_ONLY],
      ['classic_policy', withConfig({ legacyFileUploadUX: true }), eligible, CODE_ONLY],
      [
        'explicit_destination',
        automaticRouting('openAI'),
        { ...eligible, metadata: { destinationChosen: true } },
        CODE_ONLY,
      ],
      ['unmarked_record', automaticRouting('openAI'), { ...eligible, metadata: {} }, CODE_ONLY],
      ['unmarked_record', automaticRouting('openAI'), { ...eligible, metadata: null }, CODE_ONLY],
      [
        'not_message_attachment',
        automaticRouting('openAI'),
        { ...eligible, context: 'agents' },
        CODE_ONLY,
      ],
      [
        'not_message_attachment',
        automaticRouting('openAI'),
        { ...eligible, context: 'execute_code' },
        CODE_ONLY,
      ],
      [
        'not_message_attachment',
        automaticRouting('openAI'),
        { ...eligible, context: undefined },
        CODE_ONLY,
      ],
      ['text_only_record', automaticRouting('openAI'), { ...eligible, source: 'text' }, CODE_ONLY],
      [
        'configured_route',
        withConfig({ defaultLLMDeliveryPath: { overrides: { [XLSX]: 'text' } } }),
        eligible,
        CODE_ONLY,
      ],
      [
        'configured_route',
        withConfig({ defaultLLMDeliveryPath: { overrides: { 'application/*': 'none' } } }),
        eligible,
        NO_TOOLS,
      ],
      [
        'configured_route',
        automaticRouting('openAI', {
          fileConfig: { endpoints: {}, defaultLLMDeliveryPath: { fallback: 'text' } },
        }),
        eligible,
        CODE_ONLY,
      ],
      ['consumers_unknown', automaticRouting('openAI'), eligible, undefined],
      ['no_file_tools', automaticRouting('openAI'), eligible, NO_TOOLS],
      ['no_file_tools', automaticRouting('bedrock'), attachment(XLSX), NO_TOOLS],
      ['no_file_tools', automaticRouting('openAI'), attachment(PPTX, { text: 'slides' }), NO_TOOLS],
      ['no_file_tools', automaticRouting('openAI'), attachment('audio/mpeg'), NO_TOOLS],
      [
        'media_category',
        automaticRouting('openAI'),
        attachment('image/png', { llmDeliveryPath: 'provider' }),
        CODE_ONLY,
      ],
      ['media_category', automaticRouting('openAI'), attachment('audio/mpeg'), SEARCH_ONLY],
      ['media_category', automaticRouting('google'), attachment('video/mp4'), BOTH_TOOLS],
    ];

    it.each(cases)('keeps the classic route: %s', (reason, routing, file, consumers) => {
      const reading = decideFileReading({ routing, file, consumers });

      expect(reading).toMatchObject({ reason, automatic: false, skipped: [], needsText: false });
      expect(reading.path).toBe(resolveClassicTurnLLMDeliveryPath(routing, file, consumers));
      expect(reading.classicPath).toBe(reading.path);
    });

    it('checks the gates in order', () => {
      const configured = automaticRouting('openAI', {
        endpointConfig: {
          ...automaticConfig,
          defaultLLMDeliveryPath: { overrides: { [XLSX]: 'text' } },
        },
      });
      let file = attachment(XLSX, {
        source: 'text',
        context: 'agents',
        metadata: { destinationChosen: true },
      });
      const reasonOf = (
        routing: Partial<TurnDeliveryRouting>,
        consumers?: TurnFileConsumers,
      ): FileReading['reason'] => decideFileReading({ routing, file, consumers }).reason;

      expect(reasonOf(configured)).toBe('explicit_destination');
      file = { ...file, metadata: {} };
      expect(reasonOf(configured)).toBe('unmarked_record');
      file = { ...file, metadata: { destinationChosen: false } };
      expect(reasonOf(configured)).toBe('not_message_attachment');
      file = { ...file, context: 'message_attachment' };
      expect(reasonOf(configured)).toBe('text_only_record');
      file = { ...file, source: 'local' };
      expect(reasonOf(configured)).toBe('configured_route');
      expect(reasonOf(automaticRouting('openAI'))).toBe('consumers_unknown');
      expect(reasonOf(automaticRouting('openAI'), NO_TOOLS)).toBe('no_file_tools');
      expect(reasonOf(automaticRouting('openAI'), CODE_ONLY)).toBe('code_preferred');
      file = { ...file, type: 'image/png' };
      expect(reasonOf(automaticRouting('openAI'), NO_TOOLS)).toBe('no_file_tools');
      expect(reasonOf(automaticRouting('openAI'), CODE_ONLY)).toBe('media_category');
    });
  });

  describe('tabular order: code, provider, text, search', () => {
    it('prefers Run Code whenever it can read the file', () => {
      expect(decide(attachment(XLSX, { text: 'region,total' }), BOTH_TOOLS)).toMatchObject({
        path: 'none',
        reader: 'code',
        reason: 'code_preferred',
        automatic: true,
        skipped: [],
        code: 'eligible',
        category: 'tabular',
        classicPath: 'text',
      });
    });

    it.each([...excelFileTypes, ODS, 'text/csv', 'application/csv', TSV])(
      'gives %s to Run Code',
      (mimeType) => {
        expect(decide(attachment(mimeType), CODE_ONLY)).toMatchObject({
          category: 'tabular',
          reader: 'code',
          reason: 'code_preferred',
        });
      },
    );

    it('falls back to native delivery where the provider takes the type', () => {
      const reading = decide(attachment(XLSX), SEARCH_ONLY, automaticRouting('bedrock'));
      expect(reading).toMatchObject({
        reader: 'provider',
        path: 'provider',
        reason: 'code_unavailable',
      });
      expect(skippedReaders(reading)).toEqual(['code']);
    });

    it('then to complete stored text', () => {
      const routing = automaticRouting('openAI', { reading: withEvidence({ text: 'fits' }) });
      const reading = decide(attachment(XLSX, { text: 'region,total' }), SEARCH_ONLY, routing);
      expect(reading).toMatchObject({ reader: 'text', path: 'text', needsText: false });
      expect(reading.skipped).toEqual([
        { reader: 'code', reason: 'code_unavailable' },
        { reader: 'provider', reason: 'native_unsupported' },
      ]);
    });

    it('then to File Search', () => {
      const reading = decide(attachment(XLSX), SEARCH_ONLY);
      expect(reading).toMatchObject({ reader: 'search', path: 'none' });
      expect(skippedReaders(reading)).toEqual(['code', 'provider', 'text']);
    });

    it('reports the file unavailable when no reader can take it', () => {
      const routing = automaticRouting('openAI', {
        reading: withEvidence({ search: 'unreachable' }),
      });
      const reading = decide(attachment(XLSX), SEARCH_ONLY, routing);
      expect(reading).toMatchObject({
        reader: 'unavailable',
        path: 'none',
        reason: 'code_unavailable',
      });
      expect(skippedReaders(reading)).toEqual(['code', 'provider', 'text', 'search']);
    });

    it('keeps the classic route when no file tool is loaded', () => {
      const reading = decide(attachment(XLSX, { text: 'region,total' }), NO_TOOLS);
      expect(reading).toMatchObject({
        reader: 'text',
        path: 'text',
        classicPath: 'text',
        reason: 'no_file_tools',
        automatic: false,
        skipped: [],
      });
    });
  });

  describe('document order: provider, text, search, code', () => {
    it('sends a document natively where the provider takes it', () => {
      const routing = automaticRouting('openAI', { reading: withEvidence({ native: 'fits' }) });
      expect(
        decide(attachment(PDF, { llmDeliveryPath: 'provider' }), BOTH_TOOLS, routing),
      ).toMatchObject({
        reader: 'provider',
        path: 'provider',
        reason: 'native_supported',
        skipped: [],
        category: 'document',
      });
    });

    it('then complete stored text', () => {
      const reading = decide(attachment(DOCX, { text: 'parsed' }), BOTH_TOOLS);
      expect(reading).toMatchObject({ reader: 'text', path: 'text', reason: 'native_unsupported' });
      expect(decide(attachment('text/markdown', { text: '# notes' }), CODE_ONLY)).toMatchObject({
        reader: 'text',
        reason: 'native_unsupported',
      });
    });

    it('then File Search, before Run Code', () => {
      const reading = decide(attachment(DOCX), BOTH_TOOLS);
      expect(reading).toMatchObject({ reader: 'search', path: 'none' });
      expect(skippedReaders(reading)).toEqual(['provider', 'text']);
    });

    it('then Run Code', () => {
      const reading = decide(attachment(DOCX), CODE_ONLY);
      expect(reading).toMatchObject({ reader: 'code', path: 'none', reason: 'text_unavailable' });
      expect(skippedReaders(reading)).toEqual(['provider', 'text', 'search']);
    });

    it('keeps an email export with stored text on its text route', () => {
      const mail = attachment(eml, { llmDeliveryPath: 'text', text: 'mail body' });
      const reading = decide(mail, BOTH_TOOLS);
      expect(reading).toMatchObject({
        reader: 'text',
        path: 'text',
        code: 'incompatible',
        category: 'document',
        automatic: true,
      });
      expect(reading.path).toBe(reading.classicPath);
    });

    it('sends a Word 97 document natively on Bedrock', () => {
      const doc = attachment(MSWORD);
      expect(decide(doc, CODE_ONLY, automaticRouting('bedrock'))).toMatchObject({
        category: 'document',
        reader: 'provider',
        path: 'provider',
        reason: 'native_supported',
      });
      expect(decide(doc, CODE_ONLY, automaticRouting('openAI'))).toMatchObject({
        reader: 'code',
        path: 'none',
      });
    });

    it('tries File Search before Run Code for a presentation', () => {
      const searched = decide(attachment(PPTX), BOTH_TOOLS);
      expect(searched).toMatchObject({ reader: 'search', path: 'none' });
      expect(skippedReaders(searched)).toEqual(['provider', 'text']);

      const coded = decide(attachment(PPTX), CODE_ONLY);
      expect(coded).toMatchObject({ reader: 'code', path: 'none' });
      expect(skippedReaders(coded)).toEqual(['provider', 'text', 'search']);
    });

    it('leaves archives and columnar data to Run Code or nothing', () => {
      expect(decide(attachment(ZIP), CODE_ONLY)).toMatchObject({ reader: 'code', path: 'none' });
      expect(decide(attachment(ZIP), SEARCH_ONLY)).toMatchObject({ reader: 'unavailable' });
      expect(decide(attachment(ZIP), NO_TOOLS)).toMatchObject({
        reader: 'unavailable',
        path: 'none',
        reason: 'no_file_tools',
        automatic: false,
      });
      expect(decide(attachment(PARQUET), CODE_ONLY)).toMatchObject({
        reader: 'code',
        reason: 'code_preferred',
      });
      expect(decide(attachment(PARQUET), SEARCH_ONLY)).toMatchObject({
        reader: 'unavailable',
        path: 'none',
      });
      expect(decide(attachment('application/x-parquet'), NO_TOOLS)).toMatchObject({
        reader: 'unavailable',
        path: 'none',
        reason: 'no_file_tools',
        automatic: false,
      });
    });
  });

  describe('evidence', () => {
    /* The walk runs only with a file tool loaded, so "no tool can take it" is a loaded File
     * Search that will not receive the file: the row is then walked to its end. */
    const unreachable = { search: 'unreachable' } as const;

    it.each<[string, string, ReadingEvidence]>([
      ['native capacity', 'openAI', { native: 'capacity' }],
      ['capacity discovered by encoding', 'anthropic', { native: 'fits', rejected: 'capacity' }],
    ])(
      'sends a document over %s to search, then code, then complete fitting text last',
      (_name, endpoint, evidence) => {
        const pdf = attachment(PDF, { llmDeliveryPath: 'provider', text: 'extracted' });
        const routing = automaticRouting(endpoint, {
          reading: withEvidence({ ...evidence, text: 'fits' }),
        });

        expect(decide(pdf, BOTH_TOOLS, routing)).toMatchObject({
          reader: 'search',
          reason: 'native_capacity',
        });
        expect(decide(pdf, CODE_ONLY, routing)).toMatchObject({
          reader: 'code',
          reason: 'native_capacity',
        });
        const unreached = automaticRouting(endpoint, {
          reading: withEvidence({ ...evidence, text: 'fits', ...unreachable }),
        });
        const text = decide(pdf, SEARCH_ONLY, unreached);
        expect(text).toMatchObject({
          reader: 'text',
          path: 'text',
          reason: 'native_capacity',
          needsText: false,
        });
        expect(skippedReaders(text)).toEqual(['provider', 'search', 'code']);

        const exceeding = automaticRouting(endpoint, {
          reading: withEvidence({ ...evidence, text: 'exceeds', ...unreachable }),
        });
        expect(decide(pdf, SEARCH_ONLY, exceeding)).toMatchObject({
          reader: 'unavailable',
          path: 'none',
          reason: 'native_capacity',
        });
      },
    );

    it('sends a spreadsheet over native capacity to File Search before its text', () => {
      const sheet = attachment(XLSX, { text: 'region,total' });
      const routing = automaticRouting('bedrock', {
        reading: withEvidence({ native: 'capacity', text: 'fits' }),
      });

      const searched = decide(sheet, SEARCH_ONLY, routing);
      expect(searched).toMatchObject({ reader: 'search', reason: 'native_capacity' });
      expect(skippedReaders(searched)).toEqual(['code', 'provider']);

      const unreached = automaticRouting('bedrock', {
        reading: withEvidence({ native: 'capacity', text: 'fits', ...unreachable }),
      });
      const text = decide(sheet, SEARCH_ONLY, unreached);
      expect(text).toMatchObject({ reader: 'text', path: 'text', reason: 'native_capacity' });
      expect(skippedReaders(text)).toEqual(['code', 'provider', 'search']);
      expect(decide(sheet, CODE_ONLY, routing)).toMatchObject({ reader: 'code', skipped: [] });
    });

    it('derives a capacity fallback while keeping integrity failures away from text', () => {
      const pdf = attachment(PDF, { llmDeliveryPath: 'provider' });
      const routing = automaticRouting('anthropic', {
        reading: withEvidence({ native: 'fits', rejected: 'capacity', ...unreachable }, true),
      });
      expect(decide(pdf, SEARCH_ONLY, routing)).toMatchObject({
        reader: 'text',
        reason: 'native_capacity',
        needsText: true,
      });

      const invalid = automaticRouting('anthropic', {
        reading: withEvidence({ native: 'fits', rejected: 'integrity', ...unreachable }, true),
      });
      expect(decide(pdf, SEARCH_ONLY, invalid)).toMatchObject({
        reader: 'unavailable',
        reason: 'native_rejected',
        needsText: false,
      });
    });

    it('preserves unsupported encoding as a capability failure with a fitting-text fallback', () => {
      const routing = automaticRouting('anthropic', {
        reading: withEvidence({ native: 'fits', rejected: 'unsupported', text: 'fits' }),
      });
      expect(decide(attachment(PDF, { text: 'extracted' }), BOTH_TOOLS, routing)).toMatchObject({
        reader: 'text',
        reason: 'native_unsupported',
      });
    });

    it('moves past a provider the encoder would skip', () => {
      const routing = automaticRouting('anthropic', {
        reading: withEvidence({ native: 'unsupported' }),
      });
      const reading = decide(attachment(PDF, { text: 'extracted' }), BOTH_TOOLS, routing);
      expect(reading).toMatchObject({ reader: 'text', reason: 'native_unsupported' });
    });

    it('never offers a direct reader after an encode-time rejection', () => {
      const routing = automaticRouting('bedrock', {
        reading: withEvidence({ rejected: 'integrity', text: 'fits' }),
      });
      const unreached = automaticRouting('bedrock', {
        reading: withEvidence({ rejected: 'integrity', text: 'fits', ...unreachable }),
      });
      const pdf = attachment(PDF, { text: 'extracted' });

      const unavailable = decide(pdf, SEARCH_ONLY, unreached);
      expect(unavailable).toMatchObject({ reader: 'unavailable', reason: 'native_rejected' });
      expect(skippedReaders(unavailable)).toEqual(['provider', 'search', 'code']);
      expect(decide(pdf, SEARCH_ONLY, routing)).toMatchObject({
        reader: 'search',
        reason: 'native_rejected',
      });

      const sheet = decide(attachment(XLSX, { text: 'region,total' }), SEARCH_ONLY, unreached);
      expect(sheet.reader).toBe('unavailable');
      expect(skippedReaders(sheet)).toEqual(['code', 'provider', 'search']);
    });

    it('sends text over the limit to search and code instead of truncating it', () => {
      const routing = automaticRouting('openAI', { reading: withEvidence({ text: 'exceeds' }) });
      const docx = attachment(DOCX, { text: 'long' });

      const coded = decide(docx, CODE_ONLY, routing);
      expect(coded).toMatchObject({ reader: 'code', reason: 'text_exceeds' });
      expect(coded.skipped).toContainEqual({ reader: 'text', reason: 'text_exceeds' });
      const unreached = automaticRouting('openAI', {
        reading: withEvidence({ text: 'exceeds', ...unreachable }),
      });
      expect(decide(docx, SEARCH_ONLY, unreached)).toMatchObject({
        reader: 'unavailable',
        path: 'none',
      });

      const csv = decide(attachment('text/csv', { text: 'long' }), SEARCH_ONLY, routing);
      expect(csv).toMatchObject({ reader: 'search' });
      expect(skippedReaders(csv)).toEqual(['code', 'provider', 'text']);
    });

    it('gives overflowed direct content to search and code only', () => {
      const routing = automaticRouting('openAI', {
        reading: withEvidence({ overflow: true, text: 'fits' }),
      });
      const unreached = automaticRouting('openAI', {
        reading: withEvidence({ overflow: true, text: 'fits', ...unreachable }),
      });
      const pdf = attachment(PDF, { llmDeliveryPath: 'provider', text: 'extracted' });

      const unavailable = decide(pdf, SEARCH_ONLY, unreached);
      expect(unavailable).toMatchObject({ reader: 'unavailable', path: 'none' });
      expect(unavailable.skipped[0]).toEqual({ reader: 'provider', reason: 'aggregate_overflow' });
      expect(skippedReaders(unavailable)).toEqual(['provider', 'search', 'code']);
      expect(decide(pdf, SEARCH_ONLY, routing)).toMatchObject({
        reader: 'search',
        reason: 'aggregate_overflow',
      });

      const docx = decide(attachment(DOCX, { text: 'parsed' }), CODE_ONLY, routing);
      expect(docx).toMatchObject({ reader: 'code' });
      expect(docx.skipped).toContainEqual({ reader: 'text', reason: 'aggregate_overflow' });
    });

    it('names the limit the file hit rather than a reader that was missing', () => {
      const exceeds = automaticRouting('openAI', { reading: withEvidence({ text: 'exceeds' }) });
      const unreached = automaticRouting('openAI', {
        reading: withEvidence({ text: 'exceeds', ...unreachable }),
      });

      const largeCsv = decide(attachment('text/csv', { text: 'long' }), SEARCH_ONLY, unreached);
      expect(largeCsv).toMatchObject({ reader: 'unavailable', reason: 'text_exceeds' });
      expect(skippedReaders(largeCsv)).toEqual(['code', 'provider', 'text', 'search']);

      const hugeLog = decide(attachment('text/plain', { text: 'long' }), SEARCH_ONLY, exceeds);
      expect(hugeLog).toMatchObject({ reader: 'search', reason: 'text_exceeds' });
      expect(hugeLog.skipped[0]).toEqual({ reader: 'provider', reason: 'native_unsupported' });
    });

    it('names the preferred reader that was missing when no limit was hit', () => {
      const unreached = automaticRouting('openAI', { reading: withEvidence(unreachable) });
      expect(decide(attachment(PARQUET), SEARCH_ONLY)).toMatchObject({
        reader: 'unavailable',
        reason: 'code_unavailable',
      });
      expect(decide(attachment(PPTX), SEARCH_ONLY, unreached)).toMatchObject({
        reader: 'unavailable',
        reason: 'text_unavailable',
      });
      expect(decide(attachment(DOCX, { text: 'parsed' }), BOTH_TOOLS)).toMatchObject({
        reader: 'text',
        reason: 'native_unsupported',
      });
    });

    it('continues the row when File Search will not receive the file', () => {
      const routing = automaticRouting('openAI', {
        reading: withEvidence({ search: 'unreachable' }),
      });
      const reading = decide(attachment(PPTX), BOTH_TOOLS, routing);
      expect(reading).toMatchObject({ reader: 'code', path: 'none' });
      expect(reading.skipped).toContainEqual({ reader: 'search', reason: 'search_unavailable' });
      expect(decide(attachment(XLSX), SEARCH_ONLY, routing)).toMatchObject({
        reader: 'unavailable',
      });
    });

    it('asks the turn for evidence once per decision', () => {
      const judge = jest.fn((): ReadingEvidence => ({ native: 'capacity' }));
      decide(
        attachment(PDF),
        BOTH_TOOLS,
        automaticRouting('openAI', { reading: { judge, canDerive: false } }),
      );
      expect(judge).toHaveBeenCalledTimes(1);
    });
  });

  describe('text derived from the original', () => {
    const deferred = attachment(XLSX, {
      metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
    });
    const deriving = (evidence: ReadingEvidence = {}) =>
      automaticRouting('openAI', { reading: withEvidence(evidence, true) });

    const unreachable = { search: 'unreachable' } as const;

    it('asks for text when a deriver is wired and code cannot read the file', () => {
      expect(decide(deferred, SEARCH_ONLY, deriving(unreachable))).toMatchObject({
        reader: 'text',
        path: 'text',
        needsText: true,
        automatic: true,
      });
      expect(decide(deferred, CODE_ONLY, deriving())).toMatchObject({
        reader: 'code',
        needsText: false,
      });
    });

    it('derives the text its classic route names when no file tool is loaded', () => {
      expect(decide(deferred, NO_TOOLS, deriving())).toMatchObject({
        reader: 'text',
        path: 'text',
        classicPath: 'text',
        needsText: true,
        automatic: false,
        reason: 'no_file_tools',
      });
      expect(decide(deferred, NO_TOOLS, automaticRouting('openAI'))).toMatchObject({
        path: 'none',
        classicPath: 'text',
        reader: 'unavailable',
        needsText: false,
        reason: 'no_file_tools',
      });
    });

    it('does not ask without a deriver, an original, an extractor, or after a failure', () => {
      const failed = {
        ...deferred,
        metadata: { destinationChosen: false, textDerivation: { outcome: 'failed' as const } },
      };
      const unreadable = [
        decide(
          deferred,
          SEARCH_ONLY,
          automaticRouting('openAI', { reading: withEvidence(unreachable) }),
        ),
        decide({ ...deferred, source: 'openai' }, SEARCH_ONLY, deriving(unreachable)),
        decide({ ...deferred, type: PPTX }, SEARCH_ONLY, deriving(unreachable)),
        decide(failed, SEARCH_ONLY, deriving(unreachable)),
        decide(deferred, SEARCH_ONLY, deriving({ textFailed: true, ...unreachable })),
      ];
      unreadable.forEach((reading) => {
        expect(reading).toMatchObject({ reader: 'unavailable', needsText: false });
        expect(reading.skipped).toContainEqual({ reader: 'text', reason: 'text_unavailable' });
      });

      /* With no reading inputs at all, File Search is reachable and takes the file; text is
       * still passed over rather than asked for. */
      const bare = decide(deferred, SEARCH_ONLY, automaticRouting('openAI'));
      expect(bare).toMatchObject({ reader: 'search', needsText: false });
      expect(bare.skipped).toContainEqual({ reader: 'text', reason: 'text_unavailable' });
      expect(decide(deferred, SEARCH_ONLY, deriving({ textFailed: true }))).toMatchObject({
        reader: 'search',
      });
    });

    it('uses stored text rather than deriving it again', () => {
      expect(decide({ ...deferred, text: 'region,total' }, SEARCH_ONLY, deriving())).toMatchObject({
        reader: 'text',
        needsText: false,
        automatic: true,
      });
      expect(decide({ ...deferred, text: 'region,total' }, NO_TOOLS, deriving())).toMatchObject({
        reader: 'text',
        needsText: false,
        automatic: false,
      });
    });
  });

  describe('marked records under classic routing', () => {
    const marked = attachment(XLSX, {
      metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
    });
    const classicRouting = (reading?: TurnReadingInputs) =>
      automaticRouting('openAI', { endpointConfig: {}, reading });

    it('derives the text a classic text route needs', () => {
      expect(decide(marked, NO_TOOLS, classicRouting(withEvidence({}, true)))).toMatchObject({
        path: 'text',
        classicPath: 'text',
        reader: 'text',
        needsText: true,
        automatic: false,
        reason: 'classic_policy',
      });
    });

    it('delivers nothing rather than empty text when it cannot', () => {
      const failed = {
        ...marked,
        metadata: { destinationChosen: false, textDerivation: { outcome: 'failed' as const } },
      };
      const readings = [
        decide(marked, NO_TOOLS, classicRouting()),
        decide(marked, NO_TOOLS, classicRouting(withEvidence({}, false))),
        decide(failed, NO_TOOLS, classicRouting(withEvidence({}, true))),
        decide(marked, NO_TOOLS, classicRouting(withEvidence({ textFailed: true }, true))),
        decide({ ...marked, source: 'openai' }, NO_TOOLS, classicRouting(withEvidence({}, true))),
      ];
      readings.forEach((reading) => {
        expect(reading).toMatchObject({ path: 'none', classicPath: 'text', needsText: false });
      });
      expect(decide(marked, CODE_ONLY, classicRouting()).reader).toBe('code');
    });

    it('leaves every record classic routing wrote as it was', () => {
      const unmarked = attachment(XLSX);
      expect(decide(unmarked, NO_TOOLS, classicRouting()).path).toBe('text');
      expect(decide({ ...marked, text: 'region,total' }, NO_TOOLS, classicRouting())).toMatchObject(
        {
          path: 'text',
          needsText: false,
        },
      );
      expect(decide({ ...marked, type: ZIP }, NO_TOOLS, classicRouting()).path).toBe('none');
    });
  });

  describe('automatic counterparts of classic pins', () => {
    it('reads a classic-era spreadsheet with Run Code when it runs, and as text when not', () => {
      const sheet = attachment(XLSX, { llmDeliveryPath: 'text', text: 'region,total' });
      expect(decide(sheet, CODE_ONLY)).toMatchObject({ path: 'none', classicPath: 'text' });
      expect(decide(sheet, SEARCH_ONLY)).toMatchObject({
        path: 'text',
        classicPath: 'text',
        automatic: true,
      });
      expect(decide(sheet, NO_TOOLS)).toMatchObject({
        path: 'text',
        classicPath: 'text',
        automatic: false,
        reason: 'no_file_tools',
      });
    });

    it('reads stored text as a primary reader without the fallback flag', () => {
      const slides = attachment(PPTX, { text: 'slide text' });
      expect(decide(slides, BOTH_TOOLS)).toMatchObject({ path: 'text', classicPath: 'none' });
      expect(decide(slides, NO_TOOLS)).toMatchObject({
        path: 'none',
        classicPath: 'none',
        reason: 'no_file_tools',
      });
    });

    it('keeps an explicit none override with the flag off', () => {
      const routing = automaticRouting('openAI', {
        endpointConfig: {
          ...automaticConfig,
          defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
        },
      });
      expect(decide(attachment('text/csv', { text: 'a,b' }), NO_TOOLS, routing)).toMatchObject({
        path: 'none',
        reason: 'configured_route',
      });
    });
  });
});

describe('isAutomaticReadingRecord', () => {
  const config = automaticRouting('openAI');
  const record = attachment(XLSX);

  it('accepts an inferred message attachment under the automatic policy', () => {
    expect(isAutomaticReadingRecord(config, record)).toBe(true);
    expect(isAutomaticReadingRecord(config, { ...record, source: undefined })).toBe(true);
    expect(isAutomaticReadingRecord(config, { ...record, source: 'openai' })).toBe(true);
    expect(isAutomaticReadingRecord(config, { ...record, llmDeliveryPath: 'text' })).toBe(true);
  });

  it.each<[string, Partial<TurnDeliveryRouting> | undefined, TurnDeliveryFile]>([
    ['no endpoint config', undefined, record],
    ['the classic policy', { endpointConfig: {} }, record],
    [
      'the legacy chooser',
      { endpointConfig: { ...automaticConfig, legacyFileUploadUX: true } },
      record,
    ],
    ['a record predating routing', config, { ...record, llmDeliveryPath: null }],
    ['an explicit destination', config, { ...record, metadata: { destinationChosen: true } }],
    ['a missing marker', config, { ...record, metadata: {} }],
    ['no metadata', config, { ...record, metadata: null }],
    ['an agent resource', config, { ...record, context: 'agents' }],
    ['a run artifact', config, { ...record, context: 'run_artifact' }],
    ['no context', config, { ...record, context: undefined }],
    ['a text-only record', config, { ...record, source: 'text' }],
    ['media', config, { ...record, type: 'image/png' }],
  ])('rejects %s', (_name, gateConfig, file) => {
    expect(isAutomaticReadingRecord(gateConfig, file)).toBe(false);
  });

  it('rejects a type a configured route names, which the decision keeps classic', () => {
    const pdf = attachment(PDF, { llmDeliveryPath: 'provider', bytes: 20 * 1024 * 1024 });
    const configured = automaticRouting('openAI', {
      endpointConfig: {
        ...automaticConfig,
        fileSizeLimit: 5 * 1024 * 1024,
        defaultLLMDeliveryPath: { overrides: { [PDF]: 'provider' } },
      },
    });
    const globallyConfigured = automaticRouting('openAI', {
      fileConfig: { endpoints: {}, defaultLLMDeliveryPath: { fallback: 'text' } },
    });

    expect(isAutomaticReadingRecord(configured, pdf)).toBe(false);
    expect(decide(pdf, BOTH_TOOLS, configured)).toMatchObject({
      automatic: false,
      reason: 'configured_route',
      path: 'provider',
    });
    expect(isAutomaticReadingRecord(globallyConfigured, pdf)).toBe(false);
    expect(isAutomaticReadingRecord(config, pdf)).toBe(true);
  });

  it('judges media by the type routing saw before conversion', () => {
    const converted = {
      ...record,
      type: 'image/png',
      metadata: { destinationChosen: false, routingMimeType: 'text/csv' },
    };
    const heic = {
      ...record,
      type: 'text/csv',
      metadata: { destinationChosen: false, routingMimeType: 'image/heic' },
    };
    expect(isAutomaticReadingRecord(config, converted)).toBe(true);
    expect(isAutomaticReadingRecord(config, heic)).toBe(false);
  });
});

describe('decideUploadReading', () => {
  const base: UploadReadingInput = {
    mimeType: XLSX,
    endpoint: 'openAI',
    endpointConfig: automaticConfig,
    sttConfigured: true,
    isMessageAttachment: true,
    extractionRequiredForInspection: false,
  };
  const classicFields = {
    codePreferred: false,
    needsCodeAvailability: false,
    keepOriginalOnExtractionFailure: false,
    deferredMarker: false,
  };

  it.each<[string, Partial<UploadReadingInput>, Partial<UploadReading>]>([
    [
      'a spreadsheet Run Code can read',
      { codePossible: true },
      {
        path: 'none',
        policy: 'automatic',
        category: 'tabular',
        reason: 'code_preferred',
        codePreferred: true,
        needsCodeAvailability: false,
        keepOriginalOnExtractionFailure: false,
        deferredMarker: true,
      },
    ],
    [
      'a spreadsheet before code availability is known',
      {},
      {
        path: 'text',
        reason: 'automatic_default',
        codePreferred: false,
        needsCodeAvailability: true,
        keepOriginalOnExtractionFailure: true,
      },
    ],
    [
      'a spreadsheet where Run Code is not possible',
      { codePossible: false },
      {
        path: 'text',
        reason: 'code_unavailable',
        codePreferred: false,
        keepOriginalOnExtractionFailure: true,
      },
    ],
    [
      'csv',
      { mimeType: 'text/csv', codePossible: true },
      { path: 'none', codePreferred: true, deferredMarker: true },
    ],
    [
      'tsv',
      { mimeType: TSV, codePossible: true },
      { path: 'none', codePreferred: true, deferredMarker: true },
    ],
    [
      'ods',
      { mimeType: ODS, codePossible: true },
      { path: 'none', codePreferred: true, deferredMarker: true },
    ],
    [
      'parquet, which no built-in extractor reads',
      { mimeType: PARQUET, codePossible: true },
      { path: 'none', codePreferred: true, deferredMarker: false },
    ],
    [
      'a spreadsheet an inspection policy must extract',
      { codePossible: true, extractionRequiredForInspection: true },
      { path: 'text', reason: 'inspection_requires_text', ...classicFields },
    ],
    [
      'a spreadsheet an inspection policy must extract, before code availability is known',
      { extractionRequiredForInspection: true },
      { path: 'text', reason: 'inspection_requires_text', ...classicFields },
    ],
    [
      'a PDF an inspection policy must extract',
      { mimeType: PDF, endpoint: 'azureOpenAI', extractionRequiredForInspection: true },
      { path: 'text', reason: 'automatic_default', ...classicFields },
    ],
    [
      'a natively sent PDF under an inspection policy',
      { mimeType: PDF, extractionRequiredForInspection: true },
      { path: 'provider', reason: 'automatic_default', ...classicFields },
    ],
    [
      'a Word document an inspection policy must extract',
      { mimeType: DOCX, extractionRequiredForInspection: true },
      { path: 'text', reason: 'automatic_default', ...classicFields },
    ],
    [
      'a PDF on a document-capable endpoint',
      { mimeType: PDF, codePossible: true },
      {
        path: 'provider',
        category: 'document',
        reason: 'automatic_default',
        keepOriginalOnExtractionFailure: true,
      },
    ],
    [
      'a PDF the endpoint cannot take natively',
      { mimeType: PDF, endpoint: 'azureOpenAI' },
      { path: 'text', reason: 'automatic_default', keepOriginalOnExtractionFailure: true },
    ],
    [
      'a Word document',
      { mimeType: DOCX },
      { path: 'text', reason: 'automatic_default', keepOriginalOnExtractionFailure: true },
    ],
    [
      'a Word document on Bedrock',
      { mimeType: DOCX, endpoint: 'bedrock' },
      { path: 'provider', reason: 'automatic_default', keepOriginalOnExtractionFailure: true },
    ],
    [
      'an archive',
      { mimeType: ZIP, codePossible: true },
      {
        path: 'none',
        reason: 'automatic_default',
        codePreferred: false,
        keepOriginalOnExtractionFailure: true,
        deferredMarker: false,
      },
    ],
    [
      'an image',
      { mimeType: 'image/png', codePossible: true },
      { path: 'provider', category: 'media', reason: 'automatic_default', ...classicFields },
    ],
    [
      'an explicit Run Code upload',
      { toolResource: 'execute_code', codePossible: true },
      { path: 'none', reason: 'explicit_destination', ...classicFields },
    ],
    [
      'an explicit context upload',
      { toolResource: 'context' },
      { path: 'text', reason: 'explicit_destination', ...classicFields },
    ],
    [
      'a permanent agent upload',
      { isMessageAttachment: false, codePossible: true },
      { path: 'text', reason: 'agent_resource', ...classicFields },
    ],
    [
      'an upload on a classic endpoint',
      { endpointConfig: {}, codePossible: true },
      { path: 'text', policy: 'classic', reason: 'classic_policy', ...classicFields },
    ],
    [
      'an upload through the legacy chooser',
      { endpointConfig: { ...automaticConfig, legacyFileUploadUX: true }, codePossible: true },
      { path: 'provider', policy: 'classic', reason: 'classic_policy', ...classicFields },
    ],
    [
      'a type an endpoint route names',
      {
        endpointConfig: {
          ...automaticConfig,
          defaultLLMDeliveryPath: { overrides: { [XLSX]: 'text' } },
        },
        codePossible: true,
      },
      { path: 'text', reason: 'configured_route', ...classicFields },
    ],
    [
      'a type a global route names',
      {
        fileConfig: { endpoints: {}, defaultLLMDeliveryPath: { fallback: 'provider' } },
        codePossible: true,
      },
      { path: 'provider', reason: 'configured_route', ...classicFields },
    ],
  ])('decides %s', (_name, overrides, expected) => {
    expect(decideUploadReading({ ...base, ...overrides })).toMatchObject(expected);
  });

  it('never changes an upload route under the classic policy', () => {
    const mimeTypes = [
      XLSX,
      ODS,
      'text/csv',
      TSV,
      PARQUET,
      PDF,
      DOCX,
      PPTX,
      ZIP,
      'image/png',
      'audio/mpeg',
    ];
    const configs: EndpointFileConfig[] = [
      {},
      { llmDeliveryPolicy: 'classic' },
      { ...automaticConfig, legacyFileUploadUX: true },
    ];
    const departures: string[] = [];
    mimeTypes.forEach((mimeType) =>
      ['openAI', 'bedrock', 'azureOpenAI', 'agents'].forEach((endpoint) =>
        configs.forEach((endpointConfig) =>
          [undefined, true, false].forEach((codePossible) =>
            [true, false].forEach((isMessageAttachment) =>
              [true, false].forEach((extractionRequiredForInspection) => {
                const input = {
                  ...base,
                  mimeType,
                  endpoint,
                  endpointConfig,
                  codePossible,
                  isMessageAttachment,
                  extractionRequiredForInspection,
                };
                const reading = decideUploadReading(input);
                const classicPath = resolveUploadLLMDeliveryPath(input);
                const unchanged =
                  reading.policy === 'classic' &&
                  reading.path === classicPath &&
                  !reading.codePreferred &&
                  !reading.needsCodeAvailability &&
                  !reading.keepOriginalOnExtractionFailure &&
                  !reading.deferredMarker;
                if (!unchanged) {
                  departures.push(`${mimeType} on ${endpoint}: ${reading.path} vs ${classicPath}`);
                }
              }),
            ),
          ),
        ),
      ),
    );
    expect(departures).toEqual([]);
  });
});

describe('selectBuiltInTextPlan', () => {
  it.each<[string, BuiltInTextPlan | null]>([
    [XLSX, 'document_parser'],
    ['application/vnd.ms-excel', 'document_parser'],
    ['application/x-dos_ms_excel', 'document_parser'],
    [ODS, 'document_parser'],
    [PDF, 'document_parser'],
    [DOCX, 'document_parser'],
    ['application/vnd.oasis.opendocument.text', 'document_parser'],
    ['text/csv', 'native_text'],
    [TSV, 'native_text'],
    ['application/csv', 'native_text'],
    ['application/json', 'native_text'],
    ['text/markdown', 'native_text'],
    [eml, 'native_text'],
    [PPTX, null],
    [MSWORD, null],
    [ZIP, null],
    [PARQUET, null],
    ['application/epub+zip', null],
    ['image/png', null],
    ['audio/mpeg', null],
  ])('plans %s as %s', (mimeType, plan) => {
    expect(selectBuiltInTextPlan(mimeType)).toBe(plan);
  });
});

describe('classic equivalence', () => {
  const mimeTypes = [
    ...excelFileTypes,
    ODS,
    'text/csv',
    'application/csv',
    TSV,
    'application/x-parquet',
    PARQUET,
    PDF,
    DOCX,
    PPTX,
    MSWORD,
    ZIP,
    'application/epub+zip',
    'application/json',
    'text/markdown',
    eml,
    'image/png',
    'audio/mpeg',
    'video/mp4',
  ];
  const endpoints = [
    'openAI',
    'anthropic',
    'bedrock',
    'google',
    'azureOpenAI',
    'agents',
    'MyGateway',
  ];
  const consumerSets: Array<TurnFileConsumers | undefined> = [
    undefined,
    NO_TOOLS,
    CODE_ONLY,
    SEARCH_ONLY,
    BOTH_TOOLS,
  ];
  const shapes: Array<Partial<TurnDeliveryFile>> = [
    { text: 'stored text' },
    { embedded: true },
    { llmDeliveryPath: 'text', text: 'stored text' },
    { llmDeliveryPath: 'provider' },
    { text: 'stored text', metadata: { destinationChosen: true } },
    { text: 'stored text', metadata: null },
    { llmDeliveryPath: undefined, text: 'stored text' },
  ];
  const overrides: EndpointFileConfig = {
    textFallbackWithoutTools: true,
    defaultLLMDeliveryPath: {
      overrides: { 'text/csv': 'none', 'application/pdf': 'text', 'image/*': 'none' },
    },
  };

  it.each<[string, EndpointFileConfig]>([
    ['unset', {}],
    ['classic', { llmDeliveryPolicy: 'classic' }],
  ])('keeps every turn route identical with the policy %s', (_name, policy) => {
    const mismatches: string[] = [];
    let combinations = 0;
    const configs: EndpointFileConfig[] = [{}, overrides];
    configs.forEach((config) =>
      endpoints.forEach((endpoint) => {
        const routing: Partial<TurnDeliveryRouting> = {
          endpoint,
          endpointConfig: { ...config, ...policy },
          fileConfig: mergeFileConfig(undefined),
          sttConfigured: true,
          reading: withEvidence({ native: 'capacity', text: 'exceeds', overflow: true }, true),
        };
        mimeTypes.forEach((mimeType) =>
          shapes.forEach((shape) => {
            const file = attachment(mimeType, shape);
            consumerSets.forEach((consumers) => {
              combinations += 1;
              const classicPath = resolveClassicTurnLLMDeliveryPath(routing, file, consumers);
              const reading = decideFileReading({ routing, file, consumers });
              const turnPath = resolveStoredTurnPath(routing, file, consumers);
              if (reading.path !== classicPath || turnPath !== classicPath || reading.automatic) {
                mismatches.push(
                  `${mimeType} on ${endpoint}: ${String(reading.path)} vs ${String(classicPath)}`,
                );
              }
            });
          }),
        );
      }),
    );

    expect(combinations).toBe(2 * endpoints.length * mimeTypes.length * shapes.length * 5);
    expect(mismatches).toEqual([]);
  });
});
