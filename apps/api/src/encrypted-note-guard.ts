import {
  ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  encryptedNotePlaceholderDoc,
  hasEncryptedNoteMarker,
  parseEncryptedNoteEnvelope,
  type TiptapDoc,
} from "@edgeever/shared";
import { AppError } from "./app-error";
import type { DatabaseAdapter } from "./storage-contract";

// Fork feature: client-side encrypted notes. Kept in its own module so the
// hooks in upstream files stay one-liners.

export const ENCRYPTED_NOTE_CAPABILITY = true;

export const isEncryptedNoteMarkdown = (markdown: string | null | undefined) =>
  hasEncryptedNoteMarker(markdown);

/**
 * For content that carries the encrypted marker, the server keeps the
 * markdown envelope verbatim and forces a placeholder document, so no
 * client mistake can push ciphertext (or plaintext) into content_text,
 * excerpts or the search index.
 */
export type EncryptedNoteContentResolution =
  | { contentJson: TiptapDoc; error?: never }
  | { error: "invalid_encrypted_note"; message: string; status: 400; contentJson?: never };

export const resolveEncryptedNoteContent = (contentMarkdown: string): EncryptedNoteContentResolution | null => {
  if (!hasEncryptedNoteMarker(contentMarkdown)) return null;
  if (!parseEncryptedNoteEnvelope(contentMarkdown)) {
    return { error: "invalid_encrypted_note", message: "Invalid encrypted note envelope.", status: 400 };
  }
  return { contentJson: encryptedNotePlaceholderDoc() };
};

/** Blocks any document write that would drop the envelope of an encrypted note. */
export const encryptedNoteUpdateError = (
  currentMarkdown: string | null | undefined,
  nextMarkdown: string,
  hasDocumentUpdate: boolean,
) => {
  if (!hasDocumentUpdate || !hasEncryptedNoteMarker(currentMarkdown)) return null;
  if (parseEncryptedNoteEnvelope(nextMarkdown)) return null;
  return {
    error: "encrypted_update_required",
    message: "Encrypted notes can only be edited on a client that supports encrypted notes.",
    status: 409,
  } as const;
};

/** Drops the ciphertext from memos returned to MCP / agents; they get a placeholder and a flag. */
export const redactEncryptedMemo = <T extends { contentMarkdown: string; contentJson: unknown; contentText: string }>(memo: T) =>
  hasEncryptedNoteMarker(memo.contentMarkdown)
    ? {
        ...memo,
        contentMarkdown: ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
        contentJson: encryptedNotePlaceholderDoc(),
        contentText: ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
        encrypted: true as const,
      }
    : memo;

export const assertNotEncryptedNote =(markdown: string | null | undefined, action: string) => {
  if (hasEncryptedNoteMarker(markdown)) {
    throw new AppError("encrypted_note_unsupported", `Encrypted notes cannot be ${action}.`, 409);
  }
};

/**
 * Uploads are stored as plaintext, so they must never attach to an encrypted
 * note (REST, multipart, MCP, table forms). A missing memo is left to the caller.
 */
export const assertResourceTargetNotEncrypted = async (db: DatabaseAdapter, workspaceId: string, memoId: string) => {
  const row = await db.prepare(
    `SELECT mc.content_markdown FROM memo_contents mc
     INNER JOIN memos m ON m.id = mc.memo_id
     WHERE mc.memo_id = ? AND m.workspace_id = ? LIMIT 1`,
  ).bind(memoId, workspaceId).first<{ content_markdown: string | null }>();
  assertNotEncryptedNote(row?.content_markdown, "given images or attachments");
};

/** Every memo or revision shape returned to MCP gets the placeholder instead of the envelope. */
export const redactEncryptedNotesDeep = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const next = value.map((item) => redactEncryptedNotesDeep(item));
    return (next.some((item, index) => item !== value[index]) ? next : value) as T;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.contentMarkdown === "string" && hasEncryptedNoteMarker(record.contentMarkdown)) {
    return {
      ...record,
      contentMarkdown: ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
      ...("contentJson" in record ? { contentJson: encryptedNotePlaceholderDoc() } : {}),
      ...("contentText" in record ? { contentText: ENCRYPTED_NOTE_PLACEHOLDER_TEXT } : {}),
      encrypted: true,
    } as T;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const redacted = redactEncryptedNotesDeep(child);
    if (redacted !== child) changed = true;
    next[key] = redacted;
  }
  return (changed ? next : value) as T;
};
