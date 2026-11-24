import { createHash, randomUUID } from 'node:crypto';
import type { Connection, Subscription } from 'librechat-data-provider';
import type { AgentTriggerEnqueueOptions } from '~/agents/triggers/delivery';
import type { AgentTriggerDeliveryReceipt } from '~/agents/triggers/service';
import type { AgentTriggerEnvelope } from '~/agents/triggers/envelope';
import type { Occurrence } from './catalog';
import type { AccessCheck } from './access';
import type { Verified } from './provider';
import { createAgentTriggerEnvelope } from '~/agents/triggers/envelope';
import { SUBSCRIPTION_SOURCE } from '~/agents/authority/context';
import { isId, itemKey } from './item';

/** A check suite reports on a commit, whoever pushed it, so no actor rule applies to one. */
const ACTORLESS = new Set<string>(['github.check_suite.completed']);

/**
 * Why one event did not start a run for one subscription:
 * - `off`, `event`: the subscription is turned off, or does not listen for the event.
 * - `connection`: it belongs to another connection or tenant than the delivery's.
 * - `target`: it targets something other than a new conversation, which nothing runs yet.
 * - `repository`, `branch`, `label`: a filter it sets does not hold. An event that does not
 *   name a branch or labels, such as a comment in a pull request's conversation for a branch
 *   filter, does not pass a filter on them.
 * - `bot`: the actor is a bot and the subscription does not let bots in.
 * - `linked`: it lets in only actors linked to a LibreChat account, which nothing records yet.
 * - `actor`: GitHub did not confirm the actor may push to the repository.
 * - `unknown`: GitHub could not be asked whether the actor may push, or there is no app to ask.
 * - `installation`: the event came through another installation than the connection's, or the
 *   connection's installation id does not read as one.
 */
export type Skip =
  | 'off'
  | 'event'
  | 'connection'
  | 'target'
  | 'repository'
  | 'branch'
  | 'label'
  | 'bot'
  | 'linked'
  | 'actor'
  | 'unknown'
  | 'installation';

/** One verified delivery, read into events, and the connection its installation is bound to. */
export interface Delivery {
  verified: Pick<Verified, 'digest'>;
  occurrences: readonly Occurrence[];
  connection: Pick<Connection, 'id' | 'tenantId' | 'installation'>;
}

export interface Routed {
  /** Runs newly queued. */
  enqueued: number;
  /** Runs this delivery had already queued: a redelivery, or the same body posted again. */
  duplicates: number;
  /** Event and subscription pairs that started nothing, by reason. */
  skipped: Partial<Record<Skip, number>>;
}

export interface RouteDeps {
  /** The enabled subscriptions on a connection that listen for an event type. */
  match: (
    connection: Pick<Connection, 'id' | 'tenantId'>,
    type: string,
  ) => Promise<readonly Subscription[]>;
  /** The trigger service's in-process enqueue. */
  enqueue: (
    envelope: AgentTriggerEnvelope,
    options: AgentTriggerEnqueueOptions,
  ) => Promise<AgentTriggerDeliveryReceipt>;
  /**
   * GitHub's answer on whether an actor may push, for subscriptions that ask for write access.
   * `null` when no GitHub App is configured; such a subscription then starts nothing.
   */
  access: AccessCheck | null;
  now?: () => number;
}

export type Route = (delivery: Delivery) => Promise<Routed>;

function hash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** True when a filter is absent, or one of its entries is the value; `same` compares them. */
function holds(
  entries: readonly string[] | undefined,
  values: readonly string[],
  same: (entry: string, value: string) => boolean,
): boolean {
  if (entries == null) return true;
  return entries.some((entry) => values.some((value) => same(entry, value)));
}

const exact = (entry: string, value: string) => entry === value;
const folded = (entry: string, value: string) => entry.toLowerCase() === value.toLowerCase();

/**
 * The rules a subscription holds an event to that need nothing but the two of them: that it is
 * on, listens for the event, targets a new conversation, and that each filter it sets holds.
 * `null` when the event passes; otherwise the first rule it fails.
 *
 * A repository filter entry is the repository's `owner/name`, compared without case as GitHub
 * compares it, or its numeric id. A branch is compared exactly, as Git does. A label is
 * compared without case, as GitHub keeps one label per name whatever its case.
 */
export function match(subscription: Subscription, occurrence: Occurrence): Skip | null {
  if (!subscription.enabled) return 'off';
  if (!subscription.events.includes(occurrence.type)) return 'event';
  if (subscription.target !== 'new') return 'target';
  const filters = subscription.filters;
  if (!holds(filters?.repositories, [occurrence.repo.name], folded)) {
    if (!holds(filters?.repositories, [String(occurrence.repo.id)], exact)) return 'repository';
  }
  if (!holds(filters?.branches, occurrence.branch == null ? [] : [occurrence.branch], exact)) {
    return 'branch';
  }
  if (!holds(filters?.labels, occurrence.labels ?? [], folded)) return 'label';
  return null;
}

/**
 * The event as the run receives it: what the turn shows about it and nothing else from the
 * delivery. Every field comes from the catalog, which copied each by name and bounded it.
 */
function payload(occurrence: Occurrence, key: string) {
  const { type, item, actor, repo, occurredAt, title, state, url, text, sha, branch, labels } =
    occurrence;
  return {
    provider: item.provider,
    type,
    item: { ...item, key },
    actor: { ...actor },
    repo: { ...repo },
    occurredAt,
    ...(title != null && { title }),
    ...(state != null && { state }),
    ...(url != null && { url }),
    ...(text != null && { text }),
    ...(sha != null && { sha }),
    ...(branch != null && { branch }),
    ...(labels != null && { labels: [...labels] }),
  };
}

/** True for an enqueue refused because the same delivery is already queued with other content. */
function conflicted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AgentTriggerDeliveryConflictError';
}

/**
 * Turns one verified delivery into runs: for each event in it, the subscriptions on its
 * connection that listen for it and whose rules it passes each get one trigger delivery, which
 * starts a new conversation with the subscription's agent, acting as the subscription's owner
 * in the subscription's tenant. Watches are not routed yet.
 *
 * A delivery's identity is the digest of its signed body, never the provider's unsigned
 * delivery id: GitHub's own redelivery, and the same body posted again under a new id, queue
 * nothing new. Each subscription and item gets its own delivery key, so one check suite that
 * reports on several pull requests starts one run for each, and one event several subscriptions
 * listen for starts one run for each of them.
 *
 * Nothing here caps how many runs a subscription starts. The per-subscription hourly cap is a
 * separate change, and ingress must not be turned on before it exists.
 *
 * An enqueue that fails for any reason but a duplicate is thrown once every other enqueue of
 * the delivery has settled, so the caller answers with an error and the provider delivers
 * again; what was queued already is then a duplicate.
 */
export function createRoute(deps: RouteDeps): Route {
  const now = deps.now ?? Date.now;

  /** Who may start a run, for a subscription whose static rules the event passed. */
  const admits = async (
    subscription: Subscription,
    occurrence: Occurrence,
    installation: number,
  ): Promise<Skip | null> => {
    if (ACTORLESS.has(occurrence.type)) return null;
    if (occurrence.actor.bot) return subscription.bots ? null : 'bot';
    if (subscription.actors === 'any') return null;
    if (subscription.actors === 'linked') return 'linked';
    if (deps.access == null) return 'unknown';
    const answer = await deps.access(installation, occurrence.repo.name, occurrence.actor.login);
    if (answer === 'write') return null;
    return answer === 'none' ? 'actor' : 'unknown';
  };

  const enqueue = async (
    subscription: Subscription,
    occurrence: Occurrence,
    digest: string,
  ): Promise<boolean> => {
    const key = itemKey(occurrence.item);
    const id = `github_${hash([digest, occurrence.type, key])}`;
    const envelope = createAgentTriggerEnvelope({
      mode: 'fire',
      requestId: randomUUID(),
      deliveryId: id,
      receivedAt: now(),
      principal: {
        id: subscription.user,
        ...(subscription.tenantId != null && { tenantId: subscription.tenantId }),
      },
      target: { agentId: subscription.agentId },
      event: {
        id,
        type: occurrence.type,
        occurredAt: occurrence.occurredAt,
        source: { type: SUBSCRIPTION_SOURCE, id: subscription.id },
        payload: payload(occurrence, key),
      },
      input: subscription.prompt,
      run: { metadata: { revision: subscription.revision } },
    });
    try {
      // One lane per subscription and item: runs about one pull request start in order.
      const receipt = await deps.enqueue(envelope, {
        orderingKey: `event_${hash([subscription.id, key])}`,
      });
      return !receipt.replayed;
    } catch (error) {
      // The same delivery key with other content: queued before the subscription was edited.
      if (conflicted(error)) return false;
      throw error;
    }
  };

  return async ({ verified, occurrences, connection }) => {
    const routed: Routed = { enqueued: 0, duplicates: 0, skipped: {} };
    const skip = (reason: Skip) => {
      routed.skipped[reason] = (routed.skipped[reason] ?? 0) + 1;
    };
    const installation = Number(connection.installation);
    const bound = isId(installation);
    const types = Array.from(new Set(occurrences.map((occurrence) => occurrence.type)));
    const listening = new Map(
      await Promise.all(
        types.map(async (type) => [type, await deps.match(connection, type)] as const),
      ),
    );

    /** The first enqueue that failed, held in a box so a rejection with no reason still counts. */
    let failure: { error: unknown } | undefined;
    const tasks: Promise<void>[] = [];
    for (const occurrence of occurrences) {
      const own =
        bound && (occurrence.installation == null || occurrence.installation === installation);
      for (const subscription of listening.get(occurrence.type) ?? []) {
        if (
          subscription.connection !== connection.id ||
          (subscription.tenantId ?? null) !== (connection.tenantId ?? null)
        ) {
          skip('connection');
          continue;
        }
        if (!own) {
          skip('installation');
          continue;
        }
        const missed = match(subscription, occurrence);
        if (missed != null) {
          skip(missed);
          continue;
        }
        // Each enqueue is settled where it starts: one that fails while another subscription is
        // still waiting on GitHub is recorded, never left as a rejection nothing handles yet.
        tasks.push(
          (async () => {
            const refused = await admits(subscription, occurrence, installation);
            if (refused != null) {
              skip(refused);
              return;
            }
            try {
              if (await enqueue(subscription, occurrence, verified.digest)) {
                routed.enqueued += 1;
              } else {
                routed.duplicates += 1;
              }
            } catch (error) {
              failure ??= { error };
            }
          })(),
        );
      }
    }
    // Every task is awaited, so none settles unobserved; an admission that throws is a defect.
    const settled = await Promise.allSettled(tasks);
    const defect = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (defect != null) throw defect.reason;
    if (failure != null) throw failure.error;
    return routed;
  };
}
