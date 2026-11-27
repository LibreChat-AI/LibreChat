import type { RequestHandler } from 'express';
import { selectLoginAuth } from './ldap';

const directory: RequestHandler = (_req, _res, next) => next();
const local: RequestHandler = (_req, _res, next) => next();

describe('selectLoginAuth', () => {
  it('uses the directory when LDAP is enabled', () => {
    expect(selectLoginAuth({ ldap: { enabled: true }, directory, local })).toBe(directory);
  });

  it.each([undefined, {}, { enabled: false }])(
    'uses local accounts when the LDAP config is %j',
    (ldap) => {
      expect(selectLoginAuth({ ldap, directory, local })).toBe(local);
    },
  );
});
