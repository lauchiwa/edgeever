'use dom';

import "katex/dist/katex.min.css";
import CodeBlock from "@tiptap/extension-code-block";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { EdgeEverLink } from "@edgeever/shared/editor-link";
import {
  DETAILS_EDITOR_CSS,
  createEdgeEverDocumentExtensions,
  createNativeUnsupportedContentExtensions,
  prepareNativeEditorContent,
  restoreNativeEditorContent,
  type TiptapDoc,
} from "@edgeever/shared";
import { createEdgeEverMathematics } from "@edgeever/shared/mathematics";
import {
  getMobileEditorInputAttributes,
  getMobileEditorPlaceholder,
  getMobileEditorToolbarActionLabel,
  getMobileEditorToolbarLabel,
} from "@edgeever/shared/mobile-editor";
import { useEffect, useMemo, useRef } from "react";
import type { DOMProps } from "expo/dom";

/**
 * Editor for a decrypted note body. Images, galleries and attachments are left
 * out of the schema on purpose: they would be uploaded as plaintext resources,
 * so the encrypted note stays text-only (same rule as the web EncryptedNotePane).
 * The decrypted document exists only in this WebView's memory and in the
 * native screen state; it is never persisted.
 */
type Props = {
  content: TiptapDoc;
  dom?: DOMProps;
  editable: boolean;
  locale: "zh-CN" | "en-US" | "ja" | "pl" | "ru";
  theme: "light" | "dark";
  onChange: (doc: TiptapDoc) => Promise<void>;
  onContentError: () => Promise<void>;
  onAttachmentBlocked: () => Promise<void>;
  onReady?: () => Promise<void>;
};

type ToolbarAction = "undo" | "redo" | "bold" | "bulletList" | "taskList" | "blockquote" | "horizontalRule";
const TOOLBAR: Array<{ id: ToolbarAction; glyph: string }> = [
  { id: "undo", glyph: "↶" },
  { id: "redo", glyph: "↷" },
  { id: "bold", glyph: "B" },
  { id: "bulletList", glyph: "•" },
  { id: "taskList", glyph: "☑" },
  { id: "blockquote", glyph: "❝" },
  { id: "horizontalRule", glyph: "―" },
];

const hasFiles = (data: DataTransfer | null) => Boolean(data && Array.from(data.items ?? []).some((item) => item.kind === "file"));

export default function MobileEncryptedNoteEditor(props: Props) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const contentErrorRef = useRef(false);
  const extensions = useMemo(() => [
    ...createEdgeEverDocumentExtensions({
      mathematics: createEdgeEverMathematics(),
      starterKit: { codeBlock: false, link: false },
      image: false,
      gallery: false,
      pdf: false,
      file: false,
      pluginEmbed: false,
      table: { table: { renderWrapper: true } },
    }),
    EdgeEverLink.configure({ openOnClick: false }),
    CodeBlock,
    ...createNativeUnsupportedContentExtensions(),
    Placeholder.configure({ placeholder: () => getMobileEditorPlaceholder(props.locale) }),
  ], [props.locale]);

  const editor = useEditor({
    editable: props.editable,
    autofocus: false,
    extensions,
    content: prepareNativeEditorContent(props.content, props.locale),
    // An unknown node must never load as an empty document that autosave would persist.
    enableContentCheck: true,
    onContentError: ({ disableCollaboration }) => {
      disableCollaboration();
      contentErrorRef.current = true;
      void callbacks.current.onContentError();
    },
    editorProps: {
      attributes: getMobileEditorInputAttributes("edgeever-editor-content"),
      handlePaste: (_view, event) => {
        if (!hasFiles(event.clipboardData)) return false;
        void callbacks.current.onAttachmentBlocked();
        return true;
      },
      handleDrop: (_view, event) => {
        if (!hasFiles((event as DragEvent).dataTransfer)) return false;
        void callbacks.current.onAttachmentBlocked();
        return true;
      },
    },
    // Sent on every change (no debounce here), so closing the note cannot drop the last keystrokes.
    onUpdate: ({ editor: current }) => {
      if (contentErrorRef.current || !current.isEditable) return;
      void callbacks.current.onChange(restoreNativeEditorContent(current.getJSON() as TiptapDoc));
    },
  }, [extensions]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(props.editable && !contentErrorRef.current);
  }, [editor, props.editable]);

  useEffect(() => {
    if (editor) void callbacks.current.onReady?.();
  }, [editor]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: Boolean(current?.isActive("bold")),
      bulletList: Boolean(current?.isActive("bulletList")),
      taskList: Boolean(current?.isActive("taskList")),
      blockquote: Boolean(current?.isActive("blockquote")),
      canUndo: Boolean(current?.can().undo()),
      canRedo: Boolean(current?.can().redo()),
    }),
  });

  const run: Record<ToolbarAction, () => void> = {
    undo: () => editor?.chain().focus().undo().run(),
    redo: () => editor?.chain().focus().redo().run(),
    bold: () => editor?.chain().focus().toggleBold().run(),
    bulletList: () => editor?.chain().focus().toggleBulletList().run(),
    taskList: () => editor?.chain().focus().toggleTaskList().run(),
    blockquote: () => editor?.chain().focus().toggleBlockquote().run(),
    horizontalRule: () => editor?.chain().focus().setHorizontalRule().run(),
  };
  const isActive = (id: ToolbarAction) => id === "bold" || id === "bulletList" || id === "taskList" || id === "blockquote"
    ? Boolean(active?.[id])
    : false;
  const isDisabled = (id: ToolbarAction) => (id === "undo" && !active?.canUndo) || (id === "redo" && !active?.canRedo);

  return (
    <div className="edgeever-encrypted-shell">
      <style>{getStyles(props.theme)}</style>
      {props.editable ? (
        <div aria-label={getMobileEditorToolbarLabel(props.locale)} className="edgeever-encrypted-toolbar" role="toolbar">
          {TOOLBAR.map((action) => (
            <button
              aria-label={getMobileEditorToolbarActionLabel(action.id, props.locale)}
              aria-pressed={isActive(action.id)}
              className={isActive(action.id) ? "is-active" : undefined}
              disabled={isDisabled(action.id)}
              key={action.id}
              // Keep the selection: a plain button tap would blur the editor first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={run[action.id]}
              type="button"
            >
              {action.glyph}
            </button>
          ))}
        </div>
      ) : null}
      <div className="edgeever-encrypted-scroll">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

const getStyles = (theme: "light" | "dark") => {
  const dark = theme === "dark";
  const text = dark ? "#f8fafc" : "#0f172a";
  const muted = dark ? "#94a3b8" : "#64748b";
  const border = dark ? "#334155" : "#e2e8f0";
  const surface = dark ? "#1e293b" : "#f8fafc";
  const background = dark ? "#0f172a" : "#fff";
  return `
  :root { color-scheme: ${theme}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; background: ${background}; }
  body { overflow: hidden; color: ${text}; font-size: 16px; }
  .edgeever-encrypted-shell { display: flex; flex-direction: column; width: 100%; height: 100%; background: ${background}; }
  .edgeever-encrypted-toolbar { display: flex; flex: 0 0 auto; gap: 4px; overflow-x: auto; padding: 6px 12px; border-block: 1px solid ${border}; scrollbar-width: none; }
  .edgeever-encrypted-toolbar::-webkit-scrollbar { display: none; }
  .edgeever-encrypted-toolbar button { flex: 0 0 auto; min-width: 36px; min-height: 32px; padding: 0 8px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: ${muted}; font-size: 16px; font-weight: 700; }
  .edgeever-encrypted-toolbar button.is-active { border-color: ${dark ? "#166534" : "#bbf7d0"}; background: ${dark ? "#14532d" : "#ecfdf5"}; color: ${dark ? "#86efac" : "#047857"}; }
  .edgeever-encrypted-toolbar button:disabled { opacity: 0.38; }
  .edgeever-encrypted-scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px 18px 96px; }
  .tiptap { min-height: 100%; outline: none; line-height: 1.5; overflow-wrap: anywhere; }
  .tiptap p { margin: 0 0 6px; }
  .tiptap h1, .tiptap h2, .tiptap h3 { margin: 14px 0 6px; line-height: 1.3; }
  .tiptap ul, .tiptap ol { margin: 0 0 6px; padding-left: 1.4em; }
  .tiptap ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
  .tiptap ul[data-type="taskList"] li { display: flex; gap: 8px; align-items: flex-start; }
  .tiptap ul[data-type="taskList"] li > label { flex: 0 0 auto; margin-top: 2px; }
  .tiptap ul[data-type="taskList"] li > div { flex: 1; min-width: 0; }
  .tiptap blockquote { margin: 0 0 6px; padding-left: 12px; border-left: 3px solid ${border}; color: ${muted}; }
  .tiptap code { padding: 1px 4px; border-radius: 4px; background: ${surface}; font-size: 0.9em; }
  .tiptap pre { overflow-x: auto; padding: 10px 12px; border-radius: 8px; background: ${surface}; }
  .tiptap pre code { padding: 0; background: none; }
  .tiptap hr { border: 0; border-top: 1px solid ${border}; margin: 12px 0; }
  .tiptap a { color: ${dark ? "#6ee7b7" : "#047857"}; }
  .tiptap .tableWrapper { overflow-x: auto; }
  .tiptap table { border-collapse: collapse; min-width: 100%; }
  .tiptap td, .tiptap th { border: 1px solid ${border}; padding: 6px 8px; vertical-align: top; }
  .tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; height: 0; color: ${muted}; pointer-events: none; }
  ${DETAILS_EDITOR_CSS}
  `;
};
