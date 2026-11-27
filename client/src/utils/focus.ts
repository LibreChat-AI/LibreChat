let pendingChatFocus = false;

/**
 * Transient cross-navigation focus intent for the chat composer. Carried
 * outside `location.state` so consuming it needs no second state-clearing
 * navigation, which doubled every router-context sweep per conversation
 * switch; being transient, it also never re-fires from history entries on
 * back/forward navigation.
 */
export const requestChatFocus = (): void => {
  pendingChatFocus = true;
};

export const consumeChatFocus = (): boolean => {
  const requested = pendingChatFocus;
  pendingChatFocus = false;
  return requested;
};
