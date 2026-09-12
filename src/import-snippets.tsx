import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	mkdirSync,
} from "node:fs";
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
//
// SerializedSnippet JSON shape (glaze v7.2.0 serialization, round-trip tested):
//   { id, name, data: { "text": "..." } | { "file": "..." },
//     createdAt, updatedAt?, expansion?: { keyword, apps, word } }
// File lives at <dataDir>/snippets/snippets.json on every platform.
// NOTE (verified in code): the running server caches snippets in memory and
// rewrites the file on mutation — there is NO file watcher. So after import the
// app must be restarted for changes to be picked up, and snippets shouldn't be
// edited in the running instance before that restart.

interface VicinaeSnippet {
	id: string;
	name: string;
	data: { text?: string; file?: string };
	createdAt: number;
	updatedAt?: number;
	expansion?: { keyword: string; apps: string[]; word: boolean };
}

// Raycast "Export Snippets" JSON: array of { name, text, keyword, ... }.
interface RaycastSnippet {
	name?: string;
	text?: string;
	keyword?: string;
	[field: string]: unknown;
}

function dataDir(): string {
	if (process.platform === "win32") {
		return join(
			process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
			"vicinae",
			"data",
		);
	}
	// macOS: homeDir()/".local"/"share"/"vicinae"  (see upstream src/server/src/vicinae.cpp)
	// Linux: $XDG_DATA_HOME or ~/.local/share, then /vicinae
	if (process.platform === "darwin") {
		return join(homedir(), ".local", "share", "vicinae");
	}
	const xdg = process.env.XDG_DATA_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	return join(base, "vicinae");
}

function snippetsPath(): string {
	return join(dataDir(), "snippets", "snippets.json");
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function toVicinaeSnippet(
	rc: RaycastSnippet,
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
		...((keyword
			? { expansion: { keyword, apps: [] as string[], word: true } }
			: {}) as object),
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

function ImportForm() {
	const { push } = useNavigation();
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(input: Form.Values) {
		const file = Array.isArray(input.raycastFile)
			? input.raycastFile[0]
			: (input.raycastFile as string | undefined);
		const replace = Boolean(input.replaceExisting);

		setSubmitting(true);
		try {
			if (!file) {
				await showToast({
					style: Toast.Style.Failure,
					title: "Pick a file",
					message: "Select the Raycast 'Export Snippets' JSON file first.",
				});
				return;
			}
			const raw = readFileSync(file, "utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				await showToast({
					style: Toast.Style.Failure,
					title: "Invalid JSON",
					message: `${dirname(file)}/${file} is not valid JSON`,
				});
				return;
			}

			const array: RaycastSnippet[] = Array.isArray(parsed)
				? (parsed as RaycastSnippet[])
				: typeof parsed === "object" && parsed !== null &&
						Array.isArray((parsed as { snippets?: unknown }).snippets)
					? ((parsed as { snippets: RaycastSnippet[] }).snippets)
					: [];

			const at = nowSeconds();
			const existingNames = new Set<string>();
			const existingKeywords = new Set<string>();

			let existing: VicinaeSnippet[] = [];
			if (replace) {
				existing = [];
			} else {
				existing = readExisting();
			}
			for (const e of existing) {
				existingNames.add((e.name ?? "").toLowerCase());
				if (e.expansion?.keyword)
					existingKeywords.add(e.expansion.keyword.toLowerCase());
			}

			const imported: VicinaeSnippet[] = [];
			const skipped: string[] = [];
			for (const rc of array) {
				const { snippet, skippedReason } = toVicinaeSnippet(
					rc,
					at,
					existingNames,
					existingKeywords,
				);
				if (snippet) imported.push(snippet);
				else if (skippedReason) skipped.push(rc.name ?? "?");
			}

			// backup original before writing (zero data loss)
			if (existsSync(snippetsPath())) {
				const backup = `${snippetsPath()}.bak-${at}`;
				renameSync(snippetsPath(), backup);
			}
			mkdirSync(dirname(snippetsPath()), { recursive: true });
			const merged = [...existing, ...imported];
			const tmp = `${snippetsPath()}.tmp-${at}`;
			writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
			renameSync(tmp, snippetsPath());

			push(
				<ImportSummary
					imported={imported}
					skipped={skipped}
					totalExported={array.length}
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
			navigationTitle="Import Raycast Snippets"
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Import"
						icon={Icon.Download}
						onSubmit={onSubmit}
					/>
				</ActionPanel>
			}
		>
			<Form.Description
				text="In Raycast run 'Export Snippets' to save a JSON file, then pick it here. Snippets are written to Vicinae's snippet store — restart Vicinae to apply."
			/>
			<Form.FilePicker
				id="raycastFile"
				title="Raycast Export"
				info="The .json file produced by Raycast → Export Snippets."
				canChooseFiles
				canChooseDirectories={false}
				allowMultipleSelection={false}
				storeValue
			/>
			<Form.Checkbox
				id="replaceExisting"
				title="Replace existing"
				label="Delete current Vicinae snippets before importing"
				defaultValue={false}
				storeValue
			/>
		</Form>
	);
}

function ImportSummary({
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
			<List.Section
				title="Imported"
				subtitle={`${imported.length} of ${totalExported} basic snippets`}
			>
				{imported.map((s) => (
					<List.Item
						key={s.id}
						title={s.name}
						subtitle={s.data.text?.slice(0, 80)}
						icon={Icon.CheckCircle}
						accessories={
							s.expansion?.keyword
								? [{ text: `⌥ ${s.expansion.keyword}`, icon: Icon.Keyboard }]
								: []
						}
						actions={
							<ActionPanel>
								<Action.CopyToClipboard
									title="Copy Content"
									content={s.data.text ?? ""}
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

export default function Command() {
	return <ImportForm />;
}
