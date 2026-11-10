import { buildFluxToolContext, buildImageToolContext } from './imageContext';

describe('buildImageToolContext', () => {
  const imageFiles = [{ file_id: 'file-1' }, { file_id: 'file-2' }];

  it('returns an empty string without image files', () => {
    expect(buildImageToolContext({ imageFiles: [], toolName: 'image_edit_oai' })).toBe('');
  });

  it('lists the image IDs with the default call instruction', () => {
    const context = buildImageToolContext({
      imageFiles,
      toolName: 'image_edit_oai',
      contextDescription: 'image editing',
    });
    expect(context).toContain('available for image editing');
    expect(context).toContain('- file-1');
    expect(context).toContain('- file-2');
    expect(context).toContain('`image_ids` array when calling `image_edit_oai`');
  });

  it('replaces the default closing line with a provided call instruction', () => {
    const context = buildImageToolContext({
      imageFiles,
      toolName: 'flux',
      callInstruction: 'Call `flux` with action "image_edit".',
    });
    expect(context).toContain('- file-1');
    expect(context).toContain('Call `flux` with action "image_edit".');
    expect(context).not.toContain('when calling `flux`');
  });
});

describe('buildFluxToolContext', () => {
  const imageFiles = [{ file_id: 'file-1' }];

  it('returns an empty string when the provider route cannot edit images', () => {
    expect(buildFluxToolContext({ imageFiles, supportsEditing: false })).toBe('');
  });

  it('names the previous-result affordance without attached images', () => {
    const context = buildFluxToolContext({ imageFiles: [], supportsEditing: true });
    expect(context).toContain('No images are attached to this request');
    expect(context).toContain('action "image_edit"');
    expect(context).toContain('`generated_image_id`');
    expect(context).not.toContain('- file-1');
  });

  it('names the image_edit action and the available IDs', () => {
    const context = buildFluxToolContext({ imageFiles, supportsEditing: true });
    expect(context).toContain('available for image editing');
    expect(context).toContain('- file-1');
    expect(context).toContain('action "image_edit"');
    expect(context).toContain('`image_ids` array');
    expect(context).toContain('generated_image_id');
  });
});
