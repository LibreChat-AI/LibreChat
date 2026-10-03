if (!window.__librechatSidepanelInitialized) {
  window.__librechatSidepanelInitialized = true;

  const form = document.getElementById('query-form');
  const input = document.getElementById('query-input');
  const conversationContainer = document.getElementById('conversation-container');
  const submitButton = document.getElementById('submit-button');
  const newChatButton = document.getElementById('new-chat-button');
  let conversation = [];
  let currentAssistantBubble = null;
  let reconnectButton = null;
  let responseBuffer = '';
  let isAuthenticated = false;

  ensurePlaceholder();
  updateAuthStateFromStorage();
  listenForTokenChanges();

  if (newChatButton) {
    newChatButton.addEventListener('click', startNewChat);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = input.value.trim();

    if (query) {
      removeReconnectButton();
      submitButton.disabled = true;
      input.disabled = true;
      if (newChatButton) {
        newChatButton.disabled = true;
      }
      responseBuffer = '';

      appendUserMessage(query);
      beginAssistantResponse();

      console.log(`DEBUG (SP): Sending query to background: "${query}"`);
      chrome.runtime.sendMessage({ type: 'searchWithContext', query });
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!submitButton.disabled) {
        form.requestSubmit();
      }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    console.log('DEBUG (SP): Message received from background:', message);

    if (message.type === 'authStatus') {
      isAuthenticated = Boolean(message.authenticated);
      if (isAuthenticated) {
        removeReconnectButton();
        ensurePlaceholder();
      }
      return;
    }

    if (message.type === 'streamChunk' && message.chunk) {
      isAuthenticated = true;
      removeReconnectButton();
      responseBuffer += message.chunk;
      updateAssistantBubble(responseBuffer, true);
      return;
    }

    if (message.type === 'streamError') {
      const errorText = message.error || 'An unknown error occurred.';
      if (message.requiresAuth) {
        isAuthenticated = false;
        updateAssistantBubble(`${errorText} Please sign in to LibreChat and try again.`, false);
        showReconnectButton();
      } else {
        updateAssistantBubble(`Error: ${errorText}`, false);
      }
      currentAssistantBubble = null;
      responseBuffer = '';
      resetUI();
      return;
    }

    if (message.type === 'streamEnd') {
      finalizeAssistantBubble();
      resetUI();
    }
  });

  function resetUI() {
    console.log('DEBUG (SP): Resetting UI.');
    submitButton.disabled = false;
    input.disabled = false;
    input.value = '';
    input.focus();
    if (newChatButton) {
      newChatButton.disabled = false;
    }
  }

  function removeReconnectButton() {
    if (reconnectButton) {
      reconnectButton.remove();
      reconnectButton = null;
      ensurePlaceholder();
    }
  }

  function showReconnectButton() {
    if (reconnectButton) {
      return;
    }
    reconnectButton = document.createElement('button');
    reconnectButton.type = 'button';
    reconnectButton.id = 'reconnect-button';
    reconnectButton.textContent = 'Reconnect to LibreChat';
    reconnectButton.addEventListener('click', handleReconnectClick);
    if (conversationContainer) {
      removePlaceholder();
      conversationContainer.appendChild(reconnectButton);
      scrollConversation();
    }
  }

  async function handleReconnectClick() {
    if (!reconnectButton) {
      return;
    }
    reconnectButton.disabled = true;
    const originalText = 'Reconnect to LibreChat';
    reconnectButton.textContent = 'Opening LibreChat…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'initiateAuthHandshake', forceNewTab: true });
      if (!result || !result.success) {
        throw new Error(result?.error || 'Unknown error');
      }
      reconnectButton.textContent = 'LibreChat opened. Sign in, then try again.';
      await delay(1500);
      await updateAuthStateFromStorage();
    } catch (error) {
      reconnectButton.textContent = `Reconnect failed: ${error.message}`;
    } finally {
      reconnectButton.disabled = false;
      setTimeout(() => {
        if (reconnectButton) {
          reconnectButton.textContent = originalText;
        }
      }, 4000);
    }
  }

  function listenForTokenChanges() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !changes['librechat.accessToken']) {
        return;
      }
      const newValue = changes['librechat.accessToken'].newValue;
      isAuthenticated = Boolean(newValue && newValue.token);
      if (isAuthenticated) {
        removeReconnectButton();
        ensurePlaceholder();
      }
    });
  }

  function startNewChat() {
    conversation = [];
    currentAssistantBubble = null;
    responseBuffer = '';
    removeReconnectButton();
    if (conversationContainer) {
      conversationContainer.innerHTML = '';
    }
    ensurePlaceholder();
    resetUI();
  }

  function appendUserMessage(text) {
    const bubble = createMessageBubble('user', text);
    if (bubble) {
      conversation.push({ role: 'user', content: text });
    }
  }

  function beginAssistantResponse() {
    responseBuffer = '';
    currentAssistantBubble = null;
    updateAssistantBubble('', true);
  }

  function updateAssistantBubble(text, showCursor) {
    const assistant = ensureAssistantBubble();
    if (!assistant) {
      return;
    }
    if (assistant.cursor) {
      assistant.cursor.remove();
      assistant.cursor = null;
    }
    assistant.bubble.textContent = text;
    if (showCursor) {
      assistant.cursor = appendCursor(assistant.bubble);
    }
    if (conversation.length && conversation[conversation.length - 1].role === 'assistant') {
      conversation[conversation.length - 1].content = text;
    }
    scrollConversation();
  }

  function finalizeAssistantBubble() {
    updateAssistantBubble(responseBuffer, false);
    currentAssistantBubble = null;
    responseBuffer = '';
  }

  function ensureAssistantBubble() {
    if (currentAssistantBubble && currentAssistantBubble.bubble?.isConnected) {
      return currentAssistantBubble;
    }
    const bubble = createMessageBubble('assistant', '');
    if (!bubble) {
      return null;
    }
    currentAssistantBubble = { bubble, cursor: null };
    conversation.push({ role: 'assistant', content: '' });
    return currentAssistantBubble;
  }

  function createMessageBubble(role, text) {
    if (!conversationContainer) {
      return null;
    }
    removePlaceholder();
    const row = document.createElement('div');
    row.className = `message ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    conversationContainer.appendChild(row);
    scrollConversation();
    return bubble;
  }

  function appendCursor(bubble) {
    if (!bubble) {
      return null;
    }
    const cursor = document.createElement('span');
    cursor.className = 'blinking-cursor';
    bubble.appendChild(cursor);
    return cursor;
  }

  function scrollConversation() {
    if (conversationContainer) {
      conversationContainer.scrollTop = conversationContainer.scrollHeight;
    }
  }

  function removePlaceholder() {
    if (!conversationContainer) {
      return;
    }
    const placeholder = conversationContainer.querySelector('.placeholder');
    if (placeholder) {
      placeholder.remove();
    }
  }

  function ensurePlaceholder() {
    if (!conversationContainer) {
      return;
    }
    if (conversation.length > 0 || reconnectButton) {
      removePlaceholder();
      return;
    }
    if (!conversationContainer.querySelector('.placeholder')) {
      const placeholder = document.createElement('p');
      placeholder.className = 'placeholder';
      placeholder.textContent = 'Ask a question about the current page...';
      conversationContainer.appendChild(placeholder);
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function updateAuthStateFromStorage() {
    try {
      const stored = await chrome.storage.session.get('librechat.accessToken');
      const entry = stored?.['librechat.accessToken'];
      isAuthenticated = Boolean(entry && entry.token);
      if (isAuthenticated) {
        removeReconnectButton();
      }
      ensurePlaceholder();
      return isAuthenticated;
    } catch (error) {
      console.debug('Failed to read cached token', error);
      isAuthenticated = false;
      ensurePlaceholder();
      return false;
    }
  }
}