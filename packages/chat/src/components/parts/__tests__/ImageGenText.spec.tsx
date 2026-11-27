/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import { initEnglish } from '../../../__fixtures__/i18n';
import ImageGenText from '../ImageGenText';

beforeAll(initEnglish);

let mockPreparation: string | null = null;
jest.mock('../preparation', () => ({
  ...jest.requireActual('../preparation'),
  useToolPreparation: () => mockPreparation,
}));

const text = (props: React.ComponentProps<typeof ImageGenText>) =>
  render(<ImageGenText {...props} />).container.textContent;

beforeEach(() => {
  mockPreparation = null;
});

describe('ImageGenText', () => {
  it.each([
    ['image_gen_oai', 0.1, 'Getting Started'],
    ['image_gen_oai', 0.3, 'Creating image. May take a moment'],
    ['image_gen_oai', 0.5, 'Adding details'],
    ['image_gen_oai', 0.7, 'Final touch'],
    ['image_gen_oai', 0.99, 'Final touch'],
    ['image_gen_oai', 1, 'Image created'],
    ['gemini_image_gen', 0.29, 'Getting Started'],
    ['gemini_image_gen', 0.3, 'Creating image. May take a moment'],
    ['gemini_image_gen', 1, 'Image created'],
    ['image_edit_oai', 0.1, 'Getting Started'],
    ['image_edit_oai', 0.3, 'Editing image'],
    ['image_edit_oai', 0.5, 'Adding details'],
    ['image_edit_oai', 0.7, 'Final touch'],
    ['image_edit_oai', 1, 'Image edited'],
  ])('walks %s through its stages: at %s it says %s', (toolName, progress, label) => {
    expect(text({ toolName, progress })).toBe(label);
  });

  it.each([
    ['dalle', 0.1, 'Generating image...'],
    ['dalle', 0.9, 'Generating image...'],
    ['dalle', 1, 'Image created'],
    [undefined, 0.5, 'Generating image...'],
  ])('says only generating or created for %s at %s', (toolName, progress, label) => {
    expect(text({ toolName, progress })).toBe(label);
  });

  it('says it failed whatever else is true, a cancellation included', () => {
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, error: true, cancelled: true })).toBe(
      'Image generation failed',
    );
    expect(text({ toolName: 'dalle', progress: 1, error: true, intent: 'Drawing a cat' })).toBe(
      'Image generation failed',
    );
  });

  it('says it was cancelled over any stage or label', () => {
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, cancelled: true })).toBe('Cancelled');
    expect(text({ toolName: 'dalle', progress: 0.5, cancelled: true, intent: 'Drawing' })).toBe(
      'Cancelled',
    );
  });

  it('shows what the tool is preparing while it runs, and not once it is done', () => {
    mockPreparation = 'Preparing the canvas';
    expect(text({ toolName: 'image_gen_oai', progress: 0.5 })).toBe('Preparing the canvas');
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, intent: 'Drawing a cat' })).toBe(
      'Preparing the canvas',
    );
    expect(text({ toolName: 'image_gen_oai', progress: 1 })).toBe('Image created');
  });

  it('prefers the model’s own label to a stage', () => {
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, intent: 'Drawing a cat' })).toBe(
      'Drawing a cat',
    );
    expect(text({ toolName: 'dalle', progress: 1, intent: 'Drew a cat' })).toBe('Drew a cat');
  });
});
