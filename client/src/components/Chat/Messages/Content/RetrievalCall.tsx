import { RetrievalCall as PackageRetrievalCall } from '@librechat/chat/components';
import type { RetrievalCallProps } from '@librechat/chat/components';
import { OutputRenderer } from './ToolOutput';
import ProgressText from './ProgressText';

type RetrievalCallAdapterProps = Omit<RetrievalCallProps, 'renderProgress' | 'renderOutput'>;

/** App adapter: progress and output stay the app's tool-card pieces. */
export default function RetrievalCall(props: RetrievalCallAdapterProps) {
  return (
    <PackageRetrievalCall
      {...props}
      renderOutput={(text) => <OutputRenderer text={text} />}
      renderProgress={(progress) => <ProgressText {...progress} />}
    />
  );
}
