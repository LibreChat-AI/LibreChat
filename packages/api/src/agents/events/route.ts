import { Constants } from 'librechat-data-provider';
import { createHash, randomUUID } from 'node:crypto';
import type { Connection, Subscription, Watch } from 'librechat-data-provider';
import type { AgentTriggerEnqueueOptions } from '~/agents/triggers/delivery';
import type { AgentTriggerDeliveryReceipt } from '~/agents/triggers/service';
import type { AgentTriggerEnvelope } from '~/agents/triggers/envelope';
import type { Occurrence } from './catalog';
import type { AccessCheck } from './access';
import type { Verified } from './provider';
import { createAgentTriggerEnvelope } from '~/agents/triggers/envelope';
import { SUBSCRIPTION_SOURCE } from '~/agents/authority/context';
import { isId, itemKey } from './item';
import { governs } from './controls';

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
 * - `watch`: a watch on the item is no longer allowed: its subscription is gone, off, no longer
 *   allows watching, or belongs to another owner, agent or connection than the watch.
 * - `watched`: the subscription's own new conversation was not started, because a conversation
 *   watching the item under that subscription continues instead.
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
  | 'installation'
  | 'watch'
  | 'watched';

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
  /**
   * Conversations following the items an event is about. Absent, every event goes to
   * subscriptions alone.
   */
  watches?: {
    /** The watches on a connection that follow any of the items and have not ended. */
    following: (
      connection: Pick<Connection, 'id' | 'tenantId'>,
      items: readonly string[],
    ) => Promise<readonly Watch[]>;
    /** A subscription by id in any tenant, or `null`: the router checks whose it is. */
    subscription: (id: string) => Promise<Subscription | null>;
  };
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
 * in the subscription's tenant.
 *
 * A conversation watching the item an event is about wins over its subscription: the event
 * continues that conversation under the watch's subscription, held to that subscription's
 * actor and bot rules, and the same subscription starts no new conversation for it. Its event
 * types and filters are not applied to a watch: the agent asked to follow the item, so every
 * catalog event about it arrives. Other subscriptions still start their own runs.
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

  /**
   * Continues a watching conversation with one event, under the watch's subscription. The turn
   * is appended below the conversation's latest reply when it runs, so the parent here is only
   * a placeholder the continuation resolver replaces. One lane per conversation keeps its
   * turns in order however many items it follows.
   */
  const continueWatch = async (
    watch: Watch,
    subscription: Subscription,
    occurrence: Occurrence,
    digest: string,
  ): Promise<boolean> => {
    const key = itemKey(occurrence.item);
    const id = `github_${hash([digest, occurrence.type, key, watch.id])}`;
    const envelope = createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: randomUUID(),
      deliveryId: id,
      receivedAt: now(),
      principal: {
        id: subscription.user,
        ...(subscription.tenantId != null && { tenantId: subscription.tenantId }),
      },
      target: {
        agentId: watch.agentId,
        conversationId: watch.conversationId,
        parentMessageId: Constants.NO_PARENT as string,
      },
      event: {
        id,
        type: occurrence.type,
        occurredAt: occurrence.occurredAt,
        source: { type: SUBSCRIPTION_SOURCE, id: subscription.id },
        payload: { ...payload(occurrence, key), watch: watch.id },
      },
      input: subscription.prompt,
    });
    try {
      const receipt = await deps.enqueue(envelope, {
        orderingKey: `watch_${hash([watch.user, watch.conversationId])}`,
      });
      return !receipt.replayed;
    } catch (error) {
      if (conflicted(error)) return false;
      throw error;
    }
  };

  /** True when a watch may still continue its conversation under this subscription here. */
  const binds = (
    watch: Watch,
    subscription: Subscription | null,
    connection: Pick<Connection, 'id' | 'tenantId'>,
  ): subscription is Subscription =>
    governs(watch, subscription) &&
    watch.connection === connection.id &&
    (watch.tenantId ?? null) === (connection.tenantId ?? null);

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

    const keys = Array.from(new Set(occurrences.map((occurrence) => itemKey(occurrence.item))));
    const watching = deps.watches == null ? [] : await deps.watches.following(connection, keys);
    /**
     * Each watch's subscription, read once per delivery however many events name its item, and
     * the watches it still lets continue. Only those win over their subscription's own run: a
     * watch its subscription no longer allows must not silence that subscription too.
     */
    const governing = new Map(
      await Promise.all(
        Array.from(new Set(watching.map((watch) => watch.subscription))).map(
          async (id) => [id, (await deps.watches?.subscription(id)) ?? null] as const,
        ),
      ),
    );
    const eligible = new Map<Watch, Subscription>();
    for (const watch of watching) {
      const subscription = governing.get(watch.subscription) ?? null;
      if (binds(watch, subscription, connection)) eligible.set(watch, subscription);
    }

    /** The first enqueue that failed, held in a box so a rejection with no reason still counts. */
    let failure: { error: unknown } | undefined;
    const tasks: Promise<void>[] = [];
    /** Settles one enqueue where it starts, so none is left as a rejection nothing handles. */
    const settle = (run: () => Promise<boolean>) =>
      run().then(
        (fresh) => {
          if (fresh) routed.enqueued += 1;
          else routed.duplicates += 1;
        },
        (error: unknown) => {
          failure ??= { error };
        },
      );
    for (const occurrence of occurrences) {
      const own =
        bound && (occurrence.installation == null || occurrence.installation === installation);
      const key = itemKey(occurrence.item);
      /** The subscriptions whose watches on this item continue a conversation instead. */
      const watched = new Set<string>();
      for (const watch of watching) {
        if (watch.item !== key) continue;
        if (!own) {
          skip('installation');
          continue;
        }
        const subscription = eligible.get(watch);
        if (subscription == null) {
          skip('watch');
          continue;
        }
        watched.add(subscription.id);
        tasks.push(
          (async () => {
            const refused = await admits(subscription, occurrence, installation);
            if (refused != null) {
              skip(refused);
              return;
            }
            await settle(() => continueWatch(watch, subscription, occurrence, verified.digest));
          })(),
        );
      }
      for (const subscription of listening.get(occurrence.type) ?? []) {
        if (watched.has(subscription.id)) {
          skip('watched');
          continue;
        }
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
            await settle(() => enqueue(subscription, occurrence, verified.digest));
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
