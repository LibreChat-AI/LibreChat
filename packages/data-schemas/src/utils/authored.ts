/** Authorship only: callers must also enforce owner, tenant, response and retention scope. */
export const SERVER_AUTHORED_MESSAGE_FILTER = {
  isCreatedByUser: false,
  isUserSubmitted: { $ne: true },
} as const;

export function isServerAuthoredMessage(message: {
  isCreatedByUser?: boolean;
  isUserSubmitted?: boolean;
}): boolean {
  return message.isCreatedByUser === false && message.isUserSubmitted !== true;
}
