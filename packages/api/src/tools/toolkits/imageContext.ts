/**
 * Builds tool context string for image generation tools based on available image files.
 * @param params - The parameters for building image context
 * @param params.imageFiles - Array of image file objects with file_id property
 * @param params.toolName - The name of the tool (e.g., 'gemini_image_gen', 'image_edit_oai')
 * @param params.contextDescription - Description of what the images are for (e.g., 'image context', 'image editing')
 * @param params.callInstruction - Instruction replacing the default closing line, for tools whose call shape differs (e.g., an action parameter instead of a dedicated edit tool)
 * @returns The tool context string or empty string if no images
 */
export function buildImageToolContext({
  imageFiles,
  toolName,
  contextDescription = 'image context',
  callInstruction,
}: {
  imageFiles: Array<{ file_id: string }>;
  toolName: string;
  contextDescription?: string;
  callInstruction?: string;
}): string {
  if (!imageFiles || imageFiles.length === 0) {
    return '';
  }

  const closingInstruction =
    callInstruction ??
    `Include any you need in the \`image_ids\` array when calling \`${toolName}\` to use them as visual context for generation. You may also include previously referenced or generated image IDs.`;

  let toolContext = '';
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    if (!file) {
      continue;
    }
    if (i === 0) {
      toolContext = `Image files provided in this request (their image IDs listed in order of appearance) available for ${contextDescription}:`;
    }
    toolContext += `\n\t- ${file.file_id}`;
    if (i === imageFiles.length - 1) {
      toolContext += `\n\n${closingInstruction}`;
    }
  }
  return toolContext;
}

/**
 * Builds the image-edit context for the Flux tool. The Foundry BFL provider
 * route takes references through the `image_edit` action of the single `flux`
 * tool rather than a dedicated edit tool, so the instruction names the action
 * explicitly. Returns an empty string unless the configured provider route
 * accepts reference images at all, so the caller never advertises editing
 * the tool cannot perform. Without attached images the context still names
 * the affordance — an edit request that carries no new attachment must
 * reach for a previous result's `generated_image_id` instead of dead-ending.
 * @param params - The parameters for building the Flux image context
 * @param params.imageFiles - Reference images attached to the current request
 * @param params.supportsEditing - Whether the configured provider serves the Foundry BFL edit route
 * @returns The tool context string or empty string
 */
export function buildFluxToolContext({
  imageFiles,
  supportsEditing,
}: {
  imageFiles: Array<{ file_id: string }>;
  supportsEditing: boolean;
}): string {
  if (!supportsEditing) {
    return '';
  }
  if (imageFiles.length === 0) {
    return (
      'No images are attached to this request. You can still edit or reference images from earlier in this conversation: ' +
      'call `flux` with action "image_edit" and pass the `generated_image_id` of a previous Flux result in the `image_ids` array. ' +
      'The IDs are listed in each result text as `generated_image_id`.'
    );
  }
  return buildImageToolContext({
    imageFiles,
    toolName: 'flux',
    contextDescription: 'image editing',
    callInstruction:
      'To edit or use them as visual context, call `flux` with action "image_edit" and include the needed IDs in the `image_ids` array. You may also include the `generated_image_id` of a previous Flux result.',
  });
}
