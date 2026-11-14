import { setToolCallAttachments } from './toolCallAttachment';
import { MCPAppViews } from '~/components/MCPUIResource';
import { AttachmentGroup } from './Parts';

setToolCallAttachments((attachments) => (
  <>
    <AttachmentGroup attachments={attachments} />
    <MCPAppViews attachments={attachments} />
  </>
));
