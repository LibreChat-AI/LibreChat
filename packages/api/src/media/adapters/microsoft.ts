import { z } from 'zod';
import sharp from 'sharp';
import type { MediaConfig } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter } from '../provider';
import { imageBytes, nativeDownload, nativeRequest, providerOptions } from './native';
import { MediaProviderError } from '../errors';

const models = new Map([
  ['microsoft/mai-image-2.6', 'MAI-Image-2.6'],
  ['microsoft/mai-image-2.6-flash', 'MAI-Image-2.6-Flash'],
  ['microsoft/mai-image-2.5-pro', 'MAI-Image-2.5-Pro'],
  ['microsoft/mai-image-2.5', 'MAI-Image-2.5'],
]);
const dimensions = new Map([
  ['1:1', [1024, 1024]],
  ['4:3', [1152, 864]],
  ['3:4', [864, 1152]],
  ['3:2', [1248, 832]],
  ['2:3', [832, 1248]],
  ['16:9', [1365, 768]],
  ['9:16', [768, 1365]],
]);

function catalog(config: MediaConfig): MediaModelProfile[] {
  return [...models].map(([modelId, modelName]) => ({
    modelId,
    modelName,
    capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
      operation,
      inputs: {
        roles: ['reference'],
        min: operation === 'image.edit' ? 1 : 0,
        max: operation === 'image.edit' ? Math.min(1, config.limits.maxInputs) : 0,
      },
      execution: { kind: 'direct', previews: false },
      controls: {
        count: { min: 1, max: 1 },
        format: { values: ['png'] },
        ...(operation === 'image.generate'
          ? {
              aspectRatio: {
                values: [...dimensions.keys(), ...(modelId.includes('2.6') ? ['auto'] : [])],
              },
            }
          : {}),
        ...(modelId.includes('2.6')
          ? { providerOptions: ['auto_aspect_ratio', 'web_grounding'] }
          : {}),
      },
    })),
  }));
}

export function createMicrosoftImageAdapter(): MediaProviderAdapter {
  return {
    api: 'microsoft.images',
    configuration: { baseURL: '', keyHeader: 'api-key', keyPrefix: '' },
    operations: ['image.generate', 'image.edit'],
    catalog,
    download: nativeDownload,
    async submit(request, inputs, context) {
      const model = models.get(request.selection.modelId);
      const modern = model?.startsWith('MAI-Image-2.6');
      if (
        !model ||
        request.operation === 'video.generate' ||
        request.parameters.count !== 1 ||
        inputs.length > 1 ||
        inputs.some(
          (input) =>
            input.role !== 'reference' ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(input.type),
        ) ||
        (request.operation === 'image.edit' && !inputs.length) ||
        (request.operation === 'image.generate' && inputs.length)
      )
        throw new MediaProviderError('rejected');
      const extra = z
        .object({
          auto_aspect_ratio: z.boolean().optional(),
          web_grounding: z.boolean().optional(),
        })
        .strict()
        .safeParse(providerOptions(request, modern ? ['auto_aspect_ratio', 'web_grounding'] : []));
      if (!extra.success) throw new MediaProviderError('rejected');
      const ratio = request.parameters.aspectRatio;
      if (ratio && !dimensions.has(ratio) && !(modern && ratio === 'auto'))
        throw new MediaProviderError('rejected');
      const [width, height] = dimensions.get(ratio ?? '1:1') ?? [1024, 1024];
      const fields = {
        model: context.connection.options?.deployments?.[model] ?? model,
        prompt: request.prompt,
        ...(request.operation === 'image.generate' ? { width, height } : {}),
        ...extra.data,
        ...(ratio === 'auto' ? { auto_aspect_ratio: true } : {}),
      };
      let body: FormData | string;
      if (request.operation === 'image.edit') {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields))
          if (value !== undefined) form.set(key, String(value));
        const input = inputs[0];
        const convert = input.type !== 'image/png' && input.type !== 'image/jpeg';
        const data = convert ? await sharp(input.data).png().toBuffer() : input.data;
        if (data.length > context.config.transfers.maxImageBytes)
          throw new MediaProviderError('rejected');
        form.set(
          'image',
          new Blob([new Uint8Array(data)], { type: convert ? 'image/png' : input.type }),
          convert ? 'reference.png' : `reference.${input.type.split('/')[1]}`,
        );
        body = form;
      } else body = JSON.stringify(fields);
      const result = await context.transport.json(
        nativeRequest(
          context,
          request.operation === 'image.edit' ? 'images/edits' : 'images/generations',
          body,
        ),
        z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).length(1) }),
      );
      return {
        status: 'completed',
        parts: result.data.map((image, ordinal) => ({
          kind: 'image',
          ordinal,
          type: 'image/png',
          data: imageBytes(image.b64_json, context),
        })),
      };
    },
  };
}
