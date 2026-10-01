import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { Tools } from 'librechat-data-provider';
import type { TAttachment, MemoryArtifact } from 'librechat-data-provider';
import MemoryArtifacts from '../MemoryArtifacts';

// Mock the localize hook
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_memory_updated: 'Updated saved memory',
      com_ui_memory_error: 'Memory Error',
    };
    return translations[key] || key;
  },
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

// Mock the MemoryInfo component
jest.mock('../MemoryInfo', () => ({
  __esModule: true,
  default: ({ memoryArtifacts }: { memoryArtifacts: MemoryArtifact[] }) => (
    <div data-testid="memory-info">
      {memoryArtifacts.map((artifact, index) => (
        <div key={index} data-testid={`memory-artifact-${artifact.type}`}>
          {artifact.type}: {artifact.key}
        </div>
      ))}
    </div>
  ),
}));

describe('MemoryArtifacts', () => {
  const createMemoryAttachment = (type: 'update' | 'delete' | 'error', key: string): TAttachment =>
    ({
      type: Tools.memory,
      [Tools.memory]: {
        type,
        key,
        value:
          type === 'error'
            ? JSON.stringify({ errorType: 'exceeded', tokenCount: 100 })
            : 'test value',
      } as MemoryArtifact,
    }) as TAttachment;

  describe('Error State Handling', () => {
    test('displays error styling when memory artifacts contain errors', () => {
      const attachments = [
        createMemoryAttachment('error', 'system'),
        createMemoryAttachment('update', 'memory1'),
      ];

      render(<MemoryArtifacts attachments={attachments} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-status-error');
    });

    test('displays normal styling when no errors present', () => {
      const attachments = [
        createMemoryAttachment('update', 'memory1'),
        createMemoryAttachment('delete', 'memory2'),
      ];

      render(<MemoryArtifacts attachments={attachments} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-text-secondary');
      expect(button).not.toHaveClass('text-status-error');
    });

    test('displays error message when errors are present', () => {
      const attachments = [createMemoryAttachment('error', 'system')];

      render(<MemoryArtifacts attachments={attachments} />);

      expect(screen.getByText('Memory Error')).toBeInTheDocument();
      expect(screen.queryByText('Updated saved memory')).not.toBeInTheDocument();
    });

    test('displays normal message when no errors are present', () => {
      const attachments = [createMemoryAttachment('update', 'memory1')];

      render(<MemoryArtifacts attachments={attachments} />);

      expect(screen.getByText('Updated saved memory')).toBeInTheDocument();
      expect(screen.queryByText('Memory Error')).not.toBeInTheDocument();
    });
  });

  describe('Memory Artifacts Filtering', () => {
    test('filters and passes only memory-type attachments to MemoryInfo', () => {
      const attachments = [
        createMemoryAttachment('update', 'memory1'),
        { type: 'file' } as TAttachment, // Non-memory attachment
        createMemoryAttachment('error', 'system'),
      ];

      render(<MemoryArtifacts attachments={attachments} />);

      // Click to expand
      fireEvent.click(screen.getByRole('button'));

      // Check that only memory artifacts are passed to MemoryInfo
      expect(screen.getByTestId('memory-artifact-update')).toBeInTheDocument();
      expect(screen.getByTestId('memory-artifact-error')).toBeInTheDocument();
    });

    test('correctly identifies multiple error artifacts', () => {
      const attachments = [
        createMemoryAttachment('error', 'system1'),
        createMemoryAttachment('error', 'system2'),
        createMemoryAttachment('update', 'memory1'),
      ];

      render(<MemoryArtifacts attachments={attachments} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-status-error');
      expect(screen.getByText('Memory Error')).toBeInTheDocument();
    });

    test('ignores attachments already rendered as an inline memory tool card', () => {
      /** A `set_memory`/`delete_memory` call routes to `MemoryCall`, which
       *  shows the same key, value and outcome. Counting its attachment here
       *  too rendered one mutation twice. `toolCallId` is the discriminator. */
      const linked = {
        ...createMemoryAttachment('update', 'memory1'),
        toolCallId: 'call_abc123',
      } as TAttachment;

      const { container } = render(<MemoryArtifacts attachments={[linked]} />);

      expect(container).toBeEmptyDOMElement();
    });

    test('still renders a memory attachment carrying no tool call id', () => {
      render(<MemoryArtifacts attachments={[createMemoryAttachment('update', 'memory1')]} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByTestId('memory-artifact-update')).toBeInTheDocument();
    });
  });

  describe('Collapse/Expand Functionality', () => {
    test('uses the standard tool row and expanded panel styling', () => {
      const attachments = [createMemoryAttachment('update', 'memory1')];

      render(<MemoryArtifacts attachments={attachments} />);

      const button = screen.getByRole('button');
      expect(button.parentElement).toHaveClass('my-1', 'h-5');
      expect(button).toHaveClass('group/disclosure');

      fireEvent.click(button);

      expect(screen.getByTestId('memory-info').parentElement).toHaveClass(
        'mb-2',
        'mt-0',
        'rounded-lg',
        'bg-surface-secondary',
      );
    });

    test('toggles memory info visibility on button click', () => {
      const attachments = [createMemoryAttachment('update', 'memory1')];

      render(<MemoryArtifacts attachments={attachments} />);

      // Initially collapsed
      expect(screen.queryByTestId('memory-info')).not.toBeInTheDocument();

      // Click to expand
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByTestId('memory-info')).toBeInTheDocument();

      // Click to collapse
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByTestId('memory-info')).not.toBeInTheDocument();
    });

    test('updates aria-expanded attribute correctly', () => {
      const attachments = [createMemoryAttachment('update', 'memory1')];

      render(<MemoryArtifacts attachments={attachments} />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('Edge Cases', () => {
    test('handles empty attachments array', () => {
      render(<MemoryArtifacts attachments={[]} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    test('handles undefined attachments', () => {
      render(<MemoryArtifacts />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    test('handles attachments with no memory artifacts', () => {
      const attachments = [{ type: 'file' } as TAttachment, { type: 'image' } as TAttachment];

      render(<MemoryArtifacts attachments={attachments} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    test('handles malformed memory artifacts gracefully', () => {
      const attachments = [
        {
          type: Tools.memory,
          [Tools.memory]: {
            type: 'error',
            key: 'system',
            // Missing value
          },
        } as TAttachment,
      ];

      render(<MemoryArtifacts attachments={attachments} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-status-error');
      expect(screen.getByText('Memory Error')).toBeInTheDocument();
    });
  });
});
