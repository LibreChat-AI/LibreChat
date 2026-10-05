import { resolveMediaConfig } from 'librechat-data-provider';
import {
  mediaDiagnosticSecrets,
  parseMediaProviderDiagnostic,
  sanitizeMediaProviderDiagnostic,
} from './diagnostics';

describe('private media provider diagnostics', () => {
  const limits = resolveMediaConfig().recovery;

  it('keeps actionable recognized fields and prefers the vendor status over a duplicate HTTP code', () => {
    expect(
      parseMediaProviderDiagnostic(
        JSON.stringify({
          error: {
            code: 400,
            status: 'FAILED_PRECONDITION',
            message:
              'Async process failed with the following error: The task field is not supported.',
            details: { raw: 'private-provider-data' },
          },
        }),
        { status: 400, requestId: 'req-123', limits },
      ),
    ).toEqual({
      status: 400,
      code: 'FAILED_PRECONDITION',
      message: 'Async process failed with the following error: The task field is not supported.',
      requestId: 'req-123',
    });
  });

  it.each([
    {
      body: {
        error: { code: null, type: 'invalid_request_error', message: 'Unsupported quality' },
      },
      code: 'invalid_request_error',
      message: 'Unsupported quality',
    },
    {
      body: { error: { code: 'invalid_parameter', message: 'Unsupported duration' } },
      code: 'invalid_parameter',
      message: 'Unsupported duration',
    },
    {
      body: { errors: [{ type: 'validation', message: 'Unsupported size' }] },
      code: 'validation',
      message: 'Unsupported size',
    },
    {
      body: { error: 'invalid_request', error_description: 'Unsupported format' },
      code: undefined,
      message: 'Unsupported format',
    },
    { body: { detail: 'Try a shorter prompt' }, code: undefined, message: 'Try a shorter prompt' },
  ])('parses common documented JSON error forms: $message', ({ body, code, message }) => {
    expect(parseMediaProviderDiagnostic(JSON.stringify(body), { status: 400, limits })).toEqual({
      status: 400,
      code,
      message,
    });
  });

  it('redacts the bare key of any Authorization scheme without redacting other header words', () => {
    const secrets = mediaDiagnosticSecrets({
      Authorization: 'Riverflow-Key sourceful-secret',
      'X-Title': 'Studio App',
    });
    expect(secrets).toContain('sourceful-secret');
    expect(secrets).not.toContain('App');
  });

  it('redacts credentials, signed URLs, embedded media and control characters before bounding fields', () => {
    const secrets = mediaDiagnosticSecrets({
      Authorization: 'Bearer fixture-secret',
      'X-Custom-Credential': 'opaque-credential',
      'Content-Type': 'application/json',
    });
    const diagnostic = sanitizeMediaProviderDiagnostic(
      {
        status: 400,
        code: 'invalid_request',
        message:
          'Unsupported task\u202e\nfixture-secret opaque-credential Bearer other-token "api_key": "hidden-key" password=hidden-password https://provider.example/video?X-Goog-Signature=signed-secret data:image/png;base64,embedded-secret sk-another-key ' +
          'a'.repeat(160),
        requestId: 'req-' + 'x'.repeat(300),
      },
      2000,
      secrets,
    );
    expect(diagnostic?.message).toContain('Unsupported task');
    expect(diagnostic?.message).not.toMatch(
      /fixture-secret|opaque-credential|other-token|hidden-key|hidden-password|provider.example|signed-secret|embedded-secret|sk-another-key|a{128}|\u202e|\n/,
    );
    expect(diagnostic?.requestId?.length).toBeLessThanOrEqual(256);
    expect(
      sanitizeMediaProviderDiagnostic(
        { message: 'A helpful explanation that is longer than allowed' },
        21,
      )?.message,
    ).toBe('A helpful explanation');
  });

  it.each([
    '<html>private upstream error</html>',
    'private raw text',
    JSON.stringify({ unexpected: { message: 'private unrecognized field' } }),
    JSON.stringify({ error: { message: 'x'.repeat(100) } }),
  ])('does not expose raw or over-limit response bodies', (body) => {
    expect(
      parseMediaProviderDiagnostic(body, {
        status: 502,
        limits: { ...limits, maxDiagnosticResponseBytes: 64 },
      }),
    ).toEqual({ status: 502 });
  });
});
