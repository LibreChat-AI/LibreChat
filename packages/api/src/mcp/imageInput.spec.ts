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
