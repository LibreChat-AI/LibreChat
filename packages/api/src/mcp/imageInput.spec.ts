import type { ServerRequest } from '~/types';
import { resolveMCPImageInputMimeTypes } from './imageInput';

const reqWith = (fileConfig: unknown): ServerRequest =>
  ({ config: fileConfig === undefined ? undefined : { fileConfig } }) as unknown as ServerRequest;

describe('resolveMCPImageInputMimeTypes', () => {
  it('returns the image types an endpoint explicitly lists', () => {
    const req = reqWith({
      endpoints: {
        'My Gateway': { supportedMimeTypes: ['^image\\/(jpeg|png|webp)$', '^application\\/pdf$'] },
      },
    });
    expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
  });

  it('returns nothing when the endpoint only inherits the default list', () => {
    const req = reqWith({ endpoints: { Other: { supportedMimeTypes: ['^image\\/.*$'] } } });
    expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual([]);
  });

  describe('requires a declaration on the named endpoint itself', () => {
    const imageList = ['^image\\/.*$'];

    it('ignores an admin-configured default list', () => {
      const req = reqWith({ endpoints: { default: { supportedMimeTypes: imageList } } });
      expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual([]);
    });

    it('ignores the default list when the endpoint entry sets other options only', () => {
      const req = reqWith({
        endpoints: {
          default: { supportedMimeTypes: imageList },
          'My Gateway': { fileLimit: 1 },
        },
      });
      expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual([]);
    });

    it.each(['custom', 'agents'])('ignores the generic %s fallback list', (fallback) => {
      const req = reqWith({ endpoints: { [fallback]: { supportedMimeTypes: imageList } } });
      expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual([]);
    });

    it('uses only the endpoint list when a broader default list exists', () => {
      const req = reqWith({
        endpoints: {
          default: { supportedMimeTypes: imageList },
          'My Gateway': { supportedMimeTypes: ['^image\\/png$'] },
        },
      });
      expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual(['image/png']);
    });
  });

  it('returns nothing for an explicit list without image types (a text-only model)', () => {
    const req = reqWith({
      endpoints: {
        'My Gateway': { supportedMimeTypes: ['^application\\/pdf$', '^text\\/plain$'] },
      },
    });
    expect(resolveMCPImageInputMimeTypes(req, 'My Gateway')).toEqual([]);
  });

  it('returns nothing without a request, a fileConfig or an endpoint', () => {
    expect(resolveMCPImageInputMimeTypes(undefined, 'My Gateway')).toEqual([]);
    expect(resolveMCPImageInputMimeTypes(reqWith(undefined), 'My Gateway')).toEqual([]);
    expect(resolveMCPImageInputMimeTypes(reqWith({ endpoints: {} }), undefined)).toEqual([]);
  });
});
