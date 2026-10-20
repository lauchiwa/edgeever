# Encrypted notes (fork feature)

Encrypted notes are opt-in. The client encrypts the note body before saving it, so the server, backups and sync only ever see ciphertext. Create one from the new-note menu → "Encrypted note". Ordinary notes are unchanged.

## How it works

- The body is encrypted in the Web/desktop client with WebCrypto. The key is derived with PBKDF2-SHA256 (600,000 iterations, a fresh salt per note) and the body is sealed with AES-256-GCM (a fresh IV on every save). The passphrase and derived keys stay in memory only. The vault locks after 15 minutes of inactivity, or when you lock it manually.
- Storage reuses the existing columns, so no migration is needed. `content_markdown` holds a placeholder line plus an `<!-- edgeever-encrypted-v1:… -->` envelope. `content_json` and `content_text` only hold the placeholder "🔒 Encrypted note", so search, excerpts, AI and MCP see nothing else.
- One vault passphrase is shared by all encrypted notes. Each device keeps a small encrypted verifier in local storage that catches a mistyped passphrase when you create a note. It is per device and does not sync.

## Deliberate limits

- **Lost passphrase:** if you forget the passphrase, the notes cannot be recovered. There is no reset.
- **Titles:** titles, tags and notebook placement stay plaintext.
- **Attachments:** images and files cannot be inserted, because they would be uploaded unencrypted.
- **Disabled features:** search over the body, AI and companion, MCP content reads and writes, public or notebook sharing, and merging are all unavailable.
- **One-way:** there is no in-place "decrypt back to a normal note". To convert, copy the content into a new note.
- **Existing notes:** a plaintext note is never encrypted in place. To protect existing content, create an encrypted note, paste the content in, then delete the original and empty the trash. Older revisions, backups and database snapshots taken before that keep the plaintext.

## Server guard and deployment

A server built from this fork:
- rejects any write that would drop an encrypted envelope (409 `encrypted_update_required`), including revision restore;
- refuses merge and share for encrypted notes;
- returns only placeholders to MCP;
- advertises `features.encryptedNotes` in `/api/v1/auth/session`.

The client offers encrypted notes only when the server advertises that capability.

The fork's Android test build ([fork releases](fork-releases.md#android-test-build)) can unlock and edit existing encrypted notes:
- The native module `apps/mobile/modules/edgeever-crypto` does PBKDF2 and AES-GCM with the platform's `javax.crypto`, because Hermes has no WebCrypto. The same envelope opens on web, desktop and Android.
- The passphrase and keys stay in memory. The vault locks after 15 minutes of inactivity, on manual lock, or when the account or server changes.
- Only ciphertext reaches the local SQLite mirror and the offline outbox. Local search and excerpts only see the placeholder. Plaintext is never written as a draft.
- Rich-text editing, AI drafts, images and attachments are blocked for encrypted notes. Creating one is still done on web or desktop.

Upstream Android and iOS apps do not know this format. They show the placeholder text, and if a user edits it there, the save is rejected as a conflict by the fork server instead of overwriting the ciphertext. An **upstream** server image has no such guard, so do not use encrypted notes against it.

## Inline secret blocks

An ordinary note can encrypt just a small part of its content, such as the passwords in a deployment log. Type `/secret` in the editor (or search for "Secret block") to insert one. The label stays plaintext and only the secret is encrypted.

- Encryption matches encrypted notes and uses the same vault passphrase. The additional authenticated data (AAD) is different, so a secret block cannot be opened as an encrypted note or the other way round.
  - Blocks in one note share a salt, and every encryption uses a fresh IV. A block holds up to 32 KB, and a note holds up to 100 blocks.
- A block is stored as an `edgeever-secret` code block holding one JSON line (`id`, `label` and the envelope). A client that does not know the format keeps it as an ordinary code block instead of dropping it or blanking the note.
- The plaintext lives only in the block component's memory. It never enters the document, drafts, the offline queue or sync, and it is cleared as soon as the vault locks.
- A block is re-encrypted only when you press "Done" after changing it.
- Search, excerpts, shared pages, AI, Companion and MCP only see "🔒 label". An AI rewrite of a selection never replaces a selection that contains a secret block.

Server guard:
- A client that does not declare support (no `secret-blocks-v1` in the `X-EdgeEver-Client-Features` header) must keep every existing block unchanged in both JSON and Markdown, or the save gets 409 `secret_block_update_required`. It can still edit the text around a block and its label.
- Going over the block limit gets 400 `secret_block_limit`.
- The server announces `features.secretBlocks` in `/api/v1/auth/session`. Clients offer the insert command and send the header above only when the server announces it.

Limits:
- The label and the rest of the note are plaintext.
- AI and MCP cannot rewrite a whole note that contains secret blocks (409), but they can still change its title and tags.
- Restoring a revision skips this guard, but the current version is saved first, so it can still be recovered.
- The fork Android test build shows a secret block as its label and opens it read-only. Tapping the block opens a native dialog: enter the vault passphrase (once per vault session), then view or copy the text. The plaintext stays in that dialog and is dropped when it closes, the vault locks or the app goes to the background; it never reaches the editor WebView, the note or local storage. Editing or adding secret blocks needs Web or desktop, and the server rejects a save that drops or changes one. This has not been verified on a real device yet.

## Verification status

Automated tests cover:
- encryption round-trip, wrong passphrase, tampering and bounds;
- placeholder-only search and excerpts;
- rejection of envelope-dropping updates, JSON-only updates and revision restores;
- merge refusal and MCP redaction;
- the Android crypto core against WebCrypto in both directions (on a desktop JVM), and the Android vault, autosave reload rules and local placeholder text.

Verified by hand:
- unlocking an encrypted note in the browser against a fork server (v1.120.0-rc.1);
- the signed fork Android test build (1.120.0, `714a494`) on a real device: unlocking and reading notes created on other clients, edits made on Android syncing back to them, auto-lock after 15 idle minutes, the blocked image and attachment actions, and no upstream update prompt.

Not yet verified:
- the Windows desktop app end to end;
- upgrading a real deployment from the upstream image;
- the behaviour of upstream mobile apps on a real device.
