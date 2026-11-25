import { logger } from '@librechat/data-schemas';
import type { App } from './github/app';
import { GitHubError } from './github/app';

/**
 * What GitHub said about one account in one repository: it may push (`write`), it may not
 * (`none`), or nothing could be learned (`unknown`), such as when GitHub limited the app or was
 * down. Only `write` lets an event through a subscription that asks for write access.
 */
export type Answer = 'write' | 'none' | 'unknown';

export interface AccessOptions {
  /** How long a `write` or `none` that GitHub gave is reused; 0 asks for every event. */
  ttlMs: number;
  /** Most answers held at once; the oldest is dropped first. Default 10,000. */
  capacity?: number;
  now?: () => number;
}

/** Asks whether `login` may push to `repo` (`owner/name`) through the app's installation. */
export type AccessCheck = (installation: number, repo: string, login: string) => Promise<Answer>;

const CAPACITY = 10_000;

/**
 * GitHub's write-access answers for routing, reused for a short while. Only what GitHub said
 * about the account is reused: that it may push, or that it may not, which includes an account
 * GitHub does not know as a collaborator. Everything else is asked again on the next event: an
 * installation GitHub refused, a question the app may not ask, a limit and an outage. So a
 * passing outage cannot keep a collaborator out, and nothing learned during one is remembered.
 * Questions about the same account asked at once share one request.
 *
 * A `GitHubError` is caught here and answered `unknown`, which the router treats as a refusal
 * of that one event; it is logged by its code and status only. Any other error is a defect and
 * is thrown.
 */
export function createAccessCheck(app: Pick<App, 'access'>, options: AccessOptions): AccessCheck {
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? CAPACITY;
  const held = new Map<string, { answer: Answer; until: number }>();
  const asking = new Map<string, Promise<Answer>>();

  const keep = (key: string, answer: Answer): void => {
    if (options.ttlMs <= 0) return;
    held.delete(key);
    if (held.size >= capacity) {
      const oldest = held.keys().next();
      if (!oldest.done) held.delete(oldest.value);
    }
    held.set(key, { answer, until: now() + options.ttlMs });
  };

  const ask = async (key: string, installation: number, repo: string, login: string) => {
    try {
      const reply = await app.access(installation, repo, login);
      if (reply.ok) {
        const answer: Answer = reply.value.write ? 'write' : 'none';
        keep(key, answer);
        return answer;
      }
      return 'unknown';
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      logger.warn('[agents:events] GitHub write access could not be checked', {
        code: error.code,
        ...(error.status != null && { status: error.status }),
      });
      return 'unknown';
    }
  };

  return (installation, repo, login) => {
    // GitHub compares repository names and logins without case.
    const key = `${installation}\n${repo.toLowerCase()}\n${login.toLowerCase()}`;
    const hit = held.get(key);
    if (hit != null && hit.until > now()) return Promise.resolve(hit.answer);
    if (hit != null) held.delete(key);
    const pending = asking.get(key);
    if (pending != null) return pending;
    const question = ask(key, installation, repo, login).finally(() => asking.delete(key));
    asking.set(key, question);
    return question;
  };
}
