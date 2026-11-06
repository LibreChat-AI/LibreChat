import { isLdapAuthEnabled } from './ldap';

describe('isLdapAuthEnabled', () => {
  const originalUrl = process.env.LDAP_URL;
  const originalSearchBase = process.env.LDAP_USER_SEARCH_BASE;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.LDAP_URL;
    } else {
      process.env.LDAP_URL = originalUrl;
    }
    if (originalSearchBase === undefined) {
      delete process.env.LDAP_USER_SEARCH_BASE;
    } else {
      process.env.LDAP_USER_SEARCH_BASE = originalSearchBase;
    }
  });

  it('is false when neither LDAP_URL nor LDAP_USER_SEARCH_BASE is set', () => {
    delete process.env.LDAP_URL;
    delete process.env.LDAP_USER_SEARCH_BASE;
    expect(isLdapAuthEnabled()).toBe(false);
  });

  it('is false when only LDAP_URL is set', () => {
    process.env.LDAP_URL = 'ldap://directory.example.com';
    delete process.env.LDAP_USER_SEARCH_BASE;
    expect(isLdapAuthEnabled()).toBe(false);
  });

  it('is false when only LDAP_USER_SEARCH_BASE is set', () => {
    delete process.env.LDAP_URL;
    process.env.LDAP_USER_SEARCH_BASE = 'ou=users,dc=example,dc=com';
    expect(isLdapAuthEnabled()).toBe(false);
  });

  it('is true when both LDAP_URL and LDAP_USER_SEARCH_BASE are set', () => {
    process.env.LDAP_URL = 'ldap://directory.example.com';
    process.env.LDAP_USER_SEARCH_BASE = 'ou=users,dc=example,dc=com';
    expect(isLdapAuthEnabled()).toBe(true);
  });
});
