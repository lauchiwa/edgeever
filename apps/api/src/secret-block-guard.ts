import {
  CLIENT_FEATURES_HEADER,
  SECRET_BLOCKS_CLIENT_FEATURE,
  SECRET_BLOCK_MAX_PER_NOTE,
  collectSecretBlocks,
  collectSecretBlocksFromMarkdown,
  docToText,
  downgradeSecretBlocksForStorage,
  markdownHasSecretBlocks,
  redactSecretBlocksInDoc,
  redactSecretBlocksInMarkdown,
  type SecretBlockAttributes,
  type TiptapDoc,
} from "@edgeever/shared";

// Fork feature: inline secret blocks inside plaintext notes. Kept in its own
// module so the hooks in upstream files stay one-liners.

export const SECRET_BLOCKS_CAPABILITY = true;

/** True when the request comes from a client that edits secret blocks itself. */
export const clientSupportsSecretBlocks = (header: string | null | undefined) =>
  Boolean(header?.split(",").some((feature) => feature.trim() === SECRET_BLOCKS_CLIENT_FEATURE));

export const readSecretBlocksClientFeature = (request: { header: (name: string) => string | undefined }) =>
  clientSupportsSecretBlocks(request.header(CLIENT_FEATURES_HEADER));

/** JSON written to storage keeps secret blocks in their code block form. */
export const canonicalSecretBlockDoc = (doc: TiptapDoc) =>
  doc && Array.isArray(doc.content) ? downgradeSecretBlocksForStorage(doc) : doc;

const signature = ({ id, envelope }: SecretBlockAttributes) => `${id}:${JSON.stringify(envelope)}`;

const blocksOf = (doc: TiptapDoc | null | undefined, markdown: string | null | undefined) => ({
  json: collectSecretBlocks(doc),
  markdown: collectSecretBlocksFromMarkdown(markdown),
});

/**
 * A client that does not know secret blocks can only carry them along: every
 * existing block must come back with the same id and ciphertext in both the
 * JSON and the Markdown body. That catches a dropped block, a JSON line broken
 * by hand in a code block, and an agent writing back a redacted body. Aware
 * clients may delete or re-encrypt blocks, but never exceed the per-note cap.
 */
export const secretBlockUpdateError = (
  current: { contentJson: TiptapDoc | null | undefined; contentMarkdown: string | null | undefined },
  next: { contentJson: TiptapDoc; contentMarkdown: string },
  clientSupportsBlocks: boolean,
) => {
  const before = blocksOf(current.contentJson, current.contentMarkdown);
  const after = blocksOf(next.contentJson, next.contentMarkdown);
  const beforeCount = Math.max(before.json.length, before.markdown.length);
  const afterCount = Math.max(after.json.length, after.markdown.length);
  if (afterCount > SECRET_BLOCK_MAX_PER_NOTE && afterCount > beforeCount) {
    return {
      error: "secret_block_limit",
      message: `A note can hold at most ${SECRET_BLOCK_MAX_PER_NOTE} secret blocks.`,
      status: 400,
    } as const;
  }
  if (clientSupportsBlocks || !beforeCount) return null;
  const kept = (blocks: SecretBlockAttributes[]) => new Set(blocks.map(signature));
  const keptJson = kept(after.json);
  const keptMarkdown = kept(after.markdown);
  const intact = [...before.json, ...before.markdown]
    .every((block) => keptJson.has(signature(block)) && keptMarkdown.has(signature(block)));
  return intact
    ? null
    : {
        error: "secret_block_update_required",
        message: "This note has secret blocks. Update EdgeEver to edit it, or keep the blocks unchanged.",
        status: 409,
      } as const;
};

/** Drops secret block ciphertext from memos sent to agents, AI and public readers. */
export const redactSecretBlockMemo = <T extends { contentMarkdown: string; contentJson: unknown; contentText: string }>(memo: T) => {
  const doc = memo.contentJson as TiptapDoc | null;
  const jsonHasBlocks = Boolean(doc && Array.isArray(doc.content) && collectSecretBlocks(doc).length);
  if (!jsonHasBlocks && !markdownHasSecretBlocks(memo.contentMarkdown)) return memo;
  const contentJson = jsonHasBlocks && doc ? redactSecretBlocksInDoc(doc) : memo.contentJson;
  return {
    ...memo,
    contentMarkdown: redactSecretBlocksInMarkdown(memo.contentMarkdown),
    contentJson,
    contentText: jsonHasBlocks ? docToText(contentJson) : memo.contentText,
  };
};

/**
 * Redacts every `contentMarkdown` / `contentJson` in a tool result (memos,
 * revisions, templates), so MCP clients and the companion model only see labels.
 */
export const redactSecretBlocksDeep = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const next = value.map((item) => redactSecretBlocksDeep(item));
    return (next.some((item, index) => item !== value[index]) ? next : value) as T;
  }
  if (!value || typeof value !== "object") return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const redacted = key === "contentMarkdown" && typeof child === "string"
      ? redactSecretBlocksInMarkdown(child)
      : key === "contentJson" ? redactSecretBlockDoc(child) : redactSecretBlocksDeep(child);
    if (redacted !== child) changed = true;
    next[key] = redacted;
  }
  return (changed ? next : value) as T;
};

export const redactSecretBlockMarkdown =(markdown: string | null | undefined) =>
  markdown ? redactSecretBlocksInMarkdown(markdown) : markdown ?? "";

export const redactSecretBlockDoc = <T>(doc: T): T =>
  doc && typeof doc === "object" && Array.isArray((doc as unknown as TiptapDoc).content)
    ? redactSecretBlocksInDoc(doc as unknown as TiptapDoc) as T
    : doc;
