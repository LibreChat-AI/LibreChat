import { ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import {
  errorCopyKey,
  classifyErrorText,
  getLangChainErrorKey,
  codeWorkspaceErrorKeys,
} from '../classify';
import { getStreamStartFailureText } from '../../resumable/errors';
import { extractJson, isJson } from '../../json';

const langChainText = (code: string) =>
  `Model failed. Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/${code}/`;

describe('extractJson', () => {
  it('finds the first balanced object inside prose', () => {
    expect(extractJson('Request failed: 400 {"type":"a","info":{"b":1}} trailing')).toBe(
      '{"type":"a","info":{"b":1}}',
    );
  });

  it('ignores braces inside quoted strings, escaped quotes included', () => {
    expect(extractJson('x {"message":"a } \\" { b"} y')).toBe('{"message":"a } \\" { b"}');
  });

  it('returns an empty string when no object closes', () => {
    expect(extractJson('no braces')).toBe('');
    expect(extractJson('open { only')).toBe('');
  });

  it('pairs with isJson for text that is not JSON after all', () => {
    expect(isJson(extractJson('{not json}'))).toBe(false);
    expect(isJson('{"a":1}')).toBe(true);
  });
});

describe('getLangChainErrorKey', () => {
  it('localizes the LangChain codes with copy and leaves the rest to the provider text', () => {
    expect(getLangChainErrorKey(langChainText('MODEL_NOT_FOUND'))).toBe(
      'com_error_model_not_found',
    );
    expect(getLangChainErrorKey(langChainText('MODEL_RATE_LIMIT'))).toBe(
      'com_error_model_rate_limit',
    );
    expect(getLangChainErrorKey(langChainText('MODEL_AUTHENTICATION'))).toBeUndefined();
    expect(getLangChainErrorKey('plain failure')).toBeUndefined();
  });
});

describe('classifyErrorText', () => {
  it('reads a LangChain failure an older server persisted as prose', () => {
    expect(classifyErrorText(langChainText('MODEL_NOT_FOUND'))).toEqual({
      kind: 'langchain',
      key: 'com_error_model_not_found',
    });
  });

  it('treats text without a parseable payload as prose', () => {
    expect(classifyErrorText('Something broke')).toEqual({ kind: 'prose' });
    expect(classifyErrorText('Something broke {not json}')).toEqual({ kind: 'prose' });
  });

  it('reads a top-level code or type, the code first', () => {
    const body = { type: ErrorTypes.INPUT_LENGTH, code: ErrorTypes.MISSING_MODEL };
    expect(classifyErrorText(JSON.stringify(body))).toEqual({
      kind: 'payload',
      json: body,
      payload: body,
      code: ErrorTypes.MISSING_MODEL,
    });
  });

  it('reads an OpenAI-style envelope when only the envelope names a code', () => {
    const body = { error: { code: 'invalid_api_key', message: 'Incorrect API key' } };
    expect(classifyErrorText(`401 ${JSON.stringify(body)}`)).toEqual({
      kind: 'payload',
      json: body,
      payload: body.error,
      code: 'invalid_api_key',
    });
  });

  it('keeps the body when the top level names a type, even a generic one', () => {
    const body = { type: 'error', error: { type: 'overloaded_error' } };
    expect(classifyErrorText(JSON.stringify(body))).toEqual({
      kind: 'payload',
      json: body,
      payload: body,
      code: 'error',
    });
  });

  it('preserves the localized admission code through a refused chat start', () => {
    const body = {
      code: ErrorTypes.ASSISTANT_OUTPUT_UNSUPPORTED,
      error: 'content_filter_block',
      message: 'Start a regular text-only Agent turn to use assistant reply protection.',
    };
    const failure = classifyErrorText(getStreamStartFailureText(body));
    expect(failure).toMatchObject({
      kind: 'payload',
      code: ErrorTypes.ASSISTANT_OUTPUT_UNSUPPORTED,
    });
    expect(failure.kind === 'payload' && errorCopyKey(failure.code ?? '')).toBe(
      'com_error_assistant_output_unsupported',
    );
  });

  it('reports a payload with no code at all', () => {
    expect(classifyErrorText('{"message":"no code"}')).toEqual({
      kind: 'payload',
      json: { message: 'no code' },
      payload: { message: 'no code' },
      code: undefined,
    });
  });
});

describe('errorCopyKey', () => {
  it('gives the one sentence a code renders as', () => {
    expect(errorCopyKey(ErrorTypes.MODERATION)).toBe('com_error_moderation');
    expect(errorCopyKey(ViolationTypes.BAN)).toBe('com_error_ban');
  });

  it('has no copy for a code with a renderer of its own, or for an inherited name', () => {
    expect(errorCopyKey(ErrorTypes.NO_USER_KEY)).toBeUndefined();
    expect(errorCopyKey('constructor')).toBeUndefined();
    expect(errorCopyKey('toString')).toBeUndefined();
  });
});

describe('codeWorkspaceErrorKeys', () => {
  it('names a sentence for every refusal reason', () => {
    expect(Object.keys(codeWorkspaceErrorKeys).sort()).toEqual(
      ['invalid', 'locked', 'missing', 'required', 'unsupported', 'worker_unavailable'].sort(),
    );
  });
});
