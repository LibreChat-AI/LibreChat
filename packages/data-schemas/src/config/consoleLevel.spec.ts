import { logLevels, resolveConsoleLevel } from './utils';

describe('resolveConsoleLevel', () => {
  const original = process.env.CONSOLE_LOG_LEVEL;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    if (original === undefined) {
      delete process.env.CONSOLE_LOG_LEVEL;
      return;
    }
    process.env.CONSOLE_LOG_LEVEL = original;
  });

  it('defaults to info and stays audible when unset', () => {
    delete process.env.CONSOLE_LOG_LEVEL;
    expect(resolveConsoleLevel()).toEqual({ level: 'info', silent: false });
  });

  it('treats an empty or whitespace-only value as unset', () => {
    process.env.CONSOLE_LOG_LEVEL = '   ';
    expect(resolveConsoleLevel()).toEqual({ level: 'info', silent: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts every level the loggers are built with', () => {
    for (const name of Object.keys(logLevels)) {
      process.env.CONSOLE_LOG_LEVEL = name;
      expect(resolveConsoleLevel()).toEqual({ level: name, silent: false });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalizes casing and surrounding whitespace', () => {
    process.env.CONSOLE_LOG_LEVEL = '  WARN ';
    expect(resolveConsoleLevel()).toEqual({ level: 'warn', silent: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('silences the transport without emitting an invalid winston level', () => {
    process.env.CONSOLE_LOG_LEVEL = 'silent';
    const { level, silent } = resolveConsoleLevel();
    expect(silent).toBe(true);
    expect(level).toBe('info');
  });

  it('keeps a caller-supplied fallback when silenced', () => {
    process.env.CONSOLE_LOG_LEVEL = 'silent';
    expect(resolveConsoleLevel('error')).toEqual({ level: 'error', silent: true });
  });

  it('falls back and warns on an unknown level rather than muting every log', () => {
    process.env.CONSOLE_LOG_LEVEL = 'warning';
    expect(resolveConsoleLevel()).toEqual({ level: 'info', silent: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('warning'));
  });

  it('does not treat an inherited Object property as a level', () => {
    process.env.CONSOLE_LOG_LEVEL = 'constructor';
    expect(resolveConsoleLevel()).toEqual({ level: 'info', silent: false });
    expect(warn).toHaveBeenCalled();
  });
});
