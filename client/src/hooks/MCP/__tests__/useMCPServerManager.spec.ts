import { selectInitializedMCPServer } from '../useMCPServerManager';

describe('selectInitializedMCPServer', () => {
  it('preserves selections from concurrent initialization completions', () => {
    const valuesRef = { current: [] as string[] };
    const setValues = jest.fn();

    selectInitializedMCPServer(valuesRef, setValues, 'github');
    selectInitializedMCPServer(valuesRef, setValues, 'spotify');

    expect(valuesRef.current).toEqual(['github', 'spotify']);
    expect(setValues).toHaveBeenLastCalledWith(['github', 'spotify']);
  });

  it('does not write a selection that is already present', () => {
    const valuesRef = { current: ['github'] };
    const setValues = jest.fn();

    selectInitializedMCPServer(valuesRef, setValues, 'github');

    expect(setValues).not.toHaveBeenCalled();
  });
});
