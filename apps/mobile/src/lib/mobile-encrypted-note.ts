import { ENCRYPTED_NOTE_PLACEHOLDER_TEXT, hasEncryptedNoteMarker } from "@edgeever/shared";

export const isMobileEncryptedNote = (contentMarkdown: string | null | undefined) => hasEncryptedNoteMarker(contentMarkdown);

/**
 * Local search/preview text for a note. An encrypted note shows the same
 * placeholder the server stores in content_text, never the envelope.
 */
export const encryptedNoteLocalText = (contentMarkdown: string) =>
  isMobileEncryptedNote(contentMarkdown) ? ENCRYPTED_NOTE_PLACEHOLDER_TEXT : null;

/**
 * Whether an open, decrypted note should be replaced by a newer server copy.
 * Our own saves come back through sync (same envelope, or a revision we wrote),
 * and a local edit that is not saved yet must never be discarded.
 */
export const shouldReloadEncryptedNote = ({
  contentMarkdown,
  revision,
  seenRevision,
  known,
  hasUnsavedChanges,
}: {
  contentMarkdown: string;
  revision: number;
  seenRevision: number;
  known: ReadonlySet<string>;
  hasUnsavedChanges: boolean;
}) => !hasUnsavedChanges && revision > seenRevision && !known.has(contentMarkdown);

/** Guard for write paths that build plaintext markdown (AI drafts, appends). */
export const assertNotEncryptedNote = (contentMarkdown: string) => {
  if (isMobileEncryptedNote(contentMarkdown)) {
    throw new Error("加密笔记只能在解锁后于笔记内编辑。");
  }
};
