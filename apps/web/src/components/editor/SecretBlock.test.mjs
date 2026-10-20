import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { parseHTML } from "linkedom";
import { SECRET_BLOCK_NODE_TYPE, createEdgeEverDocumentExtensions, docToMarkdown, resolveMemoContentDoc } from "@edgeever/shared";
import { createEdgeEverMathematics } from "@edgeever/shared/mathematics";
import { ensureTestWindowDom } from "../../lib/restore-test-global.mjs";
import { SecretBlock } from "./SecretBlock.tsx";

const envelope = {
  v: 1,
  kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
  cipher: { name: "AES-GCM", iv: "aXZpdml2aXZpdml2" },
  ct: "Y2lwaGVydGV4dA",
};
const block = (id) => ({ type: SECRET_BLOCK_NODE_TYPE, attrs: { id, label: "Prod DB", envelope } });

const createEditor = (content) => {
  ensureTestWindowDom();
  return new Editor({
    extensions: createEdgeEverDocumentExtensions({ mathematics: createEdgeEverMathematics(), secretBlock: SecretBlock }),
    content,
  });
};

const secretBlocksIn = (editor) => editor.getJSON().content.filter((node) => node.type === SECRET_BLOCK_NODE_TYPE);

describe("editor secret block", () => {
  test("loads the stored code block form and saves it back losslessly", () => {
    const stored = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "edgeever-secret" }, content: [{ type: "text", text: JSON.stringify({ id: "block-id-0001", label: "Prod DB", envelope }) }] }] };
    const editor = createEditor(resolveMemoContentDoc(stored, ""));
    expect(secretBlocksIn(editor)).toEqual([block("block-id-0001")]);
    expect(docToMarkdown(editor.getJSON())).toContain("```edgeever-secret");
    editor.destroy();
  });

  test("copy and paste inside EdgeEver keeps the envelope and gives the copy a fresh id", () => {
    const editor = createEditor({ type: "doc", content: [block("block-id-0001"), { type: "paragraph" }] });
    const { schema } = editor;
    const { document } = parseHTML("<html><body></body></html>");
    const container = document.createElement("div");
    container.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(editor.state.doc.content, { document }));
    expect(container.innerHTML).toContain("data-secret-envelope");

    const pasted = DOMParser.fromSchema(schema).parseSlice(container);
    // A headless editor has no view, so build the state with the editor's plugins.
    const initial = EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins });
    const end = initial.doc.content.size;
    const { state } = initial.applyTransaction(initial.tr.replace(end, end, pasted).setMeta("paste", true));
    const blocks = state.doc.toJSON().content.filter((node) => node.type === SECRET_BLOCK_NODE_TYPE);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].attrs.envelope).toEqual(envelope);
    expect(blocks[1].attrs.id).not.toBe(blocks[0].attrs.id);
    editor.destroy();
  });

  test("HTML without an envelope (a shared page) parses as plain text, never an empty secret", () => {
    const editor = createEditor({ type: "doc", content: [{ type: "paragraph" }] });
    const { document } = parseHTML('<html><body><div id="c"><div data-type="edgeever-secret-block" data-secret-id="block-id-0001" data-secret-label="Prod DB">🔒 Prod DB</div></div></body></html>');
    const slice = DOMParser.fromSchema(editor.schema).parseSlice(document.getElementById("c"));
    expect(JSON.stringify(slice.content.toJSON())).not.toContain(SECRET_BLOCK_NODE_TYPE);
    expect(slice.content.textBetween(0, slice.content.size)).toContain("Prod DB");
    editor.destroy();
  });
});
