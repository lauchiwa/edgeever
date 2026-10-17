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

Upstream Android and iOS apps do not know this format. They show the placeholder text, and if a user edits it there, the save is rejected as a conflict by the fork server instead of overwriting the ciphertext. An **upstream** server image has no such guard, so do not use encrypted notes against it.

## Verification status

Automated tests cover:
- encryption round-trip, wrong passphrase, tampering and bounds;
- placeholder-only search and excerpts;
- rejection of envelope-dropping updates, JSON-only updates and revision restores;
- merge refusal and MCP redaction.

Not yet verified:
- the Windows desktop app end to end;
- upgrading a real deployment from the upstream image;
- the behaviour of upstream mobile apps on a real device.
