import { ScreenshotProvider, useScreenshot } from '~/hooks/ScreenshotContext';
import useExportConversation from '../useExportConversation';

/**
 * The export and screenshot libraries load when a user exports, not with the entry page. These
 * factories run only when something requires the package, so a static import in either hook
 * (or anything it imports) makes this suite fail.
 */
const mockEvaluated = jest.fn();
jest.mock('downloadjs', () => {
  mockEvaluated('downloadjs');
  return jest.fn();
});
jest.mock('export-from-json', () => {
  mockEvaluated('export-from-json');
  return Object.assign(jest.fn(), { types: {} });
});
jest.mock('html-to-image', () => {
  mockEvaluated('html-to-image');
  return { toCanvas: jest.fn() };
});

it('loads no export library when the export and screenshot hooks are imported', () => {
  expect(useExportConversation).toBeInstanceOf(Function);
  expect(useScreenshot).toBeInstanceOf(Function);
  expect(ScreenshotProvider).toBeInstanceOf(Function);
  expect(mockEvaluated).not.toHaveBeenCalled();
});
