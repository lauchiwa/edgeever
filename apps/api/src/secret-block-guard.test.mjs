import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import {
  SECRET_BLOCK_MAX_PER_NOTE,
  SECRET_BLOCK_NODE_TYPE,
  createEncryptedNoteSalt,
  createSecretBlockId,
  decryptSecretBlockText,
  deriveEncryptedNoteKey,
  docToMarkdown,
  encryptSecretBlockText,
  markdownToDoc,
  resolveMemoContentDoc,
} from "@edgeever/shared";
import { createMemoRecord, updateMemoRecord } from "./memo-service.ts";
import { clientSupportsSecretBlocks, redactSecretBlockMemo, redactSecretBlocksDeep } from "./secret-block-guard.ts";

class Statement {
  constructor(sqlite, sql, bindings = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new Statement(this.sqlite, this.sql, bindings); }
  async all() { return { results: this.sqlite.query(this.sql).all(...this.bindings) }; }
  async first() { return this.sqlite.query(this.sql).get(...this.bindings) ?? null; }
  async run() { this.sqlite.query(this.sql).run(...this.bindings); return { success: true, meta: {} }; }
}

class Db {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new Statement(this.sqlite, sql); }
  async batch(statements) {
    const results = [];
    this.sqlite.transaction(() => {
      for (const statement of statements) results.push(this.sqlite.query(statement.sql).run(...statement.bindings));
    })();
    return results;
  }
}

const setup = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  const seed = sqlite.query("SELECT workspace_id, notebook_id FROM memos WHERE is_deleted = 0 ORDER BY id LIMIT 1").get();
  return { sqlite, db: new Db(sqlite), workspaceId: seed.workspace_id, notebookId: seed.notebook_id };
};

const actor = { actorType: "user", actorId: "user_owner" };
const ITERATIONS = 100_000;
const salt = createEncryptedNoteSalt();
const kdf = { salt, iterations: ITERATIONS };
const key = await deriveEncryptedNoteKey("vault passphrase", salt, ITERATIONS);
const envelope = await encryptSecretBlockText("root / hunter2", key, kdf);
const block = { id: createSecretBlockId(), label: "Prod DB", envelope };
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const editorDoc = (...content) => ({ type: "doc", content: [paragraph("deploy log"), { type: SECRET_BLOCK_NODE_TYPE, attrs: block }, ...content] });

const storedRow = (ctx, id) => ctx.sqlite.query(
  "SELECT c.content_markdown, c.content_text, c.content_json, m.excerpt FROM memo_contents c JOIN memos m ON m.id = c.memo_id WHERE c.memo_id = ?",
).get(id);

const createWithBlock = (ctx) => createMemoRecord(ctx.db, ctx.workspaceId, {
  notebookId: ctx.notebookId,
  title: "Deploy",
  contentJson: editorDoc(),
  contentMarkdown: docToMarkdown(editorDoc()),
}, actor, "owner");

const save = (ctx, id, doc, extra = {}) => updateMemoRecord(ctx.db, ctx.workspaceId, id, {
  contentJson: doc,
  contentMarkdown: docToMarkdown(doc),
  ...extra,
}, actor, "owner");

describe("secret block server guard", () => {
  test("stores blocks as code fences and keeps ciphertext out of search text", async () => {
    const ctx = setup();
    const memo = await createWithBlock(ctx);
    const row = storedRow(ctx, memo.id);
    expect(row.content_json).not.toContain(SECRET_BLOCK_NODE_TYPE);
    expect(JSON.parse(row.content_json).content[1]).toMatchObject({ type: "codeBlock", attrs: { language: "edgeever-secret" } });
    expect(row.content_text).toBe("deploy log 🔒 Prod DB");
    expect(row.excerpt).not.toContain(envelope.ct);
    const searchDoc = ctx.sqlite.query("SELECT content_text FROM memo_search_documents WHERE memo_id = ?").get(memo.id);
    expect(searchDoc.content_text).not.toContain(envelope.ct);
    const restored = resolveMemoContentDoc(JSON.parse(row.content_json), row.content_markdown);
    expect(restored.content[1]).toEqual({ type: SECRET_BLOCK_NODE_TYPE, attrs: block });
    expect(await decryptSecretBlockText(restored.content[1].attrs.envelope, key)).toBe("root / hunter2");
    ctx.sqlite.close();
  });

  test("an unaware client may edit around blocks but not drop or alter them", async () => {
    const ctx = setup();
    const memo = await createWithBlock(ctx);
    const stored = JSON.parse(storedRow(ctx, memo.id).content_json);

    // An older client keeps the stored code block and edits the rest.
    const edited = await save(ctx, memo.id, { ...stored, content: [...stored.content, paragraph("more notes")] });
    expect(edited.error).toBeUndefined();

    const renamed = await save(ctx, memo.id, {
      ...stored,
      content: [stored.content[0], { ...stored.content[1], content: [{ type: "text", text: JSON.stringify({ ...block, label: "Prod DB (old)" }) }] }],
    });
    expect(renamed.error).toBeUndefined();

    const before = storedRow(ctx, memo.id).content_markdown;
    const dropped = await save(ctx, memo.id, { type: "doc", content: [paragraph("deploy log")] });
    expect(dropped).toMatchObject({ error: "secret_block_update_required", status: 409 });
    const broken = await save(ctx, memo.id, {
      ...stored,
      content: [stored.content[0], { ...stored.content[1], content: [{ type: "text", text: JSON.stringify(block).replace(envelope.ct.slice(0, 8), "AAAAAAAA") }] }],
    });
    expect(broken).toMatchObject({ error: "secret_block_update_required" });
    const redactedWriteBack = await updateMemoRecord(ctx.db, ctx.workspaceId, memo.id, {
      contentMarkdown: "deploy log\n\n🔒 Prod DB",
    }, actor, "owner");
    expect(redactedWriteBack).toMatchObject({ error: "secret_block_update_required" });
    expect(storedRow(ctx, memo.id).content_markdown).toBe(before);
    ctx.sqlite.close();
  });

  test("an aware client may delete or re-encrypt blocks", async () => {
    const ctx = setup();
    const memo = await createWithBlock(ctx);
    const reencrypted = await encryptSecretBlockText("root / new-pass", key, kdf);
    const next = await save(ctx, memo.id, {
      type: "doc",
      content: [paragraph("deploy log"), { type: SECRET_BLOCK_NODE_TYPE, attrs: { ...block, envelope: reencrypted } }],
    }, { secretBlocksAware: true });
    expect(next.error).toBeUndefined();
    const deleted = await save(ctx, memo.id, { type: "doc", content: [paragraph("deploy log")] }, { secretBlocksAware: true });
    expect(deleted.error).toBeUndefined();
    expect(storedRow(ctx, memo.id).content_markdown).not.toContain("edgeever-secret");
    ctx.sqlite.close();
  });

  test("notes without blocks are unaffected", async () => {
    const ctx = setup();
    const memo = await createMemoRecord(ctx.db, ctx.workspaceId, { notebookId: ctx.notebookId, contentMarkdown: "plain" }, actor, "owner");
    const next = await save(ctx, memo.id, markdownToDoc("plain edited"));
    expect(next.error).toBeUndefined();
    ctx.sqlite.close();
  });

  test("caps the number of blocks per note", async () => {
    const ctx = setup();
    const many = { type: "doc", content: Array.from({ length: SECRET_BLOCK_MAX_PER_NOTE + 1 }, () => ({
      type: SECRET_BLOCK_NODE_TYPE, attrs: { ...block, id: createSecretBlockId() },
    })) };
    await expect(createMemoRecord(ctx.db, ctx.workspaceId, {
      notebookId: ctx.notebookId, contentJson: many, contentMarkdown: docToMarkdown(many),
    }, actor, "owner")).rejects.toMatchObject({ code: "secret_block_limit" });
    ctx.sqlite.close();
  });

  test("redacts ciphertext from memos sent to agents", async () => {
    const ctx = setup();
    const memo = await createWithBlock(ctx);
    const redacted = redactSecretBlockMemo(memo);
    expect(redacted.contentMarkdown).toBe("deploy log\n\n🔒 Prod DB");
    expect(JSON.stringify(redacted.contentJson)).not.toContain(envelope.ct);
    expect(redacted.contentText).toBe("deploy log 🔒 Prod DB");
    const plain = { contentMarkdown: "a", contentJson: markdownToDoc("a"), contentText: "a" };
    expect(redactSecretBlockMemo(plain)).toBe(plain);
    ctx.sqlite.close();
  });

  test("redacts every content field in nested tool results", async () => {
    const ctx = setup();
    const memo = await createWithBlock(ctx);
    const result = { memo, revisions: [{ contentMarkdown: memo.contentMarkdown }], template: { contentJson: memo.contentJson } };
    const redacted = redactSecretBlocksDeep(result);
    expect(JSON.stringify(redacted)).not.toContain(envelope.ct);
    expect(redacted.revisions[0].contentMarkdown).toBe("deploy log\n\n🔒 Prod DB");
    expect(JSON.stringify(result)).toContain(envelope.ct);
    const plain = { memo: { contentMarkdown: "a", contentJson: markdownToDoc("a") }, items: [1, "x"] };
    expect(redactSecretBlocksDeep(plain)).toBe(plain);
    ctx.sqlite.close();
  });

  test("reads the client features header", () => {
    expect(clientSupportsSecretBlocks("secret-blocks-v1")).toBe(true);
    expect(clientSupportsSecretBlocks("other, secret-blocks-v1")).toBe(true);
    expect(clientSupportsSecretBlocks("secret-blocks-v2")).toBe(false);
    expect(clientSupportsSecretBlocks(undefined)).toBe(false);
  });
});
