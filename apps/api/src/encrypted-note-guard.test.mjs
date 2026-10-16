import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import {
  ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  createEncryptedNoteSalt,
  deriveEncryptedNoteKey,
  encryptNoteDoc,
  markdownToDoc,
  parseEncryptedNoteEnvelope,
  serializeEncryptedNoteEnvelope,
} from "@edgeever/shared";
import { createMemoRecord, getMemoDetail, getMemoDetailRow, listMemosForMcp, mergeMemosRecord, updateMemoRecord } from "./memo-service.ts";
import { restoreMemoRevision } from "./memo-revision-service.ts";

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

const sealed = async (text) => {
  const salt = createEncryptedNoteSalt();
  const key = await deriveEncryptedNoteKey("vault passphrase", salt, ITERATIONS);
  const envelope = await encryptNoteDoc(markdownToDoc(text), key, { salt, iterations: ITERATIONS });
  return serializeEncryptedNoteEnvelope(envelope);
};

const createEncrypted = async (ctx, text = "secret body") => createMemoRecord(ctx.db, ctx.workspaceId, {
  notebookId: ctx.notebookId,
  title: "Vault",
  // A buggy client sending real content in JSON must not leak into search.
  contentJson: markdownToDoc(text),
  contentMarkdown: await sealed(text),
}, actor, "owner");

const storedRow = (ctx, id) => ctx.sqlite.query(
  "SELECT c.content_markdown, c.content_text, c.content_json, m.excerpt FROM memo_contents c JOIN memos m ON m.id = c.memo_id WHERE c.memo_id = ?",
).get(id);

describe("encrypted note server guard", () => {
  test("create stores the envelope verbatim and forces placeholder text", async () => {
    const ctx = setup();
    const memo = await createEncrypted(ctx);
    const row = storedRow(ctx, memo.id);
    expect(parseEncryptedNoteEnvelope(row.content_markdown)).not.toBeNull();
    expect(row.content_text).toBe(ENCRYPTED_NOTE_PLACEHOLDER_TEXT);
    expect(row.content_json).not.toContain("secret body");
    expect(row.excerpt).not.toContain("secret body");
    const searchDoc = ctx.sqlite.query("SELECT content_text FROM memo_search_documents WHERE memo_id = ?").get(memo.id);
    expect(searchDoc.content_text).toBe(ENCRYPTED_NOTE_PLACEHOLDER_TEXT);
    ctx.sqlite.close();
  });

  test("create rejects a corrupt envelope", async () => {
    const ctx = setup();
    await expect(createMemoRecord(ctx.db, ctx.workspaceId, {
      notebookId: ctx.notebookId,
      contentMarkdown: "<!-- edgeever-encrypted-v1:bm90LWpzb24 -->",
    }, actor, "owner")).rejects.toMatchObject({ code: "invalid_encrypted_note" });
    ctx.sqlite.close();
  });

  test("update without a valid envelope cannot overwrite the ciphertext (upstream mobile editors)", async () => {
    const ctx = setup();
    const memo = await createEncrypted(ctx);
    const before = storedRow(ctx, memo.id).content_markdown;

    const viaMarkdown = await updateMemoRecord(ctx.db, ctx.workspaceId, memo.id, {
      contentJson: markdownToDoc(`${ENCRYPTED_NOTE_PLACEHOLDER_TEXT} edited`),
      contentMarkdown: `${ENCRYPTED_NOTE_PLACEHOLDER_TEXT} edited`,
    }, actor, "owner");
    expect(viaMarkdown.error).toBe("encrypted_update_required");
    expect(viaMarkdown.status).toBe(409);

    const viaJsonOnly = await updateMemoRecord(ctx.db, ctx.workspaceId, memo.id, {
      contentJson: markdownToDoc("legacy editor"),
    }, actor, "owner");
    expect(viaJsonOnly.error).toBe("encrypted_update_required");
    expect(storedRow(ctx, memo.id).content_markdown).toBe(before);

    const tagsOnly = await updateMemoRecord(ctx.db, ctx.workspaceId, memo.id, { tags: ["private"] }, actor, "owner");
    expect(tagsOnly.memo.tags).toEqual(["private"]);
    expect(storedRow(ctx, memo.id).content_markdown).toBe(before);
    ctx.sqlite.close();
  });

  test("update with a fresh envelope succeeds and keeps search text as placeholder", async () => {
    const ctx = setup();
    const memo = await createEncrypted(ctx);
    const next = await updateMemoRecord(ctx.db, ctx.workspaceId, memo.id, {
      expectedRevision: memo.revision,
      contentJson: markdownToDoc("new secret"),
      contentMarkdown: await sealed("new secret"),
    }, actor, "owner");
    expect(next.error).toBeUndefined();
    expect(storedRow(ctx, memo.id).content_text).toBe(ENCRYPTED_NOTE_PLACEHOLDER_TEXT);
    ctx.sqlite.close();
  });

  test("revision restore cannot replace an encrypted note with an older plaintext body", async () => {
    const ctx = setup();
    const plain = await createMemoRecord(ctx.db, ctx.workspaceId, { notebookId: ctx.notebookId, contentMarkdown: "old plaintext" }, actor, "owner");
    const encrypted = await updateMemoRecord(ctx.db, ctx.workspaceId, plain.id, { contentMarkdown: await sealed("secret") }, actor, "owner");
    expect(encrypted.error).toBeUndefined();
    const revision = ctx.sqlite.query("SELECT id FROM memo_revisions WHERE memo_id = ? ORDER BY revision DESC LIMIT 1").get(plain.id);
    expect(revision).toBeTruthy();
    await expect(restoreMemoRevision(ctx.db, ctx.workspaceId, plain.id, revision.id, actor, "owner", { getMemoDetail, getMemoDetailRow }))
      .rejects.toMatchObject({ code: "encrypted_update_required" });
    expect(parseEncryptedNoteEnvelope(storedRow(ctx, plain.id).content_markdown)).not.toBeNull();
    ctx.sqlite.close();
  });

  test("merge refuses encrypted sources", async () => {
    const ctx = setup();
    const encrypted = await createEncrypted(ctx);
    const plain = await createMemoRecord(ctx.db, ctx.workspaceId, { notebookId: ctx.notebookId, contentMarkdown: "plain" }, actor, "owner");
    await expect(mergeMemosRecord(ctx.db, ctx.workspaceId, { memoIds: [plain.id, encrypted.id] }, actor, "owner"))
      .rejects.toMatchObject({ code: "encrypted_note_unsupported" });
    ctx.sqlite.close();
  });

  test("MCP list with content does not expose the envelope", async () => {
    const ctx = setup();
    const encrypted = await createEncrypted(ctx);
    const listed = await listMemosForMcp(ctx.db, { workspaceId: ctx.workspaceId, limit: 100, offset: 0, includeContent: true, includeDeleted: false });
    const memo = listed.memos.find((item) => item.id === encrypted.id);
    expect(memo.encrypted).toBe(true);
    expect(memo.contentMarkdown).not.toContain("edgeever-encrypted-v1");
    ctx.sqlite.close();
  });
});
