import { z } from 'zod';
import type { MediaCapability, MediaConfig } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter } from '../provider';
import { dataURI, imageBytes, nativeDownload, nativeRequest, providerOptions } from './native';
import { MediaProviderError } from '../errors';

const models = new Map(
  [
    ['recraft-v4-styles-pro', 'recraftv4_styles_pro'],
    ['recraft-v4-styles-vector', 'recraftv4_styles_vector'],
    ['recraft-v4-styles-pro-vector', 'recraftv4_styles_pro_vector'],
    ['recraft-v4-styles', 'recraftv4_styles'],
    ['recraft-v4.1-pro-vector', 'recraftv4_1_pro_vector'],
    ['recraft-v4.1-vector', 'recraftv4_1_vector'],
    ['recraft-v4.1-utility-pro', 'recraftv4_1_utility_pro'],
    ['recraft-v4.1-utility', 'recraftv4_1_utility'],
    ['recraft-v4.1-pro', 'recraftv4_1_pro'],
    ['recraft-v4.1', 'recraftv4_1'],
    ['recraft-v4-pro-vector', 'recraftv4_pro_vector'],
    ['recraft-v4-vector', 'recraftv4_vector'],
    ['recraft-v4-pro', 'recraftv4_pro'],
    ['recraft-v4', 'recraftv4'],
    ['recraft-v3', 'recraftv3'],
  ].map(([id, native]) => [`recraft/${id}`, native]),
);
const options = ['style', 'style_id', 'style_match', 'controls', 'text_layout'];
const ratios = [
  '1:1',
  '2:1',
  '1:2',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '5:4',
  '4:5',
  '6:10',
  '14:10',
  '10:14',
  '16:9',
  '9:16',
];

function catalog(config: MediaConfig): MediaModelProfile[] {
  return [...models].map(([modelId, native]) => {
    const styles = native.includes('_styles');
    const vector = native.endsWith('_vector');
    const capabilities: MediaCapability[] = (
      styles ? (['image.generate'] as const) : (['image.generate', 'image.edit'] as const)
    ).map((operation) => ({
      operation,
      constraints:
        operation === 'image.generate'
          ? [
              {
                when: [{ kind: 'input', role: 'reference', present: true }],
                anyOf: [
                  {
                    kind: 'parameter',
                    name: 'providerOptions',
                    option: 'style_id',
                    present: false,
                  },
                ],
              },
            ]
          : undefined,
      inputs: {
        roles: ['reference'],
        min: styles || operation === 'image.edit' ? 1 : 0,
        max: Math.min(operation === 'image.edit' ? 1 : 10, config.limits.maxInputs),
      },
      execution: { kind: 'direct', previews: false },
      controls: {
        count: { min: 1, max: Math.min(6, config.limits.maxOutputs) },
        ...(operation === 'image.generate'
          ? { aspectRatio: { values: ratios } }
          : { strength: { min: 0, max: 1, default: 0.2 } }),
        format: { values: vector ? ['svg'] : ['png', 'webp'] },
        seed: { min: 0, max: 4_294_967_295 },
        negativePrompt: true,
        providerOptions: options,
      },
    }));
    return {
      modelId,
      modelName: `Recraft ${modelId.slice('recraft/recraft-'.length).replaceAll('-', ' ')}`,
      capabilities,
    };
  });
}

export function createRecraftMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'recraft.images',
      configuration: { baseURL: 'https://external.api.recraft.ai/v1' },
      operations: ['image.generate', 'image.edit'],
      catalog,
      download: nativeDownload,
      async submit(request, inputs, context) {
        const model = models.get(request.selection.modelId);
        if (
          request.operation === 'video.generate' ||
          !model ||
          request.parameters.count > 6 ||
          inputs.some(
            (input) =>
              input.role !== 'reference' || !/^image\/(png|jpeg|webp|svg\+xml)$/.test(input.type),
          )
        )
          throw new MediaProviderError('rejected');
        const editing = request.operation === 'image.edit';
        const styles = model.includes('_styles');
        const vector = model.endsWith('_vector');
        const extra = providerOptions(request, options);
        if (
          (editing && (styles || inputs.length !== 1)) ||
          (styles && !inputs.length) ||
          (!editing && (inputs.length > 10 || (inputs.length && extra.style_id !== undefined)))
        )
          throw new MediaProviderError('rejected');
        const parameters = request.parameters;
        const response = await context.transport.json(
          nativeRequest(
            context,
            editing ? 'images/imageToImage' : 'images/generations',
            JSON.stringify({
              ...extra,
              model,
              prompt: request.prompt,
              n: parameters.count,
              size: editing ? undefined : (parameters.size ?? parameters.aspectRatio),
              image_format: vector ? undefined : parameters.format,
              response_format: 'b64_json',
              random_seed: parameters.seed,
              negative_prompt: parameters.negativePrompt,
              image_url: editing ? dataURI(inputs[0]) : undefined,
              strength: editing ? (parameters.strength ?? 0.2) : undefined,
              style_reference_urls: !editing && inputs.length ? inputs.map(dataURI) : undefined,
            }),
          ),
          z.object({
            data: z
              .array(
                z.object({ b64_json: z.string().optional(), url: z.string().url().optional() }),
              )
              .min(1)
              .max(Math.min(6, context.config.limits.maxOutputs)),
          }),
        );
        return {
          status: 'completed',
          parts: response.data.map((item, ordinal) => {
            if (!item.b64_json && !item.url) throw new MediaProviderError('uncertain');
            return {
              kind: 'image',
              ordinal,
              type: vector ? 'image/svg+xml' : `image/${parameters.format ?? 'png'}`,
              data: item.b64_json ? imageBytes(item.b64_json, context) : undefined,
              url: item.url,
            };
          }),
        };
      },
    },
  ];
}
