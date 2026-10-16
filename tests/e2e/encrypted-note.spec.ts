import { expect, test } from "@playwright/test";

const PASSPHRASE = "e2e-vault-passphrase";
const SECRET = `e2e secret ${Date.now()}`;

test("encrypts a note in the browser and never stores its body in plaintext on the server", async ({ page }) => {
  await page.goto("/");

  const session = await (await page.request.get("/api/v1/auth/session")).json();
  expect(session.features?.encryptedNotes).toBe(true);

  await page.getByRole("button", { name: "选择笔记类型", exact: true }).click();
  await page.getByRole("menuitem", { name: "加密笔记" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.locator("#encrypted-note-passphrase").fill(PASSPHRASE);
  const confirm = dialog.locator("#encrypted-note-passphrase-confirm");
  if (await confirm.count()) await confirm.fill(PASSPHRASE);

  const createResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/memos",
  );
  await dialog.getByRole("button", { name: "创建加密笔记" }).click();
  const created = await (await createResponse).json();
  const memoId: string = created.memo?.id ?? created.id;
  expect(memoId).toBeTruthy();

  const editor = page.getByRole("textbox", { name: "Encrypted note content" });
  await expect(editor).toBeVisible();
  const saveResponse = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/memos/${memoId}`,
  );
  await editor.click();
  await page.keyboard.type(SECRET);
  const saved = await saveResponse;
  expect(saved.ok(), await saved.text()).toBe(true);

  // Server copy: ciphertext envelope only, placeholder everywhere else.
  const stored = await (await page.request.get(`/api/v1/memos/${memoId}`)).json();
  const memo = stored.memo ?? stored;
  expect(JSON.stringify(memo)).not.toContain(SECRET);
  expect(memo.contentMarkdown).toContain("<!-- edgeever-encrypted-v1:");

  // A plaintext overwrite (what an upstream client would send) is refused.
  const editSession = await (await page.request.post(`/api/v1/memos/${memoId}/edit-sessions`, { data: {} })).json();
  const overwrite = await page.request.patch(`/api/v1/memos/${memoId}`, {
    data: {
      editSessionId: editSession.editSession.id,
      expectedRevision: memo.revision,
      expectedContentHash: memo.contentHash,
      contentMarkdown: "plaintext overwrite",
    },
  });
  expect(overwrite.status()).toBe(409);
  expect((await overwrite.json()).error.code).toBe("encrypted_update_required");

  // Locking clears the plaintext; a wrong passphrase fails; the right one decrypts.
  await page.getByRole("button", { name: "锁定", exact: true }).first().click();
  await expect(page.getByText("这篇笔记已加密")).toBeVisible();
  await expect(page.getByText(SECRET)).toHaveCount(0);

  await page.locator("#encrypted-note-unlock").fill("not-the-passphrase");
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByText("口令错误，或笔记已损坏。")).toBeVisible();

  await page.locator("#encrypted-note-unlock").fill(PASSPHRASE);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(editor).toContainText(SECRET);

  // A reload starts locked: the passphrase lives only in memory.
  await page.reload();
  await page.locator(`[data-memo-id="${memoId}"]`).locator("button").first().click();
  await expect(page.getByText("这篇笔记已加密")).toBeVisible();
});
