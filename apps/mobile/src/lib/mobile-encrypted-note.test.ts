import { describe, expect, test } from "bun:test";
import {
  ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  serializeEncryptedNoteEnvelope,
  type MemoDetail,
} from "@edgeever/shared";
import { createOptimisticMemo } from "../screens/workspace-memo-cache";
import {
  assertNotEncryptedNote,
  encryptedNoteLocalText,
  isMobileEncryptedNote,
  shouldReloadEncryptedNote,
} from "./mobile-encrypted-note";

const envelopeMarkdown = (ct: string) => serializeEncryptedNoteEnvelope({
  v: 1,
  kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
  cipher: { name: "AES-GCM", iv: "aXZpdml2aXZpdml2" },
  ct,
});

const memo: MemoDetail = {
  id: "memo_1",
  notebookId: "notebook_1",
  title: "Bank",
  excerpt: ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  contentJson: { type: "doc", content: [] },
  contentMarkdown: envelopeMarkdown("Y2lwaGVydGV4dA"),
  contentText: ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  tags: [],
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  revision: 3,
  sourceMemoIds: [],
  mergeSourceCount: 0,
  mergedIntoMemoId: null,
  contentHash: "hash_3",
};

describe("mobile encrypted notes", () => {
  test("recognises the envelope marker", () => {
    expect(isMobileEncryptedNote(memo.contentMarkdown)).toBe(true);
    expect(isMobileEncryptedNote("plain body")).toBe(false);
    expect(isMobileEncryptedNote(null)).toBe(false);
  });

  test("the optimistic local copy of a save shows the placeholder, never the envelope", () => {
    const next = envelopeMarkdown("bmV3Y2lwaGVydGV4dA");
    const optimistic = createOptimisticMemo(memo, { contentMarkdown: next });
    expect(optimistic.contentMarkdown).toBe(next);
    expect(optimistic.contentText).toBe(ENCRYPTED_NOTE_PLACEHOLDER_TEXT);
    expect(optimistic.excerpt).toBe(ENCRYPTED_NOTE_PLACEHOLDER_TEXT);
    // The plaintext rich document is never sent, so the cached JSON stays the server placeholder.
    expect(optimistic.contentJson).toBe(memo.contentJson);
    expect(encryptedNoteLocalText("plain")).toBeNull();
  });

  test("refuses plaintext writes such as AI drafts on an encrypted note", () => {
    expect(() => assertNotEncryptedNote(memo.contentMarkdown)).toThrow();
    expect(() => assertNotEncryptedNote("plain")).not.toThrow();
  });

  test("reloads an open note only for a newer revision written elsewhere, never over unsaved edits", () => {
    const base = { contentMarkdown: envelopeMarkdown("cmVtb3Rl"), revision: 4, seenRevision: 3, known: new Set<string>(), hasUnsavedChanges: false };
    expect(shouldReloadEncryptedNote(base)).toBe(true);
    expect(shouldReloadEncryptedNote({ ...base, hasUnsavedChanges: true })).toBe(false);
    // Our own save coming back from the server.
    expect(shouldReloadEncryptedNote({ ...base, known: new Set([base.contentMarkdown]) })).toBe(false);
    // A stale mirror refresh after an optimistic save.
    expect(shouldReloadEncryptedNote({ ...base, revision: 3 })).toBe(false);
  });
});
