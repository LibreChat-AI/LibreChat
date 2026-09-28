import { hasConfiguredFooter } from './footer';

describe('hasConfiguredFooter', () => {
  it('is true for any content the deployment configured itself', () => {
    expect(hasConfiguredFooter({ customFooter: 'Operator policy' })).toBe(true);
    /** An operator who set the footer to nothing still set it. */
    expect(hasConfiguredFooter({ customFooter: '' })).toBe(true);
    expect(
      hasConfiguredFooter({ interface: { privacyPolicy: { externalUrl: 'https://x/privacy' } } }),
    ).toBe(true);
    expect(
      hasConfiguredFooter({ interface: { termsOfService: { externalUrl: 'https://x/terms' } } }),
    ).toBe(true);
  });

  it('is false for a deployment that configured none of it', () => {
    expect(hasConfiguredFooter()).toBe(false);
    expect(hasConfiguredFooter(null)).toBe(false);
    expect(hasConfiguredFooter({})).toBe(false);
    /** The links carry the policy sections, so a section without one is not a
     *  footer: this is what the bar renders from. */
    expect(hasConfiguredFooter({ interface: { privacyPolicy: {}, termsOfService: {} } })).toBe(
      false,
    );
  });
});
