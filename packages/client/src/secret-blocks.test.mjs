import { describe, expect, test } from "bun:test";
import { CLIENT_FEATURES_HEADER, SECRET_BLOCKS_CLIENT_FEATURE, SECRET_BLOCK_NODE_TYPE } from "@edgeever/shared";
import { createEdgeEverClient } from "./index.ts";

const envelope = {
  v: 1,
  kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
  cipher: { name: "AES-GCM", iv: "aXZpdml2aXZpdml2" },
  ct: "Y2lwaGVydGV4dA",
};
const secretNode = { type: SECRET_BLOCK_NODE_TYPE, attrs: { id: "block-id-0001", label: "DB", envelope } };

const recordingClient = (clientFeatures) => {
  const calls = [];
  const client = createEdgeEverClient({
    baseUrl: "https://notes.example",
    clientFeatures,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ memo: {} }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { client, calls };
};

describe("secret block client contract", () => {
  test("declares client features only when the app opts in", async () => {
    const off = recordingClient(() => []);
    await off.client.updateMemo("m1", { title: "x" });
    expect(off.calls[0].headers.has(CLIENT_FEATURES_HEADER)).toBe(false);

    const on = recordingClient(() => [SECRET_BLOCKS_CLIENT_FEATURE]);
    await on.client.updateMemo("m1", { title: "x" });
    expect(on.calls[0].headers.get(CLIENT_FEATURES_HEADER)).toBe(SECRET_BLOCKS_CLIENT_FEATURE);
  });

  test("sends secret blocks in their stored code block form", async () => {
    const { client, calls } = recordingClient(() => []);
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "host" }] }, secretNode] };
    await client.updateMemo("m1", { contentJson: doc });
    await client.createMemo({ notebookId: "n1", contentJson: doc });
    for (const call of calls) {
      const block = call.body.contentJson.content[1];
      expect(block.type).toBe("codeBlock");
      expect(block.attrs.language).toBe("edgeever-secret");
      expect(JSON.parse(block.content[0].text)).toEqual({ id: "block-id-0001", label: "DB", envelope });
    }
  });
});
