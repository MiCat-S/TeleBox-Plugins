import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("keyword full-table replacement rolls back when one insert fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-keyword-db-"));
  const previousCwd = process.cwd();
  let plugin: { cleanup?: () => void; cmdHandlers: Record<string, (msg: unknown) => Promise<void>> } | undefined;
  const edits: string[] = [];
  try {
    process.chdir(root);
    plugin = require("./keyword").default;
    const makeMessage = (key: string) => ({
      message: `.keyword ${key}\n+++\nreply-${key}`,
      chat: { id: 123 },
      edit: async ({ text }: { text: string }) => {
        edits.push(text);
      },
    });

    await plugin!.cmdHandlers.keyword(makeMessage("good"));
    const database = new Database(
      path.join(root, "assets", "keyword", "keyword.db"),
    );
    try {
      assert.deepEqual(
        database.prepare("SELECT task_id, key FROM keyword_tasks ORDER BY task_id").all(),
        [{ task_id: 1, key: "good" }],
      );
      database.exec(`
        CREATE TRIGGER reject_bad_keyword
        BEFORE INSERT ON keyword_tasks
        WHEN NEW.key = 'bad'
        BEGIN
          SELECT RAISE(ABORT, 'rejected for test');
        END;
      `);

      await plugin!.cmdHandlers.keyword(makeMessage("bad"));
      assert.deepEqual(
        database.prepare("SELECT task_id, key FROM keyword_tasks ORDER BY task_id").all(),
        [{ task_id: 1, key: "good" }],
      );
      assert.equal(edits.some((text) => text.includes("rejected for test")), true);
    } finally {
      database.close();
    }
  } finally {
    plugin?.cleanup?.();
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
