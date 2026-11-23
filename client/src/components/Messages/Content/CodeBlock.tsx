import { CodeBlock as Block } from '@librechat/chat/components';
import type { CodeBlockProps, RunCodeProps } from '@librechat/chat/components';
import CodeOutput from '~/components/Messages/Content/CodeOutput';
import RunCode from '~/components/Messages/Content/RunCode';

const renderRun = (props: RunCodeProps) => <RunCode {...props} />;

/** The chat package's code block, with LibreChat's run button and the output of its runs. */
export default function CodeBlock({
  allowExecution = true,
  ...props
}: Omit<CodeBlockProps, 'renderRun' | 'output'>) {
  return (
    <Block
      {...props}
      allowExecution={allowExecution}
      renderRun={renderRun}
      output={allowExecution ? <CodeOutput blockIndex={props.blockIndex} /> : null}
    />
  );
}
