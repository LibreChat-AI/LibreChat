/** Only accepts process groups created by this harness with detached: true. */
export async function stopGroup(child, graceMs = 5000) {
  if (!child.pid) return;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      // An existence probe can observe an inaccessible group during teardown.
      // Keep polling; never suppress permission failures for actual signals.
      if (name === 0 && error.code === 'EPERM') return true;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const deadline = Date.now() + graceMs;
  while (signal(0)) {
    if (Date.now() >= deadline) {
      signal('SIGKILL');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
