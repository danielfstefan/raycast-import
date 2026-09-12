# raycast-import

Import data exported from Raycast into Vicinae.

**Currently: snippets + clipboard history (text/links).** Reads either:
- a **plain `.json`** from Raycast's **"Export Snippets"** command (unencrypted), or
- an encrypted **`.rayconfig`** backup from **"Export Settings & Data"** — decrypted
  **locally in the extension** with the passphrase you supply (nothing transmitted).

## What it does

- `Import Raycast Data` command → pick the export file (+ passphrase for `.rayconfig`)
- **Snippets:** converts Raycast snippets to Vicinae's native `SerializedSnippet` shape
  and merges into `<dataDir>/snippets/snippets.json`. Merge mode (default) or full
  replace (checkbox); duplicates skipped by name/keyword.
- **Clipboard history** (`.rayconfig` only, checkbox): writes text + link entries from
  `builtin_package_clipboardHistory` into Vicinae's clipboard SQLite store
  (`selection` + `data_offer` + content files in `clipboard-data/<offerId>`), schema-verified
  against the core's own migrations. Dedupes by content md5; images/files are skipped
  (no body in the Raycast export). Runs in a transaction with `busy_timeout`.
- Atomic write (tmp + rename) for the snippet store, with a `.bak-<ts>` backup of the
  previous store.

## Clipboard history & encryption

Vicinae on macOS enables **"Encrypt sensitive data"** by default, which makes
`clipboard.db` a SQLCipher-encrypted file. An extension can't write to an encrypted
DB, so the importer **detects that state and reports it in-app** instead of corrupting
your data (no silent downgrade of the security setting). To import clipboard history:

1. Disable **Settings → Encrypt sensitive data**
2. Quit and reopen Vicinae (the core migrates the DB to plaintext)
3. Re-run the import with the clipboard checkbox on
4. Re-enable **Encrypt sensitive data** and restart again

If the DB is unencrypted (e.g. Linux, or the option was off), clipboard import just works.
Imported text entries browse normally; full-text (fuzzy) search may not match them because
the trigram tokenizer is registered by the core, not loadable from Node — a known v1 limit.

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
