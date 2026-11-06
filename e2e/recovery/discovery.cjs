const http = require('node:http');
let available = false;
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/availability') {
      available = url.searchParams.get('available') === 'true';
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        url.pathname === '/v1/models'
          ? {
              data: available ? [{ id: 'recovery-model' }] : [],
            }
          : { available },
      ),
    );
  })
  .listen(Number(process.env.E2E_RECOVERY_PROVIDER_PORT ?? 4018), '127.0.0.1');
