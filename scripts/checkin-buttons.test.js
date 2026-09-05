const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const core = path.resolve(__dirname, "../../TeleBox-Core");
const { Api } = require(require.resolve("teleproto", { paths: [core] }));
const esbuild = require(require.resolve("esbuild", { paths: [core] }));
const source = fs.readFileSync(path.resolve(__dirname, "../checkin/checkin.ts"), "utf8");

function snippet(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

const moduleObject = { exports: {} };
vm.runInNewContext(esbuild.transformSync(`
  class Checkin {
    ${snippet("  private async clickCallbackButton(", "  private parseButtonMatcher(")}
    ${snippet("  private decodeData(", "  private isAfterMessage(")}
  }
  module.exports = Checkin;
`, { loader: "ts", format: "cjs", target: "es2022" }).code, {
  Api, Buffer, module: moduleObject,
});
const Checkin = moduleObject.exports;

test("checkin matches Layer 229 callbacks by text or data and sends the original bytes", async () => {
  const payload = Buffer.from("checkin");
  const button = new Api.KeyboardInlineButton({
    text: "Sign in", type: new Api.InlineButtonTypeCallback({ data: payload }),
  });
  const msg = {
    id: 99,
    replyMarkup: new Api.ReplyInlineMarkup({
      rows: [new Api.KeyboardInlineButtonRow({ buttons: [button] })],
    }),
  };
  const checkin = new Checkin();
  for (const target of [{ callbackData: "checkin" }, { buttonText: "Sign in" }]) {
    let sent;
    await checkin.clickCallbackButton({ invoke: async (request) => { sent = request; } }, "test-bot", msg, target);
    assert.deepEqual(sent.data, payload);
    assert.equal(sent.msgId, 99);
  }
});

test("checkin ignores URL buttons with matching text", async () => {
  const checkin = new Checkin();
  const msg = {
    replyMarkup: { rows: [{ buttons: [
      new Api.KeyboardInlineButton({
        text: "Sign in", type: new Api.InlineButtonTypeUrl({ url: "https://example.com" }),
      }),
    ] }] },
  };
  await assert.rejects(checkin.clickCallbackButton({
    invoke: async () => assert.fail("unexpected request"),
  }, "test-bot", msg, { buttonText: "Sign in" }), /未找到回调按钮/);
});
