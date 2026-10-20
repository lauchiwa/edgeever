import { Extension, mergeAttributes, Node } from "@tiptap/core";
import { Base64 } from "js-base64";
import { z } from "zod";
import type { TiptapDoc, TiptapNode, TiptapTextNode } from "./content";
import {
  ENCRYPTED_NOTE_PBKDF2_ITERATIONS,
  EncryptedNoteEnvelopeSchema,
  createEncryptedNoteSalt,
  openEnvelopePayload,
  sealEnvelopePayload,
  type EncryptedNoteEnvelope,
} from "./encrypted-note";

/**
 * Inline secret blocks: an encrypted island inside an otherwise plaintext note
 * (for example the passwords in a server deployment log).
 *
 * The block is an atom node whose attrs hold an id, a plaintext label and the
 * same AES-GCM envelope as encrypted notes, sealed with its own AAD. In
 * Markdown it is a fenced code block (`edgeever-secret`) carrying one JSON
 * line, so a client or tool that does not know the format still keeps it as
 * an opaque code block instead of dropping it. Stored JSON uses that same code
 * block form (see `downgradeSecretBlocksForStorage`); only editors that render
 * the block upgrade it to the node. The plaintext never enters the document:
 * editors decrypt into component state only.
 *
 * Only the secret text is confidential and authenticated. The label and the
 * surrounding note are plaintext, and the block id is not bound to the
 * ciphertext, so a pasted duplicate can take a fresh id without re-encrypting.
 */
export const SECRET_BLOCK_NODE_TYPE = "edgeeverSecretBlock" as const;
export const SECRET_BLOCK_MARKDOWN_LANGUAGE = "edgeever-secret" as const;
/** AES-GCM additional data; native crypto (Android) must authenticate the same bytes. */
export const SECRET_BLOCK_AAD = "edgeever-secret-v1";
export const SECRET_BLOCK_MAX_TEXT_BYTES = 32 * 1024;
export const SECRET_BLOCK_MAX_PER_NOTE = 100;
export const SECRET_BLOCK_LABEL_MAX_LENGTH = 80;
export const SECRET_BLOCK_PLACEHOLDER_TEXT = "🔒 Secret";
/** Clients that understand secret blocks send this feature in the header below. */
export const SECRET_BLOCKS_CLIENT_FEATURE = "secret-blocks-v1";
export const CLIENT_FEATURES_HEADER = "X-EdgeEver-Client-Features";

// 32 KiB of plaintext plus JSON wrapping and the GCM tag, in base64url.
const MAX_CIPHERTEXT_LENGTH = 48_000;
const HTML_TYPE = "edgeever-secret-block";

const SecretBlockEnvelopeSchema = EncryptedNoteEnvelopeSchema.extend({
  ct: z.string().min(1).max(MAX_CIPHERTEXT_LENGTH).regex(/^[A-Za-z0-9_-]+$/),
});
const SecretBlockIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const SecretBlockPayloadSchema = z.object({ v: z.literal(1), text: z.string() });

export type SecretBlockAttributes = {
  id: string;
  label: string;
  envelope: EncryptedNoteEnvelope;
};

export class SecretBlockTooLargeError extends Error {
  constructor() {
    super(`Secret block text exceeds ${SECRET_BLOCK_MAX_TEXT_BYTES} bytes.`);
    this.name = "SecretBlockTooLargeError";
  }
}

export const normalizeSecretBlockLabel = (value: unknown) =>
  typeof value === "string"
    ? Array.from(value.replace(/\s+/g, " ").trim()).slice(0, SECRET_BLOCK_LABEL_MAX_LENGTH).join("")
    : "";

export const normalizeSecretBlockAttributes = (value: unknown): SecretBlockAttributes | null => {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = SecretBlockIdSchema.safeParse(input.id);
  const envelope = SecretBlockEnvelopeSchema.safeParse(input.envelope);
  if (!id.success || !envelope.success) return null;
  return { id: id.data, label: normalizeSecretBlockLabel(input.label), envelope: envelope.data };
};

/** What readers without the plaintext see: search, excerpts, shares, AI and MCP. */
export const secretBlockPlaceholderText = (label: unknown) => {
  const safe = normalizeSecretBlockLabel(label);
  return safe ? `🔒 ${safe}` : SECRET_BLOCK_PLACEHOLDER_TEXT;
};

export const secretBlockToMarkdown = (attributes: SecretBlockAttributes) => {
  const { id, label, envelope } = attributes;
  return `\`\`\`${SECRET_BLOCK_MARKDOWN_LANGUAGE}\n${JSON.stringify({ id, label, envelope })}\n\`\`\``;
};

/** Parses the body of an `edgeever-secret` fence; null when it is not a valid block. */
export const parseSecretBlockFence = (source: string): SecretBlockAttributes | null => {
  try {
    return normalizeSecretBlockAttributes(JSON.parse(source.trim()));
  } catch {
    return null;
  }
};

const parseEnvelopeAttribute = (value: string | null) => {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const readHtmlAttributes = (element: HTMLElement) => ({
  id: element.getAttribute("data-secret-id"),
  label: element.getAttribute("data-secret-label"),
  envelope: parseEnvelopeAttribute(element.getAttribute("data-secret-envelope")),
});

/**
 * Schema node shared by Markdown codecs and editors. Its HTML carries no
 * ciphertext, so shared pages and exported HTML show only the label; the
 * editor extends it to keep the envelope when copying within EdgeEver.
 */
export const SecretBlock = Node.create({
  name: SECRET_BLOCK_NODE_TYPE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-secret-id") ?? "",
        renderHTML: (attributes) => ({ "data-secret-id": attributes.id }),
      },
      label: {
        default: "",
        parseHTML: (element) => normalizeSecretBlockLabel(element.getAttribute("data-secret-label")),
        renderHTML: (attributes) => ({ "data-secret-label": attributes.label }),
      },
      envelope: {
        default: null,
        rendered: false,
        parseHTML: (element) => readHtmlAttributes(element).envelope,
      },
    };
  },

  parseHTML() {
    return [{
      tag: `div[data-type="${HTML_TYPE}"]`,
      // Without a valid envelope (e.g. HTML copied from a shared page) the
      // block falls back to its label text instead of an empty secret.
      getAttrs: (element) => (normalizeSecretBlockAttributes(readHtmlAttributes(element)) ? null : false),
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": HTML_TYPE, class: HTML_TYPE, contenteditable: "false" }),
      secretBlockPlaceholderText(node.attrs.label),
    ];
  },

  renderText: ({ node }) => secretBlockPlaceholderText(node.attrs.label),

  renderMarkdown: (node) => {
    const attributes = normalizeSecretBlockAttributes(node.attrs);
    return attributes ? secretBlockToMarkdown(attributes) : "";
  },
});

/** Reuses the Markdown lexer's fence handling; any other fence stays a code block. */
export const SecretBlockCodeFence = Extension.create({
  name: "secretBlockCodeFence",
  priority: 101,
  markdownTokenName: "code",
  parseMarkdown: (token) => {
    if (token.lang !== SECRET_BLOCK_MARKDOWN_LANGUAGE) return [];
    const attrs = parseSecretBlockFence(token.text ?? "");
    return attrs ? { type: SECRET_BLOCK_NODE_TYPE, attrs } : [];
  },
});

// ---------------------------------------------------------------------------
// Crypto

const textBytes = (text: string) => new TextEncoder().encode(text).length;

/** Plaintext that AES-GCM seals (as UTF-8): the secret text in a versioned payload. */
export const secretBlockPayloadJson = (text: string) => {
  if (textBytes(text) > SECRET_BLOCK_MAX_TEXT_BYTES) throw new SecretBlockTooLargeError();
  return JSON.stringify({ v: 1, text });
};

export const parseSecretBlockPayloadJson = (json: string) => SecretBlockPayloadSchema.parse(JSON.parse(json)).text;

export const isSecretBlockTextTooLarge = (text: string) => textBytes(text) > SECRET_BLOCK_MAX_TEXT_BYTES;

export const createSecretBlockId = () => Base64.fromUint8Array(crypto.getRandomValues(new Uint8Array(16)), true);

export const createSecretBlockKdf = () => ({
  salt: createEncryptedNoteSalt(),
  iterations: ENCRYPTED_NOTE_PBKDF2_ITERATIONS,
});

export const encryptSecretBlockText = async (
  text: string,
  key: CryptoKey,
  kdf: { salt: string; iterations: number },
) => sealEnvelopePayload(secretBlockPayloadJson(text), key, kdf, SECRET_BLOCK_AAD);

/** Throws when the key is wrong or the envelope was tampered with (AES-GCM auth tag). */
export const decryptSecretBlockText = async (envelope: EncryptedNoteEnvelope, key: CryptoKey) =>
  parseSecretBlockPayloadJson(await openEnvelopePayload(envelope, key, SECRET_BLOCK_AAD));

// ---------------------------------------------------------------------------
// Document helpers

type AnyNode = TiptapNode | TiptapTextNode;

const isSecretCodeBlock = (node: AnyNode) =>
  node.type === "codeBlock" && (node as TiptapNode).attrs?.language === SECRET_BLOCK_MARKDOWN_LANGUAGE;

const codeBlockText = (node: AnyNode) =>
  ((node as TiptapNode).content ?? []).map((child) => ("text" in child ? child.text : "")).join("");

/** Valid secret attributes of a node, including a fence an older schema kept as a code block. */
const secretAttributesOf = (node: AnyNode): SecretBlockAttributes | null => {
  if (node.type === SECRET_BLOCK_NODE_TYPE) return normalizeSecretBlockAttributes((node as TiptapNode).attrs);
  if (isSecretCodeBlock(node)) return parseSecretBlockFence(codeBlockText(node));
  return null;
};

const mapSecretNodes = (doc: TiptapDoc, replace: (node: AnyNode, attributes: SecretBlockAttributes) => AnyNode): TiptapDoc => {
  const visit = (node: AnyNode): AnyNode => {
    const attributes = secretAttributesOf(node);
    if (attributes) return replace(node, attributes);
    const content = (node as TiptapNode).content;
    if (!content) return node;
    const next = content.map(visit);
    return next.some((child, index) => child !== content[index]) ? { ...node, content: next } as TiptapNode : node;
  };
  if (!Array.isArray(doc?.content)) return doc;
  const content = doc.content.map((node) => visit(node) as TiptapNode);
  return content.some((node, index) => node !== doc.content[index]) ? { ...doc, content } : doc;
};

export const collectSecretBlocks = (doc: TiptapDoc | null | undefined): SecretBlockAttributes[] => {
  const blocks: SecretBlockAttributes[] = [];
  if (doc) mapSecretNodes(doc, (node, attributes) => {
    blocks.push(attributes);
    return node;
  });
  return blocks;
};

export const collectSecretBlockIds = (doc: TiptapDoc | null | undefined) =>
  collectSecretBlocks(doc).map((block) => block.id);

/** Reuses a block's salt so every block in a note derives the same key once. */
export const findSecretBlockKdf = (doc: TiptapDoc | null | undefined) => {
  const kdf = collectSecretBlocks(doc)[0]?.envelope.kdf;
  return kdf ? { salt: kdf.salt, iterations: kdf.iterations } : null;
};

/** Turns stored `edgeever-secret` code blocks into secret blocks for editors that render them. */
export const upgradeSecretBlockCodeFences = (doc: TiptapDoc): TiptapDoc =>
  mapSecretNodes(doc, (node, attrs) => (
    node.type === SECRET_BLOCK_NODE_TYPE ? node : { type: SECRET_BLOCK_NODE_TYPE, attrs }
  ));

/**
 * Stored and synced JSON keeps secret blocks as plain `edgeever-secret` code
 * blocks. A client without the node in its schema would otherwise fail to load
 * the whole document, and autosave could then persist an empty note.
 */
export const downgradeSecretBlocksForStorage = (doc: TiptapDoc): TiptapDoc =>
  mapSecretNodes(doc, (node, { id, label, envelope }) => (
    node.type === SECRET_BLOCK_NODE_TYPE
      ? {
          type: "codeBlock",
          attrs: { language: SECRET_BLOCK_MARKDOWN_LANGUAGE },
          content: [{ type: "text", text: JSON.stringify({ id, label, envelope }) }],
        }
      : node
  ));

/** Replaces each secret block with its label, for readers that must never get the ciphertext. */
export const redactSecretBlocksInDoc = (doc: TiptapDoc): TiptapDoc =>
  mapSecretNodes(doc, (_node, { label }) => ({
    type: "paragraph",
    content: [{ type: "text", text: secretBlockPlaceholderText(label) }],
  }));

/** Label of a secret block (or of its fence kept as a code block); null for other nodes. */
export const getSecretBlockNodeLabel = (node: unknown): string | null => {
  if (!node || typeof node !== "object" || typeof (node as AnyNode).type !== "string") return null;
  const current = node as AnyNode;
  if (current.type === SECRET_BLOCK_NODE_TYPE) return normalizeSecretBlockLabel((current as TiptapNode).attrs?.label);
  return isSecretCodeBlock(current) ? parseSecretBlockFence(codeBlockText(current))?.label ?? null : null;
};

export const docHasSecretBlocks =(doc: TiptapDoc | null | undefined) => collectSecretBlocks(doc).length > 0;

// ---------------------------------------------------------------------------
// Markdown helpers (server side: no editor schema needed)

// Container prefix of a fence line: indentation, blockquote markers and list markers.
const FENCE_OPEN = /^((?:[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t]))*[ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})[ \t]*$/;

type SecretFence = { start: number; end: number; prefix: string; attributes: SecretBlockAttributes };

/** Walks fenced code in document order, so a fence shown inside another fence is not a block. */
const scanSecretFences = (markdown: string) => {
  const lines = markdown.split(/\r?\n/);
  const fences: SecretFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open) continue;
    const [, prefix, marker, info] = open;
    if (marker.startsWith("`") && info.includes("`")) continue;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const close = FENCE_CLOSE.exec(lines[end]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
    }
    if (info.trim().split(/\s+/)[0] === SECRET_BLOCK_MARKDOWN_LANGUAGE && end < lines.length) {
      const body = lines.slice(index + 1, end).map((line) => line.replace(/^[ \t>]*/, "")).join("\n");
      const attributes = parseSecretBlockFence(body);
      if (attributes) fences.push({ start: index, end, prefix, attributes });
    }
    index = end;
  }
  return { lines, fences };
};

export const markdownHasSecretBlocks = (markdown: string | null | undefined) =>
  Boolean(markdown?.includes(SECRET_BLOCK_MARKDOWN_LANGUAGE)) && scanSecretFences(markdown ?? "").fences.length > 0;

export const collectSecretBlocksFromMarkdown = (markdown: string | null | undefined) =>
  markdown?.includes(SECRET_BLOCK_MARKDOWN_LANGUAGE)
    ? scanSecretFences(markdown).fences.map((fence) => fence.attributes)
    : [];

export const collectSecretBlockIdsFromMarkdown = (markdown: string | null | undefined) =>
  collectSecretBlocksFromMarkdown(markdown).map((block) => block.id);

/** Replaces each secret fence with its label line, keeping list and quote prefixes. */
export const redactSecretBlocksInMarkdown = (markdown: string) => {
  if (!markdown.includes(SECRET_BLOCK_MARKDOWN_LANGUAGE)) return markdown;
  const { lines, fences } = scanSecretFences(markdown);
  if (!fences.length) return markdown;
  const output: string[] = [];
  let cursor = 0;
  for (const fence of fences) {
    output.push(...lines.slice(cursor, fence.start), `${fence.prefix}${secretBlockPlaceholderText(fence.attributes.label)}`);
    cursor = fence.end + 1;
  }
  output.push(...lines.slice(cursor));
  return output.join("\n");
};
