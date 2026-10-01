import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import type { MemoryArtifact } from 'librechat-data-provider';
import MemoryInfo from '../MemoryInfo';

// Mock the localize hook
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      com_ui_memory_already_exceeded: `Memory storage already full - exceeded by ${params?.tokens || 0} tokens. Delete existing memories before adding new ones.`,
      com_ui_memory_would_exceed: `Cannot save - would exceed limit by ${params?.tokens || 0} tokens. Delete existing memories to make space.`,
      com_ui_memory_deleted: 'This memory has been deleted',
      com_ui_memory_storage_full: 'Memory Storage Full',
      com_ui_memory_error: 'Memory Error',
      com_ui_updated_successfully: 'Updated successfully',
      com_ui_none_selected: 'None selected',
    };
    return translations[key] || key;
  },
}));

describe('MemoryInfo', () => {
  const createMemoryArtifact = (
    type: 'update' | 'delete' | 'error',
    key: string,
    value?: string,
  ): MemoryArtifact => ({
    type,
    key,
    value: value || `test value for ${key}`,
  });

  describe('Error Memory Display', () => {
    test('displays error section when memory is already exceeded', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'already_exceeded', tokenCount: 150 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Memory storage already full - exceeded by 150 tokens. Delete existing memories before adding new ones.',
        ),
      ).toBeInTheDocument();
    });

    test('displays error when memory would exceed limit', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 50 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Cannot save - would exceed limit by 50 tokens. Delete existing memories to make space.',
        ),
      ).toBeInTheDocument();
    });

    test('displays multiple error messages', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system1',
          value: JSON.stringify({ errorType: 'already_exceeded', tokenCount: 100 }),
        },
        {
          type: 'error',
          key: 'system2',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 25 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(
        screen.getByText(
          'Memory storage already full - exceeded by 100 tokens. Delete existing memories before adding new ones.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Cannot save - would exceed limit by 25 tokens. Delete existing memories to make space.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Mixed Memory Types', () => {
    test('displays all sections when different memory types are present', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        createMemoryArtifact('update', 'memory1', 'Updated content'),
        createMemoryArtifact('delete', 'memory2'),
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 200 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Entries render without section headings; only the error section keeps one
      expect(screen.queryByText('Updated Memories')).not.toBeInTheDocument();
      expect(screen.queryByText('Deleted Memories')).not.toBeInTheDocument();
      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();

      // Check content
      expect(screen.getByText('memory1')).toBeInTheDocument();
      expect(screen.getByText('Updated content')).toBeInTheDocument();
      expect(screen.getByText('memory2')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Cannot save - would exceed limit by 200 tokens. Delete existing memories to make space.',
        ),
      ).toBeInTheDocument();
    });

    test('only displays sections with content', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'already_exceeded', tokenCount: 10 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Only error section should be present
      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(screen.queryByText('Updated Memories')).not.toBeInTheDocument();
      expect(screen.queryByText('Deleted Memories')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    test('handles empty memory artifacts array', () => {
      const { container } = render(<MemoryInfo memoryArtifacts={[]} />);
      expect(container.firstChild).toBeNull();
    });

    test('handles malformed error data gracefully', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: 'invalid json',
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Should render generic error message
      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(screen.getByText('Memory Error')).toBeInTheDocument();
    });

    test('handles missing value in error artifact', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          // value is undefined
        } as MemoryArtifact,
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(screen.getByText('Memory Error')).toBeInTheDocument();
    });

    test('handles unknown errorType gracefully', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        {
          type: 'error',
          key: 'system',
          value: JSON.stringify({ errorType: 'unknown_type', tokenCount: 30 }),
        },
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      // Should show generic error message for unknown types
      expect(screen.getByText('Memory Storage Full')).toBeInTheDocument();
      expect(screen.getByText('Memory Error')).toBeInTheDocument();
    });

    test('returns null when no memories of any type exist', () => {
      const memoryArtifacts: MemoryArtifact[] = [{ type: 'unknown' as any, key: 'test' }];

      const { container } = render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Update and Delete Memory Display', () => {
    test('displays updated memories correctly', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        createMemoryArtifact('update', 'preferences', 'User prefers dark mode'),
        createMemoryArtifact('update', 'location', 'Lives in San Francisco'),
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.queryByText('Updated Memories')).not.toBeInTheDocument();
      expect(screen.getByText('preferences')).toBeInTheDocument();
      expect(screen.getByText('User prefers dark mode')).toBeInTheDocument();
      expect(screen.getByText('location')).toBeInTheDocument();
      expect(screen.getByText('Lives in San Francisco')).toBeInTheDocument();
    });

    test('displays deleted memories correctly', () => {
      const memoryArtifacts: MemoryArtifact[] = [
        createMemoryArtifact('delete', 'old_preference'),
        createMemoryArtifact('delete', 'outdated_info'),
      ];

      render(<MemoryInfo memoryArtifacts={memoryArtifacts} />);

      expect(screen.queryByText('Deleted Memories')).not.toBeInTheDocument();
      expect(screen.getByText('old_preference')).toBeInTheDocument();
      expect(screen.getByText('outdated_info')).toBeInTheDocument();
    });
  });
});
