import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("lottery creates indexes for hot lookups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-lottery-db-"));
  const previousCwd = process.cwd();
  let plugin: { cleanup?: () => void } | undefined;
  try {
    process.chdir(root);
    plugin = require("./lottery").default;
    const database = new Database(
      path.join(root, "assets", "lottery", "lottery.db"),
      { readonly: true },
    );
    try {
      const indexNames = new Set(
        (database.prepare("PRAGMA index_list(lottery_winners)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      assert.equal(indexNames.has("idx_lottery_winners_lottery_assigned"), true);
      assert.equal(indexNames.has("idx_lottery_winners_lottery_user"), true);
      assert.equal(indexNames.has("idx_lottery_winners_pending_expiry"), true);

      const activePlan = database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM lottery_config WHERE chat_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        )
        .all("123") as Array<{ detail: string }>;
      assert.match(
        activePlan.map((row) => row.detail).join("\n"),
        /idx_lottery_config_active_chat_created/,
      );

      const participantPlan = database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT 1 FROM lottery_participants WHERE lottery_id = ? AND user_id = ? LIMIT 1",
        )
        .all(1, "2") as Array<{ detail: string }>;
      assert.match(
        participantPlan.map((row) => row.detail).join("\n"),
        /sqlite_autoindex_lottery_participants_1/,
      );
    } finally {
      database.close();
    }

    plugin?.cleanup?.();
    plugin = undefined;
    delete require.cache[require.resolve("./lottery")];
    assert.doesNotThrow(() => {
      plugin = require("./lottery").default;
    });
  } finally {
    plugin?.cleanup?.();
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
