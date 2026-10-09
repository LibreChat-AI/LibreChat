import MCPServerDialog from '~/components/SidePanel/MCPBuilder/MCPServerDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddMcpServerDialog({ open, onOpenChange }: Props) {
  return <MCPServerDialog open={open} onOpenChange={onOpenChange} />;
}
