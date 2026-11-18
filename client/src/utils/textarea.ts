export { insertTextAtCursor, forceResize } from '@librechat/chat';

/** Whether the textarea can scroll its content. */
export const checkIfScrollable = (element: HTMLTextAreaElement | null): boolean => {
  if (!element) {
    return false;
  }
  return element.scrollHeight > element.clientHeight;
};
