/** Track in-flight acquisition as well as acquired resources before shutdown can exit. */
export function createLifecycle() {
  const pending = [];
  const releases = [];
  let closing = false;
  let stopped;
  return {
    acquire(create, release) {
      if (closing) return Promise.reject(new Error('Acceptance shutdown has begun.'));
      const acquisition = Promise.resolve()
        .then(create)
        .then((resource) => {
          releases.push(() => release(resource));
          return resource;
        });
      pending.push(acquisition);
      return acquisition;
    },
    stop() {
      if (stopped) return stopped;
      closing = true;
      stopped = (async () => {
        await Promise.allSettled(pending);
        const errors = [];
        for (const release of releases.reverse()) {
          try {
            await release();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Acceptance cleanup failed.');
      })();
      return stopped;
    },
  };
}
