import { getSubagentPrompt, readSubagentArgs } from '../prompt';

describe('readSubagentArgs', () => {
  it('reads nothing from no arguments', () => {
    expect(readSubagentArgs(undefined)).toEqual({ complete: false });
    expect(readSubagentArgs('')).toEqual({ complete: false });
  });

  it('reads a parsed object as complete', () => {
    expect(readSubagentArgs({ description: 'Review it', subagent_type: 'agent_1' })).toEqual({
      complete: true,
      prompt: 'Review it',
      subagentType: 'agent_1',
    });
  });

  it('reads whole JSON text as complete', () => {
    expect(
      readSubagentArgs('{"intent":"Reviewing","description":"Review it","subagent_type":"self"}'),
    ).toEqual({ complete: true, prompt: 'Review it', subagentType: 'self' });
  });

  it('streams the brief, decoding escapes and holding back a dangling one', () => {
    expect(readSubagentArgs('{"intent":"Reviewing","description":"Say \\"hi\\"\\nthen')).toEqual({
      complete: false,
      prompt: 'Say "hi"\nthen',
    });
    expect(readSubagentArgs('{"intent":"Reviewing","description":"Line one\\')).toEqual({
      complete: false,
      prompt: 'Line one',
    });
  });

  it('reads the type only once its value has closed', () => {
    const head = '{"intent":"Reviewing","description":"Review it","subagent_type":"agent_';
    expect(readSubagentArgs(head).subagentType).toBeUndefined();
    expect(readSubagentArgs(`${head}1"`).subagentType).toBe('agent_1');
  });

  it('does not take a key named inside the brief for the real one', () => {
    const args = '{"description":"Pass \\"subagent_type\\": \\"agent_x\\" along';
    expect(readSubagentArgs(args)).toEqual({
      complete: false,
      prompt: 'Pass "subagent_type": "agent_x" along',
    });
  });

  it('reads a brief that happens to end in a brace mid-stream as still streaming', () => {
    expect(readSubagentArgs('{"description":"Return {a: 1}')).toEqual({
      complete: false,
      prompt: 'Return {a: 1}',
    });
  });

  it('skips an empty brief while it has only whitespace', () => {
    expect(readSubagentArgs('{"description":"   ').prompt).toBeUndefined();
  });

  it('agrees with the settled reader once the arguments are whole', () => {
    const args = '{"intent":"x","task":"Do the thing","subagent_type":"self"}';
    expect(readSubagentArgs(args).prompt).toBe(getSubagentPrompt(args));
  });
});
