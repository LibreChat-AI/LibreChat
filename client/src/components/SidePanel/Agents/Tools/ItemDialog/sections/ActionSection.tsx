import { useEffect } from 'react';
import type { ActionItem } from '../../items/types';
import ActionBackground from '../../../Actions/Background';
import { useAgentPanelContext } from '~/Providers';
import { NEW_ACTION_ID } from '../../items/types';
import ActionEditor from '../../ActionEditor';

interface Props {
  item: ActionItem;
  agentId: string;
  onClose: () => void;
}

export default function ActionSection({ item, agentId, onClose }: Props) {
  const { setAction } = useAgentPanelContext();
  const isCreate = item.id === NEW_ACTION_ID;

  useEffect(() => {
    setAction(isCreate ? undefined : item.action);
    return () => setAction(undefined);
  }, [isCreate, item.action, setAction]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {!isCreate && <ActionBackground agentId={agentId} />}
      <ActionEditor
        agentId={agentId}
        onClose={onClose}
        onDeleted={onClose}
        onCreated={isCreate ? onClose : undefined}
      />
    </div>
  );
}
