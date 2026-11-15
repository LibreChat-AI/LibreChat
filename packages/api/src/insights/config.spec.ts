import type { TInsightsConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { createInsightsConfigResolver } from './config';

const request = (insights?: TInsightsConfig): Pick<ServerRequest, 'config'> =>
  ({ config: { interfaceConfig: { insights } } }) as Pick<ServerRequest, 'config'>;

describe('Insights request configuration', () => {
  it('uses the scoped policy to disable the admin all-agents view', () => {
    expect(
      createInsightsConfigResolver(() => false)(
        request({ enabled: true, adminAllowAllAgents: false }),
      ).adminAllowAllAgents,
    ).toBe(false);
  });
  it('uses YAML to enable aggregate-only Insights without the environment switch', () => {
    expect(
      createInsightsConfigResolver(() => false)(request({ enabled: true, showDetails: false })),
    ).toEqual({ enabled: true, showDetails: false, adminAllowAllAgents: true });
  });

  it('honours explicit YAML disable even when the environment switch is enabled', () => {
    expect(
      createInsightsConfigResolver(() => true)(request({ enabled: false, showDetails: true })),
    ).toEqual({ enabled: false, showDetails: true, adminAllowAllAgents: true });
  });

  it('keeps environment-only enablement aggregate-only by default', () => {
    expect(createInsightsConfigResolver(() => true)(request())).toEqual({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: true,
    });
    expect(createInsightsConfigResolver(() => false)(request()).enabled).toBe(false);
  });

  it('requires explicit detail opt-in', () => {
    const resolve = createInsightsConfigResolver(() => false);
    expect(resolve(request({ enabled: true }))).toEqual({
      enabled: true,
      showDetails: false,
      adminAllowAllAgents: true,
    });
    expect(resolve(request({ enabled: true, showDetails: true }))).toEqual({
      enabled: true,
      showDetails: true,
      adminAllowAllAgents: true,
    });
  });

  it('resolves scoped configuration per request rather than reusing another viewer’s policy', () => {
    const resolve = createInsightsConfigResolver(() => true);
    expect(resolve(request({ enabled: true, showDetails: true })).showDetails).toBe(true);
    expect(resolve(request({ enabled: true, showDetails: false })).showDetails).toBe(false);
    expect(resolve(request({ enabled: false })).enabled).toBe(false);
  });
});
