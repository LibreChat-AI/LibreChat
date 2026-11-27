import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SubagentThreadLink from '../SubagentThreadLink';

const mockUseGetConversationByIdQuery = jest.fn<
  { data: { conversationId: string } | undefined },
  [string, Record<string, unknown>?]
>(() => ({ data: undefined }));
const mockNavigateToConvo = jest.fn();

jest.mock('librechat-data-provider/react-query', () => ({
  useGetConversationByIdQuery: (id: string, config?: Record<string, unknown>) =>
    mockUseGetConversationByIdQuery(id, config),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => () => 'Back to parent chat',
  useNavigateToConvo: () => ({ navigateToConvo: mockNavigateToConvo }),
}));

jest.mock('lucide-react', () => ({
  ChevronLeft: () => <span data-testid="left-icon" />,
}));

describe('SubagentThreadLink', () => {
  const renderLink = (element: React.ReactElement) => render(element);

  beforeEach(() => {
    mockUseGetConversationByIdQuery.mockReset();
    mockUseGetConversationByIdQuery.mockReturnValue({ data: undefined });
    mockNavigateToConvo.mockReset();
  });

  it('loads a parent chat and navigates through the conversation state helper', () => {
    const parent = { conversationId: 'parent-thread' };
    mockUseGetConversationByIdQuery.mockReturnValue({ data: parent });
    renderLink(<SubagentThreadLink threadId="parent-thread" />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to parent chat' }));
    expect(mockNavigateToConvo).toHaveBeenCalledWith(parent);
    expect(screen.getByTestId('left-icon')).toBeInTheDocument();
    expect(mockUseGetConversationByIdQuery).toHaveBeenCalledWith(
      'parent-thread',
      expect.objectContaining({ enabled: true }),
    );
  });

  it('does not render an empty thread selector', () => {
    const { container } = renderLink(<SubagentThreadLink threadId="   " />);
    expect(container).toBeEmptyDOMElement();
  });
});
