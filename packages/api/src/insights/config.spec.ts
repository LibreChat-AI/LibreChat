import type { ServerRequest } from '~/types';
import { createInsightsConfigResolver } from './config';

const request = (insights?: unknown): Pick<ServerRequest, 'config'> =>
  ({ config: { interfaceConfig: { insights } } }) as Pick<ServerRequest, 'config'>;

describe('Insights request configuration', () => {
  it('uses YAML to enable aggregate-only Insights without the environment switch', () => {
    expect(
      createInsightsConfigResolver(() => false)(request({ enabled: true, showDetails: false })),
    ).toEqual({ enabled: true, showDetails: false });
  });

  it('honours explicit YAML disable even when the environment switch is enabled', () => {
    expect(
      createInsightsConfigResolver(() => true)(request({ enabled: false, showDetails: true })),
    ).toEqual({ enabled: false, showDetails: true });
  });

  it('keeps environment-only enablement aggregate-only by default', () => {
    expect(createInsightsConfigResolver(() => true)(request())).toEqual({
      enabled: true,
      showDetails: false,
    });
    expect(createInsightsConfigResolver(() => false)(request()).enabled).toBe(false);
  });

  it('requires explicit detail opt-in', () => {
    const resolve = createInsightsConfigResolver(() => false);
    expect(resolve(request({ enabled: true }))).toEqual({ enabled: true, showDetails: false });
    expect(resolve(request({ enabled: true, showDetails: true }))).toEqual({
      enabled: true,
      showDetails: true,
    });
  });

  it('resolves scoped configuration per request rather than reusing another viewer’s policy', () => {
    const resolve = createInsightsConfigResolver(() => true);
    expect(resolve(request({ enabled: true, showDetails: true })).showDetails).toBe(true);
    expect(resolve(request({ enabled: true, showDetails: false })).showDetails).toBe(false);
    expect(resolve(request({ enabled: false })).enabled).toBe(false);
  });

  it('does not coerce unvalidated strings into enablement or detailed access', () => {
    expect(
      createInsightsConfigResolver(() => true)(request({ enabled: 'true', showDetails: 'true' })),
    ).toEqual({ enabled: false, showDetails: false });
  });
});
