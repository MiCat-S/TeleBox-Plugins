'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeAccess = fs.access;
const path = require('node:path');
const os = require('node:os');
const timers = require('node:timers/promises');
const nativeSleep = timers.setTimeout;
const {spawnSync} = require('node:child_process');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const {CronJob} = require(path.join(core, 'node_modules/cron'));
const cookie = 'session=fictional-secret-12345; other=second-secret';
const envelope = {id: 17, chatId: '9007199254740993', outgoing: true, text: '.nodeseek now'};
const base = {cookie, autoEnabled: true, lastDoneDate: '', lastResult: '', unknown: {nested: ['keep']}};
const successful = () => Response.json({success: true, message: '获得 5 鸡腿'});
const challenge = () => new Response('Just a moment', {status: 403, headers: {server: 'cloudflare'}});
let buildRoot, PluginHost, ScopedProcesses, createNodeSeek, metadata, waitPort, processPort;
const cronEntries = [];

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
function date() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await nativeSleep(1);
  }
  assert.fail('condition did not settle');
}
function processResult(payload = {status: 200, server: 'cloudflare', text: JSON.stringify({success: true})}) {
  return {stdout: Buffer.from(JSON.stringify(payload)), stderr: Buffer.alloc(0), exitCode: 0};
}

test.before(async () => {
  assert.equal(process.versions.node.split('.')[0], '24', 'run with the specified Node 24 runtime');
  test.mock.method(globalThis, 'fetch', () => assert.fail('real network is forbidden'));
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-nodeseek-build-')));
  await fs.symlink(path.join(core, 'node_modules'), path.join(buildRoot, 'node_modules'), 'dir');
  const options = {bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external', logLevel: 'silent'};
  esbuild.buildSync({...options, stdin: {contents:
    `export {PluginHost} from ${JSON.stringify(path.join(core, 'src/v2/host.ts'))};\n` +
    `export {ScopedProcesses} from ${JSON.stringify(path.join(core, 'src/v2/processes.ts'))};`,
  resolveDir: core, loader: 'ts'}, outfile: path.join(buildRoot, 'host.cjs')});
  metadata = esbuild.buildSync({...options,
    entryPoints: [path.resolve(__dirname, '../nodeseek/v2.ts')], outfile: path.join(buildRoot, 'nodeseek.cjs'),
    alias: {'telebox/sdk': path.join(core, 'src/v2/sdk.ts')}, metafile: true,
  }).metafile;
  ({PluginHost, ScopedProcesses} = require(path.join(buildRoot, 'host.cjs')));
  test.mock.method(ScopedProcesses.prototype, 'run', (command, args, options) => {
    assert.ok(processPort, 'real helper execution is forbidden');
    return processPort(command, args, options);
  });
  test.mock.method(timers, 'setTimeout', (ms, value, options) => {
    assert.ok(waitPort, 'waits may only start inside a fixture');
    return waitPort(ms, value, options);
  });
  const from = CronJob.from.bind(CronJob);
  test.mock.method(CronJob, 'from', options => {
    const job = from(options);
    cronEntries.push({job, options});
    return job;
  });
  createNodeSeek = require(path.join(buildRoot, 'nodeseek.cjs')).default;
});

test.after(async () => {
  test.mock.restoreAll();
  if (buildRoot) await fs.rm(buildRoot, {recursive: true, force: true});
});

async function fixture(t, {data, config, fetch = successful, process: runProcess, wait, edit, send, factory, hostOptions} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-nodeseek-data-')));
  const dir = path.join(root, 'nodeseek');
  // Executable discovery may inspect only synthetic fixture metadata, never the host's Python.
  t.mock.method(fs, 'access', async (file, ...args) => {
    if (!String(file).startsWith(root + path.sep)) throw Object.assign(new Error('fixture executable absent'), {code: 'ENOENT'});
    return nativeAccess(file, ...args);
  });
  if (data !== undefined || config !== undefined) await fs.mkdir(dir);
  for (const [file, value] of [['data.json', data], ['config.json', config]]) {
    if (value !== undefined) await fs.writeFile(path.join(dir, file), JSON.stringify(value), {mode: 0o600});
  }
  const requests = [], edits = [], sends = [], logs = [], processes = [], waits = [];
  waitPort = (ms, value, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    waits.push({ms, signal: options.signal});
    return wait ? wait(ms, value, options) : nativeSleep(Math.min(ms, 1), value, options);
  };
  processPort = async (command, args, options) => {
    assert.ok(path.isAbsolute(command));
    assert.equal(args[0], '-E');
    assert.equal(args[1], '-c');
    assert.match(args[2], /from curl_cffi import requests/);
    assert.match(args[2], /sys.path = \[entry for entry in sys.path if entry\]/);
    assert.doesNotMatch(args.join(' '), /fictional-secret|second-secret|pip install| -I| -s/);
    assert.equal(options.env, undefined, 'do not inherit secrets from the environment');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    if (options.input === undefined) {
      assert.equal(options.timeoutMs, 5000);
      assert.equal(options.maxOutputBytes, 4096);
      assert.doesNotMatch(args[2], /requests\.(?:get|post|request)|json.load\(sys.stdin\)/);
      processes.push({command, args, options, probe: true});
      return runProcess ? runProcess(command, args, options) : processResult({state: 'available'});
    }
    assert.match(args[2], /impersonate="chrome"/);
    assert.match(args[2], /timeout=25/);
    assert.match(args[2], /allow_redirects=False/);
    assert.match(args[2], /65536/);
    assert.doesNotMatch(args.join(' '), /fictional-secret|second-secret|pip install/);
    assert.equal(options.timeoutMs, 30000);
    assert.equal(options.maxOutputBytes, 1024 * 1024);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    const payload = JSON.parse(options.input);
    assert.equal(payload.url, requests.at(-1).url.href);
    assert.equal(payload.headers.Cookie, requests.at(-1).headers.get('Cookie'));
    assert.equal(options.env, undefined, 'do not inherit secrets from the environment');
    processes.push({command, args, options, payload});
    return runProcess ? runProcess(command, args, options) : processResult();
  };
  const before = cronEntries.length;
  const host = new PluginHost({
    storageRoot: root,
    logger: {info(event, fields) { logs.push({event, fields}); }, error(event, fields) { logs.push({event, fields}); }},
    http: {fetch: async (input, init) => {
      const url = new URL(input), headers = new Headers(init.headers);
      assert.equal(url.origin, 'https://www.nodeseek.com');
      assert.equal(url.pathname, '/api/attendance');
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{}');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(headers.get('Content-Type'), 'application/json');
      assert.match(headers.get('User-Agent'), /Chrome\/125/);
      assert.equal(headers.get('origin'), url.origin);
      assert.equal(headers.get('referer'), url.origin + '/board');
      assert.equal(init.signal.aborted, false);
      requests.push({url, init, headers});
      return fetch(url, init);
    }},
    telegram: {
      async edit(message, text, options, signal) {
        assert.equal(signal.aborted, false);
        edits.push({text, options});
        if (edit) await edit(message, text, options, signal);
      },
      async withClient(operation, signal) {
        assert.equal(signal.aborted, false);
        return operation({async sendMessage(target, options) {
          assert.equal(signal.aborted, false);
          sends.push({target, options});
          if (send) await send(target, options, signal);
        }}, signal);
      },
      async reply() { assert.fail('unexpected reply'); },
      async getReply() { assert.fail('unexpected reply read'); },
      async invoke() { assert.fail('unexpected RPC'); },
    },
    ...hostOptions,
  });
  await host.load(createNodeSeek(factory));
  assert.equal(cronEntries.length, before + 1);
  const cron = cronEntries.at(-1);
  t.after(async () => {
    const report = await host.shutdown(1000);
    assert.equal(report.completed, true, JSON.stringify(report));
    assert.equal(host.snapshot().jobs.jobs, 0);
    assert.equal(host.snapshot().jobs.running, 0);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, root, dir, cron, requests, edits, sends, logs, processes, waits,
    run: text => host.dispatchPrimary({...envelope, text}),
    tick: () => cron.options.onTick(),
    read: (file = 'data.json') => fs.readFile(path.join(dir, file), 'utf8').then(JSON.parse),
  };
}

test('pure synchronous factory and lazy load use only candidate/helper/SDK source', async t => {
  const first = createNodeSeek(), second = createNodeSeek();
  assert.equal(typeof first.then, 'undefined');
  assert.notEqual(first, second);
  assert.equal(first.id, 'nodeseek');
  assert.equal(first.apiVersion, 1);
  assert.deepEqual(Object.keys(first.commands), ['nodeseek']);
  assert.equal(first.setup, undefined);
  assert.equal(first.cleanup, undefined);
  assert.equal(Object.keys(metadata.inputs).length, 3);
  assert.ok(Object.keys(metadata.inputs).every(file => /(?:nodeseek\/v2(?:\/curl-cffi)?|src\/v2\/sdk)\.ts$/.test(file)));
  const f = await fixture(t);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(f.requests.length + f.processes.length + f.edits.length + f.waits.length, 0);
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  assert.equal(f.cron.options.cronTime, '0 8 * * *');
  assert.equal(f.cron.options.timeZone, undefined, 'retain local timezone');
});

test('candidate and helper pass strict source typechecking against the existing SDK', async () => {
  const configFile = path.join(buildRoot, 'tsconfig.json');
  await fs.writeFile(configFile, JSON.stringify({compilerOptions: {
    target: 'ES2022', lib: ['ES2022'], module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
    types: ['node'], typeRoots: [path.join(core, 'node_modules/@types')],
    paths: {'telebox/sdk': [path.join(core, 'src/v2/sdk.ts')]},
  }, files: [path.resolve(__dirname, '../nodeseek/v2.ts')]}));
  const result = spawnSync(process.execPath, [path.join(core, 'node_modules/typescript/bin/tsc'), '-p', configFile],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('help, unknown commands and unset-cookie paths are local and do not create data', async t => {
  const f = await fixture(t);
  for (const text of ['.nodeseek', '.nodeseek help', '.nodeseek HELP', '.nodeseek what']) {
    await f.run(text);
    assert.match(f.edits.at(-1).text, /NodeSeek 自动签到/);
    assert.match(f.edits.at(-1).text, /curl_cffi/);
    assert.equal(f.edits.at(-1).options.parseMode, 'html');
  }
  await f.run('.nodeseek now');
  assert.match(f.edits.at(-1).text, /还没有设置 Cookie/);
  await f.run('.nodeseek status');
  assert.match(f.edits.at(-1).text, /Cookie：未设置/);
  assert.equal(f.requests.length + f.processes.length, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('set and auto preserve unknown data, reset only the completion date and use 0600', async t => {
  const f = await fixture(t, {data: {...base, lastDoneDate: '2020-01-01', lastResult: 'old result'}});
  await f.run('.nodeseek set tiny');
  assert.equal((await f.read()).lastDoneDate, '2020-01-01');
  await f.run('.nodeseek set new_session=fictional-new-secret;  extra=foo');
  const saved = await f.read();
  assert.equal(saved.cookie, 'new_session=fictional-new-secret; extra=foo');
  assert.equal(saved.lastDoneDate, '');
  assert.equal(saved.lastResult, 'old result');
  assert.deepEqual(saved.unknown, base.unknown);
  for (const mode of ['OFF', 'on']) {
    await f.run('.nodeseek auto ' + mode);
    assert.equal((await f.read()).autoEnabled, mode === 'on');
  }
  await f.run('.nodeseek auto bogus');
  assert.match(f.edits.at(-1).text, /用法/);
  assert.equal((await f.read()).autoEnabled, true);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.dir, 'data.json'))).mode & 0o777, 0o600);
  assert.equal(f.requests.length, 0);
});

for (const [name, status, payload, title] of [
  ['success flag', 200, {success: true}, '签到成功'],
  ['code', 200, {code: 1}, '签到成功'],
  ['retcode', 200, {retcode: 1}, '签到成功'],
  ['reward message', 200, {msg: '获得 9 鸡腿'}, '签到成功'],
  ['success wording', 200, {reason: '成功签到'}, '签到成功'],
  ['already HTTP 500', 500, {message: '今天已完成签到'}, '今日已签到'],
  ['zero code', 200, {code: 0}, '今日已签到'],
  ['expired code', 200, {code: 4001}, 'Cookie 已失效'],
  ['expired alternate code', 200, {retcode: 1001}, 'Cookie 已失效'],
  ['expired status', 200, {status: 401}, 'Cookie 已失效'],
  ['expired wording precedence', 200, {success: true, message: '请先登录'}, 'Cookie 已失效'],
]) test('business classification and terminal persistence: ' + name, async t => {
  const f = await fixture(t, {data: base, fetch: async () => Response.json(payload, {status})});
  await f.run('.nodeseek now');
  assert.match(f.edits.at(-1).text, new RegExp(title));
  assert.equal(f.requests.length, 1);
  assert.equal(f.processes.length, 0);
  assert.equal((await f.read()).lastDoneDate, date());
  assert.deepEqual((await f.read()).unknown, base.unknown);
});

test('manual runs ignore daily completion and random/fixed reward modes retain exact URL semantics', async t => {
  for (const random of [true, false]) {
    const f = await fixture(t, {data: {...base, lastDoneDate: date()}, factory: {signRandom: random}});
    await f.run('.nodeseek now');
    assert.equal(f.requests[0].url.search, '?random=' + random);
    assert.equal(f.requests[0].headers.get('Cookie'), cookie);
  }
});

test('business failure retries three times with two 3-second waits and leaves completion unchanged', async t => {
  const f = await fixture(t, {data: base, fetch: async () => Response.json({code: 900, message: '稍后重试'})});
  await f.run('.nodeseek now');
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.waits.map(item => item.ms), [3000, 3000]);
  assert.equal((await f.read()).lastDoneDate, '');
  assert.equal((await f.read()).lastResult, '稍后重试');
});

test('network errors are logged safely and a later successful attempt stops retries', async t => {
  let calls = 0;
  const f = await fixture(t, {data: base, fetch: async () => {
    if (++calls === 1) throw new Error('private-network-credential');
    return successful();
  }});
  await f.run('.nodeseek now');
  assert.equal(f.requests.length, 2);
  assert.equal(f.logs[0].event, 'nodeseek.request.failed');
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private-network/);
});

test('malformed and non-object JSON, redirects and non-200 transport responses stay retryable', async t => {
  for (const [body, status] of [['{bad', 200], ['null', 200], ['[]', 200], ['"text"', 200], ['{}', 500], ['moved', 302]]) {
    const f = await fixture(t, {data: base, fetch: async () => new Response(body, {status, headers: {Location: 'https://private.invalid'}})});
    await f.run('.nodeseek now');
    assert.equal(f.requests.length, 3);
    assert.equal((await f.read()).lastDoneDate, '');
    assert.doesNotMatch(f.edits.at(-1).text, /private.invalid/);
  }
});

test('bare HTTP 401 marks login invalid without retry', async t => {
  const f = await fixture(t, {data: base, fetch: async () => new Response('Unauthorized', {status: 401})});
  await f.run('.nodeseek now');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.read()).lastDoneDate, date());
  assert.match(f.edits.at(-1).text, /Cookie 已失效/);
});

test('provider output is bounded, HTML escaped and configured cookie values are redacted before persistence', async t => {
  const f = await fixture(t, {data: base, fetch: async () => Response.json({success: true,
    message: '<b>&"\' ' + cookie + ' ' + 'x'.repeat(1000)})});
  await f.run('.nodeseek now');
  const output = f.edits.at(-1).text;
  assert.ok(output.includes('&lt;b&gt;&amp;&quot;&#39;'));
  assert.doesNotMatch(output, /fictional-secret|second-secret/);
  assert.ok(output.length < 4000);
  assert.ok((await f.read()).lastResult.length <= 500);
  await f.run('.nodeseek status');
  assert.doesNotMatch(f.edits.at(-1).text, /fictional-secret|second-secret/);
});

test('redaction preserves complete UTF-16 characters at the 500-unit boundary and repairs JSON surrogates', async t => {
  for (const [message, expected] of [
    ['a'.repeat(499) + '🍗', 'a'.repeat(499)],
    ['a'.repeat(498) + '🍗', 'a'.repeat(498) + '🍗'],
    ['a'.repeat(500) + '🍗', 'a'.repeat(500)],
    ['a'.repeat(499) + '\ud800', 'a'.repeat(499) + '\ufffd'],
    ['\ud800x\udc00🍗', '\ufffdx\ufffd🍗'],
    ['fictional-secret-12345\ud800', '[REDACTED]\ufffd'],
  ]) {
    const f = await fixture(t, {data: base, fetch: async () => Response.json({success: true, message})});
    await f.run('.nodeseek now');
    const result = (await f.read()).lastResult;
    assert.equal(result, expected);
    assert.equal(result.isWellFormed(), true);
    assert.ok(result.length <= 500);
    assert.ok(f.edits.every(edit => edit.text.isWellFormed()));
    await f.run('.nodeseek status');
    assert.equal(f.edits.at(-1).text.isWellFormed(), true);
  }
});

test('status repairs malformed legacy result text and cron/fallback notifications remain UTF-16 valid', async t => {
  const status = await fixture(t, {data: {...base, lastResult: '\ud800legacy\udc00'}});
  await status.run('.nodeseek status');
  assert.match(status.edits.at(-1).text, /\ufffdlegacy\ufffd/);
  assert.equal(status.edits.at(-1).text.isWellFormed(), true);
  const f = await fixture(t, {data: base, config: {pythonPath: '/fake/python'}, fetch: challenge,
    process: async () => processResult({status: 200, server: '', text: JSON.stringify({success: true, message: 'a'.repeat(499) + '🍗'})})});
  await f.tick();
  assert.equal(f.sends[0].options.message.isWellFormed(), true);
  assert.equal((await f.read()).lastResult, 'a'.repeat(499));
});

test('settings retain independent config file, write-only cookie, omitted secrets and unknown fields', async t => {
  const f = await fixture(t, {data: base, config: {cookie: 'panel-private-secret', chatId: '9007199254740999', interval: 5, maxItems: 5, unknown: {keep: true}}});
  const schema = await f.host.settingsSchema('nodeseek');
  assert.equal(schema.find(field => field.key === 'cookie').secret, true);
  assert.deepEqual(schema.map(field => field.key), ['cookie', 'chatId', 'interval', 'maxItems', 'pythonPath']);
  const publicRead = await f.host.readSettings('nodeseek');
  assert.equal(publicRead.secretSet.cookie, true);
  assert.equal(publicRead.values.cookie, undefined);
  assert.equal(publicRead.values.unknown, undefined);
  assert.doesNotMatch(JSON.stringify(publicRead), /panel-private/);
  await f.host.patchSettings('nodeseek', {interval: 8});
  assert.equal((await f.read('config.json')).cookie, 'panel-private-secret');
  assert.deepEqual((await f.read('config.json')).unknown, {keep: true});
  assert.deepEqual(await f.read(), base);
  await f.host.patchSettings('nodeseek', {cookie: ''});
  assert.equal((await f.host.readSettings('nodeseek')).secretSet.cookie, false);
  assert.equal((await f.read()).cookie, cookie);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.dir, 'config.json'))).mode & 0o777, 0o600);
});

test('invalid settings patches reject atomically and schema defaults do not rewrite saved fields', async t => {
  const config = {cookie: 'private-panel-cookie', extra: 7};
  const f = await fixture(t, {config});
  for (const patch of [{interval: 0}, {interval: 1441}, {interval: '5'}, {maxItems: 21}, {chatId: 123},
    {cookie: true}, {unknown: 9}, {pythonPath: 'relative/python'}, JSON.parse('{"__proto__":{}}')]) {
    await assert.rejects(f.host.patchSettings('nodeseek', patch));
    assert.deepEqual(await f.read('config.json'), config);
  }
  await f.host.patchSettings('nodeseek', {});
  assert.deepEqual((await f.host.readSettings('nodeseek')).values, {});
  await f.host.patchSettings('nodeseek', {pythonPath: '/explicit/venv/bin/python'});
  assert.equal((await f.read('config.json')).pythonPath, '/explicit/venv/bin/python');
});

test('concurrent settings patches preserve both edits and unknown unsafe integer literals', async t => {
  const f = await fixture(t, {config: {cookie: 'private-panel'}});
  await fs.writeFile(path.join(f.dir, 'config.json'), '{"cookie":"private-panel","unknown":9007199254740993123}');
  await Promise.all([f.host.patchSettings('nodeseek', {interval: 6}), f.host.patchSettings('nodeseek', {chatId: '42'})]);
  const bytes = await fs.readFile(path.join(f.dir, 'config.json'), 'utf8');
  assert.match(bytes, /9007199254740993123/);
  assert.equal(JSON.parse(bytes).interval, 6);
  assert.equal(JSON.parse(bytes).chatId, '42');
});

for (const operation of ['read', 'patch']) test('settings ' + operation + ' cancellation tracks file read until it settles', async t => {
  const f = await fixture(t, {config: {cookie: 'private-panel', interval: 5}});
  const started = deferred(), release = deferred();
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path.join(f.dir, 'config.json')) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async options => { started.resolve(); await release.promise; return read(options); };
    }
    return handle;
  });
  const running = (operation === 'read' ? f.host.readSettings('nodeseek') : f.host.patchSettings('nodeseek', {interval: 7}));
  const observed = assert.rejects(running, /Settings adapter failed|Settings are unavailable/);
  await started.promise;
  try {
    const report = await f.host.unload('nodeseek', 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
  } finally { release.resolve(); }
  await observed;
  assert.equal((await f.host.unload('nodeseek', 1000)).completed, true);
  assert.equal((await f.read('config.json')).interval, 5);
});

test('WAF challenge uses configured Python and stdin cookie then accepts fallback HTTP 500 business JSON', async t => {
  const f = await fixture(t, {data: base, factory: {signRandom: false}, config: {pythonPath: '/configured/venv/bin/python'}, fetch: challenge,
    process: async () => processResult({status: 500, server: 'cloudflare', text: '{"message":"今天已完成签到"}'})});
  await f.run('.nodeseek now');
  assert.equal(f.processes.length, 1);
  assert.equal(f.processes[0].payload.url, 'https://www.nodeseek.com/api/attendance?random=false');
  assert.equal(f.processes[0].command, '/configured/venv/bin/python');
  assert.equal((await f.read()).lastDoneDate, date());
  assert.match(f.edits.at(-1).text, /今日已签到/);
});

test('HTTP 200 WAF body triggers fallback but ordinary Cloudflare success does not', async t => {
  for (const bodyChallenge of [true, false]) {
    const f = await fixture(t, {data: base, config: {pythonPath: '/fake/python'},
      fetch: async () => new Response(bodyChallenge ? 'Checking your browser' : '{"success":true}', {headers: {server: 'cloudflare'}})});
    await f.run('.nodeseek now');
    assert.equal(f.processes.length, bodyChallenge ? 1 : 0);
  }
});

test('fallback resolves existing PATH executables lazily without executing or installing Python', async t => {
  const f = await fixture(t, {data: base, fetch: challenge});
  const bin = path.join(f.root, 'fake-bin');
  await fs.mkdir(bin);
  const candidate = path.join(bin, process.platform === 'win32' ? 'python3.exe' : 'python3');
  await fs.writeFile(candidate, 'fixture only, must never execute', {mode: 0o700});
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.equal(f.processes.length, 0);
    await f.run('.nodeseek status');
    assert.equal(f.processes.length, 1);
    assert.equal(f.processes[0].probe, true);
    await f.run('.nodeseek now');
    assert.equal(f.processes[1].command, candidate);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test('legacy venv precedes PATH, explicit Python precedes venv, and both probe and fallback use that choice', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, {data: base, config: explicit ? {pythonPath: '/configured/python'} : {}, fetch: challenge});
    const legacy = path.join(f.dir, 'curl_cffi_venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
    await fs.mkdir(path.dirname(legacy), {recursive: true});
    await fs.writeFile(legacy, 'fixture only, never execute', {mode: 0o700});
    const bin = path.join(f.root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'python3.exe' : 'python3'), 'fixture only', {mode: 0o700});
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      assert.equal(f.processes.length, 0);
      await f.run('.nodeseek status');
      await f.run('.nodeseek now');
      assert.equal(f.processes.length, 2);
      assert.equal(f.processes[0].probe, true);
      assert.ok(f.processes.every(item => item.command === (explicit ? '/configured/python' : legacy)));
      assert.match(f.edits[0].text, /可用（仅本地依赖导入检查）/);
    } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  }
});

test('status without Python neither creates a data directory nor executes a helper', async t => {
  const f = await fixture(t);
  await f.run('.nodeseek status');
  assert.match(f.edits.at(-1).text, /不可用（Python 不可执行）/);
  assert.equal(f.processes.length + f.requests.length, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

for (const state of ['available', 'unavailable', 'failed']) test('status dependency probe reports ' + state + ' with no cookies or network', async t => {
  const f = await fixture(t, {data: base, config: {pythonPath: '/fake/python'}, process: async () => processResult({state})});
  await f.run('.nodeseek status');
  assert.equal(f.processes.length, 1);
  assert.equal(f.processes[0].probe, true);
  assert.equal(f.processes[0].options.input, undefined);
  assert.equal(f.requests.length, 0);
  const expected = state === 'available' ? '可用（仅本地依赖导入检查）' : state === 'unavailable' ? '不可用（未安装 curl_cffi）' : '检查失败';
  assert.ok(f.edits[0].text.includes(expected));
  assert.equal(f.logs.filter(log => log.event === 'nodeseek.probe.failed').length, state === 'failed' ? 1 : 0);
});

test('status probe errors and invalid output stay bounded, observable and do not expose helper diagnostics', async t => {
  const cases = [
    async () => { throw Object.assign(new Error('private-probe-secret'), {code: 'SPAWN_FAILED'}); },
    async () => { throw Object.assign(new Error('private-probe-secret'), {code: 'TIMED_OUT'}); },
    async () => { throw Object.assign(new Error('private-probe-secret'), {code: 'OUTPUT_LIMIT'}); },
    async () => ({stdout: Buffer.from('{bad'), stderr: Buffer.alloc(0), exitCode: 0}),
    async () => ({...processResult({state: 'available'}), stderr: Buffer.alloc(4096)}),
    async () => ({...processResult({state: 'available'}), exitCode: 1}),
    async () => processResult({state: 'unknown'}),
  ];
  for (let index = 0; index < cases.length; index++) {
    const f = await fixture(t, {config: {pythonPath: '/fake/python'}, process: cases[index]});
    await f.run('.nodeseek status');
    assert.match(f.edits[0].text, index === 0 ? /Python 不可执行/ : /检查失败/);
    assert.equal(f.requests.length, 0);
    assert.doesNotMatch(JSON.stringify({logs: f.logs, edits: f.edits}), /private-probe-secret/);
  }
});

test('unload retains a noncooperative status probe until actual settlement and suppresses late status', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, {config: {pythonPath: '/fake/python'}, process: async () => {
    started.resolve(); await release.promise; return processResult({state: 'available'});
  }});
  const running = f.run('.nodeseek status').catch(error => error);
  await started.promise;
  try {
    const report = await f.host.unload('nodeseek', 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
    assert.equal(f.processes[0].options.signal.aborted, true);
  } finally { release.resolve(); }
  await running;
  assert.equal(f.edits.length, 0);
  assert.equal((await f.host.unload('nodeseek', 1000)).completed, true);
});

test('missing Python is an observable fallback failure, not invalid login or automatic installation', async t => {
  const f = await fixture(t, {data: base, fetch: challenge});
  const previous = process.env.PATH;
  process.env.PATH = f.root;
  try { await f.run('.nodeseek now'); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  assert.equal(f.processes.length, 0);
  assert.equal(f.requests.length, 3);
  assert.equal(f.logs.filter(item => item.event === 'nodeseek.fallback.failed').length, 3);
  assert.match(f.edits.at(-1).text, /fallback=失败/);
  assert.equal((await f.read()).lastDoneDate, '');
});

for (const code of ['SPAWN_FAILED', 'EXIT_FAILED', 'TIMED_OUT', 'OUTPUT_LIMIT', 'IO_FAILED', 'CONTROL_FAILED']) {
  test('fallback process error is bounded and observable: ' + code, async t => {
    const f = await fixture(t, {data: base, config: {pythonPath: '/fake/python'}, fetch: challenge,
      process: async () => { throw Object.assign(new Error('private-helper-credential'), {code, stderr: Buffer.from(cookie)}); }});
    await f.run('.nodeseek now');
    assert.equal(f.processes.length, 3);
    assert.equal(f.logs.filter(item => item.event === 'nodeseek.fallback.failed').length, 3);
    assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private-helper|fictional-secret|second-secret/);
    assert.equal((await f.read()).lastDoneDate, '');
  });
}

test('malformed or oversized fallback output rejects while preserving primary WAF classification', async t => {
  for (const output of [
    {stdout: Buffer.from('{bad'), stderr: Buffer.alloc(0), exitCode: 0},
    processResult(null), processResult({status: 999, server: '', text: '{}'}),
    processResult({status: 200, server: 5, text: '{}'}), processResult({status: 200, server: '', text: 'x'.repeat(65537)}),
    {...processResult(), stderr: Buffer.alloc(1024 * 1024)}, {...processResult(), exitCode: 2},
  ]) {
    const f = await fixture(t, {data: base, config: {pythonPath: '/fake/python'}, fetch: challenge, process: async () => output});
    await f.run('.nodeseek now');
    assert.equal(f.processes.length, 3);
    assert.match(f.edits.at(-1).text, /并非 Cookie 失效/);
    assert.match(f.edits.at(-1).text, /fallback=失败/);
  }
});

test('daily cron skips disabled, missing-cookie and already-processed state', async t => {
  for (const data of [{...base, autoEnabled: false}, {...base, cookie: ''}, {...base, lastDoneDate: date()}]) {
    const f = await fixture(t, {data});
    await f.tick();
    assert.equal(f.requests.length + f.waits.length + f.sends.length, 0);
  }
});

test('daily cron keeps random window and saves result before literal Saved Messages notification', async t => {
  t.mock.method(Math, 'random', () => 0.5);
  const f = await fixture(t, {data: base});
  await f.tick();
  assert.deepEqual(f.waits.map(item => item.ms), [1770000]);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.read()).lastDoneDate, date());
  assert.equal(f.sends[0].target, 'me');
  assert.equal(f.sends[0].options.parseMode, false);
  assert.match(f.sends[0].options.message, /NodeSeek 签到成功/);
  await f.tick();
  assert.equal(f.requests.length, 1);
});

test('daily delay rereads disabled, cookie-cleared, manual-complete and replacement-cookie state', async t => {
  for (const change of [{autoEnabled: false}, {cookie: ''}, {lastDoneDate: date()}, {cookie: 'changed=fictional-new-cookie'}]) {
    const release = deferred();
    const f = await fixture(t, {data: base, wait: () => release.promise});
    const running = f.tick();
    await until(() => f.waits.length === 1);
    await fs.writeFile(path.join(f.dir, 'data.json'), JSON.stringify({...base, ...change}));
    release.resolve();
    await running;
    assert.equal(f.requests.length, change.cookie?.startsWith('changed=') ? 1 : 0);
    if (f.requests.length) assert.equal(f.requests[0].headers.get('Cookie'), change.cookie);
  }
});

test('cron notification errors remain observable after committed result', async t => {
  const f = await fixture(t, {data: base, send: async () => { throw new Error('private-Telegram-error'); }});
  await f.tick();
  assert.equal((await f.read()).lastDoneDate, date());
  assert.equal(f.logs.at(-1).event, 'scheduler.callback_failed');
  assert.doesNotMatch(JSON.stringify(f.logs), /private-Telegram/);
  assert.equal(f.host.snapshot().jobs.running, 0);
});

test('simultaneous manual/cron attempts do not duplicate a running sign-in', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, {data: base, fetch: async () => { started.resolve(); await release.promise; return successful(); }});
  const first = f.run('.nodeseek now');
  await started.promise;
  await f.host.dispatchPrimary({...envelope, chatId: 'other'});
  await f.tick();
  assert.equal(f.requests.length, 1);
  assert.match(f.edits.at(-1).text, /请等待当前签到完成/);
  release.resolve();
  await first;
});

test('replacing cookie in flight preserves the replacement completion reset and unknown fields', async t => {
  const release = deferred(), started = deferred();
  const f = await fixture(t, {data: base, fetch: async () => { started.resolve(); await release.promise; return successful(); }});
  const running = f.run('.nodeseek now');
  await started.promise;
  await f.host.dispatchPrimary({...envelope, chatId: 'other', text: '.nodeseek set session=fictional-new-cookie'});
  release.resolve();
  await running;
  assert.equal((await f.read()).cookie, 'session=fictional-new-cookie');
  assert.equal((await f.read()).lastDoneDate, '');
  assert.equal((await f.read()).lastResult, '');
  assert.deepEqual((await f.read()).unknown, base.unknown);
});

test('oversized HTTP streaming response is cancelled and retries without retaining readers', async t => {
  let cancelled = 0;
  const f = await fixture(t, {data: base, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled++; },
  }))});
  await f.run('.nodeseek now');
  assert.equal(cancelled, 3);
  assert.equal(f.requests.length, 3);
  assert.equal((await f.read()).lastDoneDate, '');
});

test('bounded HTTP parser accepts 64 KiB with split UTF-8 bytes', async t => {
  const raw = JSON.stringify({success: true, message: '获得鸡腿', padding: ''});
  const bytes = Buffer.from(JSON.stringify({success: true, message: '获得鸡腿', padding: 'x'.repeat(65536 - Buffer.byteLength(raw))}));
  const f = await fixture(t, {data: base, fetch: async () => new Response(new ReadableStream({
    start(controller) { const split = bytes.indexOf(Buffer.from('鸡腿')) + 1; controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close(); },
  }))});
  await f.run('.nodeseek now');
  assert.match(f.edits.at(-1).text, /获得鸡腿/);
  assert.equal(f.requests.length, 1);
});

test('64 KiB one-byte HTTP chunks are copied into fixed storage and decoded once', async t => {
  const raw = JSON.stringify({success: true, message: '获得🍗', padding: ''});
  const bytes = Buffer.from(JSON.stringify({success: true, message: '获得🍗', padding: 'x'.repeat(65536 - Buffer.byteLength(raw))}));
  let offset = 0, calls = 0;
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, 'decode', function (...args) { calls++; return decode.apply(this, args); });
  const f = await fixture(t, {data: base, fetch: async () => new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    },
  }))});
  await f.run('.nodeseek now');
  assert.equal(offset, 65536);
  assert.equal(calls, 1);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.read()).lastResult, '获得🍗');
});

test('one-byte chunks exceeding 64 KiB cancel the stream on each attempt', async t => {
  let cancelled = 0;
  const f = await fixture(t, {data: base, fetch: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array([32])); }, cancel() { cancelled++; },
  }))});
  await f.run('.nodeseek now');
  assert.equal(f.requests.length, 3);
  assert.equal(cancelled, 3);
  assert.equal((await f.read()).lastDoneDate, '');
});

test('15-second HTTP deadline waits for actual fetch settlement before retrying', async t => {
  const release = deferred();
  let first = true;
  const f = await fixture(t, {data: base, fetch: async () => {
    if (first) { first = false; await release.promise; }
    return successful();
  }});
  t.mock.timers.enable({apis: ['setTimeout']});
  try {
    const running = f.run('.nodeseek now');
    await until(() => f.requests.length === 1);
    t.mock.timers.tick(15000);
    assert.equal(f.requests[0].init.signal.aborted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
    assert.equal(f.edits.length, 1);
    t.mock.timers.reset();
    release.resolve();
    await running;
    assert.equal(f.requests.length, 2);
    assert.equal(f.logs[0].fields.timeout, true);
  } finally { release.resolve(); t.mock.timers.reset(); }
});

for (const phase of ['http', 'process', 'telegram']) test('unload keeps noncooperative ' + phase + ' pending until real settlement', async t => {
  const started = deferred(), release = deferred();
  const options = {data: base, config: {pythonPath: '/fake/python'}};
  if (phase === 'http') options.fetch = async () => { started.resolve(); await release.promise; return successful(); };
  if (phase === 'process') { options.fetch = challenge; options.process = async () => { started.resolve(); await release.promise; return processResult(); }; }
  if (phase === 'telegram') options.send = async () => { started.resolve(); await release.promise; };
  const f = await fixture(t, options);
  const running = phase === 'telegram' ? f.tick() : f.run('.nodeseek now');
  const observed = running.catch(error => error);
  await started.promise;
  try {
    const report = await f.host.unload('nodeseek', 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
    await assert.rejects(f.host.load(createNodeSeek()), /already loaded/);
    if (phase === 'http') assert.equal(f.requests[0].init.signal.aborted, true);
    if (phase === 'process') assert.equal(f.processes[0].options.signal.aborted, true);
  } finally { release.resolve(); }
  await observed;
  assert.equal((await f.host.unload('nodeseek', 1000)).completed, true);
  if (phase !== 'telegram') {
    assert.equal(f.edits.length, 1);
    assert.deepEqual(await f.read(), base);
  }
});

test('unload cancels streaming reader and waits for asynchronous reader cleanup', async t => {
  const started = deferred(), cleanup = deferred();
  let cancelled = 0;
  const f = await fixture(t, {data: base, fetch: async () => new Response(new ReadableStream({
    pull() { started.resolve(); }, cancel() { cancelled++; return cleanup.promise; },
  }))});
  const running = f.run('.nodeseek now').catch(error => error);
  await started.promise;
  assert.equal((await f.host.unload('nodeseek', 5)).completed, false);
  assert.equal(cancelled, 1);
  cleanup.resolve();
  await running;
  assert.equal((await f.host.unload('nodeseek', 1000)).completed, true);
  assert.deepEqual(await f.read(), base);
  assert.equal(f.edits.length, 1);
});

for (const phase of ['random delay', 'retry delay']) test('unload cancels ' + phase + ' and removes its native timer', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const baseline = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  const f = await fixture(t, {data: base, wait: nativeSleep,
    fetch: phase === 'retry delay' ? async () => Response.json({code: 9}) : successful});
  const running = (phase === 'random delay' ? f.tick() : f.run('.nodeseek now')).catch(error => error);
  await until(() => f.waits.length === 1);
  assert.equal((await f.host.unload('nodeseek', 1000)).completed, true);
  await running;
  assert.equal(f.waits[0].signal.aborted, true);
  assert.equal(f.requests.length, phase === 'random delay' ? 0 : 1);
  assert.ok(process.getActiveResourcesInfo().filter(name => name === 'Timeout').length <= baseline);
});

test('storage malformed JSON and symlink failures do not overwrite files or expose filesystem details', async t => {
  const f = await fixture(t, {data: base, config: {cookie: 'private-panel'}});
  const file = path.join(f.dir, 'data.json');
  await fs.writeFile(file, '{malformed');
  await f.run('.nodeseek now');
  assert.equal(await fs.readFile(file, 'utf8'), '{malformed');
  assert.match(f.edits.at(-1).text, /操作失败/);
  await fs.writeFile(path.join(f.dir, 'config.json'), '{malformed');
  await assert.rejects(f.host.readSettings('nodeseek'), /Settings adapter failed/);
  await assert.rejects(f.host.patchSettings('nodeseek', {interval: 5}), /Settings adapter failed/);
  await fs.unlink(file);
  const other = path.join(f.root, 'fixture-target.json');
  await fs.writeFile(other, JSON.stringify(base));
  await fs.symlink(other, file);
  await f.run('.nodeseek set session=new-private-cookie');
  assert.deepEqual(JSON.parse(await fs.readFile(other, 'utf8')), base);
  assert.equal(f.requests.length, 0);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), new RegExp(f.root));
});

test('Telegram edit failures are logged and failed final reporting rejects the command', async t => {
  const f = await fixture(t, {data: base, edit: async () => { throw new Error('private-telegram'); }});
  await assert.rejects(f.run('.nodeseek now'), /NodeSeek message delivery failed/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.logs[0].event, 'nodeseek.command.failed');
  assert.doesNotMatch(JSON.stringify(f.logs), /private-telegram/);
});

test('Core enforces owner/edited admission, saved messages and aliases', async t => {
  const f = await fixture(t, {hostOptions: {prefixes: ['!!', '.'], aliases: {ns: 'nodeseek'}}});
  assert.equal(await f.host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await f.host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(f.requests.length + f.edits.length, 0);
  assert.equal(await f.host.dispatchPrimary({...envelope, outgoing: false, saved: true, text: '.nodeseek help'}), true);
  await f.run('!!ns status');
  assert.match(f.edits.at(-1).text, /Cookie：未设置/);
});

test('50 reload cycles preserve state and fully release cron, settings, tasks and timers', async t => {
  const baseline = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  const f = await fixture(t, {data: base, config: {cookie: 'panel-private', custom: {keep: true}}});
  for (let cycle = 0; cycle < 50; cycle++) {
    await f.run('.nodeseek now');
    await f.host.patchSettings('nodeseek', {interval: cycle + 1});
    const report = await f.host.unload('nodeseek');
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks + report.pendingResources, 0);
    const snapshot = f.host.snapshot();
    assert.equal(snapshot.plugins + snapshot.commands + snapshot.jobs.jobs + snapshot.jobs.running, 0);
    assert.equal(snapshot.queue.active + snapshot.queue.queued, 0);
    assert.deepEqual(await f.host.listSettings(), []);
    await assert.rejects(f.host.readSettings('nodeseek'), /unavailable/);
    assert.deepEqual((await f.read()).unknown, base.unknown);
    assert.equal((await f.read('config.json')).cookie, 'panel-private');
    if (cycle < 49) await f.host.load(createNodeSeek());
  }
  assert.equal(f.requests.length, 50);
  assert.ok(process.getActiveResourcesInfo().filter(name => name === 'Timeout').length <= baseline);
});
