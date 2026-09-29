import { getClientBuildId } from './build';

describe('loaded client build identity', () => {
  afterEach(() =>
    document
      .querySelectorAll('[data-lc-client-entry], meta[name="lc-asset-build-id"]')
      .forEach((el) => el.remove()),
  );

  it('uses the loaded entry filename, without query parameters or deployment subpath', () => {
    const script = document.createElement('script');
    script.setAttribute('data-lc-client-entry', '');
    script.type = 'module';
    script.src = '/chat/assets/index-abc123.js?secret=hidden#fragment';
    document.head.append(script);
    expect(getClientBuildId()).toBe('index-abc123.js');
  });

  it('prefers the stamped asset identity over a pod or entry filename', () => {
    const meta = document.createElement('meta');
    meta.name = 'lc-asset-build-id';
    meta.content = `assets-${'a'.repeat(64)}`;
    document.head.append(meta);
    expect(getClientBuildId()).toBe(meta.content);
  });

  it('does not invent an identity when the entry is unavailable', () => {
    expect(getClientBuildId()).toBe('unknown');
  });
});
