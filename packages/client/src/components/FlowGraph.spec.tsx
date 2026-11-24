import { render, screen } from '@testing-library/react';
import { FlowGraph, layoutFlow } from './FlowGraph';

describe('layoutFlow', () => {
  it('puts each node one column past its furthest source', () => {
    const layout = layoutFlow(
      ['plan', 'research', 'critique', 'write'],
      [
        { from: 'plan', to: ['research', 'critique'] },
        { from: ['research', 'critique'], to: 'write' },
      ],
    );

    expect(layout.columns).toEqual([['plan'], ['research', 'critique'], ['write']]);
    expect(layout.links).toHaveLength(4);
  });

  it('keeps a node behind its longest path, not its shortest', () => {
    const layout = layoutFlow(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
      ],
    );

    expect(layout.columns).toEqual([['a'], ['b'], ['c']]);
  });

  it('stacks members that nothing connects yet in the first column', () => {
    expect(layoutFlow(['a', 'b', 'c'], []).columns).toEqual([['a', 'b', 'c']]);
  });

  it('still shows nodes a draft has tied in a loop, and drops connections to unknown nodes', () => {
    const layout = layoutFlow(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b' },
        { from: 'a', to: 'gone' },
        { from: 'a', to: 'a' },
      ],
    );

    expect(layout.columns).toEqual([['a'], ['b', 'c']]);
    expect(layout.links).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'b' },
    ]);
  });
});

describe('FlowGraph', () => {
  const nodes = [
    { id: 'plan', label: 'Planner' },
    { id: 'write', label: 'Writer' },
  ];
  const edges = [{ from: 'plan', to: 'write' }];

  it('is one labelled image holding every node name and one line per connection', () => {
    const { container } = render(
      <FlowGraph nodes={nodes} edges={edges} entry="plan" result="write" label="Review team" />,
    );

    const image = screen.getByRole('img', { name: 'Review team' });
    expect(image).toHaveTextContent('Planner');
    expect(image).toHaveTextContent('Writer');
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelectorAll('[data-flow-result]')).toHaveLength(1);
  });

  it('draws dots without names at the small size', () => {
    render(<FlowGraph nodes={nodes} edges={edges} size="sm" label="Review team" />);

    expect(screen.getByRole('img', { name: 'Review team' })).toHaveTextContent('');
  });

  it('renders nothing for a team with no members', () => {
    const { container } = render(<FlowGraph nodes={[]} edges={[]} label="Empty" />);

    expect(container).toBeEmptyDOMElement();
  });
});
