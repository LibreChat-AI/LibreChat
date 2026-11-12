const UI_MODULES: string[] = [
  'react',
  'react-dom',
  'jotai',
  'recoil',
  '@tanstack/react-query',
  '@librechat/client',
];

beforeAll(() => {
  for (const name of UI_MODULES) {
    jest.doMock(
      name,
      () => {
        throw new Error(`the core entry imported ${name}`);
      },
      { virtual: true },
    );
  }
});

describe('@librechat/chat core entry', () => {
  it('runs without a DOM', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('loads without React, Jotai, Recoil, React Query or the component library', async () => {
    const core = await import('../index');
    expect(core.ContentTypes.TEXT).toBe('text');
    expect(typeof core.toUIMessage).toBe('function');
    expect(typeof core.fromUIMessage).toBe('function');
    expect(typeof core.isUIToolPart).toBe('function');
    expect(typeof core.isUIDataPart).toBe('function');
  });

  it('re-exports the data-provider message mapping unchanged', async () => {
    const core = await import('../index');
    const provider = await import('librechat-data-provider');
    expect(core.toUIMessage).toBe(provider.toUIMessage);
    expect(core.fromUIMessage).toBe(provider.fromUIMessage);
  });

  it('fails when a UI module is imported, so the guard above is live', async () => {
    await expect(import('react')).rejects.toThrow('the core entry imported react');
  });
});
