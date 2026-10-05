import { z } from 'zod';
import { MediaServiceError } from './errors';

export interface MediaRoutingPolicy {
  only?: string[];
  ignore?: string[];
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
  sort?: 'price' | 'throughput' | 'latency';
}

/** Only validated routing policy may cross the media provider boundary. */
export const mediaRoutingPolicySchema: z.ZodType<MediaRoutingPolicy> = z
  .object({
    only: z.array(z.string().min(1)).optional(),
    ignore: z.array(z.string().min(1)).optional(),
    order: z.array(z.string().min(1)).optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(['allow', 'deny']).optional(),
    zdr: z.boolean().optional(),
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
  })
  .strict();

function matches(tag: string, selector: string): boolean {
  return tag === selector || tag.startsWith(`${selector}/`);
}

export function mediaRouteAllowed(tag: string | undefined, policy?: MediaRoutingPolicy): boolean {
  if (!policy) {
    return true;
  }
  if (!tag) {
    return policy.only === undefined && !policy.ignore?.length && !policy.order?.length;
  }
  if (policy.only && !policy.only.some((selector) => matches(tag, selector))) {
    return false;
  }
  if (policy.ignore?.some((selector) => matches(tag, selector))) {
    return false;
  }
  return (
    policy.allow_fallbacks !== false ||
    !policy.order?.length ||
    policy.order.some((selector) => matches(tag, selector))
  );
}

export function mediaRoutePriority(tag: string | undefined, policy?: MediaRoutingPolicy): number {
  const index = tag ? policy?.order?.findIndex((selector) => matches(tag, selector)) : undefined;
  return index !== undefined && index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function mediaImageRouting(
  policy?: MediaRoutingPolicy,
  tag?: string,
): MediaRoutingPolicy | undefined {
  if (!mediaRouteAllowed(tag, policy)) {
    throw new MediaServiceError(
      'unsupported',
      422,
      'The media route conflicts with provider policy.',
    );
  }
  return tag ? { ...policy, only: [tag], allow_fallbacks: false } : policy;
}

/** The Video API currently documents provider options, not request routing policy. */
export function mediaVideoPolicySupported(policy?: MediaRoutingPolicy): boolean {
  return (
    !policy ||
    (!policy.zdr &&
      policy.data_collection !== 'deny' &&
      policy.only === undefined &&
      !policy.ignore?.length &&
      !policy.order?.length &&
      policy.allow_fallbacks !== false &&
      !policy.require_parameters &&
      !policy.sort)
  );
}
