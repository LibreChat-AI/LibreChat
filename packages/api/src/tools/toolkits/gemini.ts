import type { ExtendedJsonSchema } from '../registry/schema';

/** Default description for Gemini image generation tool */
const DEFAULT_GEMINI_IMAGE_GEN_DESCRIPTION =
  `Generates high-quality, original images based on text prompts, with optional image context.

When to use \`gemini_image_gen\`:
- To create entirely new images from detailed text descriptions
- To generate images using existing images as context or inspiration
- When the user requests image generation, creation, or asks to "generate an image"
- When the user asks to "edit", "modify", "change", or "swap" elements in an image (generates new image with changes)

When NOT to use \`gemini_image_gen\`:
- For uploading or saving existing images without modification

Generated image IDs will be returned in the response, so you can refer to them in future requests.` as const;

const getGeminiImageGenDescription = () => {
  return process.env.GEMINI_IMAGE_GEN_DESCRIPTION || DEFAULT_GEMINI_IMAGE_GEN_DESCRIPTION;
};

/** Default prompt description for Gemini image generation */
const DEFAULT_GEMINI_IMAGE_GEN_PROMPT_DESCRIPTION =
  `A detailed text description of the desired image, up to 32000 characters. For "editing" requests, describe the changes you want to make to the referenced image. Be specific about composition, style, lighting, and subject matter.` as const;

const getGeminiImageGenPromptDescription = () => {
  return (
    process.env.GEMINI_IMAGE_GEN_PROMPT_DESCRIPTION || DEFAULT_GEMINI_IMAGE_GEN_PROMPT_DESCRIPTION
  );
};

/** Default image IDs description */
const DEFAULT_GEMINI_IMAGE_IDS_DESCRIPTION = `
Optional array of image IDs to use as visual context for generation.

Guidelines:
- For "editing" requests: ALWAYS include the image ID being "edited"
- For new generation with context: Include any relevant reference image IDs
- If the user's request references any prior images, include their image IDs in this array
- These images will be used as visual context/inspiration for the new generation
- Never invent or hallucinate IDs; only use IDs that are visible in the conversation
- If no images are relevant, omit this field entirely
`.trim();

const getGeminiImageIdsDescription = () => {
  return process.env.GEMINI_IMAGE_IDS_DESCRIPTION || DEFAULT_GEMINI_IMAGE_IDS_DESCRIPTION;
};

const geminiImageGenJsonSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 32000,
      description: getGeminiImageGenPromptDescription(),
    },
    image_ids: {
      type: 'array',
      items: { type: 'string' },
      description: getGeminiImageIdsDescription(),
    },
    aspectRatio: {
      type: 'string',
      enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
      description:
        'The aspect ratio of the generated image. Use 16:9 or 3:2 for landscape, 9:16 or 2:3 for portrait, 21:9 for ultra-wide/cinematic, 1:1 for square. Defaults to 1:1 if not specified.',
    },
    imageSize: {
      type: 'string',
      enum: ['1K', '2K', '4K'],
      description:
        'The resolution of the generated image. Use 1K for standard, 2K for high, 4K for maximum quality. Defaults to 1K if not specified.',
    },
  },
  required: ['prompt'],
};

export const geminiToolkit: {
  readonly gemini_image_gen: {
    readonly name: 'gemini_image_gen';
    readonly description: string;
    readonly description_for_model: 'Use this tool to generate images from text descriptions using Vertex AI Gemini.\n1. Prompts should be detailed and specific for best results.\n2. One image per function call. Create only 1 image per request.\n3. IMPORTANT: When user asks to "edit", "modify", "change", or "swap" elements in an existing image:\n   - ALWAYS include the original image ID in the image_ids array\n   - Describe the desired changes clearly in the prompt\n   - The tool will generate a new image based on the original image context + your prompt\n4. IMPORTANT: For editing requests, use DIRECT editing instructions:\n   - User says "remove the gun" → prompt should be "remove the gun from this image"\n   - User says "make it blue" → prompt should be "make this image blue"\n   - User says "add sunglasses" → prompt should be "add sunglasses to this image"\n   - DO NOT reconstruct or modify the original prompt - use the user\'s editing instruction directly\n   - ALWAYS include the image being edited in image_ids array\n5. OPTIONAL: Use image_ids to provide context images that will influence the generation:\n   - Include any relevant image IDs from the conversation in the image_ids array\n   - These images will be used as visual context/inspiration for the new generation\n   - For "editing" requests, always include the image being "edited"\n6. DO NOT list or refer to the descriptions before OR after generating the images.\n7. Always mention the image type (photo, oil painting, watercolor painting, illustration, cartoon, drawing, vector, render, etc.) at the beginning of the prompt.\n8. Use aspectRatio to control the shape of the image:\n   - 16:9 or 3:2 for landscape/wide images\n   - 9:16 or 2:3 for portrait/tall images\n   - 21:9 for ultra-wide/cinematic images\n   - 1:1 for square images (default)\n9. Use imageSize to control the resolution: 1K (standard), 2K (high), 4K (maximum quality).\n\nThe prompt should be a detailed paragraph describing every part of the image in concrete, objective detail.';
    readonly schema: ExtendedJsonSchema;
    readonly responseFormat: 'content_and_artifact';
  };
} = {
  gemini_image_gen: {
    name: 'gemini_image_gen' as const,
    description: getGeminiImageGenDescription(),
    description_for_model: `Use this tool to generate images from text descriptions using Vertex AI Gemini.
1. Prompts should be detailed and specific for best results.
2. One image per function call. Create only 1 image per request.
3. IMPORTANT: When user asks to "edit", "modify", "change", or "swap" elements in an existing image:
   - ALWAYS include the original image ID in the image_ids array
   - Describe the desired changes clearly in the prompt
   - The tool will generate a new image based on the original image context + your prompt
4. IMPORTANT: For editing requests, use DIRECT editing instructions:
   - User says "remove the gun" → prompt should be "remove the gun from this image"
   - User says "make it blue" → prompt should be "make this image blue"
   - User says "add sunglasses" → prompt should be "add sunglasses to this image"
   - DO NOT reconstruct or modify the original prompt - use the user's editing instruction directly
   - ALWAYS include the image being edited in image_ids array
5. OPTIONAL: Use image_ids to provide context images that will influence the generation:
   - Include any relevant image IDs from the conversation in the image_ids array
   - These images will be used as visual context/inspiration for the new generation
   - For "editing" requests, always include the image being "edited"
6. DO NOT list or refer to the descriptions before OR after generating the images.
7. Always mention the image type (photo, oil painting, watercolor painting, illustration, cartoon, drawing, vector, render, etc.) at the beginning of the prompt.
8. Use aspectRatio to control the shape of the image:
   - 16:9 or 3:2 for landscape/wide images
   - 9:16 or 2:3 for portrait/tall images
   - 21:9 for ultra-wide/cinematic images
   - 1:1 for square images (default)
9. Use imageSize to control the resolution: 1K (standard), 2K (high), 4K (maximum quality).

The prompt should be a detailed paragraph describing every part of the image in concrete, objective detail.`,
    schema: geminiImageGenJsonSchema,
    responseFormat: 'content_and_artifact' as const,
  },
} as const;

export type GeminiToolkit = typeof geminiToolkit;
