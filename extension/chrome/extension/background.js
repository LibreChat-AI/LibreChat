const LIBRECHAT_URL = 'https://REPLACE_ME.com';
const TOKEN_STORAGE_KEY = 'librechat.accessToken';
const TOKEN_DEFAULT_TTL = 55 * 1000;

function safeSendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch (error) {
    if (error?.message?.includes('Extension context invalidated')) {
      console.debug('Skipping runtime message, context invalidated');
    } else {
      console.warn('Failed to send runtime message', error);
    }
  }
}

async function getAccessToken() {
  const cached = await loadCachedToken();
  if (cached) {
    return cached;
  }
  return requestAccessTokenFromPage();
}

async function loadCachedToken() {
  const stored = await chrome.storage.session.get(TOKEN_STORAGE_KEY);
  const entry = stored[TOKEN_STORAGE_KEY];
  if (!entry || !entry.token) {
    return null;
  }
  if (entry.expiresAt && Date.now() >= entry.expiresAt) {
    await chrome.storage.session.remove(TOKEN_STORAGE_KEY);
    return null;
  }
  return entry.token;
}

async function cacheToken(token, metadata = {}) {
  const expiresAt = deriveExpiry(metadata);
  await chrome.storage.session.set({
    [TOKEN_STORAGE_KEY]: {
      token,
      expiresAt
    }
  });
}

function deriveExpiry({ expires, expiresIn }) {
  if (expires) {
    const ts = Date.parse(expires);
    if (!Number.isNaN(ts)) {
      return ts;
    }
  }
  if (expiresIn && Number.isFinite(expiresIn)) {
    return Date.now() + expiresIn * 1000;
  }
  return Date.now() + TOKEN_DEFAULT_TTL;
}

async function clearCachedToken() {
  await chrome.storage.session.remove(TOKEN_STORAGE_KEY);
}

async function ensureLibreChatTab() {
  const tabs = await chrome.tabs.query({ url: `${LIBRECHAT_URL}/*` });
  if (!tabs || tabs.length === 0) {
    const error = new Error('Open your librechat site in a new tab to refresh your session.');
    error.requiresAuth = true;
    throw error;
  }
  return tabs[0];
}

async function requestAccessTokenFromPage() {
  const tab = await ensureLibreChatTab();
  let response;
  try {
    response = await sendAccessTokenRequest(tab.id);
  } catch (error) {
    const wrapped = new Error(error?.message || 'Token request failed. Log back into your librechat site.');
    wrapped.requiresAuth = true;
    throw wrapped;
  }
  if (!response || !response.success) {
    const error = new Error(response?.error || 'Token request failed. Log back into your librechat site');
    error.requiresAuth = true;
    throw error;
  }
  await cacheToken(response.token, { expires: response.expires, expiresIn: response.expiresIn });
  return response.token;
}

async function sendAccessTokenRequest(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'requestAccessToken' });
  } catch (initialError) {
    if (initialError && initialError.message && initialError.message.includes('Could not establish connection')) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
        return await chrome.tabs.sendMessage(tabId, { type: 'requestAccessToken' });
      } catch (retryError) {
        throw retryError;
      }
    }
    throw initialError;
  }
}

async function initiateAuthHandshake(forceNewTab = false) {
  try {
    if (forceNewTab) {
      await chrome.tabs.create({ url: `${LIBRECHAT_URL}/` });
      return;
    }
    const tab = await ensureLibreChatTab();
    await chrome.tabs.update(tab.id, { active: true });
  } catch (error) {
    if (error.requiresAuth || forceNewTab) {
      await chrome.tabs.create({ url: `${LIBRECHAT_URL}/` });
    } else {
      throw error;
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'searchWithContext') {
    handleSearchRequest(message.query);
  } else if (message.type === 'initiateAuthHandshake') {
    initiateAuthHandshake(Boolean(message.forceNewTab))
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.type === 'checkAuthStatus') {
    getAccessToken()
      .then((token) => {
        safeSendRuntimeMessage({ type: 'authStatus', authenticated: true });
        sendResponse({ success: true, authenticated: true, token });
      })
      .catch((error) => {
        safeSendRuntimeMessage({ type: 'authStatus', authenticated: false, requiresAuth: Boolean(error.requiresAuth), error: error.message });
        sendResponse({ success: false, authenticated: false, error: error.message, requiresAuth: Boolean(error.requiresAuth) });
      });
    return true;
  }
});

async function handleSearchRequest(query) {
  let accessToken;
  try {
    // 1. Get a fresh, valid access token for this request.
    accessToken = await getAccessToken();
    safeSendRuntimeMessage({ type: 'authStatus', authenticated: true });
  } catch (error) {
    safeSendRuntimeMessage({ type: 'authStatus', authenticated: false, requiresAuth: Boolean(error.requiresAuth), error: error.message });
    safeSendRuntimeMessage({ type: 'streamError', error: error.message, requiresAuth: Boolean(error.requiresAuth) });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://')) { return; }
  let pageContent;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['Readability.js'] });
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => new Readability(document.cloneNode(true)).parse().textContent });
    pageContent = res[0].result;
  } catch (err) {
      safeSendRuntimeMessage({ type: 'streamError', error: "Could not read page content." });
      return;
  }
  if (!pageContent || !pageContent.trim()) {
      safeSendRuntimeMessage({ type: 'streamError', error: "Page has no readable content." });
      return;
  }

  const fullPrompt = `Based on the following context...\n\n---CONTEXT---\n${pageContent.substring(0, 10000)}\n\n---QUERY---\n${query}`;

  try {
    const response = await fetch(`${LIBRECHAT_URL}/api/agents/chat/openAI`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}` // 2. Use the accessToken here.
      },
      body: JSON.stringify({
        conversationId: null,
        parentMessageId: null,
        endpoint: "openAI",
        model: 'gpt-4o',
        text: fullPrompt,
        isContinued: false,
        isCreatedByUser: true,
        sender: "User"
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        await clearCachedToken();
      }
      const errorBody = await response.text();
      const apiError = new Error(`API request failed: ${response.status} ${errorBody}`);
      if (response.status === 401 || response.status === 403) {
        apiError.requiresAuth = true;
      }
      throw apiError;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamBuffer += decoder.decode(value, { stream: true });
      const segments = streamBuffer.split('\n');
      streamBuffer = segments.pop() || '';
      processStreamSegments(segments);
    }
    if (streamBuffer.trim()) {
      processStreamSegments([streamBuffer]);
    }
  } catch (error) {
    console.error("Error during API call:", error);
    safeSendRuntimeMessage({ type: 'streamError', error: error.message, requiresAuth: Boolean(error.requiresAuth) });
    if (error.requiresAuth) {
      safeSendRuntimeMessage({ type: 'authStatus', authenticated: false, requiresAuth: true, error: error.message });
    }
  } finally {
    safeSendRuntimeMessage({ type: 'streamEnd' });
  }
}

function processStreamSegments(segments) {
  for (const rawSegment of segments) {
    const trimmed = rawSegment.trim();
    if (!trimmed) {
      continue;
    }
    let payloadString = trimmed;
    if (payloadString.startsWith('data:')) {
      payloadString = payloadString.slice(5).trim();
    }
    if (!payloadString || payloadString === '[DONE]') {
      continue;
    }
    try {
      const payload = JSON.parse(payloadString);
      const text = extractTextFromPayload(payload);
      if (text) {
        safeSendRuntimeMessage({ type: 'streamChunk', chunk: text });
      }
    } catch (error) {
      console.debug('Failed to parse stream segment', payloadString, error);
    }
  }
}

function extractTextFromPayload(payload) {
  if (!payload) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload.text) {
    return payload.text;
  }
  if (payload.data && payload.data.delta && Array.isArray(payload.data.delta.content)) {
    return payload.data.delta.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  }
  if (payload.delta && Array.isArray(payload.delta.content)) {
    return payload.delta.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  }
  return '';
}