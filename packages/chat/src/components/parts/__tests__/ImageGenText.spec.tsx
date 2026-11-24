/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import ImageGenText from '../ImageGenText';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

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
    ['image_gen_oai', 0.1, 'com_ui_getting_started'],
    ['image_gen_oai', 0.3, 'com_ui_creating_image'],
    ['image_gen_oai', 0.5, 'com_ui_adding_details'],
    ['image_gen_oai', 0.7, 'com_ui_final_touch'],
    ['image_gen_oai', 0.99, 'com_ui_final_touch'],
    ['image_gen_oai', 1, 'com_ui_image_created'],
    ['gemini_image_gen', 0.29, 'com_ui_getting_started'],
    ['gemini_image_gen', 0.3, 'com_ui_creating_image'],
    ['gemini_image_gen', 1, 'com_ui_image_created'],
    ['image_edit_oai', 0.1, 'com_ui_getting_started'],
    ['image_edit_oai', 0.3, 'com_ui_edit_editing_image'],
    ['image_edit_oai', 0.5, 'com_ui_adding_details'],
    ['image_edit_oai', 0.7, 'com_ui_final_touch'],
    ['image_edit_oai', 1, 'com_ui_image_edited'],
  ])('walks %s through its stages: at %s it says %s', (toolName, progress, key) => {
    expect(text({ toolName, progress })).toBe(key);
  });

  it.each([
    ['dalle', 0.1, 'com_ui_generating_image'],
    ['dalle', 0.9, 'com_ui_generating_image'],
    ['dalle', 1, 'com_ui_image_created'],
    [undefined, 0.5, 'com_ui_generating_image'],
  ])('says only generating or created for %s at %s', (toolName, progress, key) => {
    expect(text({ toolName, progress })).toBe(key);
  });

  it('says it failed whatever else is true, a cancellation included', () => {
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, error: true, cancelled: true })).toBe(
      'com_ui_image_gen_failed',
    );
    expect(text({ toolName: 'dalle', progress: 1, error: true, intent: 'Drawing a cat' })).toBe(
      'com_ui_image_gen_failed',
    );
  });

  it('says it was cancelled over any stage or label', () => {
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, cancelled: true })).toBe(
      'com_ui_cancelled',
    );
    expect(text({ toolName: 'dalle', progress: 0.5, cancelled: true, intent: 'Drawing' })).toBe(
      'com_ui_cancelled',
    );
  });

  it('shows what the tool is preparing while it runs, and not once it is done', () => {
    mockPreparation = 'Preparing the canvas';
    expect(text({ toolName: 'image_gen_oai', progress: 0.5 })).toBe('Preparing the canvas');
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, intent: 'Drawing a cat' })).toBe(
      'Preparing the canvas',
    );
    expect(text({ toolName: 'image_gen_oai', progress: 1 })).toBe('com_ui_image_created');
  });

  it('prefers the model’s own label to a stage', () => {
    expect(text({ toolName: 'image_gen_oai', progress: 0.5, intent: 'Drawing a cat' })).toBe(
      'Drawing a cat',
    );
    expect(text({ toolName: 'dalle', progress: 1, intent: 'Drew a cat' })).toBe('Drew a cat');
  });
});
