export { isJson, extractJson } from '@librechat/chat';

export function formatJSON(json: string) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
