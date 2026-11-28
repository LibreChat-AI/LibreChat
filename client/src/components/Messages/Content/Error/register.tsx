import { setAppErrorSlots } from '~/components/Chat/Messages/Content/Parts/slots';
import { SetKeyDialog } from '~/components/Input/SetKeyDialog';
import AttachmentRecoveryActions from './recovery';

/** Fills the parts host's error slots with this app's key dialog and recovery actions. The
 *  surfaces that draw errors load this module, so the host never imports either at boot. */
setAppErrorSlots({
  renderSetKeyDialog: (props) => <SetKeyDialog {...props} />,
  renderErrorActions: (props) => <AttachmentRecoveryActions {...props} />,
});
