import { useMemo } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { ToolIconType } from './ToolIcon';
import ToolIcon, { getToolIconType, getMCPServerName } from './ToolIcon';
import { FaviconImage } from '~/components/Web/SourceHovercard';
import { useMCPServerNames } from '~/hooks/MCP';
import { cn } from '~/utils';

interface ResolvedIcon {
  key: string;
  type: ToolIconType;
  iconUrl?: string;
  /** A site a web search read, shown as its favicon. */
  domain?: string;
}

interface StackedToolIconsProps {
  toolNames: string[];
  mcpIconMap?: Map<string, string>;
  maxIcons?: number;
  isAnimating?: boolean;
  /** A hidden action's terminal warning takes precedence over its identity. */
  status?: 'failed' | 'cancelled';
  /** Sites the stack's web searches read. They take the generic search
   *  glyph's place: a header stands for rows it hides, so it shows the most
   *  specific glyph those rows do. */
  sourceDomains?: readonly string[];
}

export default function StackedToolIcons({
  toolNames,
  mcpIconMap,
  maxIcons = 3,
  isAnimating = false,
  sourceDomains,
  status,
}: StackedToolIconsProps) {
  const mcpServerNames = useMCPServerNames();
  const uniqueIcons = useMemo(() => {
    const seen = new Set<string>();
    const result: ResolvedIcon[] = [];
    for (const name of toolNames) {
      const type = getToolIconType(name);
      const serverName = getMCPServerName(name, mcpServerNames);
      const iconUrl = serverName ? mcpIconMap?.get(serverName) : undefined;
      if (type === 'web_search' && sourceDomains != null && sourceDomains.length > 0) {
        for (const domain of sourceDomains) {
          if (!seen.has(`site-${domain}`)) {
            seen.add(`site-${domain}`);
            result.push({ key: `site-${domain}`, type, domain });
          }
        }
        continue;
      }
      const key = iconUrl ? `mcp-${serverName}` : type;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ key, type, iconUrl });
      }
    }
    return result;
  }, [toolNames, mcpIconMap, mcpServerNames, sourceDomains]);

  if (status != null) {
    const StatusIcon = status === 'failed' ? TriangleAlert : X;
    return <StatusIcon className="text-text-warning size-4 shrink-0" aria-hidden="true" />;
  }

  const visibleIcons = uniqueIcons.slice(0, maxIcons);
  const overflowCount = uniqueIcons.length - visibleIcons.length;

  if (visibleIcons.length <= 1 && visibleIcons[0]?.domain == null) {
    const icon = visibleIcons[0];
    return (
      <ToolIcon type={icon?.type ?? 'generic'} iconUrl={icon?.iconUrl} isAnimating={isAnimating} />
    );
  }

  return (
    <div className="flex items-center" aria-hidden="true">
      {visibleIcons.map((icon, index) => (
        <div
          key={icon.key}
          className={cn(
            'border-border-medium bg-surface-secondary relative flex items-center justify-center rounded-full border',
            'h-[22px] w-[22px]',
            index > 0 && '-ml-2.5',
          )}
          style={{ zIndex: visibleIcons.length - index }}
        >
          {icon.domain != null ? (
            <FaviconImage domain={icon.domain} className="size-3 rounded-full" />
          ) : (
            <ToolIcon
              type={icon.type}
              iconUrl={icon.iconUrl}
              isAnimating={isAnimating}
              className="size-3"
            />
          )}
        </div>
      ))}
      {overflowCount > 0 && (
        <div
          className={cn(
            'border-border-medium bg-surface-tertiary relative flex items-center justify-center rounded-full border',
            'text-text-secondary -ml-2.5 h-[22px] w-[22px] text-xs font-medium',
          )}
          style={{ zIndex: 0 }}
        >
          +{overflowCount}
        </div>
      )}
    </div>
  );
}
