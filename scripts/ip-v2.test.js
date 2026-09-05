'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

const envelope = {id: 17, chatId: '9007199254740993', senderId: '123', outgoing: true, text: '.ip 8.8.8.8'};
const fields = 'status,message,country,regionName,city,isp,org,as,query,timezone,proxy,hosting';
const success = {
  status: 'success', query: '8.8.8.8', country: '美国', regionName: '加利福尼亚州', city: '山景城',
  isp: 'Google LLC', org: 'Google Public DNS', as: 'AS15169 Google LLC', timezone: 'America/Los_Angeles',
  proxy: false, hosting: false,
};
let buildRoot, createIp, manifest;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

test.before(async () => {
  test.mock.method(globalThis, 'fetch', () => assert.fail('real network is forbidden, including at import time'));
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-ip-candidate-')));
  await fs.mkdir(path.join(buildRoot, 'node_modules'));
  await fs.symlink(core, path.join(buildRoot, 'node_modules', 'telebox'), 'dir');
  const built = buildPlugin({id: 'ip', packageRoot: path.resolve(__dirname, '../ip'), entry: 'v2.ts', rootDir: buildRoot});
  manifest = built.manifest;
  createIp = require(path.join(built.artifactDir, 'index.cjs')).default;
});

test.after(async () => {
  if (buildRoot) await fs.rm(buildRoot, {recursive: true, force: true});
  test.mock.restoreAll();
});

async function fixture(t, {fetch: fetcher = async () => Response.json(success), reply, edit, hostOptions = {}} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-ip-v2-')));
  const edits = [], requests = [], replyReads = [], logs = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {info(event, data) { logs.push({event, data}); }, error(event, data) { logs.push({event, data}); }},
    http: {fetch: async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, 'http://ip-api.com');
      assert.equal(url.username, '');
      assert.equal(url.password, '');
      assert.ok(url.pathname.startsWith('/json/'));
      assert.equal(url.searchParams.get('lang'), 'zh-CN');
      assert.equal(url.searchParams.get('fields'), fields);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('User-Agent'), 'TeleBox-IP-Plugin/1.0');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      requests.push({url, init, target: decodeURIComponent(url.pathname.slice('/json/'.length))});
      return fetcher(url, init);
    }},
    telegram: {
      async edit(message, text, options, signal) {
        assert.equal(signal.aborted, false, 'no edit may be submitted after cancellation');
        edits.push({message, text, options, signal});
        if (edit) await edit(message, text, options, signal);
      },
      async reply() { assert.fail('IP output should edit the command message'); },
      async getReply(message, signal) {
        replyReads.push({message, signal});
        const text = typeof reply === 'function' ? await reply(message, signal) : reply;
        return text === undefined ? undefined : {...envelope, id: 18, text};
      },
      async withClient() { assert.fail('unexpected native Telegram call'); },
      async invoke() { assert.fail('unexpected RPC'); },
    },
    ...hostOptions,
  });
  await host.load(createIp());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    assert.deepEqual(await fs.readdir(root), [], 'IP has no persistent configuration or cache');
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, root, edits, requests, replyReads, logs, run: text => host.dispatchPrimary({...envelope, text})};
}

test('ip candidate exports a pure factory and imports only the SDK and native input validators', async t => {
  assert.equal(typeof createIp, 'function');
  const first = createIp(), second = createIp();
  assert.notEqual(first, second);
  assert.equal(first.id, 'ip');
  assert.equal(first.apiVersion, 1);
  assert.deepEqual(Object.keys(first.commands), ['ip']);
  assert.deepEqual(manifest.imports, ['node:net', 'node:url', 'telebox/sdk']);
  assert.equal(first.setup, undefined);
  assert.equal(first.cleanup, undefined);
  const {requests, edits, replyReads} = await fixture(t);
  assert.equal(requests.length + edits.length + replyReads.length, 0);
});

test('empty input preserves help, examples and HTML mode without provider requests', async t => {
  const {run, edits, requests, replyReads} = await fixture(t);
  await run('.ip');
  assert.equal(edits[0].text, `📍 <b>IP查询插件</b>

<b>使用方法：</b>
• <code>ip &lt;IP地址&gt;</code>
• <code>ip &lt;域名&gt;</code>
• 回复包含IP/域名的消息后使用 <code>ip</code>

<b>示例：</b>
• <code>ip 8.8.8.8</code>
• <code>ip google.com</code>
• <code>ip 2001:4860:4860::8888</code>`);
  assert.deepEqual(edits[0].options, {parseMode: 'html'});
  assert.equal(replyReads.length, 1);
  assert.equal(requests.length, 0);
  await run('.ip \t\n');
  assert.equal(edits.at(-1).text, edits[0].text);
});

test('IPv4, IPv6, domains and hostname boundaries query the original provider', async t => {
  const {run, requests, replyReads} = await fixture(t);
  const maximum = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  assert.equal(maximum.length, 253);
  const cases = [
    ['8.8.8.8', '8.8.8.8'], ['0.0.0.0', '0.0.0.0'], ['255.255.255.255', '255.255.255.255'],
    ['2001:4860:4860::8888', '2001:4860:4860::8888'], ['::1', '::1'],
    ['::ffff:192.0.2.1', '::ffff:192.0.2.1'], ['google.com', 'google.com'],
    ['EXAMPLE.COM', 'example.com'], ['example.com.', 'example.com.'], ['bücher.de', 'xn--bcher-kva.de'],
    [maximum, maximum], [maximum + '.', maximum + '.'],
  ];
  for (const [input, expected] of cases) {
    await run('.ip\t' + input + '\n');
    assert.equal(requests.at(-1).target, expected);
  }
  assert.equal(requests.length, cases.length);
  assert.equal(replyReads.length, 0);
});

test('result preserves field order, proxy/hosting warnings, timezone and AS preview', async t => {
  const {run, edits} = await fixture(t, {fetch: async () => Response.json({...success, proxy: true, hosting: true})});
  await run('.ip google.com');
  assert.equal(edits[0].text, '🔍 <b>正在查询:</b> <code>google.com</code>');
  assert.equal(edits[1].text, `此 IP 可能为代理 IP
此 IP 可能为数据中心 IP

🌍 <b>IP/域名查询结果</b>

<b>🔍 查询目标:</b> <code>8.8.8.8</code>
<b>📍 地理位置:</b> 美国 - 加利福尼亚州 - 山景城
<b>🏢 ISP:</b> Google LLC
<b>🏦 组织:</b> Google Public DNS
<b>🔢 AS号:</b> <code>AS15169 Google LLC</code>
<b>⏰ 时区:</b> America/Los_Angeles

https://bgp.he.net/AS15169`);
  assert.deepEqual(edits[1].options, {parseMode: 'html', linkPreview: true});
  assert.equal(edits[1].message.id, envelope.id);
  assert.equal(edits[1].message.chatId, envelope.chatId);
});

test('missing optional fields retain N/A fallbacks and omit conditional output', async t => {
  const {run, edits} = await fixture(t, {fetch: async () => Response.json({status: 'success', country: '', regionName: null})});
  await run('.ip 8.8.8.8');
  const output = edits.at(-1).text;
  assert.equal((output.match(/N\/A/g) || []).length, 7);
  assert.doesNotMatch(output, /代理 IP|数据中心 IP|时区|bgp\.he\.net/);
});

test('reply extraction keeps IPv4 then domain then first-word priority', async t => {
  const cases = [
    ['domain example.com first, IPv4 8.8.4.4 later', '8.8.4.4'],
    ['visit https://example.com/path?q=test', 'example.com'],
    ['Look up example.com.', 'example.com'],
    ['2001:4860:4860::8888 some text', '2001:4860:4860::8888'],
    ['2001:db8::1 and example.com', 'example.com'],
    ['https://alice:top-secret@example.com/private', 'example.com'],
    ['bücher.de', 'xn--bcher-kva.de'],
  ];
  for (const [reply, expected] of cases) {
    const {run, requests, edits} = await fixture(t, {reply});
    await run('.ip');
    assert.equal(requests[0].target, expected);
    assert.doesNotMatch(JSON.stringify(edits), /top-secret/);
  }
  const explicit = await fixture(t, {reply: '1.1.1.1'});
  await explicit.run('.ip 8.8.8.8');
  assert.equal(explicit.requests[0].target, '8.8.8.8');
  assert.equal(explicit.replyReads.length, 0);
});

test('blank replies and reply-read failures preserve help without exposing transport errors', async t => {
  for (const reply of ['', ' \n\t ', async () => { throw new Error('secret reply credentials'); }]) {
    const {run, edits, requests, logs} = await fixture(t, {reply});
    await run('.ip');
    assert.match(edits.at(-1).text, /使用方法/);
    assert.equal(requests.length, 0);
    assert.doesNotMatch(JSON.stringify({edits, logs}), /secret reply/);
  }
});

test('invalid addresses and credential URLs fail locally with bounded escaped output', async t => {
  const {run, edits, requests} = await fixture(t);
  const invalid = [
    '999.999.999.999', '8.8.8.08', '2001:db8:::1', 'fe80::1%en0', '[::1]', '8.8.8.8/24',
    'http://user:top-secret@example.com/private', 'https://example.com', '//example.com',
    'user:top-secret@example.com', 'example.com:443', 'example.com?token=secret', '../example.com',
    'example.com\\private', '-bad.example', 'bad-.example', 'a..example', 'localhost',
    '8.8.8.8 google.com', '<b>evil</b>', 'a'.repeat(64) + '.com', 'a'.repeat(10000),
  ];
  for (const query of invalid) {
    await run('.ip ' + query);
    assert.match(edits.at(-1).text, /请提供有效的IP地址或域名/);
    assert.ok(edits.at(-1).text.length < 2500);
  }
  assert.equal(requests.length, 0);
  assert.doesNotMatch(edits.map(edit => edit.text).join('\n'), /top-secret|token=secret|<b>evil<\/b>/);
  assert.ok(edits.some(edit => edit.text.includes('&lt;b&gt;evil&lt;/b&gt;')));
  const reply = await fixture(t, {reply: '999.999.999.999 example.com'});
  await reply.run('.ip');
  assert.equal(reply.requests.length, 0);
});

test('provider fields and business errors are escaped including AS hyperlink boundaries', async t => {
  const injected = '<b>owned</b>&"\'';
  const expected = '&lt;b&gt;owned&lt;/b&gt;&amp;&quot;&#x27;';
  const data = {...success};
  for (const field of ['query', 'country', 'regionName', 'city', 'isp', 'org', 'timezone']) data[field] = injected;
  data.as = 'AS123' + injected;
  const {run, edits} = await fixture(t, {fetch: async () => Response.json(data)});
  await run('.ip 8.8.8.8');
  assert.equal(edits.at(-1).text.split(expected).length - 1, 8);
  assert.ok(edits.at(-1).text.endsWith('https://bgp.he.net/AS123'));
  assert.doesNotMatch(edits.at(-1).text, /<b>owned<\/b>/);
  const failed = await fixture(t, {fetch: async () => Response.json({status: 'fail', message: injected})});
  await failed.run('.ip 8.8.8.8');
  assert.match(failed.edits.at(-1).text, /查询失败/);
  assert.ok(failed.edits.at(-1).text.includes(expected));
});

test('business API failures are displayed verbatim and have no retry or fallback provider', async t => {
  for (const message of ['private range', 'reserved range', 'invalid query', 'SSL unavailable for this endpoint', 'rate limited', '']) {
    const {run, requests, edits} = await fixture(t, {fetch: async () => Response.json({status: 'fail', message})});
    await run('.ip 127.0.0.1');
    assert.match(edits.at(-1).text, /查询失败/);
    assert.ok(edits.at(-1).text.includes(message || '查询失败，请检查IP地址或域名是否正确'));
    assert.equal(requests.length, 1);
  }
});

test('non-200 statuses including redirects and quota failures are explicit without following Location', async t => {
  for (const status of [201, 204, 301, 302, 403, 429, 500, 503]) {
    const {run, edits, requests} = await fixture(t, {fetch: async () => new Response(status === 204 ? null : 'not JSON', {
      status, headers: {Location: 'https://user:secret@other.invalid/private'},
    })});
    await run('.ip 8.8.8.8');
    assert.ok(edits.at(-1).text.includes('API请求失败，HTTP状态码: ' + status));
    assert.equal(requests.length, 1);
    assert.doesNotMatch(edits.at(-1).text, /other\.invalid|secret/);
  }
});

test('malformed provider JSON and schema failures produce the original parsing-error presentation', async t => {
  const cases = ['{broken', '', 'null', '[]', '"text"', '{}', JSON.stringify({status: 'other'}),
    JSON.stringify({...success, as: 123}), JSON.stringify({...success, country: {injected: true}}),
    JSON.stringify({...success, proxy: 'true'}), JSON.stringify({status: 'fail', message: {bad: true}})];
  for (const body of cases) {
    const {run, edits, requests} = await fixture(t, {fetch: async () => new Response(body)});
    await run('.ip 8.8.8.8');
    assert.match(edits.at(-1).text, /数据解析失败/);
    assert.match(edits.at(-1).text, /API返回了非预期的数据格式/);
    assert.equal(requests.length, 1);
  }
});

test('response and rendered output limits reject oversized data and cancel body readers', async t => {
  let canceled = 0;
  const {run, edits} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537).fill(65)); },
    cancel() { canceled++; },
  }), {headers: {'Content-Length': '1'}})});
  await run('.ip 8.8.8.8');
  assert.match(edits.at(-1).text, /数据解析失败/);
  assert.equal(canceled, 1);
  for (const body of [{...success, org: '<'.repeat(1000)}, {status: 'fail', message: 'x'.repeat(5000)}]) {
    const bounded = await fixture(t, {fetch: async () => Response.json(body)});
    await bounded.run('.ip 8.8.8.8');
    assert.match(bounded.edits.at(-1).text, /数据解析失败/);
    assert.ok(bounded.edits.at(-1).text.length < 4000);
  }
});

test('native DNS and connection-refused errors preserve localized messages without leaking details', async t => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
    for (const wrapped of [false, true]) {
      const native = Object.assign(new Error('http://user:private-token@secret-host/?token=private-token'), {code});
      const upstream = wrapped ? new TypeError('fetch failed private-token', {cause: native}) : native;
      const {run, edits, logs, requests} = await fixture(t, {fetch: async () => { throw upstream; }});
      await run('.ip 8.8.8.8');
      const reason = code === 'ECONNREFUSED' ? '连接被拒绝，请稍后重试' : 'DNS解析失败，请检查网络连接';
      assert.equal(edits.at(-1).text, `❌ <b>查询失败</b>

<b>查询目标:</b> <code>8.8.8.8</code>
<b>失败原因:</b> ${reason}

💡 <b>建议:</b>
• 检查IP地址或域名格式
• 稍后重试查询`);
      assert.doesNotMatch(JSON.stringify({edits, logs}), /secret-host|private-token|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/);
      assert.equal(requests.length, 1);
      assert.equal(edits.length, 2);
    }
  }
});

test('unclassified network failures stay generic without leaking upstream details', async t => {
  const native = Object.assign(new Error('secret-host'), {code: 'ENOTFOUND'});
  const cases = [
    ...['getaddrinfo ENOTFOUND secret-host', 'EAI_AGAIN secret-host', 'ECONNREFUSED secret-host', 'upstream private-token'].map(reason => new Error(reason)),
    Object.assign(new Error('private-token'), {code: 'ECONNRESET'}),
    new TypeError('private-token', {cause: new Error('secret-host', {cause: native})}),
  ];
  for (const upstream of cases) {
    const {run, edits, logs, requests} = await fixture(t, {fetch: async () => { throw upstream; }});
    await run('.ip 8.8.8.8');
    assert.match(edits.at(-1).text, /网络请求失败/);
    assert.doesNotMatch(JSON.stringify({edits, logs}), /secret-host|private-token/);
    assert.equal(requests.length, 1);
  }
});

test('bounded response consumption accepts 64 KiB and reassembles split UTF-8', async t => {
  const base = {...success, padding: ''};
  const padding = 65536 - Buffer.byteLength(JSON.stringify(base));
  const bytes = Buffer.from(JSON.stringify({...base, padding: 'x'.repeat(padding)}));
  assert.equal(bytes.byteLength, 65536);
  const {run, edits} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    start(controller) {
      const split = bytes.indexOf(Buffer.from('美国')) + 1;
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  }))});
  await run('.ip 8.8.8.8');
  assert.match(edits.at(-1).text, /美国 - 加利福尼亚州 - 山景城/);
  assert.doesNotMatch(edits.at(-1).text, /数据解析失败|�/);
});

test('response stream failures report a network error and leave the next query usable', async t => {
  let calls = 0;
  const {run, edits, logs} = await fixture(t, {fetch: async () => {
    if (++calls > 1) return Response.json(success);
    return new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private-stream-error')); },
    }));
  }});
  await run('.ip 8.8.8.8');
  assert.match(edits.at(-1).text, /网络请求失败/);
  assert.doesNotMatch(JSON.stringify({edits, logs}), /private-stream-error/);
  await run('.ip 8.8.8.8');
  assert.match(edits.at(-1).text, /IP\/域名查询结果/);
});

test('the original 15-second request deadline displays timeout while keeping the plugin active', async t => {
  const started = deferred();
  const {run, edits, requests, host} = await fixture(t, {fetch: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new TypeError('private-token', {
      cause: Object.assign(new Error('secret-host'), {code: 'ENOTFOUND'}),
    })), {once: true});
    started.resolve();
  })});
  t.mock.timers.enable({apis: ['setTimeout']});
  const running = run('.ip 8.8.8.8');
  await started.promise;
  t.mock.timers.tick(15000);
  await running;
  assert.match(edits.at(-1).text, /请求超时，请稍后重试/);
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(host.snapshot().plugins, 1);
  t.mock.timers.reset();
});

test('message-edit errors retain a bounded final error and expose no private exception', async t => {
  let calls = 0;
  const {run, edits, requests, logs} = await fixture(t, {edit: async () => {
    if (++calls === 1) throw new Error('private-transport-credential');
  }});
  await run('.ip 8.8.8.8');
  assert.equal(requests.length, 0);
  assert.match(edits.at(-1).text, /IP查询失败/);
  assert.doesNotMatch(JSON.stringify({edits, logs}), /private-transport-credential/);
});

test('unload cancels an active fetch and suppresses late success or failure', async t => {
  for (const fail of [false, true]) {
    const started = deferred(), release = deferred();
    const {run, host, edits, requests} = await fixture(t, {fetch: async () => {
      started.resolve();
      await release.promise;
      if (fail) throw new TypeError('private-token', {
        cause: Object.assign(new Error('secret-host'), {code: 'ECONNREFUSED'}),
      });
      return Response.json(success);
    }});
    const running = run('.ip 8.8.8.8');
    await started.promise;
    try {
      const report = await host.unload('ip', 5);
      assert.equal(report.completed, false);
      assert.ok(report.pendingTasks > 0);
      assert.equal(requests[0].init.signal.aborted, true);
      await assert.rejects(host.load(createIp()), /already loaded/);
    } finally { release.resolve(); }
    await running;
    assert.equal((await host.unload('ip', 1000)).completed, true);
    assert.equal(edits.length, 1);
  }
});

test('cancellation during reply lookup suppresses help, requests and late output', async t => {
  const started = deferred(), release = deferred();
  const {run, host, edits, requests, replyReads} = await fixture(t, {reply: async () => {
    started.resolve(); await release.promise; return '8.8.8.8';
  }});
  const running = run('.ip');
  await started.promise;
  try { assert.equal((await host.unload('ip', 5)).completed, false); }
  finally { release.resolve(); }
  await running;
  assert.equal(replyReads[0].signal.aborted, true);
  assert.equal(edits.length + requests.length, 0);
  assert.equal((await host.unload('ip')).completed, true);
});

test('cancellation during response streaming releases the reader and emits no late result', async t => {
  const started = deferred();
  let canceled = 0, pulls = 0;
  const {run, host, edits} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('{"status":"success",'));
      else started.resolve();
    },
    cancel() { canceled++; },
  }))});
  const running = run('.ip 8.8.8.8');
  await started.promise;
  assert.equal((await host.unload('ip')).completed, true);
  await running;
  assert.equal(canceled, 1);
  assert.equal(edits.length, 1);
});

test('owner admission, saved messages, edited-message policy and prefix aliases are enforced by Core', async t => {
  const {host, requests, edits, run} = await fixture(t, {hostOptions: {prefixes: ['!!', '.'], aliases: {lookup: 'ip'}}});
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(requests.length + edits.length, 0);
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false, saved: true}), true);
  await run('!!lookup 1.1.1.1');
  assert.equal(requests[1].target, '1.1.1.1');
});

test('50 reload cycles keep resources bounded and query afresh without persisted state', async t => {
  const {host, run, requests} = await fixture(t);
  for (let cycle = 0; cycle < 50; cycle++) {
    await run('.ip 8.8.8.8');
    const report = await host.unload('ip');
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks, 0);
    assert.equal(report.pendingResources, 0);
    const snapshot = host.snapshot();
    assert.equal(snapshot.plugins, 0);
    assert.equal(snapshot.commands, 0);
    assert.equal(snapshot.queue.active, 0);
    assert.equal(snapshot.queue.queued, 0);
    if (cycle < 49) await host.load(createIp());
  }
  assert.equal(requests.length, 50);
});
