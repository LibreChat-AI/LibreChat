import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { build } from '../packages/api/node_modules/tsdown/dist/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(root, '.extraction-test-'));
chmodSync(scratch, 0o755);
const uuid = randomUUID();
const project = `librechat-extraction-test-${uuid}`;
const image = `librechat-extraction-test:${uuid}`;
const caller = `librechat-extraction-caller-${uuid}`;
const docker = (...args) => execFileSync('docker', args, { cwd: root, stdio: 'inherit' });
const output = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8' }).trim();
const composeFile = join(scratch, 'compose.json');
const envFile = join(scratch, 'empty.env');
writeFileSync(envFile, '');
const compose = (...args) =>
  docker('compose', '--env-file', envFile, '-p', project, '-f', composeFile, ...args);
let imageBuilt = false;
let callerProcess;
let callerName = caller;
try {
  const deployment = yaml.load(readFileSync(join(root, 'docker-compose.yml'), 'utf8'));
  for (const name of ['api', 'rag_api']) {
    assert.ok(
      deployment.services[name].volumes.includes('extraction-credentials:/run/extraction:ro'),
    );
    assert.ok(deployment.services[name].networks.includes('extraction'));
    assert.equal(deployment.services[name].group_add, undefined);
    assert.equal(deployment.services[name].depends_on.extraction.condition, 'service_healthy');
  }
  // Select the shipped processor unchanged. No database/app services or environment files enter this test.
  writeFileSync(
    composeFile,
    JSON.stringify({
      services: {
        extraction: {
          ...deployment.services.extraction,
          networks: { extraction: { aliases: ['cache-extraction'] } },
        },
        'extraction-init': deployment.services['extraction-init'],
      },
      volumes: { 'extraction-credentials': deployment.volumes['extraction-credentials'] },
      networks: { extraction: deployment.networks.extraction },
    }),
  );
  process.env.EXTRACTION_IMAGE = image;
  const loggerFixture = join(scratch, 'logger.cjs');
  writeFileSync(
    loggerFixture,
    'exports.logger = { debug() {}, warn() {}, error() {}, info() {} };',
  );
  await build({
    entry: {
      client: join(root, 'packages/api/src/files/extraction/client.ts'),
      upload: join(root, 'packages/api/src/files/extraction/upload.ts'),
      process: join(root, 'packages/api/src/files/code/process.ts'),
      extract: join(root, 'packages/api/src/files/code/extract.ts'),
      operations: join(root, 'packages/api/src/files/operations.ts'),
      classify: join(root, 'packages/api/src/files/code/classify.ts'),
    },
    config: false,
    outDir: scratch,
    clean: false,
    format: 'cjs',
    platform: 'node',
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    // Only logging is replaced; the cache producer, processor, client and transport are real.
    plugins: [
      {
        name: 'qualification-logger',
        resolveId(source) {
          return source === '@librechat/data-schemas' ? loggerFixture : null;
        },
      },
    ],
  });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(scratch, 'key.pem'),
      '-out',
      join(scratch, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  chmodSync(join(scratch, 'key.pem'), 0o444);
  imageBuilt = true;
  compose('up', '-d', '--wait', '--wait-timeout', '30', 'extraction');
  compose('run', '--rm', 'extraction-init');
  const id = output(
    'compose',
    '--env-file',
    envFile,
    '-p',
    project,
    '-f',
    composeFile,
    'ps',
    '-q',
    'extraction',
  );
  const container = JSON.parse(output('inspect', id))[0];
  const host = container.HostConfig;
  assert.equal(host.NetworkMode, `${project}_extraction`);
  const network = JSON.parse(output('network', 'inspect', `${project}_extraction`))[0];
  assert.equal(network.Internal, true);
  assert.equal(
    Object.keys(container.NetworkSettings.Ports).some(
      (port) => container.NetworkSettings.Ports[port]?.length,
    ),
    false,
  );
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ['ALL']);
  assert.ok(host.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(host.Memory, 768 * 1024 * 1024);
  assert.equal(host.NanoCpus, 2e9);
  assert.equal(host.PidsLimit, 32);
  assert.equal(container.Config.User, '10001:10001');
  assert.equal(container.Mounts.length, 1);
  assert.equal(container.Mounts[0].Destination, '/run/extraction');
  assert.equal(container.Mounts[0].RW, false);
  assert.deepEqual(Object.keys(host.Tmpfs), ['/jobs']);
  for (const flag of [
    'noexec',
    'nosuid',
    'nodev',
    'size=96m',
    'nr_inodes=1024',
    'uid=10001',
    'gid=10001',
    'mode=0700',
  ]) {
    assert.ok(host.Tmpfs['/jobs'].includes(flag));
  }
  console.log(
    'Shipped processor network, mounts, identity, resource caps and security flags verified',
  );
  const callerArgs = [
    'run',
    '-i',
    '--rm',
    '--name',
    caller,
    '--init',
    '--network',
    `${project}_extraction`,
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--mount',
    `type=volume,src=${project}_extraction-credentials,dst=/run/extraction,readonly`,
    '--mount',
    `type=bind,src=${scratch},dst=/test,readonly`,
    '--mount',
    `type=bind,src=${join(root, 'scripts/extraction-client.cjs')},dst=/client.cjs,readonly`,
    '--mount',
    `type=bind,src=${join(root, 'packages/api/src/files/extraction/fixtures')},dst=/fixtures,readonly`,
    '--entrypoint',
    'node',
    image,
    '/client.cjs',
  ];

  async function qualifyCancellation(args, marker) {
    let ready;
    const cancellationReady = new Promise((resolve) => {
      ready = resolve;
    });
    callerProcess = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
    let progress = '';
    callerProcess.stdout.on('data', (bytes) => {
      process.stdout.write(bytes);
      progress += bytes;
      if (progress.includes(marker)) ready();
    });
    const callerExit = new Promise((resolve, reject) => {
      callerProcess.once('error', reject);
      callerProcess.once('exit', resolve);
    });
    await Promise.race([
      cancellationReady,
      callerExit.then((code) => {
        throw new Error(`Caller exited before cancellation probe (${code})`);
      }),
    ]);
    // Freeze a real parser worker so cancellation, not a naturally fast parse, must retire it.
    const worker = output(
      'exec',
      id,
      'node',
      '-e',
      `
    const fs=require('node:fs');
    (async()=>{for(let attempt=0;attempt<300;attempt++){
      for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){
        let args;try{args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');}catch{continue;}
        if(args[0]?.includes('python')&&args.includes('/opt/extraction/extract.py')&&args.includes('pdf')){
          process.kill(Number(pid),'SIGSTOP');
          const fds=fs.readdirSync('/proc/'+pid+'/fd').map(fd=>{try{return fs.readlinkSync('/proc/'+pid+'/fd/'+fd);}catch{return '';}});
          if(fds.some(fd=>fd.startsWith('socket:')))throw new Error('Parser inherited a socket descriptor');
          console.log(pid);return;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,10));
    }throw new Error('No live PDF worker observed');})().catch(e=>{console.error(e.message);process.exitCode=1});
  `,
    );
    assert.match(worker, /^\d+$/);
    console.log('Frozen parser descriptor inspection verified no inherited or open sockets');
    callerProcess.stdin.end('cancel\n');
    let timeout;
    try {
      const code = await Promise.race([
        callerExit,
        new Promise((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Owner cancellation did not settle within 3s')),
            3000,
          );
        }),
      ]);
      assert.equal(code, 0);
    } finally {
      clearTimeout(timeout);
    }
    docker(
      'exec',
      id,
      'node',
      '-e',
      `
    const fs=require('node:fs');
    (async()=>{for(let attempt=0;attempt<200;attempt++){
      if(!fs.existsSync('/proc/${worker}')&&fs.readdirSync('/jobs').length===0){
        console.log('Observed parser worker termination and scratch cleanup after owner cancellation');return;
      }
      await new Promise(resolve=>setTimeout(resolve,10));
    }throw new Error('Cancelled worker or scratch survived');})().catch(e=>{console.error(e.message);process.exitCode=1});
  `,
    );
  }
  await qualifyCancellation(callerArgs, 'CANCEL_PROBE_READY');
  callerName = `${caller}-cache`;
  const cacheArgs = callerArgs.map((arg) =>
    arg === caller
      ? callerName
      : arg === '/client.cjs'
        ? '/cache-client.cjs'
        : arg.replace('dst=/run/extraction,readonly', 'dst=/custom-credentials,readonly'),
  );
  cacheArgs.splice(
    cacheArgs.indexOf('--entrypoint'),
    0,
    '--env',
    'NODE_EXTRA_CA_CERTS=/test/cert.pem',
    '--mount',
    `type=bind,src=${join(root, 'scripts/extraction-cache-client.cjs')},dst=/cache-client.cjs,readonly`,
  );
  await qualifyCancellation(cacheArgs, 'CACHE_CANCEL_PROBE_READY');
  docker(
    'exec',
    id,
    'node',
    '-e',
    'const fs=require("node:fs"); if(fs.readdirSync("/jobs").length) process.exit(1); console.log("Processor scratch cleanup verified");',
  );
} finally {
  try {
    if (callerProcess?.exitCode === null) docker('rm', '-f', callerName);
    compose('down', '-v', '--remove-orphans');
    if (imageBuilt && output('images', '-q', image)) docker('image', 'rm', image);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
