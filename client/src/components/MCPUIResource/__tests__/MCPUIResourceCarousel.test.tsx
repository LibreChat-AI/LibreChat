import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { UIResource } from 'librechat-data-provider';
import { useConversationUIResources } from '~/hooks/Messages/useConversationUIResources';
import { MCPUIResourceCarousel } from '../MCPUIResourceCarousel';
import { useOptionalMessagesConversation } from '~/Providers';

jest.mock('~/Providers', () => ({
  useOptionalMessagesConversation: jest.fn(),
}));
jest.mock('~/hooks/Messages/useConversationUIResources');

jest.mock('../../Chat/Messages/Content/UIResourceCarousel', () => ({
  __esModule: true,
  default: ({ uiResources }: { uiResources: UIResource[] }) => (
    <div data-testid="ui-resource-carousel" data-resource-count={uiResources.length}>
      {uiResources.map((resource, index) => (
        <div key={index} data-testid={`resource-${index}`} data-resource-uri={resource.uri} />
      ))}
    </div>
  ),
}));

const mockUseMessagesConversation = useOptionalMessagesConversation as jest.MockedFunction<
  typeof useOptionalMessagesConversation
>;
const mockUseConversationUIResources = useConversationUIResources as jest.MockedFunction<
  typeof useConversationUIResources
>;

const makeResource = (id: string, uri: string): UIResource => ({
  resourceId: id,
  uri,
  mimeType: 'text/html',
  toolName: 'test-tool',
  serverName: 'test-server',
});

describe('MCPUIResourceCarousel', () => {
  const renderWithRecoil = (ui: React.ReactNode) => render(<RecoilRoot>{ui}</RecoilRoot>);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseMessagesConversation.mockReturnValue({
      conversation: { conversationId: 'conv123' },
      conversationId: 'conv123',
    } as ReturnType<typeof useOptionalMessagesConversation>);
    mockUseConversationUIResources.mockReturnValue(new Map());
  });

  describe('multiple resource fetching', () => {
    it('fetches resources by resourceIds from the conversation map', () => {
      const r1 = makeResource('id-1', 'ui://test/resource-id1');
      const r2 = makeResource('id-2', 'ui://test/resource-id2');
      mockUseConversationUIResources.mockReturnValue(
        new Map([
          ['id-1', r1],
          ['id-2', r2],
        ]),
      );

      renderWithRecoil(
        <MCPUIResourceCarousel node={{ properties: { resourceIds: ['id-2', 'id-1'] } }} />,
      );

      const carousel = screen.getByTestId('ui-resource-carousel');
      expect(carousel).toHaveAttribute('data-resource-count', '2');
      expect(screen.getByTestId('resource-0')).toHaveAttribute(
        'data-resource-uri',
        'ui://test/resource-id2',
      );
      expect(screen.getByTestId('resource-1')).toHaveAttribute(
        'data-resource-uri',
        'ui://test/resource-id1',
      );
    });
  });

  describe('error handling', () => {
    it('returns null when no resources match the given IDs', () => {
      mockUseConversationUIResources.mockReturnValue(new Map());

      const { container } = renderWithRecoil(
        <MCPUIResourceCarousel node={{ properties: { resourceIds: ['id1', 'id2'] } }} />,
      );

      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('ui-resource-carousel')).not.toBeInTheDocument();
    });

    it('returns null when partial resources not found', () => {
      mockUseConversationUIResources.mockReturnValue(
        new Map([['existing-id', makeResource('existing-id', 'ui://test/resource')]]),
      );

      const { container } = renderWithRecoil(
        <MCPUIResourceCarousel node={{ properties: { resourceIds: ['non-existent-id'] } }} />,
      );

      expect(container.firstChild).toBeNull();
    });

    it('returns null when conversationId is absent', () => {
      mockUseMessagesConversation.mockReturnValue({
        conversation: null,
        conversationId: null,
      } as ReturnType<typeof useOptionalMessagesConversation>);
      mockUseConversationUIResources.mockReturnValue(new Map());

      const { container } = renderWithRecoil(
        <MCPUIResourceCarousel node={{ properties: { resourceIds: ['test-id'] } }} />,
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty resourceIds array', () => {
      const { container } = renderWithRecoil(
        <MCPUIResourceCarousel node={{ properties: { resourceIds: [] } }} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('passes duplicate IDs through to the carousel', () => {
      const ra = makeResource('id-a', 'ui://test/resource-a');
      const rb = makeResource('id-b', 'ui://test/resource-b');
      mockUseConversationUIResources.mockReturnValue(
        new Map([
          ['id-a', ra],
          ['id-b', rb],
        ]),
      );

      renderWithRecoil(
        <MCPUIResourceCarousel
          node={{ properties: { resourceIds: ['id-a', 'id-a', 'id-b', 'id-b', 'id-a'] } }}
        />,
      );

      const carousel = screen.getByTestId('ui-resource-carousel');
      expect(carousel).toHaveAttribute('data-resource-count', '5');

      const resources = screen.getAllByTestId(/resource-\d/);
      expect(resources).toHaveLength(5);
      expect(resources[0]).toHaveAttribute('data-resource-uri', 'ui://test/resource-a');
      expect(resources[2]).toHaveAttribute('data-resource-uri', 'ui://test/resource-b');
      expect(resources[4]).toHaveAttribute('data-resource-uri', 'ui://test/resource-a');
    });

    it('returns null for empty messages', () => {
      mockUseConversationUIResources.mockReturnValue(new Map());

      const { container } = renderWithRecoil(
        <MCPUIResourceCarousel node={{ properties: { resourceIds: ['test-id'] } }} />,
      );

      expect(container.firstChild).toBeNull();
    });
  });
});
