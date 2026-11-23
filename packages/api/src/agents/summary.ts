import { Tools } from 'librechat-data-provider';

/** Built-in upload capabilities consumed by chat when it loads the basic agent summary. */
export function getAgentUploadTools(tools?: readonly string[] | null): string[] {
  return tools?.filter((tool) => tool === Tools.file_search || tool === Tools.execute_code) ?? [];
}
