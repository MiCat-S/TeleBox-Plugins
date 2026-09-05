'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const envelope = {id: 17, chatId: '42', senderId: '42', outgoing: true, text: '.dc'};
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
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-dc-candidate-')));
  await fs.mkdir(path.join(buildRoot, 'node_modules'));
  for (const [name, source] of [['telebox', core], ['teleproto', path.join(core, 'node_modules/teleproto')]]) {
    await fs.symlink(source, path.join(buildRoot, 'node_modules', name), 'dir');
  }
  const built = buildPlugin({id: 'dc', packageRoot: path.resolve(__dirname, '../dc'), entry: 'v2.ts', rootDir: buildRoot});
  manifest = built.manifest;
  const modulePath = require.resolve(path.join(core, 'node_modules/teleproto'));
  const loaded = Boolean(require.cache[modulePath]);
  createPlugin = require(path.join(built.artifactDir, 'index.cjs')).default;
  createPlugin();
  assert.equal(Boolean(require.cache[modulePath]), loaded, 'factory import must not load Teleproto');
  ({Api} = require(path.join(core, 'node_modules/teleproto')));
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-dc-v2-')));
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
    run: (text = '.dc', fields = {}) => host.dispatchPrimary({...envelope, text, ...fields})};
}
test('dc builds a pure default SDK factory with declared protocol dependencies', async t => {
  assert.equal(typeof createPlugin, 'function');
  const first = createPlugin();
  assert.notEqual(first, createPlugin());
  assert.equal(first.id, 'dc');
  assert.equal(first.apiVersion, 1);
  assert.deepEqual(Object.keys(first.commands), ['dc']);
  assert.deepEqual(manifest.imports, ['telebox/sdk', 'teleproto', 'teleproto/Helpers.js']);
  assert.equal(first.setup, undefined);
  assert.equal(first.cleanup, undefined);
  const f = await fixture(t);
  assert.equal(f.calls.length + f.edits.length, 0);
});
test('dc obeys host outgoing/saved/edited authorization', async t => {
  const f = await fixture(t);
  await f.run(undefined, {outgoing: false});
  await f.run(undefined, {edited: true});
  assert.equal(f.calls.length + f.edits.length, 0);
  await f.run(undefined, {outgoing: false, saved: true});
  assert.ok(f.edits.length > 0);
});
test('dc unload/reload 50 cycles leaves no commands, tasks or duplicate effects', async t => {
  const f = await fixture(t);
  for (let cycle = 0; cycle < 50; cycle++) {
    await f.run();
    assert.equal((await f.host.unload('dc', 1000)).completed, true);
    const snapshot = f.host.snapshot();
    assert.equal(snapshot.plugins, 0);
    assert.equal(snapshot.commands, 0);
    assert.equal(snapshot.lifecycle.pendingTasks, 0);
    if (cycle !== 49) await f.host.load(createPlugin());
  }
  assert.equal(f.edits.length, 100);
});

test('dc rejects multiple targets before native access', async t => {
  const f = await fixture(t);
  await f.run('.dc @one @two');
  assert.equal(f.calls.length, 0);
  assert.equal(f.edits.at(-1).text, '❌ 参数错误，最多只能指定一个用户');
});

test('dc current chat uses the exact marked peer and preserves escaped output', async t => {
  const f = await fixture(t, {native: {getEntity: async peer => {
    assert.equal(peer.toString(), '-1009007199254740993');
    return {title: '<Name&>', photo: {className: 'ChatPhoto', dcId: 5}};
  }}});
  await f.run('.dc', {chatId: '-1009007199254740993'});
  assert.deepEqual(f.calls.map(call => call.method), ['getEntity']);
  assert.equal(f.edits.at(-1).text, '📍 <b>&lt;Name&amp;&gt;</b> 所在数据中心为: <b>DC5</b>');
  assert.deepEqual(f.edits.at(-1).options, {parseMode: 'html'});
});

test('dc current chat uses its borrowed native message or a complete cached chat', async t => {
  const f = await fixture(t);
  let reads = 0;
  const chat = {title: 'Group', photo: {className: 'ChatPhoto', dcId: 2}};
  await f.run('.dc', {raw: {client: f.client, async getChat() {reads++; return chat;}}});
  await f.run('.dc', {raw: {chat}});
  assert.equal(reads, 1);
  assert.equal(f.calls.length, 0);
  assert.ok(f.edits.at(-1).text.includes('DC2'));
});

test('dc never invokes a raw message bound to a different native client', async t => {
  const f = await fixture(t);
  await f.run('.dc', {raw: {client: {}, async getChat() {assert.fail('foreign client access');}}});
  assert.deepEqual(f.calls.map(call => call.method), ['getEntity']);
});

test('dc missing current chat photos retain the original notice', async t => {
  for (const chat of [undefined, {}, {photo: new Api.ChatPhotoEmpty()}]) {
    const f = await fixture(t, {native: {getEntity: async () => chat}});
    await f.run();
    assert.equal(f.edits.at(-1).text, '❌ 当前群组/频道没有头像，无法获取 DC 信息');
  }
});

test('dc explicit usernames and exact numeric IDs resolve before full-user RPC', async t => {
  for (const target of ['@alice', '9007199254740993']) {
    const f = await fixture(t);
    await f.run('.dc ' + target);
    assert.deepEqual(f.calls.map(call => call.method), ['getEntity', 'getInputEntity', 'invoke']);
    assert.equal(f.calls[0].args[0].toString(), target);
    assert.equal(typeof f.calls[0].args[0], target.startsWith('@') ? 'string' : 'object');
    assert.ok(f.edits.at(-1).text.includes('Alice'));
    assert.ok(f.edits.at(-1).text.includes('DC4'));
  }
});

test('dc mention-name and phone entities preserve peer-ID interpretation', async t => {
  const f = await fixture(t);
  await f.run('.dc mention', {raw: {entities: [new Api.MessageEntityMentionName({offset: 4, length: 7, userId: integer('9007199254740993')})]}});
  assert.equal(f.calls[0].args[0].toString(), '9007199254740993');
  await f.run('.dc 9007199254740993', {raw: {entities: [new Api.MessageEntityPhone({offset: 4, length: 16})]}});
  assert.equal(f.calls[3].args[0].toString(), '9007199254740993');
  assert.equal(typeof f.calls[3].args[0], 'object');
  await f.run('.dc 0');
  assert.equal(f.calls.length, 6);
  assert.equal(f.edits.at(-1).text, '❌ 请指定有效的用户名或用户ID');
});

test('dc reply takes priority over explicit target and uses exact sender ID', async t => {
  const f = await fixture(t, {reply: {...envelope, senderId: '9007199254740993'}});
  await f.run('.dc @ignored', {replyToId: 7, topicId: 4});
  assert.deepEqual(f.calls.map(call => call.method), ['getInputEntity', 'invoke']);
  assert.equal(f.calls[0].args[0].toString(), '9007199254740993');
  assert.equal(f.replyReads.length, 1);
  assert.equal(f.edits.at(-1).message.topicId, 4);
});

test('dc absent reply and sender produce distinct notices without querying another user', async t => {
  for (const [reply, text] of [[undefined, '❌ 无法获取回复的消息'], [{...envelope, senderId: undefined}, '❌ 无法获取回复消息的发送者']]) {
    const f = await fixture(t, {reply});
    await f.run('.dc @ignored', {replyToId: 7});
    assert.equal(f.calls.length, 0);
    assert.equal(f.edits.at(-1).text, text);
  }
});

test('dc photo-free reply does not fall back to the chat', async t => {
  const f = await fixture(t, {reply: {...envelope, senderId: '123'}, native: {
    invoke: async () => full(user({photo: undefined})), getEntity: async () => assert.fail('must not fall back'),
  }});
  await f.run('.dc', {replyToId: 7});
  assert.equal(f.edits.at(-1).text, '❌ 目标用户没有头像，无法获取 DC 信息');
});

test('dc failed reply-user RPC falls back to the reply chat without leaking errors', async t => {
  const f = await fixture(t, {reply: {...envelope, senderId: '-100123', chatId: '-100456'}, native: {
    invoke: async () => {throw new Error('private-token');},
    getEntity: async peer => {assert.equal(peer.toString(), '-100456'); return {title: 'Reply group', photo: {dcId: 2}};},
  }});
  await f.run('.dc @ignored', {replyToId: 7});
  assert.equal(f.edits.at(-1).text, '📍 <b>Reply group</b> 所在数据中心为: <b>DC2</b>');
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private-token/);
});

test('dc reply-chat fallback distinguishes empty photos and inaccessible chats', async t => {
  for (const [getEntity, text] of [[async () => ({}), '❌ 回复的消息所在对话需要先设置头像'],
    [async () => {throw new Error('private-token');}, '❌ 无法获取该对象的 DC 信息']]) {
    const f = await fixture(t, {reply: {...envelope}, native: {invoke: async () => {throw new Error('unavailable');}, getEntity}});
    await f.run('.dc', {replyToId: 7});
    assert.equal(f.edits.at(-1).text, text);
  }
});

test('dc target without a photo keeps its target-specific notice', async t => {
  const f = await fixture(t, {native: {invoke: async () => full(user({photo: new Api.UserProfilePhotoEmpty()}))}});
  await f.run('.dc @alice');
  assert.equal(f.edits.at(-1).text, '❌ 目标用户需要先设置头像才能获取 DC 信息');
});

test('dc known error categories retain messages and unknown errors are sanitized', async t => {
  const cases = [
    ['Cannot find any entity corresponding to private-token', '❌ 找不到对应的用户或实体'],
    ['No user has private-token', '❌ 没有找到指定的用户'],
    ['Could not find the input entity for private-token', '❌ 无法找到输入的实体'],
    ['int too big to convert private-token', '❌ 用户ID过长，请检查输入'],
    ['proxy://private-token@host', '❌ <b>获取用户信息失败:</b> 未知错误，请稍后重试'],
  ];
  for (const [error, text] of cases) {
    const f = await fixture(t, {native: {getEntity: async () => {throw new Error(error);}}});
    await f.run('.dc @alice');
    assert.equal(f.edits.at(-1).text, text);
    assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private-token/);
  }
  const f = await fixture(t, {native: {getEntity: async () => {throw new Error('private-token');}}});
  await f.run('.dc');
  assert.equal(f.edits.at(-1).text, '❌ <b>DC 查询失败:</b> 未知错误，请稍后重试');
});

for (const method of ['getEntity', 'getInputEntity', 'invoke']) {
  for (const rejects of [false, true]) test('dc cancellation retains ' + method + ' until actual settlement (' + rejects + ')', async t => {
    const started = deferred(), finish = deferred();
    const f = await fixture(t, {native: {[method]: async () => {started.resolve(); return finish.promise;}}});
    let settled = false;
    const running = f.run('.dc @alice').finally(() => {settled = true;});
    await started.promise;
    const report = await f.host.unload('dc', 5);
    assert.equal(report.completed, false);
    assert.ok(report.pendingTasks > 0);
    assert.equal(settled, false);
    if (rejects) finish.reject(new Error('private-token'));
    else finish.resolve(method === 'invoke' ? full() : user());
    await running;
    assert.equal(f.edits.length, 1);
    assert.equal(f.calls.at(-1).method, method);
    assert.equal((await f.host.unload('dc')).completed, true);
  });
}

test('dc cancellation during reply read and final edit suppresses late effects', async t => {
  for (const phase of ['reply', 'edit']) {
    const started = deferred(), finish = deferred();
    const f = await fixture(t, {
      reply: phase === 'reply' ? async () => {started.resolve(); await finish.promise; return envelope;} : undefined,
      onEdit: phase === 'edit' ? async (_message, text) => {if (text.startsWith('📍')) {started.resolve(); await finish.promise;}} : undefined,
    });
    const running = f.run('.dc @alice', phase === 'reply' ? {replyToId: 3} : {});
    await started.promise;
    assert.equal((await f.host.unload('dc', 5)).completed, false);
    const count = f.edits.length;
    finish.resolve(); await running;
    assert.equal(f.edits.length, count);
    if (phase === 'reply') assert.equal(f.calls.length, 0);
  }
});
