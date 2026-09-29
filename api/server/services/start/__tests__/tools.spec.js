const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAndFormatTools } = require('../tools');

describe('loadAndFormatTools', () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-tools-'));
    const toolPath = require.resolve('@librechat/agents/langchain/tools');
    fs.writeFileSync(
      path.join(directory, 'Example.js'),
      `const { Tool } = require(${JSON.stringify(toolPath)});
      module.exports = class extends Tool {
        constructor() {
          super();
          this.name = 'example';
          this.description = 'Example tool';
        }
        async _call() { return 'example'; }
      };`,
    );
    for (const file of ['Example.spec.js', 'Example.test.js']) {
      fs.writeFileSync(
        path.join(directory, file),
        `require('fs').writeFileSync(${JSON.stringify(path.join(directory, `${file}.loaded`))}, 'loaded');
        throw new Error('Test module must not execute during tool discovery');`,
      );
    }
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { adminIncluded: [] },
    { adminIncluded: ['Example.js', 'Example.spec.js', 'Example.test.js'] },
  ])(
    'skips test modules before execution with includedTools=$adminIncluded',
    ({ adminIncluded }) => {
      const tools = loadAndFormatTools({ directory, adminIncluded });

      expect(tools.example.function.name).toBe('example');
      expect(fs.existsSync(path.join(directory, 'Example.spec.js.loaded'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'Example.test.js.loaded'))).toBe(false);
    },
  );
});
