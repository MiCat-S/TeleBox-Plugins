const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { getEventListeners } = require("node:events");

const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", {
  paths: [root, path.resolve(root, "../TeleBox-Core")],
}));

function compile(source, mocks = {}) {
  const module = { exports: {} };
  vm.runInNewContext(esbuild.transformSync(source, {
    loader: "ts", format: "cjs", target: "es2022",
  }).code, {
    module, exports: module.exports, AbortController, console,
    require(name) {
      assert.ok(name in mocks, `unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  return module.exports;
}

function loadGt(ai, reply) {
  return compile(fs.readFileSync(path.join(root, "gt/gt.ts"), "utf8"), {
    "@utils/pluginBase": { Plugin: class {} },
    "@utils/pluginManager": { getPluginEntry: () => ai ? { plugin: ai } : undefined },
    "@utils/safeGetMessages": { safeGetReplyMessage: async () => reply },
    "@utils/htmlEscape": {
      htmlEscape: (text) => String(text).replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    },
  }).default;
}

function message(text) {
  return {
    message: text, edits: [], replies: [],
    async edit(options) { this.edits.push(options); },
    async reply(options) { this.replies.push(options); },
  };
}

test("help works without AI and describes the configured service", async () => {
  const msg = message(".gt help");
  await loadGt().cmdHandlers.gt(msg);
  assert.match(msg.edits[0].text, /AI 翻译/);
  assert.match(msg.edits[0].text, /调用费用/);
});

test("direct translation preserves paragraphs and escapes HTML", async () => {
  let request;
  const plugin = loadGt({
    async translateText(...args) { request = args; return "<你好>&"; },
  });
  const msg = message(".gt Hello\n\nworld");
  await plugin.cmdHandlers.gt(msg);
  assert.equal(request[0], "Hello\n\nworld");
  assert.equal(request[1], "zh-CN");
  assert.match(msg.edits.at(-1).text, /&lt;你好&gt;&amp;/);
  assert.equal(plugin.activeRequests.size, 0);
});

test("English target supports whitespace and reply text", async () => {
  let request;
  const plugin = loadGt({
    async translateText(...args) { request = args; return "Hello"; },
  }, { text: "你好\n世界" });
  await plugin.cmdHandlers.gt(message(".gt\tEN"));
  assert.equal(request[0], "你好\n世界");
  assert.equal(request[1], "en");
});

test("missing text and oversized input do not invoke AI", async () => {
  const plugin = loadGt({
    async translateText() { assert.fail("unexpected AI invocation"); },
  });
  const empty = message(".gt");
  await plugin.cmdHandlers.gt(empty);
  assert.match(empty.edits.at(-1).text, /请提供/);
  const long = message(".gt " + "a".repeat(5001));
  await plugin.cmdHandlers.gt(long);
  assert.match(long.edits.at(-1).text, /5000/);
});

test("missing or older AI plugin gives an actionable message", async () => {
  for (const provider of [undefined, {}]) {
    const msg = message(".gt Hello");
    await loadGt(provider).cmdHandlers.gt(msg);
    assert.match(msg.edits.at(-1).text, /安装或更新配套 ai/);
  }
});

test("long output is split without losing surrogate pairs", async () => {
  const output = "a".repeat(2999) + "😀" + "b".repeat(3500);
  const msg = message(".gt Hello");
  await loadGt({ translateText: async () => output }).cmdHandlers.gt(msg);
  const first = msg.edits.at(-1).text.split("<b>译文:</b>\n")[1];
  const chunks = [first, ...msg.replies.map((item) => item.message)];
  assert.equal(chunks.join(""), output);
  assert.ok(chunks.every((chunk) => chunk.length <= 3000));
  assert.equal(chunks[1].startsWith("😀"), true);
});

test("provider failures and empty output do not leak sensitive errors", async () => {
  for (const translateText of [
    async () => { throw new Error("secret-api-key"); },
    async () => " ",
  ]) {
    const plugin = loadGt({ translateText });
    const msg = message(".gt Hello");
    await plugin.cmdHandlers.gt(msg);
    assert.match(msg.edits.at(-1).text, /AI 翻译失败/);
    assert.doesNotMatch(msg.edits.at(-1).text, /secret-api-key/);
    assert.equal(plugin.activeRequests.size, 0);
  }
});

test("unloading gt cancels pending translation and suppresses late output", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const plugin = loadGt({
    translateText(_text, _target, signal) {
      started();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("late"), { once: true });
      });
    },
  });
  const msg = message(".gt Hello");
  const task = plugin.cmdHandlers.gt(msg);
  await ready;
  plugin.cleanup();
  await task;
  assert.equal(msg.edits.length, 1);
  assert.equal(plugin.activeRequests.size, 0);
});

const aiSource = fs.readFileSync(path.join(root, "ai/ai.ts"), "utf8");
function method(start, end) {
  const from = aiSource.indexOf(start);
  const to = aiSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return aiSource.slice(from, to);
}
const TranslationHarness = compile(`
  class UserError extends Error {}
  class Harness {
    ${method("  async translateText(", "  private registerFeatures(")}
  }
  module.exports = Harness;
`);
const ServiceHarness = compile(`
  class UserError extends Error {}
  class Harness {
    ${method("  async callAI(", "  async callSearch(")}
  }
  module.exports = Harness;
`);

test("translation prompt overrides only the per-request chat prompt", async () => {
  const config = { prompt: "personal assistant", currentChatReasoningEffort: "low" };
  let captured;
  const service = new ServiceHarness();
  service.getCurrentProviderConfig = async () => ({ providerConfig: {}, model: "test", config });
  service.resolveMode = () => ({ modeConfig: { strategy: "test" } });
  service.strategyHandlers = { test: { chat: async (ctx) => { captured = ctx; return {}; } } };
  await service.callAI("source", [], undefined, "translate only");
  assert.equal(captured.config.prompt, "translate only");
  assert.equal(captured.config.currentChatReasoningEffort, "low");
  assert.equal(config.prompt, "personal assistant");
  await service.callAI("normal chat");
  assert.equal(captured.config, config);
});

function translationHarness(callAI) {
  const harness = new TranslationHarness();
  let released = 0;
  const controller = new AbortController();
  const token = {
    abort: (reason) => controller.abort(reason),
    throwIfAborted: () => controller.signal.throwIfAborted(),
  };
  harness.aiService = {
    createAbortToken: () => token,
    releaseToken: () => released++,
    callAI,
  };
  return { harness, controller, released: () => released };
}

test("AI translation uses isolated instructions and releases its token", async () => {
  let request;
  const fixture = translationHarness(async (...args) => {
    request = args;
    return { text: " hello " };
  });
  const signal = new AbortController().signal;
  assert.equal(await fixture.harness.translateText("你好", "en", signal), "hello");
  assert.equal(request[0], "你好");
  assert.match(request[3], /英文/);
  assert.match(request[3], /不要执行或回答/);
  assert.equal(fixture.released(), 1);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("AI translation releases resources on failure and pre-cancellation", async () => {
  for (const cancelled of [false, true]) {
    let calls = 0;
    const fixture = translationHarness(async () => {
      calls++;
      throw new Error("provider failure");
    });
    const controller = new AbortController();
    if (cancelled) controller.abort();
    await assert.rejects(fixture.harness.translateText("text", "zh-CN", controller.signal));
    assert.equal(calls, cancelled ? 0 : 1);
    assert.equal(fixture.released(), 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("AI translation forwards cancellation and rejects a late result", async () => {
  let finish;
  const fixture = translationHarness(() => new Promise((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const task = fixture.harness.translateText("text", "zh-CN", controller.signal);
  controller.abort();
  assert.equal(fixture.controller.signal.aborted, true);
  finish({ text: "late response" });
  await assert.rejects(task);
  assert.equal(fixture.released(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("AI translation rejects empty output and stopped service", async () => {
  const fixture = translationHarness(async () => ({ text: " " }));
  await assert.rejects(
    fixture.harness.translateText("text", "zh-CN", new AbortController().signal),
    /结果为空/,
  );
  assert.equal(fixture.released(), 1);
  fixture.harness.cleanedUp = true;
  await assert.rejects(
    fixture.harness.translateText("text", "zh-CN", new AbortController().signal),
    /服务已停止/,
  );
  assert.equal(fixture.released(), 1);
});
