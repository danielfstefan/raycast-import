# raycast-import

Import data exported from Raycast into Vicinae.

**v1 — Snippets only.** Reads a Raycast `Export Snippets` JSON file and merges it
into Vicinae's snippet store (`<dataDir>/snippets/snippets.json`), with dedupe by
name/keyword and an atomic write (backup of the previous file preserved).

## What works today

- `Import Raycast Snippets` command → pick the Raycast export `.json` → snippets
  are converted to Vicinae's native `SerializedSnippet` shape and merged in.
- Merge mode (default) or full replace (checkbox). Duplicates are skipped.
- Write is atomic (`tmp` + rename) and keeps a `.bak-<ts>` of the previous store.

## Why v1 is snippets-only (verified against upstream source + glaze)

- **Snippets**: Raycast's `Export Snippets` writes plain unencrypted JSON
  (`[{name, text, keyword}]`), and Vicinae stores snippets as plain JSON at
  `<dataDir>/snippets/snippets.json` — a clean, safe import target. Clipboard
  history is **not** in the plain export: it only exists inside the encrypted
  `.rayconfig` bundle or Raycast's on-device encrypted store, and Vicinae's
  clipboard history (SQLite + content files) is core-owned with an optional
  per-install encryption key — writing into it from an extension would be
  fragile/unsafe surgery. The proper long-term route for clipboard history is a
  native importer in the Vicinae core (extension API has no snippet/IPC write
  path today).

## Dev

```bash
npm install
npx vici build --out "$HOME/.local/share/vicinae/extensions/raycast-import"
```

The app hot-scans the extensions dir (no restart needed for the extension to
appear); restart `Vicinae` afterwards for imported snippets to be picked up by
the core (it caches snippets in memory at startup).

## Restart caveat (VERIFIED in source)

`SnippetDatabase` loads snippets once at construction and rewrites the file on
every mutation — there is **no file watcher**. So after an import, quit and
reopen Vicinae before editing snippets, or the running instance may write back
its stale in-memory list over your import.
