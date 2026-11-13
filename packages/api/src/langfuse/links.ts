/**
 * Builds the Langfuse console URL for a prompt. Mirrors `resolveLangfuseSession`
 * in `./session`: `new URL(baseUrl)`, trim any trailing slash from the existing
 * path, then append the new segment, so a base URL with a path prefix (for
 * example `https://host/lf/`) produces `https://host/lf/project/...` rather
 * than discarding the prefix.
 */
export function getLangfusePromptUrl(baseUrl: string, projectId: string, name: string): string {
  const promptUrl = new URL(baseUrl);
  const basePath = promptUrl.pathname.replace(/\/+$/, '');
  promptUrl.pathname = `${basePath}/project/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(name)}`;
  return promptUrl.toString();
}
