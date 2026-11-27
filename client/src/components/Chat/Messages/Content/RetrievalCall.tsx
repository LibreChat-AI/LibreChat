import { RetrievalCall as PackageRetrievalCall } from '@librechat/chat/components';
import type { RetrievalCallProps } from '@librechat/chat/components';
import { ToolIcon, OutputRenderer } from './ToolOutput';
import ProgressText from './ProgressText';

type RetrievalCallAdapterProps = Omit<
  RetrievalCallProps,
  'renderProgress' | 'renderOutput' | 'renderIcon'
>;

/** App adapter: progress, icon and output stay the app's tool-card pieces. */
export default function RetrievalCall(props: RetrievalCallAdapterProps) {
  return (
    <PackageRetrievalCall
      {...props}
      renderIcon={({ isAnimating }) => <ToolIcon type="file_search" isAnimating={isAnimating} />}
      renderOutput={(text) => <OutputRenderer text={text} />}
      renderProgress={(progress) => <ProgressText {...progress} />}
    />
  );
}
