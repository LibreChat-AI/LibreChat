const http = require('http');
const net = require('net');

const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 1025);
const HTTP_PORT = Number(process.env.E2E_MAILBOX_PORT ?? 8025);
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

const messages = [];
let nextId = 1;

function decodeQuotedPrintable(value) {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeBody(raw, headers) {
  const encoding = headers.get('content-transfer-encoding')?.toLowerCase();
  if (encoding === 'base64') {
    return Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(raw);
  }
  return raw;
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };
  return value
    .replace(/&#x([0-9A-F]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|apos|gt|lt|quot);/g, (_match, name) => namedEntities[name]);
}

function parseMessage(raw, envelope) {
  const separator = raw.search(/\r?\n\r?\n/);
  const rawHeaders = separator === -1 ? raw : raw.slice(0, separator);
  const rawBody = separator === -1 ? '' : raw.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers = new Map();

  for (const line of rawHeaders.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
  }

  const body = decodeBody(rawBody, headers);
  const urls = (body.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map(decodeHtmlEntities);

  return {
    id: nextId++,
    from: envelope.from,
    to: [...envelope.to],
    subject: headers.get('subject') ?? '',
    body,
    urls,
  };
}

function createSmtpServer() {
  return net.createServer((socket) => {
    let buffer = '';
    let dataLines = [];
    let dataBytes = 0;
    let readingData = false;
    let envelope = { from: '', to: [] };

    const reply = (line) => socket.write(`${line}\r\n`);
    const resetEnvelope = () => {
      envelope = { from: '', to: [] };
      dataLines = [];
      dataBytes = 0;
      readingData = false;
    };

    const handleCommand = (line) => {
      const [command = ''] = line.trim().split(/\s+/, 1);
      const upperCommand = command.toUpperCase();

      if (upperCommand === 'EHLO') {
        socket.write('250-localhost\r\n250-PIPELINING\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        return;
      }
      if (upperCommand === 'HELO') {
        reply('250 localhost');
        return;
      }
      if (upperCommand === 'MAIL') {
        const match = line.match(/^MAIL FROM:\s*<?([^>\s]+)>?/i);
        if (!match) {
          reply('501 Invalid sender');
          return;
        }
        envelope.from = match[1];
        reply('250 Sender accepted');
        return;
      }
      if (upperCommand === 'RCPT') {
        const match = line.match(/^RCPT TO:\s*<?([^>\s]+)>?/i);
        if (!match) {
          reply('501 Invalid recipient');
          return;
        }
        envelope.to.push(match[1].toLowerCase());
        reply('250 Recipient accepted');
        return;
      }
      if (upperCommand === 'DATA') {
        if (!envelope.from || envelope.to.length === 0) {
          reply('503 MAIL FROM and RCPT TO required');
          return;
        }
        readingData = true;
        reply('354 End data with <CR><LF>.<CR><LF>');
        return;
      }
      if (upperCommand === 'RSET') {
        resetEnvelope();
        reply('250 Reset');
        return;
      }
      if (upperCommand === 'NOOP') {
        reply('250 OK');
        return;
      }
      if (upperCommand === 'QUIT') {
        reply('221 Bye');
        socket.end();
        return;
      }
      reply('502 Command not implemented');
    };

    const handleLine = (line) => {
      if (!readingData) {
        handleCommand(line);
        return;
      }
      if (line === '.') {
        messages.push(parseMessage(dataLines.join('\r\n'), envelope));
        resetEnvelope();
        reply('250 Message accepted');
        return;
      }

      const unstuffed = line.startsWith('..') ? line.slice(1) : line;
      dataBytes += Buffer.byteLength(unstuffed) + 2;
      if (dataBytes > MAX_MESSAGE_BYTES) {
        resetEnvelope();
        reply('552 Message too large');
        return;
      }
      dataLines.push(unstuffed);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf('\n');
      }
    });
    reply('220 localhost ESMTP LibreChat E2E mailbox');
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function createHttpServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${HTTP_PORT}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/messages') {
      messages.length = 0;
      nextId = 1;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/messages') {
      const to = url.searchParams.get('to')?.toLowerCase();
      const subject = url.searchParams.get('subject');
      const matches = messages.filter(
        (message) => (!to || message.to.includes(to)) && (!subject || message.subject === subject),
      );
      sendJson(response, 200, { messages: matches });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });
}

const smtpServer = createSmtpServer();
const httpServer = createHttpServer();

smtpServer.listen(SMTP_PORT, '127.0.0.1', () => {
  httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[e2e] Mailbox listening on SMTP ${SMTP_PORT} and HTTP ${HTTP_PORT}`);
  });
});

function shutdown() {
  httpServer.close(() => smtpServer.close());
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
