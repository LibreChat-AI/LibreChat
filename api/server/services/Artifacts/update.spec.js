const {
  ARTIFACT_START,
  ARTIFACT_END,
  findAllArtifacts,
  replaceArtifactContent,
} = require('./update');

const createArtifactText = (options = {}) => {
  const { content = '', wrapCode = true, isClosed = true, prefix = '', suffix = '' } = options;

  const codeBlock = wrapCode ? '```\n' + content + '\n```' : content;
  const end = isClosed ? `\n${ARTIFACT_END}` : '';

  return `${ARTIFACT_START}${prefix}\n${codeBlock}${end}${suffix}`;
};

describe('findAllArtifacts', () => {
  test('should return empty array for message with no artifacts', () => {
    const message = {
      content: [
        {
          type: 'text',
          text: 'No artifacts here',
        },
      ],
    };
    expect(findAllArtifacts(message)).toEqual([]);
  });

  test('should find artifacts in content parts', () => {
    const message = {
      content: [
        { type: 'text', text: createArtifactText({ content: 'content1' }) },
        { type: 'text', text: createArtifactText({ content: 'content2' }) },
      ],
    };

    const result = findAllArtifacts(message);
    expect(result).toHaveLength(2);
    expect(result[0].source).toBe('content');
    expect(result[1].partIndex).toBe(1);
  });

  test('should find artifacts in message.text when content is empty', () => {
    const artifact1 = createArtifactText({ content: 'text1' });
    const artifact2 = createArtifactText({ content: 'text2' });
    const message = { text: [artifact1, artifact2].join('\n') };

    const result = findAllArtifacts(message);
    expect(result).toHaveLength(2);
    expect(result[0].source).toBe('text');
  });

  test('should handle unclosed artifacts', () => {
    const message = {
      text: createArtifactText({ content: 'unclosed', isClosed: false }),
    };
    const result = findAllArtifacts(message);
    expect(result[0].end).toBe(message.text.length);
  });

  test('should handle multiple artifacts in single part', () => {
    const artifact1 = createArtifactText({ content: 'first' });
    const artifact2 = createArtifactText({ content: 'second' });
    const message = {
      content: [
        {
          type: 'text',
          text: [artifact1, artifact2].join('\n'),
        },
      ],
    };

    const result = findAllArtifacts(message);
    expect(result).toHaveLength(2);
    expect(result[1].start).toBeGreaterThan(result[0].end);
  });

  test('should ignore artifact close markers inside fenced content', () => {
    const content = 'before\n:::\nafter';
    const artifactText = `${ARTIFACT_START}{identifier="markdown" type="text/markdown" title="Markdown"}
\`\`\`markdown
${content}
\`\`\`
${ARTIFACT_END}`;
    const message = { text: `${artifactText}\ntrailer` };

    const result = findAllArtifacts(message);

    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(artifactText.length);
  });

  test('should allow trailing text after an artifact close marker', () => {
    const artifactText = `${ARTIFACT_START}{identifier="plain" type="text/plain" title="Plain"}
content
${ARTIFACT_END}Thanks for reading`;
    const message = { text: `${artifactText}\n${createArtifactText({ content: 'next' })}` };

    const result = findAllArtifacts(message);

    expect(result).toHaveLength(2);
    expect(message.text.slice(result[0].end, result[0].end + 18)).toBe('Thanks for reading');
  });

  test('should not end an unclosed artifact at an internal marker in a closed fence', () => {
    const artifactText = `${ARTIFACT_START}{identifier="markdown" type="text/markdown" title="Markdown"}
\`\`\`markdown
before
:::
after
\`\`\`
trailer`;
    const message = { text: artifactText };

    const result = findAllArtifacts(message);

    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(artifactText.length);
  });

  test('should keep artifact start markers inside fenced content', () => {
    const artifactText = `${ARTIFACT_START}{identifier="markdown" type="text/markdown" title="Markdown"}
\`\`\`markdown
before
:::
:::artifact{identifier="sample" type="text/plain" title="Sample"}
after
\`\`\`
${ARTIFACT_END}`;
    const message = { text: artifactText };

    const result = findAllArtifacts(message);

    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(artifactText.length);
  });

  test('should preserve markdown artifacts wrapped in longer fences with internal code blocks', () => {
    const content = `# Title

\`\`\`bash
echo one
\`\`\`
Text between sections.
## Section B
\`\`\`bash
echo two
\`\`\``;
    const artifactText = `${ARTIFACT_START}{identifier="git-cheatsheet" type="text/markdown" title="Git Cheatsheet"}
\`\`\`\`markdown
${content}
\`\`\`\`
${ARTIFACT_END}`;
    const message = { text: `${artifactText}\ntrailer` };

    const result = findAllArtifacts(message);

    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(artifactText.length);
  });

  test('should preserve the first fallback close in an unclosed fence', () => {
    const firstArtifact = `${ARTIFACT_START}{identifier="first" type="text/html" title="First"}
\`\`\`html
<div>first</div>
${ARTIFACT_END}`;
    const secondArtifact = createArtifactText({
      content: '<div>second</div>',
      wrapCode: false,
      prefix: '{identifier="second" type="text/html" title="Second"}',
    });
    const message = { text: `${firstArtifact}\n${secondArtifact}` };

    const result = findAllArtifacts(message);

    expect(result).toHaveLength(2);
    expect(result[0].end).toBe(firstArtifact.length);
    expect(result[1].start).toBe(firstArtifact.length + 1);
  });
});

describe('replaceArtifactContent', () => {
  const createTestArtifact = (content, options) => {
    const text = createArtifactText({ content, ...options });
    return {
      start: 0,
      end: text.length,
      text,
      source: 'text',
    };
  };

  test('should replace content within artifact boundaries', () => {
    const original = "console.log('hello')";
    const artifact = createTestArtifact(original);
    const updated = "console.log('updated')";

    const result = replaceArtifactContent(artifact.text, artifact, original, updated);
    expect(result).toContain(updated);
    expect(result).toMatch(ARTIFACT_START);
    expect(result).toMatch(ARTIFACT_END);
  });

  test('should return null when original not found', () => {
    const artifact = createTestArtifact('function test() {}');
    const result = replaceArtifactContent(artifact.text, artifact, 'missing', 'updated');
    expect(result).toBeNull();
  });

  test('should handle dedented content', () => {
    const original = 'function test() {';
    const artifact = createTestArtifact(original);
    const updated = 'function updated() {';

    const result = replaceArtifactContent(artifact.text, artifact, original, updated);
    expect(result).toContain(updated);
  });

  test('should preserve text outside artifact', () => {
    const artifactContent = createArtifactText({ content: 'original' });
    const fullText = `prefix\n${artifactContent}\nsuffix`;
    const artifact = createTestArtifact('original', {
      prefix: 'prefix\n',
      suffix: '\nsuffix',
    });

    const result = replaceArtifactContent(fullText, artifact, 'original', 'updated');
    expect(result).toMatch(/^prefix/);
    expect(result).toMatch(/suffix$/);
  });

  test('should handle replacement at artifact boundaries', () => {
    const original = 'console.log("hello")';
    const updated = 'console.log("updated")';

    const artifactText = `${ARTIFACT_START}\n${original}\n${ARTIFACT_END}`;
    const artifact = {
      start: 0,
      end: artifactText.length,
      text: artifactText,
      source: 'text',
    };

    const result = replaceArtifactContent(artifactText, artifact, original, updated);

    expect(result).toBe(`${ARTIFACT_START}\n${updated}\n${ARTIFACT_END}`);
  });

  test('should replace markdown artifacts with internal code fences', () => {
    const original = `# Notes

\`\`\`js
console.log('inside');
\`\`\`

Done`;
    const updated = original.replace('Done', 'Updated');
    const artifactText = `${ARTIFACT_START}{identifier="notes" type="text/markdown" title="Notes"}
${original}
${ARTIFACT_END}`;
    const message = { text: artifactText };
    const artifacts = findAllArtifacts(message);

    const result = replaceArtifactContent(artifactText, artifacts[0], original, updated);

    expect(result).not.toBeNull();
    expect(result).toContain('Updated');
    expect(result).toContain("console.log('inside');");
  });

  test('should replace markdown artifacts wrapped in longer fences with internal code blocks', () => {
    const original = `# Notes

\`\`\`bash
echo one
\`\`\`

## More
\`\`\`bash
echo two
\`\`\``;
    const updated = original.replace('## More', '## Updated');
    const artifactText = `${ARTIFACT_START}{identifier="notes" type="text/markdown" title="Notes"}
\`\`\`\`markdown
${original}
\`\`\`\`
${ARTIFACT_END}`;
    const message = { text: artifactText };
    const artifacts = findAllArtifacts(message);

    const result = replaceArtifactContent(artifactText, artifacts[0], original, updated);

    expect(result).not.toBeNull();
    expect(result).toContain('## Updated');
    expect(result).toContain('```bash');
    expect(result).toContain('````markdown');
  });

  test('should normalize editor trailing newlines before longer closing fences', () => {
    const original = '# Notes';
    const artifactText = `${ARTIFACT_START}{identifier="notes" type="text/markdown" title="Notes"}
\`\`\`\`markdown
${original}
\`\`\`\`
${ARTIFACT_END}`;
    const message = { text: artifactText };
    const artifacts = findAllArtifacts(message);

    const result = replaceArtifactContent(artifactText, artifacts[0], original, `${original}\n`);

    expect(result).toBe(artifactText);
  });

  test('should replace unclosed artifacts with internal markers in fenced content', () => {
    const original = `before
\`\`\`markdown
inside
:::
still inside
\`\`\`
after`;
    const artifactText = `${ARTIFACT_START}{identifier="notes" type="text/markdown" title="Notes"}
${original}`;
    const message = { text: artifactText };
    const artifacts = findAllArtifacts(message);
    const updated = original.replace('after', 'updated');

    const result = replaceArtifactContent(artifactText, artifacts[0], original, updated);

    expect(result).not.toBeNull();
    expect(result).toContain('updated');
    expect(result).toContain(':::');
  });
});

describe('replaceArtifactContent with shared text', () => {
  test('should replace correct artifact when text is shared', () => {
    const artifactContent = '    hi    '; // Preserve exact spacing
    const sharedText = `LOREM IPSUM

:::artifact{identifier="calculator" type="application/vnd.react" title="Calculator"}
\`\`\`
${artifactContent}
\`\`\`
:::

LOREM IPSUM

:::artifact{identifier="calculator2" type="application/vnd.react" title="Calculator"}
\`\`\`
${artifactContent}
\`\`\`
:::`;

    const message = { text: sharedText };
    const artifacts = findAllArtifacts(message);
    expect(artifacts).toHaveLength(2);

    const targetArtifact = artifacts[1];
    const updatedContent = '    updated content    ';
    const result = replaceArtifactContent(
      sharedText,
      targetArtifact,
      artifactContent,
      updatedContent,
    );

    // Verify exact matches with preserved formatting
    expect(result).toContain(artifactContent); // First artifact unchanged
    expect(result).toContain(updatedContent); // Second artifact updated
    expect(result.indexOf(updatedContent)).toBeGreaterThan(result.indexOf(artifactContent));
  });

  const codeExample = `
function greetPerson(name) {
  return \`Hello, \${name}! Welcome to JavaScript programming.\`;
}

const personName = "Alice";
const greeting = greetPerson(personName);
console.log(greeting);`;

  test('should handle random number of artifacts in content array', () => {
    const numArtifacts = 5; // Fixed number for predictability
    const targetIndex = 2; // Fixed target for predictability

    // Create content array with multiple parts
    const contentParts = Array.from({ length: numArtifacts }, (_, i) => ({
      type: 'text',
      text: createArtifactText({
        content: `content-${i}`,
        wrapCode: true,
        prefix: i > 0 ? '\n' : '',
      }),
    }));

    const message = { content: contentParts };
    const artifacts = findAllArtifacts(message);
    expect(artifacts).toHaveLength(numArtifacts);

    const targetArtifact = artifacts[targetIndex];
    const originalContent = `content-${targetIndex}`;
    const updatedContent = 'updated-content';

    const result = replaceArtifactContent(
      contentParts[targetIndex].text,
      targetArtifact,
      originalContent,
      updatedContent,
    );

    // Verify the specific content was updated
    expect(result).toContain(updatedContent);
    expect(result).not.toContain(originalContent);
    expect(result).toMatch(
      new RegExp(`${ARTIFACT_START}.*${updatedContent}.*${ARTIFACT_END}`, 's'),
    );
  });

  test('should handle artifacts with identical content but different metadata in content array', () => {
    const contentParts = [
      {
        type: 'text',
        text: createArtifactText({
          wrapCode: true,
          content: codeExample,
          prefix: '{id="1", title="First"}',
        }),
      },
      {
        type: 'text',
        text: createArtifactText({
          wrapCode: true,
          content: codeExample,
          prefix: '{id="2", title="Second"}',
        }),
      },
    ];

    const message = { content: contentParts };
    const artifacts = findAllArtifacts(message);

    // Target second artifact
    const targetArtifact = artifacts[1];
    const result = replaceArtifactContent(
      contentParts[1].text,
      targetArtifact,
      codeExample,
      'updated content',
    );
    expect(result).toMatch(/id="2".*updated content/s);
    expect(result).toMatch(new RegExp(`${ARTIFACT_START}.*updated content.*${ARTIFACT_END}`, 's'));
  });

  test('should handle empty content in artifact without code blocks', () => {
    const artifactText = `${ARTIFACT_START}\n\n${ARTIFACT_END}`;
    const artifact = {
      start: 0,
      end: artifactText.length,
      text: artifactText,
      source: 'text',
    };

    const result = replaceArtifactContent(artifactText, artifact, '', 'new content');
    expect(result).toBe(`${ARTIFACT_START}\nnew content\n${ARTIFACT_END}`);
  });

  test('should handle empty content in artifact with code blocks', () => {
    const artifactText = createArtifactText({ content: '' });
    const artifact = {
      start: 0,
      end: artifactText.length,
      text: artifactText,
      source: 'text',
    };

    const result = replaceArtifactContent(artifactText, artifact, '', 'new content');
    expect(result).toMatch(/```\nnew content\n```/);
  });

  test('should handle content with trailing newline in code blocks', () => {
    const contentWithNewline = 'console.log("test")\n';
    const message = {
      text: `Some prefix text\n${createArtifactText({
        content: contentWithNewline,
      })}\nSome suffix text`,
    };

    const artifacts = findAllArtifacts(message);
    expect(artifacts).toHaveLength(1);

    const result = replaceArtifactContent(
      message.text,
      artifacts[0],
      contentWithNewline,
      'updated content',
    );

    // Should update the content and preserve artifact structure
    expect(result).toContain('```\nupdated content\n```');
    // Should preserve surrounding text
    expect(result).toMatch(/^Some prefix text\n/);
    expect(result).toMatch(/\nSome suffix text$/);
    // Should not have extra newlines
    expect(result).not.toContain('\n\n```');
    expect(result).not.toContain('```\n\n');
  });

  describe('incomplete artifacts', () => {
    test('should handle incomplete artifacts (missing closing ::: and ```)', () => {
      const original = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pomodoro</title>
<meta name="description" content="A single-file Pomodoro timer with logs, charts, sounds, and dark mode." />
<style>
  :root{`;

      const prefix = `Awesome idea! I'll deliver a complete single-file HTML app called "Pomodoro" with:
- Custom session/break durations

You can save this as pomodoro.html and open it directly in your browser.

`;

      // This simulates the real incomplete artifact case - no closing ``` or :::
      const incompleteArtifact = `${ARTIFACT_START}{identifier="pomodoro-single-file-app" type="text/html" title="Pomodoro — Single File App"}
\`\`\`
${original}`;

      const fullText = prefix + incompleteArtifact;
      const message = { text: fullText };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].end).toBe(fullText.length);

      const updated = original.replace('Pomodoro</title>', 'Pomodoro</title>UPDATED');
      const result = replaceArtifactContent(fullText, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain('UPDATED');
      expect(result).toContain(prefix);
      // Should not have added closing markers
      expect(result).not.toMatch(/:::\s*$/);
    });

    test('should handle incomplete artifacts with only opening code block', () => {
      const original = 'function hello() { console.log("world"); }';
      const incompleteArtifact = `${ARTIFACT_START}{id="test"}\n\`\`\`\n${original}`;

      const message = { text: incompleteArtifact };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);

      const updated = 'function hello() { console.log("UPDATED"); }';
      const result = replaceArtifactContent(incompleteArtifact, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain('UPDATED');
    });

    test('should handle complete artifact marker with unclosed wrapping code block', () => {
      const original = '# Markdown document\n\n```js\nconsole.log("missing closing fence");';
      const artifactText = `${ARTIFACT_START}{identifier="doc" type="text/markdown" title="Doc"}
\`\`\`markdown
${original}
${ARTIFACT_END}`;
      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].end).toBe(artifactText.length);

      const updated = original.replace('Markdown document', 'Updated document');
      const result = replaceArtifactContent(artifactText, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain('Updated document');
      expect(result).toContain(ARTIFACT_END);
    });

    test('should handle incomplete artifacts without code blocks', () => {
      const original = 'Some plain text content';
      const incompleteArtifact = `${ARTIFACT_START}{id="test"}\n${original}`;

      const message = { text: incompleteArtifact };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);

      const updated = 'Some UPDATED text content';
      const result = replaceArtifactContent(incompleteArtifact, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain('UPDATED');
    });
  });

  describe('regression tests for edge cases', () => {
    test('should still handle complete artifacts correctly', () => {
      // Ensure we didn't break normal artifact handling
      const original = 'console.log("test");';
      const artifact = createArtifactText({ content: original });

      const message = { text: artifact };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);

      const updated = 'console.log("updated");';
      const result = replaceArtifactContent(artifact, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain(updated);
      expect(result).toContain(ARTIFACT_END);
      expect(result).toMatch(/```\nconsole\.log\("updated"\);\n```/);
    });

    test('should handle multiple complete artifacts', () => {
      // Ensure multiple artifacts still work
      const content1 = 'First artifact';
      const content2 = 'Second artifact';
      const text = `${createArtifactText({ content: content1 })}\n\n${createArtifactText({ content: content2 })}`;

      const message = { text };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(2);

      // Update first artifact
      const result1 = replaceArtifactContent(text, artifacts[0], content1, 'First UPDATED');
      expect(result1).not.toBeNull();
      expect(result1).toContain('First UPDATED');
      expect(result1).toContain(content2);

      // Update second artifact
      const result2 = replaceArtifactContent(text, artifacts[1], content2, 'Second UPDATED');
      expect(result2).not.toBeNull();
      expect(result2).toContain(content1);
      expect(result2).toContain('Second UPDATED');
    });

    test('should not mistake ::: at position 0 for artifact end in complete artifacts', () => {
      // This tests the specific fix - ensuring contentEnd=0 doesn't break complete artifacts
      const original = 'test content';
      // Create an artifact that will have ::: at position 0 when substring'd
      const artifact = `${ARTIFACT_START}\n\`\`\`\n${original}\n\`\`\`\n${ARTIFACT_END}`;

      const message = { text: artifact };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);

      const updated = 'updated content';
      const result = replaceArtifactContent(artifact, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain(updated);
      expect(result).toContain(ARTIFACT_END);
    });

    test('should handle empty artifacts', () => {
      // Edge case: empty artifact
      const artifact = `${ARTIFACT_START}\n${ARTIFACT_END}`;

      const message = { text: artifact };
      const artifacts = findAllArtifacts(message);

      expect(artifacts).toHaveLength(1);

      // Trying to replace non-existent content should return null
      const result = replaceArtifactContent(artifact, artifacts[0], 'something', 'updated');
      expect(result).toBeNull();
    });

    test('should preserve whitespace and formatting in complete artifacts', () => {
      const original = `  function test() {
    return {
      value: 42
    };
  }`;
      const artifact = createArtifactText({ content: original });

      const message = { text: artifact };
      const artifacts = findAllArtifacts(message);

      const updated = `  function test() {
    return {
      value: 100
    };
  }`;
      const result = replaceArtifactContent(artifact, artifacts[0], original, updated);

      expect(result).not.toBeNull();
      expect(result).toContain('value: 100');
      // Should preserve exact formatting
      expect(result).toMatch(
        /```\n {2}function test\(\) \{\n {4}return \{\n {6}value: 100\n {4}\};\n {2}\}\n```/,
      );
    });

    test('should handle code blocks with language identifiers (```svg, ```html, etc.)', () => {
      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" fill="#4A90A4"/>
  <rect x="50" y="50" width="100" height="100" fill="#FFFFFF"/>
</svg>`;

      /** Artifact with language identifier in code block */
      const artifactText = `${ARTIFACT_START}{identifier="test-svg" type="image/svg+xml" title="Test SVG"}
\`\`\`svg
${svgContent}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);
      expect(artifacts).toHaveLength(1);

      const updatedSvg = svgContent.replace('#FFFFFF', '#131313');
      const result = replaceArtifactContent(artifactText, artifacts[0], svgContent, updatedSvg);

      expect(result).not.toBeNull();
      expect(result).toContain('#131313');
      expect(result).not.toContain('#FFFFFF');
      expect(result).toMatch(/```svg\n/);
    });

    test('should handle code blocks with complex language identifiers', () => {
      const htmlContent = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>Hello</body>
</html>`;

      const artifactText = `${ARTIFACT_START}{identifier="test-html" type="text/html" title="Test HTML"}
\`\`\`html
${htmlContent}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const updatedHtml = htmlContent.replace('Hello', 'Updated');
      const result = replaceArtifactContent(artifactText, artifacts[0], htmlContent, updatedHtml);

      expect(result).not.toBeNull();
      expect(result).toContain('Updated');
      expect(result).toMatch(/```html\n/);
    });
  });

  describe('code block edge cases', () => {
    test('should handle code block without language identifier (```\\n)', () => {
      const content = 'const x = 1;\nconst y = 2;';
      const artifactText = `${ARTIFACT_START}{identifier="test" type="text/plain" title="Test"}
\`\`\`
${content}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const result = replaceArtifactContent(artifactText, artifacts[0], content, 'updated');

      expect(result).not.toBeNull();
      expect(result).toContain('updated');
      expect(result).toMatch(/```\nupdated\n```/);
    });

    test('should handle various language identifiers', () => {
      const languages = [
        'javascript',
        'typescript',
        'python',
        'jsx',
        'tsx',
        'css',
        'json',
        'xml',
        'markdown',
        'md',
      ];

      for (const lang of languages) {
        const content = `test content for ${lang}`;
        const artifactText = `${ARTIFACT_START}{identifier="test-${lang}" type="text/plain" title="Test"}
\`\`\`${lang}
${content}
\`\`\`
${ARTIFACT_END}`;

        const message = { text: artifactText };
        const artifacts = findAllArtifacts(message);
        expect(artifacts).toHaveLength(1);

        const result = replaceArtifactContent(artifactText, artifacts[0], content, 'updated');

        expect(result).not.toBeNull();
        expect(result).toContain('updated');
        expect(result).toMatch(new RegExp(`\`\`\`${lang}\\n`));
      }
    });

    test('should handle single character language identifier', () => {
      const content = 'single char lang';
      const artifactText = `${ARTIFACT_START}{identifier="test" type="text/plain" title="Test"}
\`\`\`r
${content}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const result = replaceArtifactContent(artifactText, artifacts[0], content, 'updated');

      expect(result).not.toBeNull();
      expect(result).toContain('updated');
      expect(result).toMatch(/```r\n/);
    });

    test('should handle code block with content that looks like code fence', () => {
      const content = 'Line 1\nSome text with ``` backticks in middle\nLine 3';
      const artifactText = `${ARTIFACT_START}{identifier="test" type="text/plain" title="Test"}
\`\`\`text
${content}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const result = replaceArtifactContent(artifactText, artifacts[0], content, 'updated');

      expect(result).not.toBeNull();
      expect(result).toContain('updated');
    });

    test('should handle code block with trailing whitespace in language line', () => {
      const content = 'whitespace test';
      /** Note: trailing spaces after 'python' */
      const artifactText = `${ARTIFACT_START}{identifier="test" type="text/plain" title="Test"}
\`\`\`python   
${content}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const result = replaceArtifactContent(artifactText, artifacts[0], content, 'updated');

      expect(result).not.toBeNull();
      expect(result).toContain('updated');
    });

    test('should handle react/jsx content with complex syntax', () => {
      const jsxContent = `function App() {
  const [count, setCount] = useState(0);
  return (
    <div className="app">
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(c => c + 1)}>
        Increment
      </button>
    </div>
  );
}`;

      const artifactText = `${ARTIFACT_START}{identifier="react-app" type="application/vnd.react" title="React App"}
\`\`\`jsx
${jsxContent}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const updatedJsx = jsxContent.replace('Increment', 'Click me');
      const result = replaceArtifactContent(artifactText, artifacts[0], jsxContent, updatedJsx);

      expect(result).not.toBeNull();
      expect(result).toContain('Click me');
      expect(result).not.toContain('Increment');
      expect(result).toMatch(/```jsx\n/);
    });

    test('should handle mermaid diagram content', () => {
      const mermaidContent = `graph TD
    A[Start] --> B{Is it?}
    B -->|Yes| C[OK]
    B -->|No| D[End]`;

      const artifactText = `${ARTIFACT_START}{identifier="diagram" type="application/vnd.mermaid" title="Flow"}
\`\`\`mermaid
${mermaidContent}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const updatedMermaid = mermaidContent.replace('Start', 'Begin');
      const result = replaceArtifactContent(
        artifactText,
        artifacts[0],
        mermaidContent,
        updatedMermaid,
      );

      expect(result).not.toBeNull();
      expect(result).toContain('Begin');
      expect(result).toMatch(/```mermaid\n/);
    });

    test('should handle artifact without code block (plain text)', () => {
      const content = 'Just plain text without code fences';
      const artifactText = `${ARTIFACT_START}{identifier="plain" type="text/plain" title="Plain"}
${content}
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const result = replaceArtifactContent(
        artifactText,
        artifacts[0],
        content,
        'updated plain text',
      );

      expect(result).not.toBeNull();
      expect(result).toContain('updated plain text');
      expect(result).not.toContain('```');
    });

    test('should handle multiline content with various newline patterns', () => {
      const content = `Line 1
Line 2

Line 4 after empty line
  Indented line
    Double indented`;

      const artifactText = `${ARTIFACT_START}{identifier="test" type="text/plain" title="Test"}
\`\`\`
${content}
\`\`\`
${ARTIFACT_END}`;

      const message = { text: artifactText };
      const artifacts = findAllArtifacts(message);

      const updated = content.replace('Line 1', 'First Line');
      const result = replaceArtifactContent(artifactText, artifacts[0], content, updated);

      expect(result).not.toBeNull();
      expect(result).toContain('First Line');
      expect(result).toContain('  Indented line');
      expect(result).toContain('    Double indented');
    });
  });
});
