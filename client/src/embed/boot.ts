import { request, dataService } from 'librechat-data-provider';
import { EmbedMessage, postToHost, requestHostToken } from './bridge';
import { getEmbedState } from './state';

/**
 * Switches this page load into embed mode before the app renders: every session refresh asks the
 * host page for a signed token and exchanges it at `/api/embed/session`, in place of the refresh
 * cookie a framed page cannot rely on.
 */
const state = getEmbedState();

if (state) {
  document.documentElement.dataset.embed = 'true';
  request.setRefreshTokenHandler(async () => {
    try {
      const token = await requestHostToken(state);
      const session = await dataService.createEmbedSession({
        app: state.app,
        token,
        origin: state.origin,
      });
      return { token: session.token, user: session.user };
    } catch (error) {
      postToHost(state, { type: EmbedMessage.authFailed });
      throw error;
    }
  });
  postToHost(state, { type: EmbedMessage.ready });
}
