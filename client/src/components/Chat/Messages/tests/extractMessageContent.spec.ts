import { ContentTypes, type TMessage } from 'librechat-data-provider';
import { extractMessageContent } from '../extractMessageContent';

/** Tests build content shapes loosely; extraction must tolerate them at runtime. */
const msg = (content: unknown, text?: string): TMessage => ({ content, text }) as TMessage;

describe('extractMessageContent', () => {
  it('passes string content through unchanged', () => {
    expect(extractMessageContent(msg('plain answer'))).toBe('plain answer');
  });

  it('joins text parts', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'Hello ' },
      { type: ContentTypes.TEXT, text: 'world' },
    ];
    expect(extractMessageContent(msg(content))).toBe('Hello world');
  });

  it('excludes think parts so Read Aloud never speaks reasoning', () => {
    const content = [{ type: ContentTypes.THINK, think: 'secret internal reasoning' }];
    expect(extractMessageContent(msg(content))).toBe('');
  });

  it('speaks only the answer when reasoning precedes it', () => {
    const content = [
      { type: ContentTypes.THINK, think: 'chain of thought' },
      { type: ContentTypes.TEXT, text: 'The answer is 4.' },
    ];
    expect(extractMessageContent(msg(content))).toBe('The answer is 4.');
  });

  it('excludes think parts whose payload is an object', () => {
    const content = [
      { type: ContentTypes.THINK, think: { text: 'object-shaped reasoning' } },
      { type: ContentTypes.TEXT, text: 'Answer' },
    ];
    expect(extractMessageContent(msg(content))).toBe('Answer');
  });

  it('keeps plain string parts and drops null parts', () => {
    const content = ['inline text', null, { type: ContentTypes.TEXT, text: ' more' }];
    expect(extractMessageContent(msg(content))).toBe('inline text more');
  });

  it('falls back to message.text when content is absent', () => {
    expect(extractMessageContent(msg(undefined, 'fallback text'))).toBe('fallback text');
  });
});
