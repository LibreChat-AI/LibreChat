const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer, request } = require('node:http');
const { resolveUploadDocumentText } = require('/test/upload.cjs');
const { createDocumentExtractor, extractionText } = require('/test/client.cjs');

function cancellablePdf() {
  const lines = Array.from({ length: 150 }, () => `(${'Cancellation fixture '.repeat(3)}) Tj`).join(
    '\n',
  );
  const content = `BT /F1 12 Tf 72 720 Td\n${lines}\nET`;
  const kids = Array.from({ length: 64 }, (_, index) => `${index + 5} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count 64 >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: 64 },
      () =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>',
    ),
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  return Buffer.from(
    `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

async function cancellationProbe() {
  let completed;
  const outcome = new Promise((resolve) => {
    completed = resolve;
  });
  let persisted = false;
  const server = createServer(async (req, res) => {
    req.resume();
    try {
      await resolveUploadDocumentText({
        file: { originalname: 'cancel.pdf', mimetype: 'application/pdf', buffer: cancellablePdf() },
        request: req,
        response: res,
        extract: async () => {
          throw new Error('Local fallback must not run');
        },
      });
      persisted = true;
      completed('SUCCESS');
    } catch (error) {
      completed(error.code);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const caller = request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST' });
  caller.on('error', () => {});
  caller.end('upload complete');
  process.stdin.once('data', () => caller.destroy());
  console.log('CANCEL_PROBE_READY');
  try {
    assert.equal(await outcome, 'CANCELLED');
    assert.equal(persisted, false);
    console.log('Actual upload lifetime cancelled on HTTP disconnect with no success persistence');
  } finally {
    caller.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  assert.equal(fs.statSync('/run/extraction').mode & 0o777, 0o755);
  assert.equal(fs.statSync('/run/extraction/token').mode & 0o777, 0o444);
  assert.match(fs.readFileSync('/run/extraction/token', 'utf8'), /^[a-f0-9]{64}$/);
  for (const path of ['/v1/capabilities', '/v1/extract-text']) {
    const unauthorized = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: 'extraction',
          port: 8000,
          path,
          method: path.endsWith('capabilities') ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${'0'.repeat(64)}`, 'Content-Length': 0 },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.once('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
          );
          res.once('error', reject);
        },
      );
      req.once('error', reject);
      req.end();
    });
    assert.deepEqual(unauthorized, { status: 401, body: { error: { code: 'UNAUTHORIZED' } } });
  }
  console.log('Automatic credential permissions and safe service authentication verified');
  const client = createDocumentExtractor();
  for (const [name, format] of [
    ['pages.pdf', 'pdf'],
    ['body.docx', 'docx'],
  ]) {
    const bytes = fs.readFileSync(`/fixtures/${name}`);
    const result = await client.extract(bytes, format);
    assert.equal(result.format, format);
    assert.equal(result.segments[0].index, 1);
    assert.ok(extractionText(result).trim());
    assert.equal(
      result.textBytes,
      result.segments.reduce((size, segment) => size + Buffer.byteLength(segment.text), 0),
    );
    if (format === 'pdf') {
      assert.equal(result.segments.length, 2);
      assert.deepEqual(
        result.segments.map((segment) => segment.text),
        ['First page text', 'Second page text'],
      );
      assert.ok(result.segments.every((segment) => segment.kind === 'page'));
    } else {
      assert.equal(result.segments.length, 1);
      assert.equal(result.segments[0].kind, 'document');
      assert.equal(
        result.segments[0].text,
        'First paragraph\nLeft cell\tRight cell\nLast paragraph\n',
      );
    }
    console.log(`Real client -> hardened processor: ${format} passed`);
  }
  await assert.rejects(
    client.extract(Buffer.from('not a PDF'), 'pdf'),
    (error) => error.code === 'INVALID_DOCUMENT',
  );
  console.log('Real processor rejection remains a safe client failure');
  await cancellationProbe();
}
module.exports = { cancellablePdf };
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
