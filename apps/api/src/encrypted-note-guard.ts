import {
  ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  encryptedNotePlaceholderDoc,
  hasEncryptedNoteMarker,
  parseEncryptedNoteEnvelope,
  type TiptapDoc,
} from "@edgeever/shared";
import { AppError } from "./app-error";

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
