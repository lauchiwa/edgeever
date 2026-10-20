import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import {
  createEdgeEverDocumentExtensions,
  createNativeUnsupportedContentExtensions,
  downgradeSecretBlocksForStorage,
  prepareNativeEditorContent,
  resolveMemoContentDoc,
  restoreNativeEditorContent,
  type TiptapDoc,
} from "@edgeever/shared";
import { parseSecretBlockPressPayload, readSecretBlockPlaceholder } from "./mobile-secret-blocks";

const envelope = {
  v: 1,
  kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
  cipher: { name: "AES-GCM", iv: "aXZpdml2aXZpdml2" },
  ct: "Y2lwaGVydGV4dGNpcGhlcnRleHQ",
};
const stored: TiptapDoc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "before" }] },
    {
      type: "codeBlock",
      attrs: { language: "edgeever-secret" },
      content: [{ type: "text", text: JSON.stringify({ id: "block-id-0001", label: "Router admin", envelope }) }],
    },
  ],
};

describe("mobile secret blocks", () => {
  test("the WebView holds a labelled ciphertext placeholder that restores the stored block exactly", () => {
    const prepared = prepareNativeEditorContent(resolveMemoContentDoc(stored, ""), "zh-CN");
    const schema = getSchema([...createEdgeEverDocumentExtensions({ mathematics: [], pdf: false, file: false, pluginEmbed: false }), ...createNativeUnsupportedContentExtensions()]);
    const placeholder = schema.nodeFromJSON(prepared).child(1);

    expect(placeholder.attrs.displayLabel).toBe("🔒 Router admin");
    const attributes = readSecretBlockPlaceholder(placeholder);
    expect(attributes).toEqual({ id: "block-id-0001", label: "Router admin", envelope });
    expect(parseSecretBlockPressPayload(JSON.stringify(attributes))).toEqual(attributes);
    expect(readSecretBlockPlaceholder(schema.nodeFromJSON(prepared).child(0))).toBeNull();

    const saved = downgradeSecretBlocksForStorage(restoreNativeEditorContent(schema.nodeFromJSON(prepared).toJSON() as TiptapDoc));
    expect(saved).toEqual(stored);
  });

  test("malformed bridge payloads are ignored", () => {
    expect(parseSecretBlockPressPayload("not json")).toBeNull();
    expect(parseSecretBlockPressPayload(JSON.stringify({ id: "x", label: "a" }))).toBeNull();
  });
});
