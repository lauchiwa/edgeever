import { describe, expect, test } from "bun:test";
import {
  ENCRYPTED_NOTE_PLACEHOLDER_TEXT,
  createEncryptedNoteSalt,
  decryptNoteDoc,
  deriveEncryptedNoteKey,
  encryptNoteDoc,
  encryptedNotePlaceholderDoc,
  hasEncryptedNoteMarker,
  parseEncryptedNoteEnvelope,
  serializeEncryptedNoteEnvelope,
} from "./encrypted-note.ts";
import { docToMarkdown, docToText, markdownToDoc } from "./content.ts";

const ITERATIONS = 100_000;
const secretDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "bank pin 4242" }] }],
};

const seal = async (passphrase = "correct horse battery") => {
  const salt = createEncryptedNoteSalt();
  const key = await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS);
  const envelope = await encryptNoteDoc(secretDoc, key, { salt, iterations: ITERATIONS });
  return { salt, key, envelope, markdown: serializeEncryptedNoteEnvelope(envelope) };
};

describe("encrypted notes", () => {
  test("round-trips the document through the markdown envelope", async () => {
    const { key, markdown } = await seal();
    expect(hasEncryptedNoteMarker(markdown)).toBe(true);
    const envelope = parseEncryptedNoteEnvelope(markdown);
    expect(envelope).not.toBeNull();
    expect(await decryptNoteDoc(envelope, key)).toEqual(secretDoc);
  });

  test("keeps plaintext out of the stored markdown and placeholder fields", async () => {
    const { markdown } = await seal();
    expect(markdown).not.toContain("bank pin");
    expect(markdown.startsWith(ENCRYPTED_NOTE_PLACEHOLDER_TEXT)).toBe(true);
    const placeholder = encryptedNotePlaceholderDoc();
    expect(docToText(placeholder)).toBe(ENCRYPTED_NOTE_PLACEHOLDER_TEXT);
    expect(docToMarkdown(placeholder)).not.toContain("edgeever-encrypted-v1");
  });

  test("rejects a wrong passphrase", async () => {
    const { salt, envelope } = await seal();
    const wrongKey = await deriveEncryptedNoteKey("not the passphrase", salt, ITERATIONS);
    await expect(decryptNoteDoc(envelope, wrongKey)).rejects.toThrow();
  });

  test("rejects tampered ciphertext", async () => {
    const { key, envelope } = await seal();
    const flipped = envelope.ct[0] === "A" ? "B" : "A";
    await expect(decryptNoteDoc({ ...envelope, ct: flipped + envelope.ct.slice(1) }, key)).rejects.toThrow();
  });

  test("refuses malformed or out-of-range envelopes", async () => {
    const { envelope } = await seal();
    const encode = (value) => `<!-- edgeever-encrypted-v1:${Buffer.from(JSON.stringify(value)).toString("base64url")} -->`;
    expect(parseEncryptedNoteEnvelope(encode({ ...envelope, kdf: { ...envelope.kdf, iterations: 10 } }))).toBeNull();
    expect(parseEncryptedNoteEnvelope("<!-- edgeever-encrypted-v1:!!! -->")).toBeNull();
    expect(parseEncryptedNoteEnvelope("plain note")).toBeNull();
    expect(hasEncryptedNoteMarker("plain note")).toBe(false);
  });

  test("an editor round-trip of the envelope markdown destroys the marker, so clients must never re-serialize it", async () => {
    const { markdown } = await seal();
    expect(parseEncryptedNoteEnvelope(docToMarkdown(markdownToDoc(markdown)))).toBeNull();
  });
});
