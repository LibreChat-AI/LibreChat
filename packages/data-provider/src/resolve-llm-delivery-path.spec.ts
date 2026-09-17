import type {
  TurnFileConsumers,
  TurnDeliveryFile,
  TurnDeliveryRouting,
} from './resolve-llm-delivery-path';
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
} from './resolve-llm-delivery-path';
import { mergeFileConfig, supportedMimeTypes, getEndpointFileConfig } from './file-config';
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
      'application/vnd.apache.parquet',
      /* Drawings are absent from documentParserMimeTypes, so no built-in parser reads
       * one and without OCR it would reach the same raw-bytes fallback. */
      'application/vnd.oasis.opendocument.graphics',
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
      /* Every format the document parser reads routes to extraction, including the
       * presentation, legacy Word and EPUB containers it gained here: admitting a type
       * the server can extract and then storing it as raw bytes leaves the upload
       * unreadable to the model it was attached for. */
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
      'application/msword',
      'application/epub+zip',
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
