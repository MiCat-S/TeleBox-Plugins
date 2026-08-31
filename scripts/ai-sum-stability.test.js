const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const coreRoot = path.resolve(repoRoot, "../TeleBox-Core");
const esbuild = require(
  require.resolve("esbuild", { paths: [repoRoot, coreRoot] }),
);

function loadSnippet(file, startMarker, endMarker, prelude, exportsExpression) {
  const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker in ${file}`);
  assert.notEqual(end, -1, `missing end marker in ${file}`);

  const compiled = esbuild.transformSync(
    `${prelude}\n${source.slice(start, end)}\nmodule.exports = ${exportsExpression};`,
    {
      format: "cjs",
      loader: "ts",
      target: "es2022",
    },
  ).code;

  const module = { exports: {} };
  const context = vm.createContext({
    AbortController,
    Buffer,
    Error,
    Promise,
    Symbol,
    clearTimeout,
    console,
    module,
    exports: module.exports,
    require,
    setTimeout,
  });
  vm.runInContext(compiled, context, { filename: file });
  return module.exports;
}

function createAbortToken(controller = new AbortController()) {
  return {
    get aborted() {
      return controller.signal.aborted;
    },
    get reason() {
      return controller.signal.reason?.toString();
    },
    get signal() {
      return controller.signal;
    },
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw new Error(this.reason);
    },
  };
}

class FakeStream extends EventEmitter {
  [Symbol.asyncIterator]() {
    return {
      next: async () => ({ done: true, value: undefined }),
    };
  }
}

const { TimeoutMiddleware } = loadSnippet(
  "ai/ai.ts",
  "class TimeoutMiddleware",
  "class HttpClient",
  "class UserError extends Error {}",
  "{ TimeoutMiddleware }",
);

const { runSummaryTaskOnce } = loadSnippet(
  "sum/sum.ts",
  "const runningSummaryTaskIds",
  "let pluginRuntimeContext",
  "",
  "{ runSummaryTaskOnce }",
);

const { normalizeStoredTimeout, timeoutToPanelSeconds } = loadSnippet(
  "sum/sum.ts",
  "function toInt",
  "function makeCronKey",
  "",
  "{ normalizeStoredTimeout, timeoutToPanelSeconds }",
);

const { cronDisposers, deletedCronKeys, unregisterScheduledTask } = loadSnippet(
  "sum/sum.ts",
  "let pluginRuntimeContext",
  "// 调度任务",
  `
    const deletedCronKeys = [];
    const makeCronKey = (id) => \`sum:\${id}\`;
    const cronManager = { del: (key) => deletedCronKeys.push(key) };
  `,
  "{ cronDisposers, deletedCronKeys, unregisterScheduledTask }",
);

test("non-stream requests remove external abort forwarding after completion", async () => {
  const middleware = new TimeoutMiddleware(
    Promise.resolve({ getConfig: () => ({ timeout: 1 }) }),
  );
  const external = createAbortToken();
  let combined;

  await middleware.process({}, async (_input, token) => {
    combined = token;
    return { data: { ok: true } };
  }, external);

  external.abort("late cancel");
  assert.equal(combined.aborted, false);
});

test("stream timeout stays active until the response body closes", async () => {
  const middleware = new TimeoutMiddleware(
    Promise.resolve({ getConfig: () => ({ timeout: 0.02 }) }),
  );
  const stream = new FakeStream();
  let combined;

  await middleware.process({}, async (_input, token) => {
    combined = token;
    return { data: stream };
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(combined.aborted, true);
  assert.match(combined.reason, /request timeout|请求超时/i);
  assert.equal(stream.listenerCount("end"), 0);
  assert.equal(stream.listenerCount("close"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});

test("stream completion clears timeout and abort forwarding", async () => {
  const middleware = new TimeoutMiddleware(
    Promise.resolve({ getConfig: () => ({ timeout: 0.02 }) }),
  );
  const external = createAbortToken();
  const stream = new FakeStream();
  let combined;

  await middleware.process({}, async (_input, token) => {
    combined = token;
    return { data: stream };
  }, external);

  stream.emit("end");
  external.abort("late cancel");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(combined.aborted, false);
});

test("summary task lock skips overlap and releases after completion", async () => {
  let releaseFirst;
  const first = runSummaryTaskOnce(
    "task-1",
    () => new Promise((resolve) => {
      releaseFirst = resolve;
    }),
  );

  assert.equal(await runSummaryTaskOnce("task-1", async () => "overlap"), null);
  releaseFirst("done");
  assert.equal(await first, "done");
  assert.equal(await runSummaryTaskOnce("task-1", async () => "next"), "next");
});

test("summary task lock releases after failure", async () => {
  await assert.rejects(
    runSummaryTaskOnce("task-2", async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.equal(await runSummaryTaskOnce("task-2", async () => "retry"), "retry");
});

test("summary cron unregister releases its lifecycle disposer immediately", async () => {
  let disposed = 0;
  cronDisposers.set("sum:task-3", () => {
    disposed += 1;
  });

  await unregisterScheduledTask("task-3");
  assert.equal(disposed, 1);
  assert.equal(cronDisposers.has("sum:task-3"), false);

  await unregisterScheduledTask("missing");
  assert.equal(deletedCronKeys.length, 1);
  assert.equal(deletedCronKeys[0], "sum:missing");
});

test("summary panel timeout converts seconds and migrates legacy values", () => {
  assert.equal(normalizeStoredTimeout(60), 60_000);
  assert.equal(normalizeStoredTimeout(120_000), 120_000);
  assert.equal(timeoutToPanelSeconds(60), 60);
  assert.equal(timeoutToPanelSeconds(120_000), 120);
});

test("OpenAI UA, reasoning, and service tier request behavior remains present", () => {
  const aiSource = fs.readFileSync(path.join(repoRoot, "ai/ai.ts"), "utf8");
  const sumSource = fs.readFileSync(path.join(repoRoot, "sum/sum.ts"), "utf8");

  assert.match(aiSource, /"User-Agent": CODEX_USER_AGENT/);
  assert.match(aiSource, /data\.reasoning = \{ effort: effectiveReasoningEffort \}/);
  assert.match(aiSource, /data\.reasoning_effort = effectiveReasoningEffort/);
  assert.match(aiSource, /data\.service_tier = effectiveServiceTier/);

  assert.match(sumSource, /"User-Agent": CODEX_USER_AGENT/);
  assert.match(sumSource, /payload\.reasoning = \{ effort: reasoningEffort \}/);
  assert.match(sumSource, /payload\.reasoning_effort = reasoningEffort/);
  assert.match(sumSource, /payload\.service_tier = serviceTier/);
});
