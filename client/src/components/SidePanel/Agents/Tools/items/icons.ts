import {
  Code,
  MessageCircleQuestion,
  Globe,
  Brain,
  Sparkles,
  FileText,
  FileSearch,
  Wrench,
  Server,
  Workflow,
  Zap,
  Layers,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AgentItem } from './types';

export interface ItemIcon {
  Icon: LucideIcon;
  colorClass: string;
  iconUrl?: string;
}

const BUILTIN_ICONS: Record<string, ItemIcon> = {
  execute_code: {
    Icon: Code,
    colorClass: 'bg-series-7/15 text-series-7',
  },
  web_search: {
    Icon: Globe,
    colorClass: 'bg-series-1/15 text-series-1',
  },
  artifacts: {
    Icon: Sparkles,
    colorClass: 'bg-series-6/15 text-series-6',
  },
  context: {
    Icon: FileText,
    colorClass: 'bg-series-4/15 text-series-4',
  },
  file_search: {
    Icon: FileSearch,
    colorClass: 'bg-series-5/15 text-series-5',
  },
  memory: {
    Icon: Brain,
    colorClass: 'bg-series-8/15 text-series-8',
  },
  ask_user_question: {
    Icon: MessageCircleQuestion,
    colorClass: 'bg-series-3/15 text-series-3',
  },
};

const KIND_FALLBACK_ICONS: Record<AgentItem['kind'], ItemIcon> = {
  builtin: {
    Icon: Layers,
    colorClass: 'bg-series-7/15 text-series-7',
  },
  tool: {
    Icon: Wrench,
    colorClass: 'bg-series-1/15 text-series-1',
  },
  mcp: {
    Icon: Server,
    colorClass: 'bg-series-6/15 text-series-6',
  },
  skill: {
    Icon: Zap,
    colorClass: 'bg-series-4/15 text-series-4',
  },
  action: {
    Icon: Workflow,
    colorClass: 'bg-series-2/15 text-series-2',
  },
};

function extractIconUrl(item: AgentItem): string | undefined {
  if (item.kind === 'tool') {
    const url = item.plugin?.icon;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  }
  if (item.kind === 'mcp') {
    const url = item.server?.metadata?.icon;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  }
  return undefined;
}

export function getIconForItem(item: AgentItem): ItemIcon {
  if (item.kind === 'builtin') {
    return BUILTIN_ICONS[item.iconKey] ?? KIND_FALLBACK_ICONS.builtin;
  }
  const base = KIND_FALLBACK_ICONS[item.kind];
  const iconUrl = extractIconUrl(item);
  return iconUrl ? { ...base, iconUrl } : base;
}
