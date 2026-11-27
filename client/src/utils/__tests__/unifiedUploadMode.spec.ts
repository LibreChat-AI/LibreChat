import { isUnifiedUploadMode } from '../files';

describe('isUnifiedUploadMode', () => {
  it('withholds unified mode until the config actually resolves', () => {
    /* An unresolved config falls back to the built-in defaults, where the absent
     * legacyFileUploadUX reads as unified. Trusting it shows the unified uploader on a
     * legacy deployment, and an upload made in that window carries no tool resource
     * while the server still applies legacy rules. A failed or paused fetch is as
     * unresolved as an in-flight one, which is why the flag is "resolved" and not
     * "settled". */
    expect(isUnifiedUploadMode(undefined, false)).toBe(false);
    expect(isUnifiedUploadMode({}, false)).toBe(false);
    expect(isUnifiedUploadMode({ legacyFileUploadUX: false }, false)).toBe(false);
  });

  it('is unified once the config lands and does not opt out', () => {
    expect(isUnifiedUploadMode({}, true)).toBe(true);
    expect(isUnifiedUploadMode({ legacyFileUploadUX: false }, true)).toBe(true);
    expect(isUnifiedUploadMode(undefined, true)).toBe(true);
  });

  it('honors an explicit legacy opt-out', () => {
    expect(isUnifiedUploadMode({ legacyFileUploadUX: true }, true)).toBe(false);
  });
});
