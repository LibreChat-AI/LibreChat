import { render, screen } from '@testing-library/react';
import { FlowGraph, describeFlow, layoutFlow } from './FlowGraph';

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

  it('bows a connection that skips a column over the nodes it passes', () => {
    const { container } = render(
      <FlowGraph
        nodes={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ]}
        edges={[
          { from: 'a', to: 'b' },
          { from: ['a', 'b'], to: 'c' },
        ]}
        label="Team"
      />,
    );
    const nodeTops = [...container.querySelectorAll<HTMLElement>('[title]')].map((node) =>
      parseFloat(node.style.top),
    );
    const lowestLine = (d: string) =>
      Math.min(
        ...[...d.matchAll(/[ ,ML]?(-?[\d.]+) (-?[\d.]+)/g)].map((match) => Number(match[2])),
      );
    const paths = [...container.querySelectorAll('path')].map(
      (path) => path.getAttribute('d') ?? '',
    );

    expect(paths).toHaveLength(3);
    /** Exactly one line, A to C, rises above the row of nodes. */
    expect(paths.filter((d) => lowestLine(d) < Math.min(...nodeTops))).toHaveLength(1);
  });

  it('reads its order aloud through the description', () => {
    const team = [
      { id: 'plan', label: 'Planner' },
      { id: 'research', label: 'Researcher' },
      { id: 'critique', label: 'Critic' },
      { id: 'write', label: 'Writer' },
    ];
    const connections = [
      { from: 'plan', to: ['research', 'critique'] },
      { from: ['research', 'critique'], to: 'write' },
    ];
    const description = describeFlow(team, connections, 'then');

    expect(description).toBe('Planner; then Researcher, Critic; then Writer');
    render(<FlowGraph nodes={team} edges={connections} label="Review" description={description} />);
    expect(screen.getByRole('img', { name: 'Review' })).toHaveAccessibleDescription(description);
  });

  it('renders nothing for a team with no members', () => {
    const { container } = render(<FlowGraph nodes={[]} edges={[]} label="Empty" />);

    expect(container).toBeEmptyDOMElement();
  });
});
