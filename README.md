# raycast-import

Import data exported from Raycast into Vicinae.

**Currently: snippets.** Reads either:
- a **plain `.json`** from Raycast's **"Export Snippets"** command (unencrypted), or
- an encrypted **`.rayconfig`** backup from **"Export Settings & Data"** — decrypted
  **locally in the extension** with the passphrase you supply (nothing transmitted).

## What it does

- `Import Raycast Data` command → pick the export file (+ passphrase for `.rayconfig`)
- Converts Raycast snippets to Vicinae's native `SerializedSnippet` shape and merges
  into `<dataDir>/snippets/snippets.json`.
- Merge mode (default) or full replace (checkbox); duplicates skipped by name/keyword.
- Atomic write (tmp + rename), with a `.bak-<ts>` backup of the previous store.

## Why the `.rayconfig` passphrase

Raycast encrypts "Export All Data" backups with a passphrase (≥8 chars) even when you
never set one — it generates it and stores it in the login keychain. Find/view it at:
**Raycast → Settings → Extensions → Export Settings & Data**. The `.rayconfig`
formats are reverse-engineered (Tinycast) and verified live here:

| Format | File layout | Key |
|---|---|---|
| v1 (Raycast 1.x) | `IV(16) + AES-256-CBC(gzip(JSON), PKCS#7)` | `SHA-256(passphrase)` |
| v2 (Raycast X) | `gzip → JSON envelope → AES-256-GCM` | `scrypt(pw, salt, N=16384, r=8, p=1)` |

Detection is by leading bytes (gzip magic `1f 8b 08` ⇒ v2, else v1), no passphrase
needed to detect. A wrong passphrase is reported as "Incorrect passphrase" and never
touches the store.

## Scope note: clipboard history

Not imported in v1. It lives inside the `.rayconfig` under
`builtin_package_clipboardHistory`, but Vicinae's clipboard store is core-owned
(SQLite + content files, optional per-install encryption) — writing into it from an
extension is fragile surgery. The proper long-term route is a native importer in the
Vicinae core.

## Dev

```bash
npm install
npx vici build --out "$HOME/.local/share/vicinae/extensions/raycast-import"
```

## Restart caveat (VERIFIED in source)

`SnippetDatabase` loads snippets once at construction and rewrites the file on every
mutation — no file watcher. After an import, **quit and reopen Vicinae** before
editing snippets, or the running instance may write back its stale in-memory list
over your import.
