import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("aitc cleanup closes the config DB and allows a clean reopen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-aitc-db-"));
  const previousCwd = process.cwd();
  let plugin: { cleanup?: () => void; cmdHandlers: Record<string, (msg: unknown) => Promise<void>> } | undefined;
  try {
    process.chdir(root);
    plugin = require("./aitc").default;
    const message = (temperature: string) => ({
      message: `.aitc temp ${temperature}`,
      edit: async () => undefined,
    });
    await plugin!.cmdHandlers.aitc(message("0.5"));

    const dbPath = path.join(root, "assets", "aitc", "aitc_config.db");
    plugin!.cleanup?.();
    fs.unlinkSync(dbPath);

    await plugin!.cmdHandlers.aitc(message("0.6"));
    assert.equal(fs.existsSync(dbPath), true);
    const database = new Database(dbPath, { readonly: true });
    try {
      assert.equal(
        (database
          .prepare("SELECT value FROM config WHERE key = 'aitc_temperature'")
          .get() as { value: string }).value,
        "0.6",
      );
    } finally {
      database.close();
    }
  } finally {
    plugin?.cleanup?.();
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
