const { mediaToolReceiptSchema } = require('librechat-data-provider');

function mediaImageResponses({
  text,
  toolNames,
  getMarkerValue,
  findLastToolMessage,
  getContentText,
}) {
  const video = !!getMarkerValue(text, 'E2E_MEDIA_VIDEO:');
  const kind = video ? 'video' : 'image';
  const label = getMarkerValue(text, video ? 'E2E_MEDIA_VIDEO:' : 'E2E_MEDIA_IMAGE:');
  if (!label) return null;
  if (!toolNames.has('media_generate')) {
    return { responses: [`E2E media ${kind} failed: media_generate was not advertised`] };
  }
  const toolCallId = `call_e2e_media_${kind}_${label}`;
  return {
    responses: ['', ''],
    toolCalls: [
      {
        id: toolCallId,
        name: 'media_generate',
        args: {
          operation: video ? 'video.generate' : 'image.generate',
          prompt: label,
          connectionId: video ? 'fixture-videos' : 'fixture-images',
          modelId: video ? 'sora-2' : 'gpt-image-1',
          inputs: [],
          parameters: { count: 1 },
        },
        type: 'tool_call',
      },
    ],
    resolveOnStream: (messages) => {
      const result = findLastToolMessage(messages, toolCallId);
      if (!result) return null;
      let output;
      try {
        output = JSON.parse(getContentText(result.content));
      } catch {
        return { responses: [`E2E media ${kind} failed: invalid tool response`] };
      }
      const receipt = mediaToolReceiptSchema.safeParse(output?.media);
      if (
        !receipt.success ||
        receipt.data.operation !== (video ? 'video.generate' : 'image.generate') ||
        (!video && receipt.data.phase !== 'succeeded') ||
        ['failed', 'cancelled', 'expired'].includes(receipt.data.phase)
      ) {
        return { responses: [`E2E media ${kind} failed: no valid durable receipt`] };
      }
      if (
        !video &&
        (!Array.isArray(output.files) ||
          output.files.length !== 1 ||
          output.files.some(
            (file) =>
              typeof file.file_id !== 'string' ||
              !file.file_id ||
              typeof file.type !== 'string' ||
              !file.type.startsWith('image/'),
          ))
      ) {
        return { responses: ['E2E media image failed: no persisted image File'] };
      }
      return { responses: [video ? 'E2E media video queued' : 'E2E media image ready'] };
    },
  };
}

module.exports = { mediaImageResponses };
