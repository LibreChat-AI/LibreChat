import { resolveSamlSubject, TRANSIENT_SAML_NAME_ID_FORMAT, type SamlSubjectProfile } from './saml';

describe('resolveSamlSubject', () => {
  test.each<SamlSubjectProfile | null | undefined>([
    undefined,
    null,
    {},
    { nameID: '' },
    { nameID: '   ' },
  ])('rejects a missing or blank NameID: %p', (profile) => {
    expect(resolveSamlSubject(profile)).toEqual({ error: 'missing_name_id' });
  });

  test('rejects a transient NameID', () => {
    expect(
      resolveSamlSubject({ nameID: 'temporary-id', nameIDFormat: TRANSIENT_SAML_NAME_ID_FORMAT }),
    ).toEqual({ error: 'transient_name_id' });
  });

  test('preserves an opaque NameID exactly', () => {
    expect(resolveSamlSubject({ nameID: ' opaque-id ' })).toEqual({ nameID: ' opaque-id ' });
  });

  test('accepts the configured IdP issuer', () => {
    expect(
      resolveSamlSubject(
        { nameID: 'persistent-id', issuer: 'https://idp.example.com' },
        'https://idp.example.com',
      ),
    ).toEqual({ nameID: 'persistent-id' });
  });

  test.each([undefined, '', 'https://other-idp.example.com'])(
    'rejects a missing or different IdP issuer: %p',
    (issuer) => {
      expect(
        resolveSamlSubject({ nameID: 'persistent-id', issuer }, 'https://idp.example.com'),
      ).toEqual({ error: 'issuer_mismatch' });
    },
  );
});
