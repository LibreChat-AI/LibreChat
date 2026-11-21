import { useMemo } from 'react';
import { useMessagePartsHost } from '../host';

/** The configured MCP servers and the icon of each that has one, as the stacked tool icons take them. */
export default function useServerIcons(): {
  names: readonly string[];
  icons: Map<string, string>;
} {
  const { mcpServerNames, mcpIconUrl } = useMessagePartsHost().useToolCallChrome();
  const icons = useMemo(() => {
    const found = new Map<string, string>();
    for (const name of mcpServerNames) {
      const url = mcpIconUrl(name);
      if (url != null) {
        found.set(name, url);
      }
    }
    return found;
  }, [mcpServerNames, mcpIconUrl]);
  return { names: mcpServerNames, icons };
}
