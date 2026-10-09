import { installRumBootstrap } from './bootstrap';

try {
  installRumBootstrap(window);
} catch {
  /* Diagnostics should never affect application startup. */
}
