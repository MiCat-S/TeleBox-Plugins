'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const envelope = {id: 17, chatId: '42', senderId: '42', outgoing: true, text: '.ids'};
let buildRoot, createPlugin, manifest, Api, integer;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
test.before(async () => {
  test.mock.method(globalThis, 'fetch', () => assert.fail('external fetch forbidden'));
  test.mock.method(require('node:net').Socket.prototype, 'connect', () => assert.fail('external socket forbidden'));
  test.mock.method(require('node:http'), 'request', () => assert.fail('external HTTP forbidden'));
  test.mock.method(require('node:https'), 'request', () => assert.fail('external HTTPS forbidden'));
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-ids-candidate-')));
  await fs.mkdir(path.join(buildRoot, 'node_modules'));
  for (const [name, source] of [['telebox', core], ['teleproto', path.join(core, 'node_modules/teleproto')]]) {
    await fs.symlink(source, path.join(buildRoot, 'node_modules', name), 'dir');
  }
  const built = buildPlugin({id: 'ids', packageRoot: path.resolve(__dirname, '../ids'), entry: 'v2.ts', rootDir: buildRoot});
  manifest = built.manifest;
  const modulePath = require.resolve(path.join(core, 'node_modules/teleproto'));
  const loaded = Boolean(require.cache[modulePath]);
  createPlugin = require(path.join(built.artifactDir, 'index.cjs')).default;
  createPlugin();
  assert.equal(Boolean(require.cache[modulePath]), loaded, 'factory import must not load Teleproto');
  ({Api} = require(path.join(core, 'node_modules/teleproto')));
  require(path.join(core, 'node_modules/teleproto/tl/custom/message.js')).installMessageBehaviour();
  ({returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js')));
});
test.after(async () => {
  if (buildRoot) await fs.rm(buildRoot, {recursive: true, force: true});
  test.mock.restoreAll();
});
function user(fields = {}) {
  return new Api.User({id: integer('123'), firstName: 'Alice', username: 'alice',
    photo: new Api.UserProfilePhoto({photoId: integer(1), dcId: 4}), ...fields});
}
function full(profile = user(), about = 'Biography') {
  return {users: [profile], fullUser: {about, commonChatsCount: 3}};
}
async function fixture(t, {native = {}, reply, hostOptions = {}, onEdit, onReply} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-ids-v2-')));
  const edits = [], replies = [], calls = [], logs = [], replyReads = [];
  const handlers = {
    getMe: async () => user(),
    getEntity: async () => user(),
    getInputEntity: async () => new Api.InputPeerUser({userId: integer(123), accessHash: integer(456)}),
    invoke: async request => {
      assert.ok(request instanceof Api.users.GetFullUser);
      return full();
    }, ...native,
  };
  const client = new Proxy({}, {get(_target, key) {
    if (key === 'then') return undefined;
    return async (...args) => {
      calls.push({method: key, args});
      assert.equal(typeof handlers[key], 'function', 'unexpected native method: ' + String(key));
      return handlers[key](...args);
    };
  }});
  const host = new PluginHost({
    storageRoot: root,
    logger: {info(event, fields) { logs.push({event, fields}); }, error(event, fields) { logs.push({event, fields}); }},
    telegram: {
      async edit(message, text, options, signal) {
        signal.throwIfAborted(); edits.push({message, text, options});
        if (onEdit) await onEdit(message, text, signal);
        signal.throwIfAborted();
      },
      async reply(message, text, options, signal) {
        signal.throwIfAborted(); replies.push({message, text, options});
        if (onReply) await onReply(message, text, signal);
        signal.throwIfAborted();
      },
      async getReply(message, signal) {
        signal.throwIfAborted(); replyReads.push(message);
        const value = typeof reply === 'function' ? await reply(message, signal) : reply;
        signal.throwIfAborted(); return value;
      },
      async withClient(operation, signal) {
        signal.throwIfAborted();
        const result = await operation(client, signal);
        signal.throwIfAborted(); return result;
      },
      async invoke() { assert.fail('native requests must use withClient'); },
    }, ...hostOptions,
  });
  await host.load(createPlugin());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    assert.deepEqual(await fs.readdir(root), [], 'stateless extension has no configuration or cache');
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, client, edits, replies, calls, logs, replyReads,
    run: (text = '.ids', fields = {}) => host.dispatchPrimary({...envelope, text, ...fields})};
}
test('ids builds a pure default SDK factory with declared protocol dependencies', async t => {
  assert.equal(typeof createPlugin, 'function');
  const first = createPlugin();
  assert.notEqual(first, createPlugin());
  assert.equal(first.id, 'ids');
  assert.equal(first.apiVersion, 1);
  assert.deepEqual(Object.keys(first.commands), ['ids']);
  assert.deepEqual(manifest.imports, ['telebox/sdk', 'teleproto', 'teleproto/Helpers.js']);
  assert.equal(first.setup, undefined);
  assert.equal(first.cleanup, undefined);
  const f = await fixture(t);
  assert.equal(f.calls.length + f.edits.length, 0);
});
test('ids obeys host outgoing/saved/edited authorization', async t => {
  const f = await fixture(t);
  await f.run(undefined, {outgoing: false});
  await f.run(undefined, {edited: true});
  assert.equal(f.calls.length + f.edits.length, 0);
  await f.run(undefined, {outgoing: false, saved: true});
  assert.ok(f.edits.length > 0);
});
test('ids unload/reload 50 cycles leaves no commands, tasks or duplicate effects', async t => {
  const f = await fixture(t);
  for (let cycle = 0; cycle < 50; cycle++) {
    await f.run();
    assert.equal((await f.host.unload('ids', 1000)).completed, true);
    const snapshot = f.host.snapshot();
    assert.equal(snapshot.plugins, 0);
    assert.equal(snapshot.commands, 0);
    assert.equal(snapshot.lifecycle.pendingTasks, 0);
    if (cycle !== 49) await f.host.load(createPlugin());
  }
  assert.equal(f.edits.length, 100);
});

test('ids help/h uses invocation prefix and never calls native methods', async t => {
  const f = await fixture(t, {hostOptions: {prefixes: ['!!']}});
  for (const target of ['help', 'h']) await f.run('!!ids ' + target);
  assert.equal(f.calls.length, 0);
  assert.equal(f.replyReads.length, 0);
  assert.match(f.edits[0].text, /!!ids @用户名/);
  assert.match(f.edits[0].text, /注册时间估算/);
  assert.equal(f.edits[0].text, f.edits[1].text);
  assert.deepEqual(f.edits[0].options, {parseMode: 'html'});
});
test('ids self output retains fields, links and a single GetFullUser', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.replyReads.length, 1);
  assert.deepEqual(f.calls.map(call => call.method), ['getMe', 'invoke']);
  assert.equal(f.calls[1].args[0].id.toString(), '123');
  assert.equal(f.edits[0].text, '🔍 <b>正在查询用户信息...</b>');
  assert.equal(f.edits[1].text, '👤 <b>Alice</b>\n\n<b>基本信息：</b>\n' +
    '• 用户名：<code>@alice</code>\n• 用户ID：<code>123</code>\n' +
    '• 注册时间（基于ID估算）：<code>2013年8月</code>\n' +
    '• DC：<code>DC4</code>\n• 共同群：<code>3</code> 个\n' +
    '\n<b>简介：</b>\n<code>Biography</code>\n\n<b>跳转链接：</b>\n' +
    '• <a href="tg://user?id=123">用户资料</a>\n• <a href="https://t.me/alice">聊天链接</a>\n' +
    '• <a href="tg://openmessage?user_id=123">打开消息</a>\n\n<b>链接文本：</b>\n' +
    '• <code>tg://user?id=123</code>\n• <code>https://t.me/alice</code>\n• <code>tg://openmessage?user_id=123</code>');
  assert.doesNotMatch(f.edits[1].text, /±|精确|校准/);
});
test('ids keeps first-line/first-target parsing and explicit target priority over reply', async t => {
  const f = await fixture(t, {reply: {...envelope, senderId: '999'}});
  await f.run('.ids @alice ignored\n@other', {replyToId: 1, raw: {message: '.ids @wrong'}});
  assert.equal(f.calls[0].args[0], '@alice');
  assert.equal(f.replyReads.length, 0);
  await f.run('.ids\n@other');
  assert.equal(f.replyReads.length, 1);
  assert.equal(f.calls.at(-1).args[0].id.toString(), '999');
});
test('ids exact decimal/hex IDs preserve parseInt-compatible prefixes without rounding', async t => {
  for (const [input, id] of [['9007199254740993', '9007199254740993'], ['-1009007199254740993', '-1009007199254740993'],
    ['123tail', '123'], ['+123', '123'], ['0x20000000000001', '9007199254740993'], ['-0x7b', '-123'], ['1e3', '1']]) {
    const f = await fixture(t);
    await f.run('.ids ' + input);
    assert.equal(f.calls[0].args[0].toString(), id);
    assert.equal(f.calls[1].args[0].id.toString(), id);
    assert.match(f.edits.at(-1).text, new RegExp('用户ID：<code>' + id + '</code>'));
    assert.ok(f.edits.at(-1).text.includes('tg://user?id=' + id));
    assert.ok(f.edits.at(-1).text.includes('tg://openmessage?user_id=' + id));
  }
});
test('ids username result uses exact protocol BigInteger ID', async t => {
  const f = await fixture(t, {native: {getEntity: async () => user({id: integer('9007199254740993')})}});
  await f.run('.ids @alice');
  assert.equal(f.calls[1].args[0].id.toString(), '9007199254740993');
  assert.match(f.edits.at(-1).text, /基于ID估算.*未知/);
});
test('ids deleted or uncached reply sender never falls back to owner', async t => {
  for (const raw of [undefined, {sender: new Api.UserEmpty({id: integer('9007199254740993')})}]) {
    const f = await fixture(t, {reply: {...envelope, senderId: '9007199254740993', raw},
      native: {invoke: async () => { throw new Error('USER_ID_INVALID secret'); }, getMe: async () => assert.fail('must not query owner')}});
    await f.run('.ids', {replyToId: 9});
    assert.match(f.edits.at(-1).text, /用户 9007199254740993/);
    assert.match(f.edits.at(-1).text, /无用户名/);
    assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /secret/);
  }
});
test('ids reply cached profile, snake_case names and status ordering survive', async t => {
  const profile = {first_name: '<First>', last_name: '"Last"', username: "a&b'", bot: true, verified: true, premium: true, scam: true, fake: true};
  const f = await fixture(t, {reply: {...envelope, senderId: '123', raw: {sender: profile}}});
  await f.run();
  const text = f.edits.at(-1).text;
  assert.match(text, /&lt;First&gt; &quot;Last&quot;/);
  assert.match(text, /@a&amp;b&#x27;/);
  assert.match(text, /🤖 机器人 ✅ 已验证 ⭐ Premium ⚠️ 诈骗 ❌ 虚假/);
});
test('ids absent reply/sender and safe reply lookup failure retain self fallback', async t => {
  for (const reply of [undefined, {...envelope, senderId: undefined}, async () => { throw new Error('unavailable'); }]) {
    const f = await fixture(t, {reply});
    await f.run();
    assert.deepEqual(f.calls.map(call => call.method), ['getMe', 'invoke']);
  }
});
test('ids invalid reply sender zero reports unavailable instead of querying owner', async t => {
  const f = await fixture(t, {reply: {...envelope, senderId: '0'}});
  await f.run();
  assert.equal(f.edits.at(-1).text, '❌ 无法获取用户信息');
  assert.equal(f.calls.length, 0);
});
test('ids missing self/auth key keeps progress, unexpected auth errors are sanitized', async t => {
  for (const getMe of [async () => undefined, async () => new Api.UserEmpty({id: integer(123)}),
    async () => { throw new Error('AUTH_KEY_UNREGISTERED private-token'); }]) {
    const f = await fixture(t, {native: {getMe}});
    await f.run();
    assert.equal(f.edits.length, 1);
    assert.deepEqual(f.calls.map(call => call.method), ['getMe']);
  }
  const f = await fixture(t, {native: {getMe: async () => { throw new Error('proxy://secret:private-token@host'); }}});
  await f.run();
  assert.equal(f.edits.at(-1).text, '❌ <b>查询失败:</b> 未知错误，请稍后重试');
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private-token|proxy/);
});
test('ids invalid format is distinguished from native lookup errors', async t => {
  const f = await fixture(t, {native: {getEntity: async () => { throw new Error('无效格式 secret'); }}});
  await f.run('.ids invalid');
  assert.equal(f.edits.at(-1).text, '❌ <b>查询失败:</b> 无效格式');
  assert.equal(f.calls.length, 0);
  await f.run('.ids @alice');
  assert.equal(f.edits.at(-1).text, '❌ <b>查询失败:</b> 未知错误，请稍后重试');
});
test('ids unresolved numeric target and optional full-user failure retain partial information', async t => {
  const f = await fixture(t, {native: {
    getEntity: async () => { throw new Error('secret'); },
    invoke: async () => { throw new Error('secret'); },
  }});
  await f.run('.ids 123');
  const text = f.edits.at(-1).text;
  assert.match(text, /用户 123/);
  assert.match(text, /无简介/);
  assert.match(text, /共同群：<code>0/);
  assert.match(text, /DC：<code>未知/);
  assert.match(text, /https:\/\/t.me\/@id123/);
  assert.equal(f.calls.length, 2);
});
test('ids photo-empty, photo-absent and empty full result retain separate DC fallbacks', async t => {
  for (const [response, expected] of [[full(user({photo: new Api.UserProfilePhotoEmpty()})), '无头像'],
    [full(user({photo: undefined})), '未知'], [{users: [], fullUser: undefined}, '未知']]) {
    const f = await fixture(t, {native: {invoke: async () => response}});
    await f.run();
    assert.ok(f.edits.at(-1).text.includes('DC：<code>' + expected + '</code>'));
    assert.equal(f.calls.filter(call => call.method === 'invoke').length, 1);
  }
});
test('ids group/forum participant RPC retains exact peer and participant and local date', async t => {
  const peer = new Api.PeerChannel({channelId: integer('9007199254740993')});
  const raw = new Api.Message({id: 17, peerId: peer, message: '.ids 9007199254740993',
    replyTo: new Api.MessageReplyHeader({replyToMsgId: 5, replyToTopId: 2, forumTopic: true})});
  raw.init(raw);
  const date = new Date(1700000000 * 1000), pad = n => String(n).padStart(2, '0');
  const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  const f = await fixture(t, {native: {invoke: async request => {
    if (request instanceof Api.channels.GetParticipant) {
      assert.equal(request.channel, peer);
      assert.equal(request.participant.toString(), '9007199254740993');
      return {participant: new Api.ChannelParticipant({userId: integer(123), date: 1700000000})};
    }
    return full();
  }}});
  await f.run('.ids 9007199254740993', {raw, topicId: 2});
  assert.equal(f.calls.filter(call => call.method === 'invoke').length, 2);
  assert.ok(f.edits.at(-1).text.includes('入群时间：<code>' + stamp));
  assert.equal(f.edits.at(-1).message.topicId, 2);
});
test('ids rawless group and inaccessible participant are handled without extra full-user RPC', async t => {
  const f = await fixture(t, {native: {invoke: async request => {
    if (request instanceof Api.channels.GetParticipant) {
      assert.equal(request.channel.toString(), '-1009007199254740993');
      throw new Error('CHAT_ADMIN_REQUIRED secret');
    }
    return full();
  }}});
  await f.run('.ids', {chatId: '-1009007199254740993'});
  assert.doesNotMatch(f.edits.at(-1).text, /入群时间|secret/);
  assert.equal(f.calls.filter(call => call.method === 'invoke').length, 2);
});
function validPage(text) {
  assert.ok(text.length <= 4096, 'HTML page exceeds Telegram bound');
  assert.equal(text.isWellFormed(), true, 'UTF-16 surrogate split');
  const stack = [];
  for (const token of text.match(/<[^>]*>|&[^;]*;|[^<&]+/gu) || []) {
    if (token.startsWith('</')) assert.equal(stack.pop(), token.slice(2, -1));
    else if (token.startsWith('<')) stack.push(token.match(/^<(\w+)/)[1]);
    else if (token.startsWith('&')) assert.match(token, /^&(amp|lt|gt|quot|#x27);$/);
  }
  assert.equal(stack.length, 0, 'unclosed formatting');
  const plain = text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#x27);/g, '');
  assert.doesNotMatch(plain, /[<&]/, 'broken token/entity');
}
test('ids generated HTML pages preserve entities, UTF-16, closing tags and oversized single href', async t => {
  for (const username of ['alice', 'u'.repeat(3600), '&'.repeat(5000)]) {
    const profile = user({firstName: "<&😀'".repeat(1800), lastName: '"'.repeat(1200), username});
    const f = await fixture(t, {native: {getMe: async () => profile, invoke: async () => full(profile, 'a'.repeat(199) + '😀tail')}});
    await f.run();
    const pages = [...f.edits.slice(1), ...f.replies];
    assert.ok(pages.length > 1);
    for (const [i, page] of pages.entries()) {
      validPage(page.text);
      assert.ok(page.text.endsWith('📄 (' + (i + 1) + '/' + pages.length + ')'));
    }
    assert.match(pages.map(page => page.text).join(''), /a{199}\.\.\./);
    assert.equal(f.calls.filter(call => call.method === 'invoke').length, 1);
  }
});
for (const method of ['getMe', 'getEntity', 'invoke']) {
  for (const rejects of [false, true]) test('ids cancellation waits for ' + method + ' settlement (' + rejects + ')', async t => {
    const started = deferred(), finish = deferred();
    const f = await fixture(t, {native: {[method]: async () => { started.resolve(); return finish.promise; }}});
    let settled = false;
    const running = f.run(method === 'getEntity' ? '.ids @alice' : '.ids').finally(() => { settled = true; });
    await started.promise;
    const report = await f.host.unload('ids', 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
    assert.equal(settled, false);
    if (rejects) finish.reject(new Error('private-token'));
    else finish.resolve(method === 'invoke' ? full() : user());
    await running;
    assert.equal(f.edits.length, 1);
    assert.equal(f.calls.at(-1).method, method);
    assert.equal((await f.host.unload('ids', 1000)).completed, true);
  });
}
test('ids cancellation during reply lookup forbids owner fallback', async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, {reply: async () => { started.resolve(); return finish.promise; }});
  const running = f.run();
  await started.promise;
  assert.equal((await f.host.unload('ids', 5)).completed, false);
  finish.reject(new Error('private-token'));
  await running;
  assert.equal(f.calls.length, 0);
  assert.equal(f.edits.length, 1);
});
test('ids queued command is canceled before any subsequent native invocation', async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, {native: {getMe: async () => { started.resolve(); return finish.promise; }}});
  const running = f.run();
  await started.promise;
  const queued = f.run();
  const rejected = assert.rejects(queued, {name: 'AbortError'});
  assert.equal((await f.host.unload('ids', 5)).completed, false);
  finish.resolve(user());
  await running; await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.edits.length, 1);
});
test('ids final edit and paginated reply remain tracked until actual settlement', async t => {
  for (const paginate of [false, true]) {
    const started = deferred(), finish = deferred();
    const hook = async () => { started.resolve(); await finish.promise; };
    const f = await fixture(t, {
      native: {getMe: async () => user({firstName: paginate ? 'a'.repeat(9000) : 'Alice'})},
      onEdit: paginate ? undefined : async (_message, text) => { if (text.startsWith('👤')) await hook(); },
      onReply: paginate ? hook : undefined,
    });
    const running = f.run();
    await started.promise;
    assert.equal((await f.host.unload('ids', 5)).completed, false);
    const count = f.edits.length + f.replies.length;
    finish.resolve(); await running;
    assert.equal(f.edits.length + f.replies.length, count);
  }
});
