/* eslint-disable i18next/no-literal-string */
import { RecoilRoot } from 'recoil';
import { render, fireEvent } from '@testing-library/react';
import Button from '../Button';

const renderWithRecoil = (ui: React.ReactElement) => render(<RecoilRoot>{ui}</RecoilRoot>);

describe('Button', () => {
  it('renders with the correct type and children', () => {
    const { getByTestId, getByText } = renderWithRecoil(
      <Button
        type="regenerate"
        onClick={() => {
          ('');
        }}
      >
        Regenerate
      </Button>,
    );
    expect(getByTestId('regenerate-generation-button')).toBeInTheDocument();
    expect(getByText('Regenerate')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const handleClick = jest.fn();
    const { getByText } = renderWithRecoil(
      <Button type="continue" onClick={handleClick}>
        Continue
      </Button>,
    );
    fireEvent.click(getByText('Continue'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
