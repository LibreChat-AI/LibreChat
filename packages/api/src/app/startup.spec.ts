import { areStartupTasksDisabled, startupTasksDisabledWarning } from './startup';

describe('areStartupTasksDisabled', () => {
  const originalValue = process.env.DISABLE_STARTUP_TASKS;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.DISABLE_STARTUP_TASKS;
      return;
    }
    process.env.DISABLE_STARTUP_TASKS = originalValue;
  });

  it('reports disabled when the flag holds an enabled value', () => {
    process.env.DISABLE_STARTUP_TASKS = 'true';
    expect(areStartupTasksDisabled()).toBe(true);
  });

  it('reports enabled when the flag is absent', () => {
    delete process.env.DISABLE_STARTUP_TASKS;
    expect(areStartupTasksDisabled()).toBe(false);
  });

  it('reports enabled when the flag is empty', () => {
    process.env.DISABLE_STARTUP_TASKS = '';
    expect(areStartupTasksDisabled()).toBe(false);
  });

  it('reports enabled when the flag holds a disabled value', () => {
    process.env.DISABLE_STARTUP_TASKS = 'false';
    expect(areStartupTasksDisabled()).toBe(false);
  });

  it('reflects the current environment on each call rather than the value at module load', () => {
    delete process.env.DISABLE_STARTUP_TASKS;
    expect(areStartupTasksDisabled()).toBe(false);

    process.env.DISABLE_STARTUP_TASKS = 'true';
    expect(areStartupTasksDisabled()).toBe(true);

    process.env.DISABLE_STARTUP_TASKS = 'false';
    expect(areStartupTasksDisabled()).toBe(false);
  });
});

describe('startupTasksDisabledWarning', () => {
  it('names every category of suppressed startup work', () => {
    expect(startupTasksDisabledWarning).toMatch(/seeding/i);
    expect(startupTasksDisabledWarning).toMatch(/permission derivation from librechat\.yaml/i);
    expect(startupTasksDisabledWarning).toMatch(/migration checks/i);
    expect(startupTasksDisabledWarning).toMatch(/file sweeps/i);
    expect(startupTasksDisabledWarning).toMatch(/skill sync/i);
    expect(startupTasksDisabledWarning).toMatch(/search indexing/i);
    expect(startupTasksDisabledWarning).toMatch(/MCP initialization/i);
  });

  it('states the container must not be run as a single-container deployment', () => {
    expect(startupTasksDisabledWarning).toMatch(/single-container deployment/i);
  });

  it('is a single line', () => {
    expect(startupTasksDisabledWarning).not.toContain('\n');
  });
});
