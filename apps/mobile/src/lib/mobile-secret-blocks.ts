import {
  normalizeSecretBlockAttributes,
  SECRET_BLOCK_NODE_TYPE,
  UNSUPPORTED_BLOCK_NODE_TYPE,
  type SecretBlockAttributes,
} from "@edgeever/shared";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Fork: inline secret blocks on Android are read-only. The WebView only ever
 * holds the lossless placeholder (label + ciphertext); a tap hands the
 * ciphertext to React Native, which decrypts it in a native modal so the
 * plaintext never enters the WebView, the document or storage.
 */

/** Secret block attributes from a native-editor placeholder node; null for anything else. */
export const readSecretBlockPlaceholder = (node: Pick<ProseMirrorNode, "type" | "attrs">): SecretBlockAttributes | null => {
  if (node.type.name !== UNSUPPORTED_BLOCK_NODE_TYPE || node.attrs.originalType !== SECRET_BLOCK_NODE_TYPE) return null;
  try {
    const original = JSON.parse(String(node.attrs.originalJson)) as { attrs?: unknown };
    return normalizeSecretBlockAttributes(original.attrs);
  } catch {
    return null;
  }
};

const SECRET_PLACEHOLDER_SELECTOR = `[data-edgeever-unsupported-block][data-original-type="${SECRET_BLOCK_NODE_TYPE}"]`;

/** WebView click handler: opens the native modal for a tapped secret block. */
export const handleSecretBlockPress = (
  view: EditorView,
  event: Event,
  onSecretBlockPress?: (attributesJson: string) => Promise<void>,
) => {
  const target = event.target instanceof Element ? event.target.closest(SECRET_PLACEHOLDER_SELECTOR) : null;
  if (!target || !onSecretBlockPress) return false;
  let attributes: SecretBlockAttributes | null = null;
  view.state.doc.descendants((node, pos) => {
    if (attributes) return false;
    if (view.nodeDOM(pos) === target) attributes = readSecretBlockPlaceholder(node);
    return !node.isAtom;
  });
  if (!attributes) return false;
  event.preventDefault();
  event.stopPropagation();
  void onSecretBlockPress(JSON.stringify(attributes));
  return true;
};

/** React Native side of the bridge; null for malformed payloads. */
export const parseSecretBlockPressPayload = (payloadJson: string): SecretBlockAttributes | null => {
  try {
    return normalizeSecretBlockAttributes(JSON.parse(payloadJson));
  } catch {
    return null;
  }
};
