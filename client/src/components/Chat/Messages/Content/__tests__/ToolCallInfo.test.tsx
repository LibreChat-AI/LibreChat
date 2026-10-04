import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolCallInfo from '~/components/Chat/Messages/Content/ToolCallInfo';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_parameters: 'Parameters',
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

jest.mock('../ToolOutput', () => ({
  OutputRenderer: ({ text }: { text: string }) => <div data-testid="output-renderer">{text}</div>,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}));

jest.mock('lucide-react', () => ({
  ChevronDown: () => <span aria-hidden="true" />,
}));

describe('ToolCallInfo', () => {
  const baseProps = { input: '{"query": "test"}' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('output rendering', () => {
    it('renders output text', () => {
      render(<ToolCallInfo {...baseProps} output="Some output" />);
      expect(screen.getByTestId('output-renderer').textContent).toBe('Some output');
    });

    it('renders nothing when output is absent', () => {
      render(<ToolCallInfo {...baseProps} />);
      expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
    });

    it('renders null output without crashing', () => {
      render(<ToolCallInfo {...baseProps} output={null} />);
      expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
    });
  });

  describe('parameters toggle', () => {
    it('shows toggle when input has JSON content', () => {
      render(<ToolCallInfo {...baseProps} output="output" />);
      expect(screen.getByText('Parameters')).toBeInTheDocument();
    });

    it('hides toggle when input is empty', () => {
      render(<ToolCallInfo input="" output="output" />);
      expect(screen.queryByText('Parameters')).not.toBeInTheDocument();
    });

    it('hides toggle when input is whitespace only', () => {
      render(<ToolCallInfo input="   " output="output" />);
      expect(screen.queryByText('Parameters')).not.toBeInTheDocument();
    });

    it('toggles expanded state when clicked', () => {
      render(<ToolCallInfo {...baseProps} output="output" />);
      const button = screen.getByText('Parameters').closest('button')!;
      expect(button).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('edge cases', () => {
    it('renders with only input and no output', () => {
      render(<ToolCallInfo {...baseProps} />);
      expect(screen.getByText('Parameters')).toBeInTheDocument();
    });

    it('renders with empty props', () => {
      render(<ToolCallInfo input="" />);
      expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
      expect(screen.queryByText('Parameters')).not.toBeInTheDocument();
    });
  });
});
