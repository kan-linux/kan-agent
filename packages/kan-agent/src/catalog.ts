/**
 * Official component catalog loader and URL resolver (HLD §4.6).
 *
 * The catalog is the only authority on official distribution URLs. Resolution is one-way: a caller
 * names a component (and optionally a version), the catalog produces the URL. A caller-supplied URL
 * is never accepted for source_type=binary, so a fabricated download address cannot enter the fetch
 * path. Mirrors and CDN redirectors are not catalog data; `origin` must be "official".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SourceType = "binary" | "source";

/** One catalog entry. `url_pattern` holds `{tarball}`/`{version}` placeholders; `versions` is separate so a bump touches only the list. */
export interface CatalogEntry {
	name: string;
	description: string;
	source_type: SourceType;
	origin: "official";
	tarball_pattern: string;
	url_pattern: string;
	versions: string[];
	default_version: string;
	install_root: string;
	extract_root: string;
	verify_cmd: string;
	config_placement: string[];
	dependencies: string[];
	/** Optional. Absence means integrity rests on the official-source allowlist plus human audit. */
	sha256?: Record<string, string>;
}

interface CatalogFile {
	schema_version: string;
	status: string;
	description: string;
	principles: string[];
	components: CatalogEntry[];
}

/** A URL resolved from the catalog, with the version it was resolved for. */
export interface ResolvedSource {
	name: string;
	version: string;
	tarball: string;
	url: string;
	sha256?: string;
	entry: CatalogEntry;
}

export class CatalogError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function defaultCatalogPath(): string {
	// src/catalog.ts -> packages/kan-agent/config/component-catalog.json. For a Bun binary the
	// catalog ships next to the executable; PI_KAN_CATALOG overrides for both.
	const override = process.env.PI_KAN_CATALOG;
	if (override) return override;
	return join(dirname(fileURLToPath(import.meta.url)), "..", "config", "component-catalog.json");
}

/** The in-memory catalog. */
export class ComponentCatalog {
	private readonly byName: Map<string, CatalogEntry>;

	constructor(entries: CatalogEntry[]) {
		this.byName = new Map();
		for (const entry of entries) {
			if (this.byName.has(entry.name)) {
				throw new CatalogError("duplicate_component", `duplicate catalog component: ${entry.name}`);
			}
			if (entry.origin !== "official") {
				throw new CatalogError("origin_not_official", `${entry.name}: origin must be "official", got ${entry.origin}`);
			}
			this.byName.set(entry.name, entry);
		}
	}

	static load(path: string = defaultCatalogPath()): ComponentCatalog {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (e) {
			throw new CatalogError("catalog_unreadable", `cannot read component catalog at ${path}: ${(e as Error).message}`);
		}
		let file: CatalogFile;
		try {
			file = JSON.parse(raw) as CatalogFile;
		} catch (e) {
			throw new CatalogError("catalog_malformed", `component catalog is not valid JSON: ${(e as Error).message}`);
		}
		if (!Array.isArray(file.components)) {
			throw new CatalogError("catalog_malformed", "component catalog has no components array");
		}
		return new ComponentCatalog(file.components);
	}

	/** Component names in catalog order. */
	names(): string[] {
		return [...this.byName.keys()];
	}

	/** The entry for `name`, or undefined. */
	get(name: string): CatalogEntry | undefined {
		return this.byName.get(name);
	}

	/**
	 * Resolve a component to a fetchable URL. `version` defaults to the entry's default and must be
	 * one of `versions`; nothing outside the catalog is ever resolvable.
	 */
	resolve(name: string, version?: string): ResolvedSource {
		const entry = this.byName.get(name);
		if (!entry) {
			const known = this.names().join(", ") || "(catalog is empty)";
			throw new CatalogError("unknown_component", `component "${name}" is not in the official component catalog. Known: ${known}`);
		}
		const picked = version ?? entry.default_version;
		if (!entry.versions.includes(picked)) {
			throw new CatalogError(
				"unknown_version",
				`${name}: version "${picked}" is not in the catalog. Available: ${entry.versions.join(", ")}`,
			);
		}
		const tarball = entry.tarball_pattern.replaceAll("{version}", picked);
		const url = entry.url_pattern.replaceAll("{version}", picked).replaceAll("{tarball}", tarball);
		const resolved: ResolvedSource = { name: entry.name, version: picked, tarball, url, entry };
		const hash = entry.sha256?.[picked];
		if (hash) resolved.sha256 = hash;
		return resolved;
	}

	/**
	 * Read-only listing of installable components, for sys_inspect's list_catalog action (HLD §4.6:
	 * "sys_inspect 只读暴露可安装组件/版本清单"). One line per component so the model can pick a
	 * name and its source_type without guessing.
	 */
	describe(): string {
		if (this.byName.size === 0) return "(official component catalog is empty)";
		return [...this.byName.values()]
			.map((e) => {
				const hashNote = e.sha256 ? ` sha256=pinned` : ` sha256=none`;
				return `- ${e.name} [source_type=${e.source_type}] ${e.description}\n    versions: ${e.versions.join(", ")} (default ${e.default_version})\n    install_root: ${e.install_root}${hashNote}`;
			})
			.join("\n");
	}
}
