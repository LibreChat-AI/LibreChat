import { RetrievalCall as PackageRetrievalCall } from '@librechat/chat/components';
import type { RetrievalCallProps } from '@librechat/chat/components';
import ProgressText from './ProgressText';

type RetrievalCallAdapterProps = Omit<RetrievalCallProps, 'renderProgress'>;

/** App adapter: the progress row stays the app's tool-card piece. */
export default function RetrievalCall(props: RetrievalCallAdapterProps) {
  return (
    <PackageRetrievalCall
      {...props}
      renderProgress={(progress) => <ProgressText {...progress} />}
    />
  );
}
