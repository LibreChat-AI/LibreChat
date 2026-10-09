import type { AgentItem } from '../items/types';
import BuiltinSection from './sections/BuiltinSection';
import ActionSection from './sections/ActionSection';
import SkillSection from './sections/SkillSection';
import ToolSection from './sections/ToolSection';
import McpSection from './sections/McpSection';
import { useAgentFileEntries } from '../hooks';

interface Props {
  item: AgentItem;
  agentId: string;
  onClose: () => void;
}

export default function ItemDialogBody({ item, agentId, onClose }: Props) {
  const { contextFiles, knowledgeFiles, codeFiles } = useAgentFileEntries();

  if (item.kind === 'builtin') {
    return (
      <BuiltinSection
        builtinId={item.id}
        agentId={agentId}
        contextFiles={contextFiles}
        knowledgeFiles={knowledgeFiles}
        codeFiles={codeFiles}
        description={item.description}
      />
    );
  }
  if (item.kind === 'tool') {
    return <ToolSection item={item} />;
  }
  if (item.kind === 'skill') {
    return <SkillSection item={item} />;
  }
  if (item.kind === 'mcp') {
    return <McpSection item={item} />;
  }
  return <ActionSection item={item} agentId={agentId} onClose={onClose} />;
}
