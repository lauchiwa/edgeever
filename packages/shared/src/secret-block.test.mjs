import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import {
  SECRET_BLOCK_MAX_TEXT_BYTES,
  SECRET_BLOCK_NODE_TYPE,
  SecretBlockTooLargeError,
  collectSecretBlockIds,
  collectSecretBlockIdsFromMarkdown,
  collectSecretBlocks,
  downgradeSecretBlocksForStorage,
  createSecretBlockId,
  decryptSecretBlockText,
  encryptSecretBlockText,
  findSecretBlockKdf,
  markdownHasSecretBlocks,
  normalizeSecretBlockLabel,
  redactSecretBlocksInDoc,
  redactSecretBlocksInMarkdown,
  secretBlockToMarkdown,
} from "./secret-block.ts";
import {
  createEncryptedNoteSalt,
  decryptNoteDoc,
  deriveEncryptedNoteKey,
} from "./encrypted-note.ts";
import { countMemoCharacters, docToMarkdown, docToText, markdownToDoc, resolveMemoContentDoc } from "./content.ts";
import { prepareNativeEditorContent, restoreNativeEditorContent } from "./mobile-content-compatibility.ts";

const ITERATIONS = 100_000;
const salt = createEncryptedNoteSalt();
const key = await deriveEncryptedNoteKey("correct horse battery", salt, ITERATIONS);
const kdf = { salt, iterations: ITERATIONS };
const envelope = await encryptSecretBlockText("db: root / s3cr3t", key, kdf);
const block = { id: createSecretBlockId(), label: "Prod DB", envelope };
const secretNode = { type: SECRET_BLOCK_NODE_TYPE, attrs: block };
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const docWith = (...content) => ({ type: "doc", content });
const fence = secretBlockToMarkdown(block);

describe("secret block crypto", () => {
  test("round-trips text and rejects a wrong key", async () => {
    expect(await decryptSecretBlockText(envelope, key)).toBe("db: root / s3cr3t");
    const wrong = await deriveEncryptedNoteKey("another passphrase", salt, ITERATIONS);
    await expect(decryptSecretBlockText(envelope, wrong)).rejects.toThrow();
  });

  test("cannot be opened as an encrypted note envelope", async () => {
    await expect(decryptNoteDoc(envelope, key)).rejects.toThrow();
  });

  test("uses a fresh IV for every seal and caps the text size", async () => {
    const again = await encryptSecretBlockText("db: root / s3cr3t", key, kdf);
    expect(again.cipher.iv).not.toBe(envelope.cipher.iv);
    expect(again.ct).not.toBe(envelope.ct);
    await expect(encryptSecretBlockText("x".repeat(SECRET_BLOCK_MAX_TEXT_BYTES + 1), key, kdf))
      .rejects.toBeInstanceOf(SecretBlockTooLargeError);
    const largest = await encryptSecretBlockText("界".repeat(Math.floor(SECRET_BLOCK_MAX_TEXT_BYTES / 3)), key, kdf);
    expect(markdownHasSecretBlocks(secretBlockToMarkdown({ ...block, envelope: largest }))).toBe(true);
  });

  test("reuses the note's existing salt", () => {
    expect(findSecretBlockKdf(docWith(paragraph("a"), secretNode))).toEqual(kdf);
    expect(findSecretBlockKdf(docWith(paragraph("a")))).toBeNull();
  });

  test("normalizes labels to one bounded line", () => {
    expect(normalizeSecretBlockLabel("  a\n  b\t c ")).toBe("a b c");
    expect(Array.from(normalizeSecretBlockLabel("🔑".repeat(200)))).toHaveLength(80);
    expect(normalizeSecretBlockLabel(42)).toBe("");
  });
});

describe("secret block Markdown", () => {
  test("round-trips through a fenced code block without plaintext", () => {
    const markdown = docToMarkdown(docWith(paragraph("before"), secretNode, paragraph("after")));
    expect(markdown).toContain("```edgeever-secret\n");
    expect(markdown).not.toContain("s3cr3t");
    expect(markdownToDoc(markdown).content[1]).toEqual(secretNode);
  });

  test("round-trips inside lists and blockquotes", () => {
    const doc = docWith(
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("item"), secretNode] }] },
      { type: "blockquote", content: [secretNode] },
    );
    const markdown = docToMarkdown(doc);
    expect(markdownToDoc(markdown)).toEqual(doc);
    expect(collectSecretBlockIdsFromMarkdown(markdown)).toEqual([block.id, block.id]);
  });

  test("keeps an invalid fence as an ordinary code block", () => {
    const parsed = markdownToDoc("```edgeever-secret\n{\"id\":\"short\"}\n```");
    expect(parsed.content[0].type).toBe("codeBlock");
    expect(parsed.content[0].attrs.language).toBe("edgeever-secret");
  });

  test("ignores a secret fence shown inside a longer fence", () => {
    const markdown = `\`\`\`\`markdown\n${fence}\n\`\`\`\`\n\n${fence}`;
    expect(collectSecretBlockIdsFromMarkdown(markdown)).toEqual([block.id]);
    expect(markdownToDoc(markdown).content.map((node) => node.type)).toEqual(["codeBlock", SECRET_BLOCK_NODE_TYPE]);
    const redacted = redactSecretBlocksInMarkdown(markdown);
    expect(redacted.endsWith("🔒 Prod DB")).toBe(true);
    expect(redacted.split(envelope.ct)).toHaveLength(2);
  });

  test("redacts nested fences and keeps their container prefix", () => {
    const markdown = docToMarkdown(docWith(
      paragraph("intro"),
      { type: "blockquote", content: [secretNode] },
      { type: "bulletList", content: [{ type: "listItem", content: [secretNode] }] },
    ));
    const redacted = redactSecretBlocksInMarkdown(markdown);
    expect(redacted).not.toContain(envelope.ct);
    expect(redacted).not.toContain("edgeever-secret");
    expect(markdownToDoc(redacted)).toEqual(docWith(
      paragraph("intro"),
      { type: "blockquote", content: [paragraph("🔒 Prod DB")] },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("🔒 Prod DB")] }] },
    ));
  });

  test("leaves notes without secret fences untouched", () => {
    const markdown = "```js\nconst a = 1;\n```\n\nedgeever-secret is mentioned here";
    expect(redactSecretBlocksInMarkdown(markdown)).toBe(markdown);
    expect(markdownHasSecretBlocks(markdown)).toBe(false);
  });
});

describe("secret block documents", () => {
  test("text projections only expose the label", () => {
    const doc = docWith(paragraph("deploy log"), secretNode);
    expect(docToText(doc)).toBe("deploy log 🔒 Prod DB");
    expect(countMemoCharacters(doc)).toBe(countMemoCharacters(docWith(paragraph("deploy logProd DB"))));
    const fenceBlock = { type: "codeBlock", attrs: { language: "edgeever-secret" }, content: [{ type: "text", text: JSON.stringify(block) }] };
    expect(docToText(docWith(fenceBlock))).toBe("🔒 Prod DB");
  });

  test("upgrades a fence that an older schema stored as a code block", () => {
    const fenceBlock = { type: "codeBlock", attrs: { language: "edgeever-secret" }, content: [{ type: "text", text: JSON.stringify(block) }] };
    const resolved = resolveMemoContentDoc(docWith(paragraph("a"), { type: "blockquote", content: [fenceBlock] }), "");
    expect(resolved.content[1].content[0]).toEqual(secretNode);
  });

  test("keeps secret JSON over stale Markdown", () => {
    const doc = docWith(paragraph("a"), secretNode);
    expect(resolveMemoContentDoc(doc, "a")).toEqual(doc);
    expect(resolveMemoContentDoc(docWith(paragraph("a")), `a\n\n${fence}`).content[1]).toEqual(secretNode);
  });

  test("collects ids and redacts nested blocks", () => {
    const other = { ...secretNode, attrs: { ...block, id: createSecretBlockId(), label: "" } };
    const doc = docWith(secretNode, { type: "blockquote", content: [other] });
    expect(collectSecretBlockIds(doc)).toEqual([block.id, other.attrs.id]);
    const redacted = redactSecretBlocksInDoc(doc);
    expect(JSON.stringify(redacted)).not.toContain(envelope.ct);
    expect(docToText(redacted)).toBe("🔒 Prod DB 🔒 Secret");
    const plain = docWith(paragraph("a"));
    expect(redactSecretBlocksInDoc(plain)).toBe(plain);
  });

  test("stores blocks as code fences that older schemas can load", () => {
    const doc = docWith(paragraph("a"), { type: "blockquote", content: [secretNode] });
    const stored = downgradeSecretBlocksForStorage(doc);
    expect(JSON.stringify(stored)).not.toContain(SECRET_BLOCK_NODE_TYPE);
    expect(stored.content[1].content[0]).toMatchObject({ type: "codeBlock", attrs: { language: "edgeever-secret" } });
    expect(docToMarkdown(stored)).toBe(docToMarkdown(doc));
    expect(collectSecretBlocks(stored)).toEqual([block]);
    expect(resolveMemoContentDoc(stored, "")).toEqual(doc);
    const plain = docWith(paragraph("a"));
    expect(downgradeSecretBlocksForStorage(plain)).toBe(plain);
  });

  test("survives native editor placeholders without losing the envelope", () => {
    const doc = docWith(paragraph("a"), secretNode);
    const prepared = prepareNativeEditorContent(doc);
    expect(prepared.content[1].type).not.toBe(SECRET_BLOCK_NODE_TYPE);
    expect(restoreNativeEditorContent(prepared)).toEqual(doc);
  });

  test("HTML keeps the label but never the ciphertext", async () => {
    const { createEdgeEverDocumentExtensions } = await import("./document-extensions.ts");
    const { createEdgeEverMarkdownMathematics } = await import("./mathematics-markdown.ts");
    const schema = getSchema(createEdgeEverDocumentExtensions({ mathematics: createEdgeEverMarkdownMathematics() }));
    const node = schema.nodeFromJSON(secretNode);
    const html = JSON.stringify(schema.nodes[SECRET_BLOCK_NODE_TYPE].spec.toDOM(node));
    expect(html).toContain("Prod DB");
    expect(html).not.toContain(envelope.ct);
  });
});
