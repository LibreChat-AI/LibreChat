import type { TInsightsConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { createInsightsConfigResolver } from './config';

const request = (insights?: TInsightsConfig): Pick<ServerRequest, 'config'> =>
  ({ config: { interfaceConfig: { insights } } }) as Pick<ServerRequest, 'config'>;

describe('Insights request configuration', () => {
  it('uses the scoped policy to load all agents automatically for admins', () => {
    expect(
      createInsightsConfigResolver(() => false)(
        request({ enabled: true, adminAutoSelectAllAgents: true }),
      ).adminAutoSelectAllAgents,
    ).toBe(true);
  });
  it('uses YAML to enable aggregate-only Insights without the environment switch', () => {
    expect(
      createInsightsConfigResolver(() => false)(request({ enabled: true, showDetails: false })),
    ).toEqual({ enabled: true, showDetails: false, adminAutoSelectAllAgents: false });
  });

  it('honours explicit YAML disable even when the environment switch is enabled', () => {
    expect(
      createInsightsConfigResolver(() => true)(request({ enabled: false, showDetails: true })),
    ).toEqual({ enabled: false, showDetails: true, adminAutoSelectAllAgents: false });
  });

  it('keeps environment-only enablement aggregate-only by default', () => {
    expect(createInsightsConfigResolver(() => true)(request())).toEqual({
      enabled: true,
      showDetails: false,
      adminAutoSelectAllAgents: false,
    });
    expect(createInsightsConfigResolver(() => false)(request()).enabled).toBe(false);
  });

  it('requires explicit detail opt-in', () => {
    const resolve = createInsightsConfigResolver(() => false);
    expect(resolve(request({ enabled: true }))).toEqual({
      enabled: true,
      showDetails: false,
      adminAutoSelectAllAgents: false,
    });
    expect(resolve(request({ enabled: true, showDetails: true }))).toEqual({
      enabled: true,
      showDetails: true,
      adminAutoSelectAllAgents: false,
    });
  });

  it('resolves scoped configuration per request rather than reusing another viewer’s policy', () => {
    const resolve = createInsightsConfigResolver(() => true);
    expect(resolve(request({ enabled: true, showDetails: true })).showDetails).toBe(true);
    expect(resolve(request({ enabled: true, showDetails: false })).showDetails).toBe(false);
    expect(resolve(request({ enabled: false })).enabled).toBe(false);
  });
});
