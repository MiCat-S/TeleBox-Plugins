'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {getEventListeners} = require('node:events');
const root = path.resolve(__dirname, '..');
const core = path.resolve(root, '../TeleBox-Core');
const esbuild = require(require.resolve('esbuild', {paths: [core]}));
const tsc = path.join(path.dirname(require.resolve('typescript/package.json', {paths: [core]})), 'bin/tsc');

function compile(source, mocks = {}) {
  const module = {exports: {}};
  vm.runInNewContext(esbuild.transformSync(source, {
    loader: 'ts', format: 'cjs', target: 'node24',
  }).code, {
    module, exports: module.exports, Buffer, URL, AbortController, TextDecoder,
    setTimeout, clearTimeout,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `unexpected dependency: ${name}`);
      return mocks[name];
    },
    fetch() { assert.fail('real fetch is forbidden'); },
  });
  return module.exports;
}

const provider = compile(fs.readFileSync(path.join(root, 'ai/v2/provider.ts'), 'utf8'));
const lifecycle = compile(fs.readFileSync(path.join(core, 'src/v2/lifecycle.ts'), 'utf8'), {
  'node:async_hooks': require('node:async_hooks'), 'node:perf_hooks': require('node:perf_hooks'),
});
const {ScopedHttp} = compile(fs.readFileSync(path.join(core, 'src/v2/http.ts'), 'utf8'), {'./lifecycle': lifecycle});
const {ResourceScope} = lifecycle;

// Extract original source methods as in gt-translation.test.js; no singleton/config/assets.
const legacySource = fs.readFileSync(path.join(root, 'ai/ai.ts'), 'utf8');
function declaration(name) {
  const start = legacySource.search(new RegExp(`^const ${name}\\b`, 'm'));
  assert.ok(start >= 0, `legacy declaration ${name}`);
  const remainder = legacySource.slice(start + 1);
  const end = remainder.search(/^(?:const|class|interface|type|export) /m);
  assert.ok(end >= 0);
  return legacySource.slice(start, start + 1 + end);
}
function method(className, name) {
  const classStart = legacySource.indexOf(`class ${className} `);
  assert.ok(classStart >= 0);
  const source = legacySource.slice(classStart);
  const modifiers = '(?:(?:private|public|protected|static|async|readonly) )*';
  const start = source.search(new RegExp(`^  ${modifiers}${name}\\(`, 'm'));
  assert.ok(start >= 0, `legacy method ${className}.${name}`);
  const end = source.slice(start + 1).search(new RegExp(`^  ${modifiers}[A-Za-z_$][\\w$]*\\(`, 'm'));
  assert.ok(end >= 0);
  return source.slice(start, start + 1 + end);
}
const legacyHelpers = [
  'CODEX_USER_AGENT', 'PROVIDER_TYPES', 'DEFAULT_PROVIDER_TYPE', 'mapHostsToProviderType',
  'createProviderProfile', 'createOpenAIProfile', 'PROVIDER_PROFILES', 'PROVIDER_HOST_TYPES',
  'getProviderHost', 'isProviderType', 'normalizeProviderType', 'resolveProviderType', 'getProviderProfile',
  'mergeDefaults', 'matchModelRule', 'resolveModeConfig', 'resolveBaseUrl', 'resolveEndpointUrl',
  'resolveResponsesEndpointUrl', 'resolveAuthMode', 'applyAuthConfig', 'normalizeOpenAIBaseUrl',
  'normalizeGeminiBaseUrl', 'buildResponsesInputContent', 'buildGeminiParts',
  'parseOpenAIChatResponse', 'isAsyncIterable', 'readResponseBodyAsText', 'collectOpenAISources',
  'aggregateOpenAIResponses', 'collectResponsesSources', 'parseResponsesOutputContent',
  'aggregateResponsesApiPayloads', 'parseOpenAIResponsePayloads', 'parseOpenAIResponseData',
];
const legacy = compile(`
  class UserError extends Error {}
  const parseDataUrl = () => { throw new Error('media outside text fixture'); };
  const resolveImageInputs = async (images) => {
    if (images.length) throw new Error('media outside text fixture');
    return [];
  };
  ${legacyHelpers.map(declaration).join('\n')}
  class Service {
    ${['getCurrentProviderConfig', 'resolveMode', 'createStrategyHandlers', 'callOpenAIChatOrSearch', 'callGeminiChatOrSearch', 'callAI'].map(name => method('AIService', name)).join('\n')}
  }
  class Translation { ${method('AIPlugin', 'translateText')} }
  export {Service, Translation, parseOpenAIResponseData, normalizeOpenAIBaseUrl, resolveProviderType};
`);

const clean = value => JSON.parse(JSON.stringify(value));
const config = (overrides = {}, providerOverrides = {}) => ({
  configs: {main: {tag: 'main', url: 'https://fixture.invalid/v1', key: 'secret-key', stream: false, responses: false, ...providerOverrides}},
  currentChatTag: 'main', currentChatModel: 'gpt-6-astra',
  currentChatReasoningEffort: 'auto', currentChatServiceTier: 'auto',
  prompt: 'personal assistant', timeout: 30, ...overrides,
});
const completion = text => ({choices: [{message: {content: text}}]});
const gemini = text => ({candidates: [{content: {parts: [{text}]}}]});
const responseObject = text => ({object: 'response', output: [{type: 'message', content: [{type: 'output_text', text}]}]});
const sse = payloads => payloads.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function original(snapshot, output = completion(' translated ')) {
  const service = new legacy.Service();
  const requests = [];
  service.getConfigManager = async () => ({getConfig: () => snapshot});
  service.strategyHandlers = service.createStrategyHandlers();
  service.httpClient = {request: async request => { requests.push(clean(request)); return {data: output}; }};
  let active = 0;
  service.createAbortToken = () => {
    active++;
    const controller = new AbortController();
    return {signal: controller.signal, abort: reason => controller.abort(reason), throwIfAborted: () => controller.signal.throwIfAborted()};
  };
  service.releaseToken = () => active--;
  const translation = new legacy.Translation();
  translation.aiService = service;
  return {service, translation, requests, active: () => active};
}

function fixture(t, fetchImpl = async () => new Response(JSON.stringify(completion('translated')))) {
  const scope = new ResourceScope();
  const requests = [];
  const http = new ScopedHttp(scope, {fetch: async (url, init) => {
    requests.push({url: String(url), init});
    return fetchImpl(url, init);
  }});
  t.after(async () => {
    assert.equal((await scope.drain(1000)).completed, true);
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.equal(scope.snapshot().pendingResources, 0);
  });
  return {scope, http, requests};
}

function noSecrets(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.name, 'ProviderError');
  assert.equal(error.cause, undefined);
  const shown = `${error}\n${error.stack}\n${JSON.stringify(error)}\n${Object.values(error).join(' ')}`;
  assert.doesNotMatch(shown, /secret-key|private-source|fixture\.invalid|Authorization/);
  return true;
}

test('component typechecks against the current Core SDK and requires no runtime dependencies', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'telebox-provider-types-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const project = path.join(temporary, 'tsconfig.json');
  fs.writeFileSync(project, JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, skipLibCheck: true, types: ['node'], typeRoots: [path.join(core, 'node_modules/@types')],
      paths: {'telebox/sdk': [path.join(core, 'src/v2/sdk.ts')]},
    },
    files: [path.join(root, 'ai/v2/provider.ts')],
  }));
  const result = spawnSync(process.execPath, [tsc, '-p', project], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('provider selection and path normalization match original helpers', async () => {
  for (const url of [
    'https://fixture.invalid', 'https://fixture.invalid/custom', 'https://fixture.invalid/x/api/v1/chat/completions?q=private-source',
    'https://fixture.invalid/v1/messages', 'https://fixture.invalid/v1/images/generations',
    'https://gateway.ai.cloudflare.com/v1/a/b/openai/chat/completions?key=secret-key',
    'https://api.openai.com/v1', 'https://api.moonshot.cn/v1', 'https://generativelanguage.googleapis.com/v1beta',
    'https://ark.cn-beijing.volces.com/api/v3', 'http://127.0.0.1:8080', 'https://api.abjj.de/foo', 'invalid',
  ]) {
    assert.equal(provider.normalizeOpenAIBaseUrl(url), legacy.normalizeOpenAIBaseUrl(url));
    for (const type of [undefined, 'openai-compatible', ' GEMINI ', 'unknown', null, 42]) {
      assert.equal(provider.resolveProviderType({url, type}), legacy.resolveProviderType({url, type}));
    }
  }
  const snapshot = config({currentChatTag: 'second', currentChatModel: 'gpt-6-astra'});
  snapshot.configs.second = {...snapshot.configs.main, tag: 'second', key: 'second-key'};
  const old = original(snapshot);
  const selected = await old.service.getCurrentProviderConfig('chat');
  assert.deepEqual(clean(provider.selectChatProvider(snapshot)), {providerConfig: selected.providerConfig, model: selected.model});
});

test('text request bodies, URL/auth/UA and flags match original callAI across providers', async () => {
  const providers = [
    {url: 'https://fixture.invalid/v1'}, {url: 'https://fixture.invalid/v1/chat/completions'},
    {url: 'https://gateway.ai.cloudflare.com/v1/a/b/openai/chat/completions'},
    {url: 'https://fixture.invalid/custom', type: 'openai-compatible'},
    {url: 'https://generativelanguage.googleapis.com/v1beta'},
    {url: 'https://ark.cn-beijing.volces.com/ignored?q=1'},
    {url: 'https://api.moonshot.cn/v1'}, {url: 'http://127.0.0.1:8080/api/v1/messages'},
    {url: 'https://fixture.invalid/v1', type: 'local-cliproxy'},
  ];
  for (const p of providers) for (const responses of [false, true]) for (const stream of [false, true]) {
    const snapshot = config({currentChatReasoningEffort: 'xhigh', currentChatServiceTier: 'fast'}, {...p, responses, stream});
    const old = original(snapshot, provider.resolveProviderType(snapshot.configs.main) === 'gemini' ? gemini('translated') : completion('translated'));
    await old.service.callAI('  source\n\nparagraph  ');
    const request = provider.buildChatRequest(snapshot, '  source\n\nparagraph  ');
    const prior = old.requests[0];
    assert.equal(request.url, prior.url);
    assert.equal(request.init.method, prior.method);
    assert.deepEqual(clean(request.init.headers), prior.headers);
    assert.deepEqual(JSON.parse(request.init.body), prior.data);
    assert.equal(request.timeoutMs, 30000);
  }
});

test('reasoning/service tier fields are never dropped or changed by model heuristics', async () => {
  for (const responses of [false, true]) for (const reasoning of ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    for (const tier of ['auto', 'default', 'priority', 'fast', 'flex']) {
      const snapshot = config({currentChatReasoningEffort: reasoning, currentChatServiceTier: tier}, {responses});
      const old = original(snapshot);
      await old.service.callAI('source');
      const current = JSON.parse(provider.buildChatRequest(snapshot, 'source').init.body);
      assert.deepEqual(current, old.requests[0].data);
      assert.equal(Object.hasOwn(current, 'thinking'), false);
    }
  }
});

test('whitespace/system prompt behavior matches original text chat', async () => {
  for (const type of ['openai', 'gemini']) for (const responses of [false, true]) for (const text of ['', ' \n ', ' source ']) {
    const snapshot = config({prompt: '  '}, {type, responses});
    const old = original(snapshot, type === 'gemini' ? gemini('translated') : completion('translated'));
    await old.service.callAI(text, [], undefined, '');
    assert.deepEqual(JSON.parse(provider.buildChatRequest(snapshot, text, '').init.body), old.requests[0].data);
  }
});

test('translation uses exact legacy independent prompt, same selection and immutable settings', async t => {
  const snapshot = config({currentChatReasoningEffort: 'high', currentChatServiceTier: 'flex'});
  Object.freeze(snapshot.configs.main); Object.freeze(snapshot.configs); Object.freeze(snapshot);
  const before = clean(snapshot);
  const f = fixture(t, async () => new Response(JSON.stringify(completion(' translated '))));
  for (const target of ['zh-CN', 'en']) {
    const old = original(snapshot);
    const signal = new AbortController().signal;
    assert.equal(await old.translation.translateText('private-source\n\nparagraph', target, signal),
      await provider.translateText(snapshot, f.http, 'private-source\n\nparagraph', target, signal));
    assert.deepEqual(JSON.parse(f.requests.at(-1).init.body), old.requests[0].data);
    assert.equal(old.active(), 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
  await provider.chatText(snapshot, f.http, 'ordinary chat');
  assert.equal(JSON.parse(f.requests.at(-1).init.body).messages[0].content, before.prompt);
  assert.deepEqual(snapshot, before);
});

test('OpenAI JSON and SSE output aggregation matches original successful text fixtures', async () => {
  const values = [
    completion(' hello '), completion([{type: 'text', text: 'a'}, {type: 'text', text: ''}, {type: 'output_text', text: 'b'}]),
    {choices: [{text: ' fallback '}]}, {content: {type: 'text', text: 'content'}}, {text: 'text'},
    responseObject(' responses '),
    {object: 'response', output: [...responseObject('first').output, ...responseObject('last').output]},
    sse([{choices: [{delta: {role: 'assistant', reasoning_content: 'thinking'}}]}, {choices: [{delta: {content: 'a '}}]}, {choices: [{delta: {content: 'b'}}]}, completion('ignored fallback')]),
    sse([{type: 'response.created'}, {type: 'response.output_text.delta', delta: 'a '}, {type: 'response.output_text.delta', delta: 'b'}, {type: 'response.output_text.done', text: 'a b'}, {type: 'response.completed', response: responseObject('a b')}]),
    sse([{type: 'response.output_text.done', text: ' done only '}]),
    sse([{type: 'response.output_item.done', item: responseObject('item').output[0]}]),
    JSON.stringify([completion('one'), completion('two')]),
  ];
  for (const value of values) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    assert.equal(provider.parseChatText(raw, 'openai'), (await legacy.parseOpenAIResponseData(value)).text);
  }
});

test('Gemini wrapped JSON retains thought-marked text just like the original', async t => {
  const parts = {candidates: [{content: {parts: [{text: 'thinking ', thought: true}, {text: 'answer'}]}}]};
  const snapshot = config({}, {type: 'gemini', stream: true, responses: true});
  for (const value of [parts, {response: parts}, {data: parts}]) {
    const old = original(snapshot, value);
    const expected = await old.service.callAI('source');
    const f = fixture(t, async () => new Response(JSON.stringify(value)));
    assert.equal(await provider.translateText(snapshot, f.http, 'source', 'en'), expected.text);
    assert.equal(expected.text, 'thinking answer');
    assert.equal(f.requests[0].init.headers['User-Agent'], undefined);
  }
});

test('SSE supports arbitrary byte boundaries and does not duplicate completed text', async t => {
  const raw = ': keepalive\r\nevent: message\r\n' + sse([
    {type: 'response.output_text.delta', delta: '你好 '},
    {type: 'response.output_text.delta', delta: 'world'},
    {type: 'response.completed', response: responseObject('你好 world')},
  ]);
  const bytes = Buffer.from(raw);
  let index = 0;
  const f = fixture(t, async () => new Response(new ReadableStream({pull(controller) {
    if (index === bytes.length) controller.close();
    else controller.enqueue(bytes.subarray(index, ++index));
  }}), {headers: {'Content-Type': 'text/event-stream'}}));
  assert.equal(await provider.translateText(config({}, {stream: true, responses: true}), f.http, 'source', 'en'), '你好 world');
});

test('malformed/empty provider replies are rejected instead of echoing raw bodies or placeholder translations', async t => {
  const cases = [
    ['', 'EMPTY_OUTPUT'], [' ', 'EMPTY_OUTPUT'], ['private-source secret-key', 'INVALID_RESPONSE'],
    ['{"secret-key":"private-source"', 'INVALID_RESPONSE'], ['null', 'EMPTY_OUTPUT'], ['{}', 'EMPTY_OUTPUT'],
    ['[]', 'EMPTY_OUTPUT'], [JSON.stringify(completion(' ')), 'EMPTY_OUTPUT'],
    [JSON.stringify(completion({text: {secret: 'secret-key'}})), 'EMPTY_OUTPUT'],
    [JSON.stringify(responseObject('')), 'EMPTY_OUTPUT'], ['data: [DONE]\n', 'EMPTY_OUTPUT'],
    ['data: {broken private-source secret-key}\n', 'INVALID_RESPONSE'],
    [sse([completion('partial')]) + 'data: {broken}\n', 'INVALID_RESPONSE'],
    [JSON.stringify({choices: 'secret-key'}), 'EMPTY_OUTPUT'],
  ];
  for (const [raw, code] of cases) {
    const f = fixture(t, async () => new Response(raw));
    await assert.rejects(provider.translateText(config(), f.http, 'private-source', 'en'), error => noSecrets(error, code));
  }
  for (const raw of ['null', '{}', '{"candidates":[{"content":{"parts":{}}}]}']) {
    assert.throws(() => provider.parseChatText(raw, 'gemini'), error => noSecrets(error, 'EMPTY_OUTPUT'));
  }
});

test('provider error envelopes never expose keys/source text even after a partial SSE result', async t => {
  for (const body of [
    JSON.stringify({error: {message: 'secret-key private-source'}}),
    sse([{choices: [{delta: {content: 'partial'}}]}, {error: {message: 'secret-key private-source'}}]),
    sse([{type: 'response.failed', response: {error: {message: 'secret-key private-source'}}}]),
    JSON.stringify({object: 'response', status: 'failed'}),
  ]) {
    const f = fixture(t, async () => new Response(body));
    await assert.rejects(provider.translateText(config(), f.http, 'private-source', 'en'), error => noSecrets(error, 'PROVIDER'));
  }
  assert.throws(() => provider.parseChatText(JSON.stringify({data: {error: {message: 'secret-key private-source'}}}), 'gemini'), error => noSecrets(error, 'PROVIDER'));
});

test('HTTP failures discard provider body and await its cancellation', async t => {
  for (const status of [301, 400, 401, 429, 500, 503]) {
    let cancelled = false;
    const f = fixture(t, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('secret-key private-source')); },
      cancel() { cancelled = true; },
    }), {status}));
    await assert.rejects(provider.translateText(config(), f.http, 'private-source', 'en'), error => {
      noSecrets(error, 'HTTP_STATUS'); assert.equal(error.status, status); return true;
    });
    assert.equal(cancelled, true);
  }
});

test('injected HTTP and fake fetch errors are scrubbed, with no automatic retries', async t => {
  const bad = new Error('secret-key private-source https://fixture.invalid');
  bad.cause = {Authorization: 'secret-key'};
  const f = fixture(t, async () => { throw bad; });
  await assert.rejects(provider.translateText(config(), f.http, 'private-source', 'en'), error => noSecrets(error, 'FAILED'));
  assert.equal(f.requests.length, 1);
  await assert.rejects(provider.translateText(config(), {withResponse: async () => { throw bad; }}, 'private-source', 'en'), error => noSecrets(error, 'FAILED'));
  const forged = new provider.ProviderError('FAILED');
  forged.code = 'secret-key'; forged.status = 'private-source';
  await assert.rejects(provider.translateText(config(), {withResponse: async () => { throw forged; }}, 'private-source', 'en'), error => noSecrets(error, 'FAILED'));
});

test('byte limit uses actual UTF-8 chunks, not Content-Length; exact boundary succeeds', async t => {
  const raw = JSON.stringify(completion('你好'));
  for (const extra of [0, -1]) {
    let body;
    const f = fixture(t, async () => {
      body = new Response(raw, {headers: {'Content-Length': '1'}});
      return body;
    });
    const task = provider.translateText(config(), f.http, 'source', 'en', undefined, {maxResponseBytes: Buffer.byteLength(raw) + extra});
    if (extra === 0) assert.equal(await task, '你好');
    else await assert.rejects(task, error => noSecrets(error, 'RESPONSE_TOO_LARGE'));
    assert.equal(body.body.locked, false);
  }
});

test('output limit rejects rather than truncates JSON/SSE/Gemini and counts UTF-16 before trimming', () => {
  for (const [raw, format] of [
    [JSON.stringify(completion('你好')), 'openai'],
    [JSON.stringify(gemini('你好')), 'gemini'],
    [sse([{type: 'response.output_text.delta', delta: '你'}, {type: 'response.output_text.delta', delta: '好'}]), 'openai'],
  ]) {
    assert.equal(provider.parseChatText(raw, format, {maxOutputChars: 2}), '你好');
    assert.throws(() => provider.parseChatText(raw, format, {maxOutputChars: 1}), error => noSecrets(error, 'OUTPUT_TOO_LARGE'));
  }
  assert.throws(() => provider.parseChatText(JSON.stringify(completion(' a ')), 'openai', {maxOutputChars: 1}), error => noSecrets(error, 'OUTPUT_TOO_LARGE'));
  const long = 'a'.repeat(provider.DEFAULT_PROVIDER_LIMITS.maxOutputChars + 1);
  assert.throws(() => provider.parseChatText(JSON.stringify(completion(long)), 'openai'), error => noSecrets(error, 'OUTPUT_TOO_LARGE'));
});

test('invalid selection/config/limits and pre-aborted calls never reach HTTP', async t => {
  const f = fixture(t);
  const snapshots = [config({currentChatTag: ''}), config({currentChatModel: ''}), config({currentChatTag: 'missing'}), config({currentChatTag: '__proto__'}),
    ...[0, -1, Infinity, NaN, 2147484].map(timeout => config({timeout})), config({}, {url: 'secret-key private-source'}), config({}, {url: 'file:///private-source'})];
  for (const snapshot of snapshots) {
    await assert.rejects(provider.translateText(snapshot, f.http, 'private-source', 'en'), error => noSecrets(error, 'CONFIG'));
  }
  for (const maxResponseBytes of [-1, Infinity, 0.1, undefined]) {
    await assert.rejects(provider.translateText(config(), f.http, 'source', 'en', undefined, {maxResponseBytes}), error => noSecrets(error, 'CONFIG'));
  }
  const controller = new AbortController(); controller.abort(new Error('secret-key private-source'));
  await assert.rejects(provider.translateText(config(), f.http, 'source', 'en', controller.signal), error => noSecrets(error, 'ABORTED'));
  assert.equal(f.requests.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('external cancellation retains ignored fetch work until completion and suppresses late text', async t => {
  const ready = defer(), finish = defer();
  const f = fixture(t, async () => { ready.resolve(); return finish.promise; });
  const controller = new AbortController();
  const task = provider.translateText(config(), f.http, 'private-source', 'en', controller.signal);
  const rejection = assert.rejects(task, error => noSecrets(error, 'ABORTED'));
  await ready.promise;
  controller.abort(new Error('secret-key private-source'));
  assert.equal(f.requests[0].init.signal.aborted, true);
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  finish.resolve(new Response(JSON.stringify(completion('late'))));
  await rejection;
  assert.equal(f.scope.snapshot().pendingTasks, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('scope drain cancellation keeps uncooperative fetch visible after drain timeout', async t => {
  const ready = defer(), finish = defer();
  const f = fixture(t, async () => { ready.resolve(); return finish.promise; });
  const task = provider.translateText(config(), f.http, 'private-source', 'en');
  const rejection = assert.rejects(task, error => noSecrets(error, 'ABORTED'));
  await ready.promise;
  const report = await f.scope.drain(5);
  assert.equal(report.completed, false);
  assert.equal(report.pendingTasks, 1);
  finish.resolve(new Response(JSON.stringify(completion('late'))));
  await rejection;
  assert.equal((await f.scope.drain(1000)).completed, true);
});

test('timeout uses configured seconds and waits for uncooperative work', async t => {
  const started = defer(), aborted = defer(), finish = defer();
  const f = fixture(t, async (_url, init) => {
    init.signal.addEventListener('abort', () => aborted.resolve(), {once: true});
    started.resolve(); return finish.promise;
  });
  const task = provider.translateText(config({timeout: 0.02}), f.http, 'private-source', 'en');
  const rejection = assert.rejects(task, error => noSecrets(error, 'TIMEOUT'));
  await started.promise; await aborted.promise;
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  finish.resolve(new Response(JSON.stringify(completion('late'))));
  await rejection;
});

test('abort during body read waits for reader cancellation cleanup and releases its lock', async t => {
  const reading = defer(), cancelling = defer(), cleanup = defer();
  let response;
  const f = fixture(t, async () => {
    response = new Response(new ReadableStream({
      pull() { reading.resolve(); },
      cancel() { cancelling.resolve(); return cleanup.promise; },
    }));
    return response;
  });
  const controller = new AbortController();
  const task = provider.translateText(config(), f.http, 'private-source', 'en', controller.signal);
  const rejection = assert.rejects(task, error => noSecrets(error, 'ABORTED'));
  await reading.promise;
  // Allow the response consumer to acquire the reader after the stream's initial pull.
  await new Promise(resolve => setImmediate(resolve));
  controller.abort('secret-key private-source');
  await cancelling.promise;
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  assert.equal(response.body.locked, true);
  cleanup.resolve();
  await rejection;
  assert.equal(response.body.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('body size overflow awaits cleanup; cleanup failures remain sanitized', async t => {
  const cancelling = defer(), cleanup = defer();
  const f = fixture(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('private-source secret-key')); },
    cancel() { cancelling.resolve(); return cleanup.promise; },
  })));
  const task = provider.translateText(config(), f.http, 'private-source', 'en', undefined, {maxResponseBytes: 1});
  const rejection = assert.rejects(task, error => noSecrets(error, 'RESPONSE_TOO_LARGE'));
  await cancelling.promise;
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  cleanup.resolve(); await rejection;
  const bad = fixture(t, async () => new Response(new ReadableStream({
    cancel() { throw new Error('secret-key private-source'); },
  }), {status: 500}));
  await assert.rejects(provider.translateText(config(), bad.http, 'private-source', 'en'), error => noSecrets(error, 'CLEANUP_FAILED'));
});

test('errored stream cleanup follows the SDK error category and releases readers', async t => {
  let body;
  const f = fixture(t, async () => {
    body = new ReadableStream({pull(controller) { controller.error(new Error('secret-key private-source')); }});
    return new Response(body);
  });
  // ScopedHttp's final body.cancel rejects for an errored stream, after our reader is released.
  await assert.rejects(provider.translateText(config(), f.http, 'private-source', 'en'), error => noSecrets(error, 'CLEANUP_FAILED'));
  assert.equal(body.locked, false);
});

test('deadline covers streamed body and asynchronous cancellation cleanup', async t => {
  const cancelling = defer(), cleanup = defer();
  let body;
  const f = fixture(t, async () => {
    body = new ReadableStream({cancel() { cancelling.resolve(); return cleanup.promise; }});
    return new Response(body);
  });
  const task = provider.translateText(config({timeout: 0.02}), f.http, 'private-source', 'en');
  const rejection = assert.rejects(task, error => noSecrets(error, 'TIMEOUT'));
  await cancelling.promise;
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  assert.equal(body.locked, true);
  cleanup.resolve(); await rejection;
  assert.equal(body.locked, false);
});

test('empty HTTP body, SSE terminal fragments and query-key encoding stay within the text contract', async t => {
  const f = fixture(t, async () => new Response(null, {status: 204}));
  await assert.rejects(provider.translateText(config(), f.http, 'source', 'en'), error => noSecrets(error, 'EMPTY_OUTPUT'));
  const raw = `data: ${JSON.stringify(completion('last fragment'))}`;
  assert.equal(provider.parseChatText(raw, 'openai'), (await legacy.parseOpenAIResponseData(raw)).text);
  for (const type of ['gemini', 'local-cliproxy']) {
    const snapshot = config({}, {type, key: 'key+ /&=?'});
    const old = original(snapshot, type === 'gemini' ? gemini('translated') : completion('translated'));
    await old.service.callAI('source');
    const request = provider.buildChatRequest(snapshot, 'source');
    assert.equal(request.url, old.requests[0].url);
    assert.equal(new URL(request.url).searchParams.get('key'), snapshot.configs.main.key);
    assert.equal(request.init.headers.Authorization, undefined);
  }
});

test('50 isolated HTTP lifecycles finish without pending work or signal listeners', async () => {
  for (let index = 0; index < 50; index++) {
    const scope = new ResourceScope();
    const controller = new AbortController();
    const bodies = [];
    const http = new ScopedHttp(scope, {fetch: async () => {
      const body = new Response(JSON.stringify(completion('translated')));
      bodies.push(body); return body;
    }});
    try {
      assert.equal(await provider.translateText(config(), http, 'source', 'en', controller.signal), 'translated');
      assert.equal(scope.snapshot().pendingTasks, 0);
      assert.equal(scope.snapshot().pendingResources, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(bodies[0].body.locked, false);
    } finally { assert.equal((await scope.drain(1000)).completed, true); }
  }
});
