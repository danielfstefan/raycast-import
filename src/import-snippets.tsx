import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { createDecipheriv, scryptSync, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { useState } from "react";
import {
	Action,
	ActionPanel,
	Form,
	Icon,
	List,
	Toast,
	showToast,
	useNavigation,
} from "@vicinae/api";

// ---- Vicinae snippet storage (verified against upstream src/snippet + glaze v7) ----
//   { id, name, data: { "text": "..." } | { "file": "..." }, createdAt, updatedAt?, expansion? }
// File lives at <dataDir>/snippets/snippets.json on every platform.
// NOTE (verified in code): the running server caches snippets in memory and rewrites on
// mutation — no file watcher. Restart the app after import; don't edit snippets first.

// ---- Raycast .rayconfig formats (reverse-engineered by Tinycast, verified live here) ----
// v1 (Raycast 1.x):   file = IV(16) || AES-256-CBC( gzip(JSON), PKCS#7 ), key = SHA-256(passphrase)
// v2 (Raycast X):     file = gzip -> JSON envelope {data, encryption:{iv,salt,authTag}} -> AES-256-GCM
//                      key = scrypt(passphrase, salt, N=16384, r=8, p=1, dkLen=32)
// Detection: leading gzip magic (1f 8b 08) => v2, else v1 (whole AES blocks).
// Snippets live at JSON.builtin_package_snippets.snippets as [{name, text, alias, ...}].

interface VicinaeSnippet {
	id: string;
	name: string;
	data: { text?: string; file?: string };
	createdAt: number;
	updatedAt?: number;
	expansion?: { keyword: string; apps: string[]; word: boolean };
}

interface RaycastSnippet {
	name?: unknown;
	text?: unknown;
	keyword?: unknown;
	alias?: unknown;
}

// ---- Raycast decryption (pure port of Tinycast's reverse-engineered format) ----

type DecryptResult =
	| { ok: true; data: unknown }
	| { ok: false; error: "notRaycast" | "passphrase" | "corrupt" };

function decryptV1(raw: Buffer, passphrase: string): DecryptResult {
	try {
		if (raw.length < 32 || raw.length % 16 !== 0)
			return { ok: false, error: "notRaycast" };
		const iv = raw.subarray(0, 16);
		const ct = raw.subarray(16);
		const key = createHash_le("sha256", passphrase);
		const decipher = createDecipheriv("aes-256-cbc", key, iv);
		decipher.setAutoPadding(false); // Node auto-unpads by default; we unpad ourselves (tinycast-compatible)
		// Node 22 renamed finalize -> final; @types/node has both. Call whichever exists.
		const finish: () => Buffer = decipher.final
			? () => decipher.final()
			: () => (decipher as unknown as { finalize: () => Buffer }).finalize();
		let pt = Buffer.concat([decipher.update(ct), finish()]);
		// strip PKCS#7
		const pad = pt[pt.length - 1];
		if (pad < 1 || pad > 16 || pad > pt.length) return { ok: false, error: "passphrase" };
		pt = pt.subarray(0, pt.length - pad);
		// integrity: must gunzip into JSON
		return parseVicinaeJson(gunzipSync(pt));
	} catch {
		return { ok: false, error: "passphrase" };
	}
}

function decryptV2(raw: Buffer, passphrase: string): DecryptResult {
	try {
		let env: Record<string, unknown>;
		try {
			env = JSON.parse(gunzipSync(raw).toString("utf8")) as Record<string, unknown>;
		} catch {
			return { ok: false, error: "notRaycast" };
		}
		const dataHex = env["data"];
		const enc = env["encryption"] as Record<string, string> | undefined;
		if (typeof dataHex !== "string" || !enc) return { ok: false, error: "notRaycast" };
		const iv = Buffer.from(enc["iv"] ?? "", "hex");
		const salt = Buffer.from(enc["salt"] ?? "", "hex");
		const tag = Buffer.from(enc["authTag"] ?? "", "hex");
		const ciphertext = Buffer.from(dataHex, "hex");
		const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		const finish: () => Buffer = decipher.final
			? () => decipher.final()
			: () => (decipher as unknown as { finalize: () => Buffer }).finalize();
		const plain = Buffer.concat([decipher.update(ciphertext), finish()]);
		return parseVicinaeJson(gunzipSync(plain));
	} catch {
		return { ok: false, error: "passphrase" };
	}
}

// tiny local sha256 for v1 (matches EVP_BytesToKey single round => SHA-256(passphrase))
function createHash_le(algo: "sha256", data: string): Buffer {
	return createHash(algo).update(data, "utf8").digest();
}

function parseVicinaeJson(plain: Buffer): DecryptResult {
	try {
		return { ok: true, data: JSON.parse(plain.toString("utf8")) };
	} catch {
		return { ok: false, error: "corrupt" };
	}
}

function findSnippetsInExport(root: unknown): { name: string; text: string; keyword?: string }[] {
	// plain "Export Snippets" JSON is a top-level array
	if (Array.isArray(root)) {
		const out: { name: string; text: string; keyword?: string }[] = [];
		for (const item of root) {
			const e = (item ?? {}) as Record<string, unknown>;
			const name = (e["name"] ?? "").toString().trim();
			const text = (e["text"] ?? "").toString();
			if (!name || !text) continue;
			const keyword = (e["keyword"] ?? e["alias"] ?? "").toString().trim();
			out.push({ name, text, keyword: keyword || undefined });
		}
		return out;
	}
	const obj = (root ?? {}) as Record<string, unknown>;
	const pkgs = obj["builtin_package_snippets"] as Record<string, unknown> | undefined;
	const raw = (typeof pkgs === "object" && pkgs && (pkgs["snippets"] as unknown[] | undefined)) ||
		(obj["snippets"] as unknown[] | undefined) || [];
	const out: { name: string; text: string; keyword?: string }[] = [];
	for (const item of raw) {
		const e = (item ?? {}) as Record<string, unknown>;
		const name = (e["name"] ?? "").toString().trim();
		const text = (e["text"] ?? "").toString();
		if (!name || !text) continue;
		const keyword = (e["keyword"] ?? e["alias"] ?? "").toString().trim();
		out.push({ name, text, keyword: keyword || undefined });
	}
	return out;
}

function readExportSnippets(file: string, passphrase: string): {
	snippets: { name: string; text: string; keyword?: string }[];
} {
	const buf = readFileSync(file);
	const lower = file.toLowerCase();

	// plain JSON file (Raycast "Export Snippets") — unencrypted
	const isPlainJson =
		lower.endsWith(".json") ||
		!lower.endsWith(".rayconfig") && !(buf[0] === 0x1f && buf[1] === 0x8b);

	if (isPlainJson) {
		try {
			const parsed = JSON.parse(buf.toString("utf8"));
			const arr = Array.isArray(parsed)
				? parsed
				: (parsed as { snippets?: unknown }).snippets ?? [];
			return { snippets: findSnippetsInExport(arr) };
		} catch {
			throw new Error("invalid-json");
		}
	}

	// encrypted .rayconfig
	if (buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) {
		// v2
		const res = decryptV2(buf, passphrase);
		if (!res.ok) throw new Error(res.error);
		return { snippets: findSnippetsInExport(res.data) };
	}
	const res = decryptV1(buf, passphrase);
	if (!res.ok) throw new Error(res.error);
	return { snippets: findSnippetsInExport(res.data) };
}

// ---- Vicinae store helpers ----

function dataDir(): string {
	if (process.platform === "win32")
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "vicinae", "data");
	if (process.platform === "darwin") return join(homedir(), ".local", "share", "vicinae");
	const xdg = process.env.XDG_DATA_HOME;
	return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share"), "vicinae");
}

function snippetsPath(): string {
	return join(dataDir(), "snippets", "snippets.json");
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function toVicinaeSnippet(
	rc: { name: string; text: string; keyword?: string },
	at: number,
	existingNames: Set<string>,
	existingKeywords: Set<string>,
): { snippet: VicinaeSnippet | null; skippedReason?: string } {
	const name = (rc.name ?? "").trim();
	const text = (rc.text ?? "").trim();
	const keyword = (rc.keyword ?? "").trim() || undefined;
	if (!name) return { snippet: null, skippedReason: "missing name" };
	if (!text) return { snippet: null, skippedReason: "snippet is empty" };
	if (existingNames.has(name.toLowerCase()))
		return { snippet: null, skippedReason: "name already exists in Vicinae" };
	if (keyword && existingKeywords.has(keyword.toLowerCase()))
		return { snippet: null, skippedReason: "keyword already in use in Vicinae" };

	let id = `snp-${Math.random().toString(16).slice(2, 14)}`;
	// core format: snp- + 12 lowercase hex; pad in case RNG yields short strings
	while (id.length < 16) id += Math.floor(Math.random() * 16).toString(16);
	id = id.slice(0, 16);

	const snippet: VicinaeSnippet = {
		id,
		name,
		data: { text },
		createdAt: at,
		...((keyword ? { expansion: { keyword, apps: [] as string[], word: true } } : {}) as object),
	};
	if (keyword) snippet.updatedAt = at;

	existingNames.add(name.toLowerCase());
	if (keyword) existingKeywords.add(keyword.toLowerCase());
	return { snippet };
}

function readExisting(): VicinaeSnippet[] {
	const p = snippetsPath();
	if (!existsSync(p)) return [];
	try {
		const raw = JSON.parse(readFileSync(p, "utf8"));
		return Array.isArray(raw) ? (raw as VicinaeSnippet[]) : [];
	} catch {
		return [];
	}
}

// ---- UI ----

function ImportForm() {
	const { push } = useNavigation();
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(input: Form.Values) {
		const file = Array.isArray(input.raycastFile)
			? input.raycastFile[0]
			: (input.raycastFile as string | undefined);
		const replace = Boolean(input.replaceExisting);
		const passphrase = String(input.passphrase ?? "");

		setSubmitting(true);
		try {
			if (!file) {
				await showToast({
					style: Toast.Style.Failure,
					title: "Pick a file",
					message:
						"Select the Raycast 'Export Snippets' JSON, or a .rayconfig backup (we'll decrypt it with your passphrase).",
				});
				return;
			}

			let entries: { name: string; text: string; keyword?: string }[];
			try {
				entries = readExportSnippets(file, passphrase).snippets;
			} catch (err) {
				// diagnostics: dump what the app actually delivered (no plaintext passphrase — length only)
				try {
					const diag = {
						when: new Date().toISOString(),
						file,
						fileSize:
							typeof file === "string" && existsSync(file) ? readFileSync(file).length : null,
						fileHead:
							typeof file === "string" && existsSync(file)
								? readFileSync(file).subarray(0, 8).toString("hex")
								: null,
						passphraseLen: passphrase.length,
						passphraseSha: createHash("sha256")
							.update("diag:" + passphrase)
							.digest("hex")
							.slice(0, 16),
						error: err instanceof Error ? err.message : String(err),
					};
					writeFileSync("/tmp/vicinae-import-diag.json", JSON.stringify(diag, null, 2));
				} catch {
					/* diagnostics must never break the flow */
				}
				const code = err instanceof Error ? err.message : "corrupt";
				const title =
					code === "notRaycast"
						? "Not a Raycast export"
						: code === "passphrase"
							? "Incorrect passphrase"
							: code === "invalid-json"
								? "Invalid JSON"
								: code === "corrupt"
									? "Corrupt export"
									: `Unexpected (${code})`;
				const message =
					code === "passphrase"
						? "The .rayconfig is encrypted. Enter the passphrase you set in Raycast → Settings → Extensions → Export Settings & Data."
						: code === "notRaycast"
							? "This doesn't look like a Raycast export. Use Export Snippets (plain .json) or Export Settings & Data (.rayconfig)."
							: `Pick a valid Raycast export: ${basename(file)} (${code})`;
				await showToast({ style: Toast.Style.Failure, title, message });
				return;
			}

			const at = nowSeconds();
			const existingNames = new Set<string>();
			const existingKeywords = new Set<string>();
			let existing: VicinaeSnippet[] = [];
			if (!replace) existing = readExisting();
			for (const e of existing) {
				existingNames.add((e.name ?? "").toLowerCase());
				if (e.expansion?.keyword)
					existingKeywords.add(e.expansion.keyword.toLowerCase());
			}

			const imported: VicinaeSnippet[] = [];
			const skipped: string[] = [];
			for (const e of entries) {
				const { snippet, skippedReason } = toVicinaeSnippet(
					e,
					at,
					existingNames,
					existingKeywords,
				);
				if (snippet) imported.push(snippet);
				else if (skippedReason) skipped.push(e.name ?? "?");
			}

			if (existsSync(snippetsPath())) {
				const b = `${snippetsPath()}.bak-${at}`;
				renameSync(snippetsPath(), b);
			}
			mkdirSync(dirname(snippetsPath()), { recursive: true });
			const all = [...existing, ...imported];
			const tmp = `${snippetsPath()}.tmp-${at}`;
			writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", "utf8");
			renameSync(tmp, snippetsPath());

			push(
				<ResultList
					imported={imported}
					skipped={skipped}
					totalExported={entries.length}
					replace={replace}
				/>,
			);
		} catch (err) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Import failed",
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Form
			navigationTitle="Import Raycast Data"
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Import" icon={Icon.Download} onSubmit={onSubmit} />
				</ActionPanel>
			}
		>
			<Form.Description
				text={
					"Pick a Raycast 'Export Snippets' (.json) file, or a full '.rayconfig' backup from 'Export Settings & Data'. For .rayconfig we decrypt locally with your passphrase (never transmitted)."
				}
			/>
			<Form.FilePicker
				id="raycastFile"
				title="Raycast Export"
				info="A .json from Export Snippets, or a .rayconfig backup."
				canChooseFiles={true}
				canChooseDirectories={false}
				allowMultipleSelection={false}
				storeValue={true}
			/>
			<Form.PasswordField
				id="passphrase"
				title="Export passphrase"
				placeholder="Only needed for .rayconfig backups"
				info="The passphrase set in Raycast → Settings → Extensions → Export Settings & Data."
				// VICINAE QUIRK (vs Raycast): storeValue=false EXCLUDES a field from the
				// submitted values entirely (ExtensionFormModel::submit() skips it) — it does
				// NOT mean "don't persist". The host persists no form values, so true is safe.
				storeValue={true}
			/>
			<Form.Checkbox
				id="replaceExisting"
				title="Replace existing"
				label="Delete current Vicinae snippets before importing"
				defaultValue={false}
				storeValue={true}
			/>
			<Form.Description
				text={
					"After import: quit and reopen Vicinae for snippets to load (the core caches them in memory at startup)."
				}
			/>
		</Form>
	);
}

function ResultList({
	imported,
	skipped,
	totalExported,
	replace,
}: {
	imported: VicinaeSnippet[];
	skipped: string[];
	totalExported: number;
	replace: boolean;
}) {
	return (
		<List isLoading={false} navigationTitle="Import result">
			<List.Section title="Imported" subtitle={`${imported.length} of ${totalExported} snippets`}>
				{imported.map((n) => (
					<List.Item
						key={n.id}
						title={n.name}
						subtitle={n.data.text?.slice(0, 80)}
						icon={Icon.CheckCircle}
						accessories={
							n.expansion?.keyword
								? [{ text: `⌥ ${n.expansion.keyword}`, icon: Icon.Keyboard }]
								: []
						}
						actions={
							<ActionPanel>
								<Action.CopyToClipboard
									title="Copy Content"
									content={n.data.text ?? ""}
								/>
							</ActionPanel>
						}
					/>
				))}
				{imported.length === 0 && (
					<List.Item
						title="Nothing to import"
						subtitle="All entries were skipped as duplicates or empty."
						icon={Icon.Info}
					/>
				)}
			</List.Section>
			<List.Section
				title="⚠️ Restart required"
				subtitle={
					replace
						? "Vicinae snippets were replaced. Quit and reopen Vicinae."
						: "Quit and reopen Vicinae for the imported snippets to appear."
				}
			>
				<List.Item
					title={
						skipped.length > 0
							? `${skipped.length} entries skipped (${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", …" : ""})`
							: "No duplicates found"
					}
					icon={Icon.Info}
				/>
			</List.Section>
		</List>
	);
}

export default function Command(): JSX.Element {
	return <ImportForm />;
}
