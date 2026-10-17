import { loadEndpoints } from './endpoints';

describe('loadEndpoints', () => {
  it('preserves deployment-owned user endpoint access rules', () => {
    const userAccess = [{ username: 'restricted-user', allowedEndpoints: ['Allowed Provider'] }];

    expect(loadEndpoints({ endpoints: { userAccess } }).userAccess).toEqual(userAccess);
  });

  it('leaves user endpoint access undefined when it is not configured', () => {
    expect(loadEndpoints({}).userAccess).toBeUndefined();
  });
});
