import fs from 'fs';
import path from 'path';

const stylesheet = fs.readFileSync(path.resolve(__dirname, 'parts.css'), 'utf8');

describe('shared message body typography', () => {
  it('ships the message-content rule with the published styles', () => {
    const rule = stylesheet.match(/^\.message-content \{([^}]*)\}/m);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/font-size:\s*var\(--markdown-font-size/);
    expect(body).toMatch(/line-height:\s*1\.6/);
    expect(body).toMatch(/max-width:\s*none/);
  });
});
