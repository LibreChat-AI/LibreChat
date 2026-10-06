import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import FileAuthoringCall from '../FileAuthoringCall';
import { SoleToolContext } from '../../disclosure';
import ReadFileCall from '../ReadFileCall';
import MemoryCall from '../MemoryCall';
import SkillCall from '../SkillCall';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useProgress: (initialProgress: number) => initialProgress,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: ({ finishedText }: { finishedText: string }) => (
    <div data-testid="progress-text">{finishedText}</div>
  ),
}));

const renderSole = (ui: React.ReactElement, sole = true) =>
  render(
    <RecoilRoot>
      <SoleToolContext.Provider value={sole}>{ui}</SoleToolContext.Provider>
    </RecoilRoot>,
  );

describe('a sole call keeps its row when its panel would be empty', () => {
  it('ReadFileCall: an empty file still shows the file name row', () => {
    renderSole(
      <ReadFileCall
        initialProgress={1}
        isSubmitting={false}
        args={{ path: 'src/empty.ts' }}
        output=""
        runStepStatus="completed"
      />,
    );
    expect(screen.getByTestId('progress-text')).toBeInTheDocument();
  });

  it('ReadFileCall: drops the row once there is output to show', () => {
    renderSole(
      <ReadFileCall
        initialProgress={1}
        isSubmitting={false}
        args={{ path: 'src/a.ts' }}
        output="const a = 1;"
        runStepStatus="completed"
      />,
    );
    expect(screen.queryByTestId('progress-text')).not.toBeInTheDocument();
  });

  it('ReadFileCall: keeps the row that carries the model-authored intent', () => {
    renderSole(
      <ReadFileCall
        initialProgress={1}
        isSubmitting={false}
        args={{ intent: 'Check the config', path: 'src/a.ts' }}
        output="const a = 1;"
        runStepStatus="completed"
      />,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Check the config');
  });

  it('FileAuthoringCall: a create that overwrote a file keeps the row naming the update', () => {
    renderSole(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{ path: 'src/a.ts', content: 'x' }}
        output="Updated src/a.ts"
        runStepStatus="completed"
      />,
    );
    expect(screen.getByTestId('progress-text')).toBeInTheDocument();
  });

  it('FileAuthoringCall: a fresh create drops the row once there is a preview', () => {
    renderSole(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{ path: 'src/a.ts', content: 'x' }}
        output="Created src/a.ts"
        runStepStatus="completed"
      />,
    );
    expect(screen.queryByTestId('progress-text')).not.toBeInTheDocument();
  });

  it('MemoryCall: output with no parseable key or value keeps its row', () => {
    renderSole(
      <MemoryCall
        toolName="set_memory"
        initialProgress={1}
        isSubmitting={false}
        args="{}"
        output="Memory saved"
        runStepStatus="completed"
      />,
    );
    expect(screen.getByTestId('progress-text')).toBeInTheDocument();
  });

  it('SkillCall: a named skill keeps its row so the skill name stays visible', () => {
    renderSole(
      <SkillCall
        initialProgress={1}
        isSubmitting={false}
        args={{ skillName: 'pdf' }}
        output="loaded"
        runStepStatus="completed"
      />,
    );
    expect(screen.getByTestId('progress-text')).toBeInTheDocument();
  });

  it('SkillCall: a named skill with empty output keeps its row', () => {
    renderSole(
      <SkillCall
        initialProgress={1}
        isSubmitting={false}
        args={{ skillName: 'pdf' }}
        output=""
        runStepStatus="completed"
      />,
    );
    expect(screen.getByTestId('progress-text')).toBeInTheDocument();
  });
});
