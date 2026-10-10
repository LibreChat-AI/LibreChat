import path from 'node:path';
import { transformSync } from '@babel/core';

describe('@librechat/chat jest transform', () => {
  it('compiles TSX to the automatic React runtime', () => {
    const output = transformSync('export const Probe = (): JSX.Element => <div />;\n', {
      filename: path.join(__dirname, 'Probe.tsx'),
      configFile: path.resolve(__dirname, '../../babel.config.js'),
    });
    expect(output?.code).toContain('react/jsx-runtime');
    expect(output?.code).not.toContain('<div');
  });
});
