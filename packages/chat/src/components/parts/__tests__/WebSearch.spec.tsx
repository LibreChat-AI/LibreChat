/**
 * @jest-environment jsdom
 */
import React from 'react';
import { Tools } from 'librechat-data-provider';
import { fireEvent, render as renderBare, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SearchResultData, TAttachment, ValidSource } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import { GeneratedToolLabelContext } from '../../../react/parts/disclosure';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import WebSearch from '../WebSearch';

function render(node: ReactElement) {
  return renderBare(
    <MessagePartsHostProvider host={createMessagePartsHost()}>{node}</MessagePartsHostProvider>,
  );
}

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      com_ui_web_searching: 'Searching the web',
      com_ui_web_searched: 'Searched the web',
      com_ui_web_search_source: `${values?.count ?? 1} source`,
      com_ui_web_search_sources: `${values?.count ?? 0} sources`,
      com_ui_web_search_details: 'Search details',
    };
    return translations[key] ?? key;
  },
}));

function source(link: string, title: string): ValidSource {
  return { link, title } as ValidSource;
}

function attachment(turn: number, organic: ValidSource[]): TAttachment {
  return {
    type: Tools.web_search,
    [Tools.web_search]: { turn, organic } as SearchResultData,
  } as unknown as TAttachment;
}

describe('WebSearch', () => {
  it('shows only the turn its attachments own', () => {
    render(
      <WebSearch
        initialProgress={1}
        isSubmitting={false}
        attachments={[attachment(0, [source('https://pi.example.com/1', 'Pi')])]}
        searchResults={{
          1: { turn: 1, organic: [source('https://other.example.com/1', 'Other')] },
        }}
        renderFavicon={({ domain }) => <span data-testid="favicon">{domain}</span>}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Searched the web/ }));
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://pi.example.com/1');
    expect(screen.queryByRole('link', { name: /Other/ })).not.toBeInTheDocument();
  });

  it('renders nothing for a legacy search error when no failure card is supplied', () => {
    const { container } = render(
      <WebSearch
        initialProgress={1}
        isSubmitting={false}
        output="Error processing search results"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('asks the host to render a failed call for schema feedback', () => {
    const renderFailedCall = jest.fn(() => <div data-testid="failed-call" />);
    render(
      <WebSearch
        initialProgress={1}
        isSubmitting={false}
        args={{ query: 'x' }}
        output={'Error: Invalid search arguments\n Please fix your mistakes.'}
        runStepStatus="completed"
        renderFailedCall={renderFailedCall}
      />,
    );
    expect(renderFailedCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: Tools.web_search,
        output: expect.stringContaining('Error:'),
      }),
    );
    expect(screen.getByTestId('failed-call')).toBeInTheDocument();
  });

  it('draws streaming icons through the host and keeps the globe', () => {
    render(
      <WebSearch
        initialProgress={0.5}
        isSubmitting
        isLast
        attachments={[attachment(0, [source('https://a.com', 'A')])]}
        renderStackedFavicons={({ sources }) => <span data-testid="stacked">{sources.length}</span>}
      />,
    );
    expect(screen.getByTestId('stacked')).toHaveTextContent('1');
  });

  it('moves details into the header slot a generated title provides', () => {
    const slot = document.createElement('span');
    document.body.appendChild(slot);
    render(
      <GeneratedToolLabelContext.Provider value>
        <WebSearch
          initialProgress={1}
          isSubmitting={false}
          args={{ query: 'example' }}
          attachments={[attachment(0, [source('https://example.com', 'Example')])]}
          headerSlot={slot}
        />
      </GeneratedToolLabelContext.Provider>,
    );
    const details = screen.getByRole('button', { name: 'Search details' });
    expect(slot).toContainElement(details);
    expect(details).not.toHaveClass('opacity-0');
    slot.remove();
  });
});
