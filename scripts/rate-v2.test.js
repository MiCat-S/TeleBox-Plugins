'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const vm = require('node:vm');
const envelope = {id: 17, chatId: '9007199254740993', senderId: '123', outgoing: true, text: '.rate BTC'};
const rateHosts = ['api.exchangerate.host', 'open.er-api.com', 'api.frankfurter.app', 'api.coinbase.com', 'cdn.jsdelivr.net'];
const listPath = '/api/v3/simple/supported_vs_currencies';
let buildRoot, createRate, manifest, oldTables, newTables;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

// Parse the static table section only; never import or execute the legacy singleton.
function tables(source) {
  const start = source.indexOf('const FIAT_CURRENCIES');
  const end = source.indexOf('// HTML转义工具');
  assert.ok(start >= 0);
  const section = source.slice(start, end < 0 ? source.length : end).replace(/^export /gm, '');
  const {code} = esbuild.transformSync(section, {loader: 'ts', target: 'node24'});
  return JSON.parse(vm.runInNewContext(code + '\nJSON.stringify({FIAT_CURRENCIES, CRYPTO_CURRENCIES})', Object.create(null), {timeout: 1000}));
}

test.before(async () => {
  test.mock.method(globalThis, 'fetch', () => assert.fail('real network is forbidden'));
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-rate-candidate-')));
  await fs.mkdir(path.join(buildRoot, 'node_modules'));
  await fs.symlink(core, path.join(buildRoot, 'node_modules/telebox'), 'dir');
  const built = buildPlugin({id: 'rate', packageRoot: path.resolve(__dirname, '../rate'), entry: 'v2.ts', rootDir: buildRoot});
  manifest = built.manifest;
  createRate = require(path.join(built.artifactDir, 'index.cjs')).default;
  oldTables = tables(await fs.readFile(path.resolve(__dirname, '../rate/rate.ts'), 'utf8'));
  newTables = tables(await fs.readFile(path.resolve(__dirname, '../rate/v2/currencies.ts'), 'utf8'));
});

test.after(async () => {
  if (buildRoot) await fs.rm(buildRoot, {recursive: true, force: true});
  test.mock.restoreAll();
});

const successFetch = async url => {
  if (url.pathname === listPath) return Response.json(['usd', 'eur', 'zzz']);
  if (url.hostname === 'api.binance.com') {
    const prices = {BTCUSDT: '100', ETHUSDT: '20', BTCETH: '5', USDTBUSD: '1'};
    const price = prices[url.searchParams.get('symbol')];
    return price ? Response.json({price}) : new Response('pair missing', {status: 400});
  }
  return Response.json({rates: {USD: 1, CNY: 7, TRY: 30, EUR: 0.9, ZZZ: 2}});
};

async function fixture(t, {fetch: fetcher = successFetch, edit, hostOptions = {}} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-rate-v2-')));
  const edits = [], requests = [], logs = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {info(event, data) { logs.push({event, data}); }, error(event, data) { logs.push({event, data}); }},
    http: {fetch: async (input, init) => {
      const url = new URL(input);
      assert.ok([...rateHosts, 'api.binance.com', 'api.coingecko.com'].includes(url.hostname));
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username + url.password, '');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      requests.push({url, init});
      return fetcher(url, init);
    }},
    telegram: {
      async edit(message, text, options, signal) {
        assert.equal(signal.aborted, false, 'no transport admission after cancellation');
        assert.ok(text.length <= 4000, 'UTF-16 output budget');
        assert.ok(text.isWellFormed());
        assert.deepEqual(options, {parseMode: 'html', linkPreview: false});
        edits.push({message, text, options, signal});
        if (edit) await edit(message, text, options, signal);
      },
      async reply() { assert.fail('rate edits its command message'); },
      async getReply() { assert.fail('rate does not read replies'); },
      async invoke() { assert.fail('native RPC forbidden'); },
      async withClient() { assert.fail('raw Telegram access forbidden'); },
    },
    ...hostOptions,
  });
  await host.load(createRate());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    assert.deepEqual(await fs.readdir(root), [], 'rate has no persisted configuration or data');
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, root, edits, requests, logs, run: text => host.dispatchPrimary({...envelope, text})};
}

test('pure synchronous factory, SDK-only imports and no setup side effects', async t => {
  const first = createRate(), second = createRate();
  assert.notEqual(first, second);
  assert.equal(typeof first.then, 'undefined');
  assert.equal(first.id, 'rate');
  assert.equal(first.apiVersion, 1);
  assert.deepEqual(Object.keys(first.commands), ['rate']);
  assert.deepEqual(manifest.imports, ['telebox/sdk']);
  assert.equal(first.setup, undefined);
  assert.equal(first.jobs, undefined);
  assert.equal(first.settings, undefined);
  assert.ok(manifest.sources.every(source => source.file === 'v2.ts' || source.file.startsWith('v2/')));
  const {requests, edits} = await fixture(t);
  assert.equal(requests.length + edits.length, 0);
});

test('every legacy currency, name, symbol and alias is retained exactly', () => {
  assert.deepEqual(newTables, oldTables);
  assert.equal(Object.keys(newTables.CRYPTO_CURRENCIES).length, 30);
  assert.ok(Object.keys(newTables.FIAT_CURRENCIES).length > 140);
});

test('help, h and empty args preserve examples without HTTP', async t => {
  const {run, edits, requests} = await fixture(t);
  for (const text of ['.rate', '.rate help', '.rate h', '.rate \t\n']) {
    await run(text);
    assert.match(edits.at(-1).text, /智能汇率查询助手/);
    for (const example of ['rate BTC', 'rate ETH CNY', 'rate CNY TRY', 'rate BTC CNY 0.5', 'rate CNY USDT 7000']) {
      assert.ok(edits.at(-1).text.includes(example));
    }
  }
  assert.equal(requests.length, 0);
});

test('all built-in fiat codes and aliases use the original canonical symbols locally', async t => {
  const {run, requests, edits} = await fixture(t);
  for (const [name, info] of Object.entries(oldTables.FIAT_CURRENCIES)) {
    for (const token of [name, ...(info.aliases || []), ...(name === 'myr' ? ['rm'] : [])]) {
      const before = requests.length;
      await run('.rate ' + token.toUpperCase() + ' USD');
      if (requests.length > before) assert.equal(requests.at(-1).url.searchParams.get('base'), info.symbol.toLowerCase());
      assert.ok(edits.at(-1).text.includes('1.00 ' + info.symbol));
    }
  }
  assert.ok(requests.every(({url}) => url.hostname === 'api.exchangerate.host' && url.pathname === '/latest'));
});

test('all built-in crypto codes and aliases keep Binance symbols and need no discovery', async t => {
  const {run, requests, edits} = await fixture(t, {fetch: async url =>
    url.hostname === 'api.binance.com' ? Response.json({price: '2'}) : successFetch(url)});
  for (const [name, info] of Object.entries(oldTables.CRYPTO_CURRENCIES)) {
    for (const token of [name, ...(info.aliases || [])]) {
      const before = requests.length;
      await run('.rate ' + token.toUpperCase());
      assert.equal(requests.slice(before).find(({url}) => url.hostname === 'api.binance.com').url.searchParams.get('symbol'), info.symbol + 'USDT');
      assert.ok(edits.at(-1).text.includes(`1 ${info.symbol} = 2.00 USD`));
    }
  }
  assert.ok(requests.every(({url}) => url.pathname !== listPath));
});

test('default USD, amount in any position, last amount wins and legacy numeric prefixes', async t => {
  const {run, edits} = await fixture(t);
  for (const text of ['.rate BTC CNY 0.5', '.rate 0.5 BTC CNY', '.rate BTC 0.5 CNY', '.rate 4 BTC CNY .5', '.rate BTC CNY 0.5btc']) {
    await run(text);
    assert.match(edits.at(-1).text, /0\.500000 BTC ≈/);
    assert.match(edits.at(-1).text, /350\.00 CNY/);
  }
  await run('.rate 2');
  assert.match(edits.at(-1).text, /2\.00 BTC ≈/);
  assert.match(edits.at(-1).text, /200\.00 USD/);
  await run('.rate BTC USD EUR 2');
  assert.match(edits.at(-1).text, /200\.00 USD/);
});

test('four conversion presentations, USD benchmarks and Shanghai timestamps', async t => {
  const {run, edits} = await fixture(t);
  const cases = [
    ['.rate BTC', /1 BTC = 100\.00 USD/, /数据更新/],
    ['.rate BTC CNY 2', /1 BTC = 700\.00 CNY/, /1,400\.00 CNY/],
    ['.rate CNY BTC 700', /1 BTC = 700\.00 CNY/, /1\.00 BTC/],
    ['.rate CNY TRY 2', /1 CNY = 30\.00 TRY/, /更新时间/],
    ['.rate BTC ETH 2', /1 BTC = 5\.00 ETH/, /BTC \$100\.00 • ETH \$20\.00/],
    ['.rate CNY USDT 7000', /1 USDT = 7\.00 CNY/, /1,000\.00 USDT/],
  ];
  for (const [command, expected, detail] of cases) {
    await run(command);
    assert.match(edits.at(-1).text, expected);
    assert.match(edits.at(-1).text, detail);
    assert.match(edits.at(-1).text, /⏰ <b>.+:<\/b> \d{4}\/\d{1,2}\/\d{1,2}/);
  }
  assert.deepEqual(edits.slice(0, 3).map(edit => edit.text), ['⚡ 正在获取最新汇率数据...', '🔍 正在识别货币类型...', '⏳ 正在获取汇率数据...']);
  assert.equal(edits[0].message.chatId, envelope.chatId);
});

for (const [price, expected] of [[1.23456, '1.23'], [0.1, '0.1000'], [0.001, '0.001000'], [0.000001, '1.00e-6']]) {
  test(`price formatting preserves precision tier ${price}`, async t => {
    const {run, edits} = await fixture(t, {fetch: async url => url.hostname === 'api.binance.com' ? Response.json({price}) : successFetch(url)});
    await run('.rate BTC');
    assert.ok(edits.at(-1).text.includes(`1 BTC = ${expected} USD`));
  });
}

test('zero and negative amounts remain supported', async t => {
  const {run, edits} = await fixture(t);
  await run('.rate BTC USD 0');
  assert.match(edits.at(-1).text, /0\.000000 USD/);
  await run('.rate BTC USD -2');
  assert.match(edits.at(-1).text, /-200\.000000 USD/);
});

for (let source = 0; source < rateHosts.length; source++) {
  test(`fiat fallback ${source + 1} preserves provider order and response envelope`, async t => {
    const {run, requests, edits} = await fixture(t, {fetch: async url => {
      if (url.hostname !== rateHosts[source]) return new Response('private-token', {status: 503});
      const rates = {USD: '1', EUR: '0.9'};
      return Response.json(source === 3 ? {data: {rates}} : source === 4 ? {usd: rates, date: '2026-09-06'} : source === 1 ? {result: 'success', rates} : {rates});
    }});
    await run('.rate USD EUR');
    assert.deepEqual(requests.map(request => request.url.hostname), rateHosts.slice(0, source + 1));
    assert.match(edits.at(-1).text, /0\.900000 EUR/);
    assert.equal(requests[0].url.searchParams.get('base'), 'usd');
    if (source === 1) assert.equal(requests[1].url.pathname, '/v6/latest/usd');
    if (source === 2) assert.equal(requests[2].url.searchParams.get('from'), 'usd');
    if (source === 3) assert.equal(requests[3].url.searchParams.get('currency'), 'USD');
    if (source === 4) assert.match(requests[4].url.pathname, /latest\/currencies\/usd\.json$/);
  });
}

for (let source = 0; source < 4; source++) {
  test(`dynamic fiat discovery source ${source + 1} and six-hour cache`, async t => {
    let listCalls = 0;
    const {run, requests, edits} = await fixture(t, {fetch: async url => {
      if (url.pathname === listPath || ['/symbols', '/currencies'].includes(url.pathname)) {
        const index = listCalls++ % 3;
        if (index !== source) return new Response('private-token', {status: 503});
        return Response.json(index === 0 ? ['ZZZ'] : index === 1 ? {symbols: {ZZZ: {description: 'test'}}} : {ZZZ: 'Test'});
      }
      if (url.hostname === 'api.binance.com') return Response.json({price: '3'});
      return successFetch(url);
    }});
    await run('.rate ZZZ USD');
    assert.match(edits.at(-1).text, source === 3 ? /1 ZZZ = 3\.00 USD/ : /1 ZZZ = 1\.00 USD/);
    const count = listCalls;
    await run('.rate ZZZ USD');
    assert.equal(listCalls, count);
    const now = Date.now();
    const mock = t.mock.method(Date, 'now', () => now + 6 * 60 * 60 * 1000);
    await run('.rate ZZZ USD');
    assert.ok(listCalls > count);
    mock.mock.restore();
    assert.ok(requests.length < 20);
  });
}

test('built-in crypto takes priority over CoinGecko quote-currency list', async t => {
  const {run, requests, edits} = await fixture(t, {fetch: async url => url.pathname === listPath ? Response.json(['btc', 'eth', 'zzz']) : successFetch(url)});
  await run('.rate ZZZ BTC');
  assert.match(edits.at(-1).text, /1 BTC = 200\.00 ZZZ/);
  assert.ok(requests.some(({url}) => url.searchParams.get('symbol') === 'BTCUSDT'));
});

test('invalid and empty discovery schemas use the remaining sources', async t => {
  for (const data of [[], {}, null, [42], ['<secret-token>'], ['x'.repeat(65)], Array(1025).fill('usd')]) {
    const {run, requests, edits} = await fixture(t, {fetch: async url => {
      if (url.pathname === listPath) return Response.json(data);
      if (url.pathname === '/symbols') return Response.json({symbols: {ZZZ: {}}});
      return successFetch(url);
    }});
    await run('.rate ZZZ USD');
    assert.equal(requests[1].url.pathname, '/symbols');
    assert.match(edits.at(-1).text, /1 ZZZ = 1\.00 USD/);
  }
});

test('direct and inverse crypto pairs retain order', async t => {
  const {run, requests, edits} = await fixture(t, {fetch: async url => {
    if (url.searchParams.get('symbol') === 'BTCETH') return new Response('no pair', {status: 400});
    if (url.searchParams.get('symbol') === 'ETHBTC') return Response.json({price: '0.2'});
    return successFetch(url);
  }});
  await run('.rate BTC ETH');
  assert.deepEqual(requests.slice(0, 2).map(({url}) => url.searchParams.get('symbol')), ['BTCETH', 'ETHBTC']);
  assert.match(edits.at(-1).text, /1 BTC = 5\.00 ETH/);
});

for (const bridge of ['USDT', 'BUSD', 'USDC']) {
  test(`crypto/crypto and crypto/fiat bridge ${bridge}`, async t => {
    const {run, edits, requests} = await fixture(t, {fetch: async url => {
      if (url.hostname === 'api.binance.com') {
        const pair = url.searchParams.get('symbol');
        if (pair === 'BTC' + bridge) return Response.json({price: '100'});
        if (pair === 'ETH' + bridge) return Response.json({price: '20'});
        return new Response('no pair', {status: 400});
      }
      return successFetch(url);
    }});
    await run('.rate BTC ETH');
    assert.match(edits.at(-1).text, /1 BTC = 5\.00 ETH/);
    assert.match(edits.at(-1).text, /BTC \$100\.00 • ETH \$20\.00/);
    await run('.rate BTC CNY');
    assert.match(edits.at(-1).text, /1 BTC = 700\.00 CNY/);
    assert.ok(requests.some(({url}) => url.searchParams.get('symbol') === 'BTC' + bridge));
  });
}

test('unavailable benchmark prices retain conversion and legacy zero placeholders', async t => {
  const {run, edits} = await fixture(t, {fetch: async url => url.searchParams.get('symbol') === 'BTCETH'
    ? Response.json({price: '5'}) : new Response('private-token', {status: 503})});
  await run('.rate BTC ETH');
  assert.match(edits.at(-1).text, /1 BTC = 5\.00 ETH/);
  assert.match(edits.at(-1).text, /BTC \$0\.00e\+0 • ETH \$0\.00e\+0/);
});

test('fiat baskets expire after five minutes, are bounded to 16 bases and isolated by factory', async t => {
  const {run, requests, host} = await fixture(t);
  await run('.rate USD EUR');
  await run('.rate USD CNY');
  assert.equal(requests.length, 1);
  const now = Date.now();
  const mock = t.mock.method(Date, 'now', () => now + 300000);
  await run('.rate USD EUR');
  assert.equal(requests.length, 2);
  mock.mock.restore();
  const names = Object.keys(oldTables.FIAT_CURRENCIES).filter(name => name !== 'usd').slice(0, 16);
  for (const name of names) await run(`.rate ${name} USD`);
  const before = requests.length;
  await run('.rate USD EUR');
  assert.equal(requests.length, before + 1);
  assert.equal((await host.unload('rate')).completed, true);
  await host.load(createRate());
  await run('.rate USD EUR');
  assert.equal(requests.length, before + 2);
});

test('unknown currencies stay dynamic and do not grow a per-query currency cache', async t => {
  const {run, requests, edits} = await fixture(t, {fetch: async url => url.hostname === 'api.binance.com' ? Response.json({price: 1}) : successFetch(url)});
  for (let index = 0; index < 300; index++) {
    await run(`.rate unknown${index} USD`);
    assert.ok(edits.at(-1).text.includes(`1 UNKNOWN${index} = 1.00 USD`));
  }
  assert.equal(requests.filter(({url}) => url.pathname === listPath).length, 1);
});

test('invalid inputs, credentials, HTML and UTF-16 boundaries are rejected without echo or requests', async t => {
  const {run, requests, edits, logs} = await fixture(t);
  const cases = ['https://alice:private-token@example.com/?token=private-token', 'USD?token=private-token',
    '<b>private-token</b>', 'BTC&USD', 'BTC"USD', "BTC'USD", '\ud800', '\udfff', '😀'.repeat(32),
    'a'.repeat(65), 'a'.repeat(100000), 'NaN', 'Infinity', '-Infinity', '1e309', Array(33).fill('USD').join(' ')];
  for (const input of cases) {
    await run('.rate ' + input);
    assert.match(edits.at(-1).text, /操作失败/);
  }
  assert.equal(requests.length, 0);
  assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-token|example\.com|<b>private/);
});

test('64-character symbols remain usable with bounded HTML and encoded Google fallback', async t => {
  const symbol = 'a'.repeat(64);
  const {run, edits} = await fixture(t, {fetch: async () => new Response('private-token', {status: 500})});
  await run(`.rate ${symbol} USD 2`);
  const text = edits.at(-1).text;
  assert.match(text, /获取价格失败/);
  assert.ok(text.includes(`<code>${symbol.toUpperCase()}</code>`));
  assert.ok(text.includes(`q=2%20${symbol.toUpperCase()}%20to%20USD`));
  assert.ok(text.length < 2000);
});

test('malformed JSON, schema, business errors and nonpositive rates fall back and never display invalid math', async t => {
  const bodies = ['{broken', '', 'null', '[]', '"private-token"', '{}',
    '{"success":false,"rates":{"USD":1}}', '{"result":"error","rates":{"USD":1}}',
    ...[null, [], 'text', {}, {USD: 0}, {USD: -1}, {USD: 'Infinity'}, {USD: true}, {USD: {}}, {'<secret>': 1}].map(rates => JSON.stringify({rates})),
    JSON.stringify({rates: Object.fromEntries(Array.from({length: 1025}, (_, i) => ['code' + i, 1]))})];
  for (const body of bodies) {
    const {run, requests, edits} = await fixture(t, {fetch: async () => new Response(body)});
    await run('.rate USD EUR');
    assert.equal(requests.length, 5);
    assert.match(edits.at(-1).text, /获取价格失败/);
    assert.doesNotMatch(edits.at(-1).text, /NaN|Infinity|private-token|<secret>/);
  }
});

test('mixed invalid fiat fields do not poison valid rates or object prototypes', async t => {
  const {run, edits} = await fixture(t, {fetch: async () => new Response('{"rates":{"EUR":"0.9","USD":1,"CNY":null,"bad":true,"__proto__":42,"constructor":0}}')});
  await run('.rate USD EUR');
  assert.match(edits.at(-1).text, /0\.900000 EUR/);
  assert.equal({}.polluted, undefined);
});

test('missing quote gives the original pair-specific error', async t => {
  const {run, edits, requests} = await fixture(t, {fetch: async () => Response.json({rates: {USD: 1}})});
  await run('.rate USD EUR');
  assert.match(edits.at(-1).text, /无法获取 USD 到 EUR 的汇率/);
  assert.equal(requests.length, 1);
});

test('invalid Binance prices never produce zero, NaN or infinite conversion rates', async t => {
  for (const price of [0, -1, null, true, {}, 'Infinity', 'NaN', '', '2garbage', '1e-9999']) {
    const {run, requests, edits} = await fixture(t, {fetch: async () => Response.json({price})});
    await run('.rate BTC USD');
    assert.equal(requests.length, 3);
    assert.match(edits.at(-1).text, /获取价格失败/);
    assert.doesNotMatch(edits.at(-1).text, /NaN|Infinity/);
  }
});

test('reciprocal and multiplication overflow remain explicit finite-number failures', async t => {
  const {run, edits} = await fixture(t, {fetch: async url => url.hostname === 'api.binance.com'
    ? Response.json({price: '1e308'}) : Response.json({rates: {USD: 1}})});
  await run('.rate BTC USD 1e308');
  assert.match(edits.at(-1).text, /换算结果超出有限数值范围/);
  const tiny = await fixture(t, {fetch: async url => url.hostname === 'api.binance.com'
    ? Response.json({price: '5e-324'}) : Response.json({rates: {USD: 1}})});
  await tiny.run('.rate USD BTC');
  assert.match(tiny.edits.at(-1).text, /反向汇率/);
  assert.doesNotMatch(tiny.edits.at(-1).text, /Infinity|NaN/);
});

test('non-2xx and redirect responses stay within original providers and disclose no response secrets', async t => {
  for (const status of [204, 301, 302, 400, 401, 403, 429, 500, 503]) {
    const {run, requests, edits, logs} = await fixture(t, {fetch: async () => new Response(status === 204 ? null : '<secret>private-token</secret>', {
      status, headers: {Location: 'https://alice:private-token@private.invalid/'},
    })});
    await run('.rate USD EUR');
    assert.equal(requests.length, 5);
    assert.match(edits.at(-1).text, status === 429 ? /API请求过于频繁/ : /获取价格失败/);
    assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-token|private\.invalid/);
  }
});

test('native transport errors are classified safely without upstream messages or credentials', async t => {
  for (const errorCode of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET']) {
    const {run, edits, logs} = await fixture(t, {fetch: async () => {
      throw new TypeError('private-token', {cause: Object.assign(new Error('https://alice:private-token@secret.invalid'), {code: errorCode})});
    }});
    await run('.rate USD EUR');
    assert.match(edits.at(-1).text, errorCode === 'ECONNRESET' ? /网络请求失败/ : /服务不可达/);
    assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-token|secret\.invalid/);
  }
});

test('128 KiB response boundary and split UTF-8 are accepted', async t => {
  const data = {rates: {USD: 1, EUR: 0.9}, note: '汇率😀', padding: ''};
  data.padding = 'x'.repeat(128 * 1024 - Buffer.byteLength(JSON.stringify(data)));
  const bytes = Buffer.from(JSON.stringify(data));
  assert.equal(bytes.length, 128 * 1024);
  const {run, edits} = await fixture(t, {fetch: async () => new Response(new ReadableStream({start(controller) {
    const split = bytes.indexOf(Buffer.from('汇')) + 1;
    controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close();
  }}))});
  await run('.rate USD EUR');
  assert.match(edits.at(-1).text, /0\.900000 EUR/);
});

test('oversized streams cancel each reader and do not trust Content-Length', async t => {
  let canceled = 0;
  const {run, edits, requests} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { canceled++; },
  }), {headers: {'Content-Length': '1'}})});
  await run('.rate USD EUR');
  assert.equal(canceled, 5);
  assert.equal(requests.length, 5);
  assert.match(edits.at(-1).text, /数据格式或大小无效/);
});

test('stream errors and invalid UTF-8 are safe and allow subsequent commands', async t => {
  for (const body of [() => new ReadableStream({start(controller) { controller.error(new Error('private-stream-secret')); }}),
    () => new Uint8Array([123, 255, 125])]) {
    let fail = true;
    const {run, edits, logs} = await fixture(t, {fetch: async url => fail ? new Response(body()) : successFetch(url)});
    await run('.rate USD EUR');
    assert.match(edits.at(-1).text, /获取价格失败/);
    fail = false;
    await run('.rate USD EUR');
    assert.match(edits.at(-1).text, /0\.900000 EUR/);
    assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-stream-secret/);
  }
});

for (const [command, timeout] of [['.rate BTC USD', 5000], ['.rate USD EUR', 8000], ['.rate ZZZ USD', 8000]]) {
  test(`request deadline ${timeout}ms covers ${command} with fake time`, async t => {
    const started = deferred();
    let calls = 0;
    const {run, edits, requests} = await fixture(t, {fetch: async (url, init) => {
      if (++calls !== 1) return successFetch(url);
      started.resolve();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('private-timeout-token')), {once: true}));
    }});
    t.mock.timers.enable({apis: ['setTimeout']});
    const running = run(command);
    await started.promise;
    t.mock.timers.tick(timeout - 1);
    assert.equal(requests[0].init.signal.aborted, false);
    t.mock.timers.tick(1);
    await running;
    assert.equal(requests[0].init.signal.aborted, true);
    assert.doesNotMatch(edits.at(-1).text, /private-timeout-token/);
    t.mock.timers.reset();
  });
}

test('edit permission failures cause no API calls and no secret disclosure', async t => {
  const {run, edits, requests, logs} = await fixture(t, {edit: async () => { throw new Error('MESSAGE_EDIT_FORBIDDEN private-token'); }});
  await run('.rate BTC');
  assert.equal(requests.length, 0);
  assert.equal(edits.length, 2);
  assert.match(edits[1].text, /消息处理失败/);
  assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-token|MESSAGE_EDIT_FORBIDDEN/);
});

test('owner admission, saved messages, edited policy and prefix aliases are enforced by host', async t => {
  const {host, requests, edits, run} = await fixture(t, {hostOptions: {prefixes: ['!!', '.'], aliases: {fx: 'rate'}}});
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(requests.length + edits.length, 0);
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false, saved: true}), true);
  await run('!!fx USD EUR');
  assert.match(edits.at(-1).text, /0\.900000 EUR/);
});

test('unload waits for ignored fetch cancellation, suppresses fallback and blocks reload until settlement', async t => {
  for (const command of ['.rate BTC ETH', '.rate ZZZ USD', '.rate USD EUR']) {
    for (const failure of [false, true]) {
      const started = deferred(), release = deferred();
      const {run, host, requests, edits} = await fixture(t, {fetch: async url => {
        started.resolve(); await release.promise;
        if (failure) throw new Error('private-late-secret');
        return successFetch(url);
      }});
      const running = run(command);
      await started.promise;
      const count = edits.length;
      try {
        const report = await host.unload('rate', 5);
        assert.equal(report.completed, false);
        assert.ok(report.pendingTasks > 0);
        assert.equal(requests[0].init.signal.aborted, true);
        await assert.rejects(host.load(createRate()), /already loaded/);
      } finally { release.resolve(); }
      await running;
      assert.equal((await host.unload('rate', 1000)).completed, true);
      assert.equal(requests.length, 1);
      assert.equal(edits.length, count);
    }
  }
});

test('stream cancellation awaits asynchronous cancel settlement before unloading', async t => {
  const started = deferred(), cancelStarted = deferred(), release = deferred();
  let canceled = 0, pulls = 0;
  const {run, host, requests, edits} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('{"rates":'));
      else started.resolve();
    },
    async cancel() { canceled++; cancelStarted.resolve(); await release.promise; },
  }))});
  const running = run('.rate USD EUR');
  await started.promise;
  try {
    const unloading = host.unload('rate', 5);
    await cancelStarted.promise;
    assert.equal((await unloading).completed, false);
  } finally { release.resolve(); }
  await running;
  assert.equal((await host.unload('rate', 1000)).completed, true);
  assert.equal(canceled, 1);
  assert.equal(requests.length, 1);
  assert.equal(edits.length, 3);
});

test('unload during response cleanup waits for real settlement and sends no result', async t => {
  const started = deferred(), release = deferred();
  const {run, host, edits, requests} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    async cancel() { started.resolve(); await release.promise; },
  }), {status: 503})});
  const running = run('.rate USD EUR');
  await started.promise;
  try { assert.equal((await host.unload('rate', 5)).completed, false); }
  finally { release.resolve(); }
  await running;
  assert.equal((await host.unload('rate', 1000)).completed, true);
  assert.equal(requests.length, 1);
  assert.equal(edits.length, 3);
});

test('cancellation during benchmark fetch refuses final conversion output', async t => {
  const started = deferred(), release = deferred();
  const {run, host, edits, requests} = await fixture(t, {fetch: async url => {
    if (url.searchParams.get('symbol') === 'BTCETH') return Response.json({price: '5'});
    started.resolve(); await release.promise; return successFetch(url);
  }});
  const running = run('.rate BTC ETH');
  await started.promise;
  try { assert.equal((await host.unload('rate', 5)).completed, false); }
  finally { release.resolve(); }
  await running;
  assert.equal((await host.unload('rate', 1000)).completed, true);
  assert.equal(edits.length, 3);
  assert.equal(requests.length, 2);
});

test('cancellation during each message edit awaits transport and starts no later send', async t => {
  for (const pauseAt of [1, 2, 3, 4]) {
    const started = deferred(), release = deferred();
    let calls = 0;
    const {run, host, edits, requests} = await fixture(t, {edit: async () => {
      if (++calls === pauseAt) { started.resolve(); await release.promise; }
    }});
    const running = run('.rate BTC');
    await started.promise;
    try { assert.equal((await host.unload('rate', 5)).completed, false); }
    finally { release.resolve(); }
    await running;
    assert.equal(edits.length, pauseAt);
    if (pauseAt < 4) assert.equal(requests.length, 0);
    assert.equal((await host.unload('rate', 1000)).completed, true);
  }
});

test('50 reload cycles release all tasks, queues, caches and persistent resources', async t => {
  const {host, run, requests} = await fixture(t);
  for (let cycle = 0; cycle < 50; cycle++) {
    await run('.rate USD EUR');
    await run('.rate USD EUR');
    const report = await host.unload('rate');
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks, 0);
    assert.equal(report.pendingResources, 0);
    const snapshot = host.snapshot();
    assert.equal(snapshot.plugins, 0);
    assert.equal(snapshot.commands, 0);
    assert.equal(snapshot.queue.active, 0);
    assert.equal(snapshot.queue.queued, 0);
    if (cycle < 49) await host.load(createRate());
  }
  assert.equal(requests.length, 50);
});

test('four concurrent queries bound HTTP admission and busy edit errors stay private', async t => {
  const started = deferred(), release = deferred();
  let calls = 0;
  let rejectBusy = false;
  const {host, requests, edits, logs, run} = await fixture(t, {
    hostOptions: {concurrency: 8},
    edit: async (_message, text) => {
      if (rejectBusy && text.includes('查询繁忙')) throw new Error('private-busy-token');
    },
    fetch: async url => {
      if (++calls === 4) started.resolve();
      await release.promise;
      return successFetch(url);
    },
  });
  const running = Array.from({length: 4}, (_, index) => host.dispatchPrimary({...envelope, chatId: String(index + 1), text: '.rate USD EUR'}));
  await started.promise;
  try {
    await run('.rate USD EUR');
    assert.match(edits.at(-1).text, /查询繁忙/);
    rejectBusy = true;
    await run('.rate USD EUR');
    assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-busy-token/);
    assert.equal(requests.length, 4);
  } finally { release.resolve(); }
  await Promise.all(running);
  await run('.rate USD EUR');
  assert.match(edits.at(-1).text, /0\.900000 EUR/);
  assert.equal(host.snapshot().queue.active, 0);
});

test('HTTP timeout does not race an uncooperative fetch or start fallback before settlement', async t => {
  const started = deferred(), release = deferred();
  let calls = 0, completed = false;
  const {run, requests, edits} = await fixture(t, {fetch: async url => {
    if (++calls === 1) { started.resolve(); await release.promise; }
    return successFetch(url);
  }});
  t.mock.timers.enable({apis: ['setTimeout']});
  const running = run('.rate USD EUR').then(() => { completed = true; });
  await started.promise;
  try {
    t.mock.timers.tick(8000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[0].init.signal.aborted, true);
    assert.equal(completed, false);
    assert.equal(requests.length, 1);
    assert.equal(edits.length, 3);
  } finally { release.resolve(); }
  await running;
  t.mock.timers.reset();
  assert.equal(requests.length, 2);
  assert.match(edits.at(-1).text, /0\.900000 EUR/);
});

test('exhausted request deadlines retain localized timeout text with fake time', async t => {
  const started = Array.from({length: 5}, deferred);
  let calls = 0;
  const {run, edits, requests} = await fixture(t, {fetch: async (_url, init) => {
    started[calls++].resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('private-timeout-token')), {once: true}));
  }});
  t.mock.timers.enable({apis: ['setTimeout']});
  const running = run('.rate USD EUR');
  for (const stage of started) { await stage.promise; t.mock.timers.tick(8000); }
  await running;
  t.mock.timers.reset();
  assert.equal(requests.length, 5);
  assert.match(edits.at(-1).text, /请求超时/);
  assert.doesNotMatch(edits.at(-1).text, /private-timeout-token/);
});

test('rejected stream cleanup is settled and sanitized before the next provider', async t => {
  let canceled = 0;
  const {run, requests, edits, logs} = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    async cancel() { canceled++; throw new Error('private-cleanup-token'); },
  }))});
  await run('.rate USD EUR');
  assert.equal(canceled, 5);
  assert.equal(requests.length, 5);
  assert.match(edits.at(-1).text, /获取价格失败/);
  assert.doesNotMatch(JSON.stringify({text: edits.map(edit => edit.text), logs}), /private-cleanup-token/);
});

test('pre-aborted handler rejects before transport admission and ignores hostile abort reasons', async () => {
  const signal = AbortSignal.abort(new Error('private-abort-token'));
  let calls = 0;
  await assert.rejects(createRate().commands.rate.handle({message: envelope, args: ['BTC'], prefix: '.', command: 'rate'}, {
    signal, telegram: {async edit() { calls++; }}, http: {async withResponse() { calls++; }},
  }));
  assert.equal(calls, 0);
});
