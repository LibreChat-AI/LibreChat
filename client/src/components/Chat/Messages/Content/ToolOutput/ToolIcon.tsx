import { Constants, isActionTool, splitToolCallName } from 'librechat-data-provider';
import {
  Terminal,
  Users,
  Globe,
  ImageIcon,
  ArrowRightLeft,
  FileSearch,
  FileText,
  FilePlus2,
  FilePenLine,
  MessageCircleQuestion,
  ScrollText,
  Brain,
  Zap,
  Wrench,
  ListChecks,
} from 'lucide-react';
import LangIcon from '~/components/Messages/Content/LangIcon';
import CustomIcon from '~/components/ui/CustomIcon';
import { cn } from '~/utils';

function BashIcon({ className }: { className?: string }) {
  return <LangIcon lang="bash" className={className} />;
}

export type ToolIconType =
  | 'mcp'
  | 'execute_code'
  | 'web_search'
  | 'image_gen'
  | 'subagent'
  | 'agent_handoff'
  | 'file_search'
  | 'skill'
  | 'read_file'
  | 'create_file'
  | 'edit_file'
  | 'bash_tool'
  | 'background_tasks'
  | 'ask_user_question'
  | 'memory'
  | 'action'
  | 'generic';

const ICON_MAP: Record<ToolIconType, React.ComponentType<{ className?: string }>> = {
  mcp: Wrench,
  execute_code: Terminal,
  web_search: Globe,
  image_gen: ImageIcon,
  agent_handoff: ArrowRightLeft,
  subagent: Users,
  file_search: FileSearch,
  skill: ScrollText,
  read_file: FileText,
  create_file: FilePlus2,
  edit_file: FilePenLine,
  bash_tool: BashIcon,
  background_tasks: ListChecks,
  ask_user_question: MessageCircleQuestion,
  memory: Brain,
  action: Zap,
  generic: Wrench,
};

export function getToolIconType(name: string): ToolIconType {
  if (!name) {
    return 'generic';
  }
  if (name.includes(Constants.mcp_delimiter)) {
    return 'mcp';
  }
  if (name === Constants.CHECK_BACKGROUND_TASK) {
    return 'background_tasks';
  }
  if (name === 'execute_code' || name === Constants.PROGRAMMATIC_TOOL_CALLING) {
    return 'execute_code';
  }
  if (name === 'web_search') {
    return 'web_search';
  }
  if (name === 'image_gen_oai' || name === 'image_edit_oai' || name === 'gemini_image_gen') {
    return 'image_gen';
  }
  if (name === 'file_search' || name === 'retrieval') {
    return 'file_search';
  }
  if (name === 'code_interpreter') {
    return 'execute_code';
  }
  if (name === 'skill') {
    return 'skill';
  }
  if (name === 'read_file') {
    return 'read_file';
  }
  if (name === 'create_file' || name === 'edit_file') {
    return name;
  }
  if (name === 'bash_tool' || name === Constants.BASH_PROGRAMMATIC_TOOL_CALLING) {
    return 'bash_tool';
  }
  if (name === Constants.SUBAGENT) {
    return 'subagent';
  }
  if (name === 'ask_user_question') {
    return 'ask_user_question';
  }
  if (name === 'set_memory' || name === 'delete_memory') {
    return 'memory';
  }
  if (name.startsWith(Constants.LC_TRANSFER_TO_)) {
    return 'agent_handoff';
  }
  if (isActionTool(name)) {
    return 'action';
  }
  return 'generic';
}

/** Extracts the MCP server name from a tool name with format `tool<delimiter>server`. */
export function getMCPServerName(toolName: string, knownServerNames?: readonly string[]): string {
  if (!toolName.includes(Constants.mcp_delimiter)) {
    return '';
  }
  const [, serverName] = splitToolCallName(toolName, knownServerNames);
  return serverName ?? '';
}

interface ToolIconProps {
  type: ToolIconType;
  iconUrl?: string;
  isAnimating?: boolean;
  className?: string;
}

export default function ToolIcon({ type, iconUrl, isAnimating = false, className }: ToolIconProps) {
  if (iconUrl) {
    return (
      <CustomIcon
        src={iconUrl}
        alt=""
        className={cn(
          'text-text-secondary size-4 shrink-0 rounded-full object-cover',
          isAnimating && 'animate-pulse',
          className,
        )}
      />
    );
  }

  const IconComponent = ICON_MAP[type];
  return (
    <IconComponent
      className={cn(
        'text-text-secondary size-4 shrink-0',
        isAnimating && 'animate-pulse',
        className,
      )}
      aria-hidden="true"
    />
  );
}
