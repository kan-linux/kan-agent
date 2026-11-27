/**
 * Official component catalog loader and URL resolver (HLD §4.6).
 *
 * The catalog is the only authority on official distribution URLs. Resolution is one-way: a caller
 * names a component (and optionally a version), the catalog produces the URL. A caller-supplied URL
 * is never accepted for source_type=binary, so a fabricated download address cannot enter the fetch
 * path. Mirrors and CDN redirectors are not catalog data; `origin` must be "official".
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SourceType = "binary" | "source";

/** Whether the component ships with the image (updated in place) or is installed on demand. */
export type ImageClass = "in-image" | "optional";

/**
 * How a fetched artifact becomes an installable tree (the per-component layouts of
 * install-prebuilts.sh's `install_*` functions).
 */
export type ExtractSpec =
	/** The tarball has a single top-level directory; its contents become the tree (go, firefox). */
	| { kind: "tar_topdir" }
	/** Extract with --strip-components=N into the tree (jdk, node, rust). */
	| { kind: "tar_strip"; strip: number }
	/** Extract fully, then move one directory's contents into the tree (vulkan's `<ver>/x86_64/`). */
	| { kind: "tar_subdir"; subdir: string }
	/** The tarball root holds a single file, placed at `target` inside the tree (mimocode). */
	| { kind: "tar_single_file"; target: string }
	/** An AppImage: `--appimage-extract`, the `tree_glob` directory's contents become the tree,
	 *  and `usr_dir` is preserved inside the tree so deploy profiles can place it. */
	| { kind: "appimage"; tree_glob: string; usr_dir: string };

/** Post-extract fixups (closed set; names the layout corrections the script performs inline). */
export type FixupSpec =
	/** rust-std's lib/rustlib tree must be merged into rustc's sysroot or rustc cannot find std. */
	{ kind: "rust_std_merge" };

/** Runtime variant selection for a URL placeholder (mimocode picks its build by CPU flag). */
export interface TargetProbe {
	kind: "cpu_flag";
	flag: string;
	if_present: string;
	if_absent: string;
}

/**
 * One declarative placement step, executed by atomic_deploy's deploy-profile engine. Paths
 * starting with "/" are root-joined (the real filesystem, or the staging root under test); bare
 * paths are relative to the component's install tree.
 */
export type DeployStep =
	/** Write a file. `vm_append` is appended when the host is a VM. */
	| { kind: "file"; path: string; content: string; vm_append?: string }
	/** Copy a host file into the install tree (e.g. Widevine CDM); `optional` tolerates absence. */
	| { kind: "copy_file"; from: string; to: string; optional?: boolean }
	/** Symlink a root-absolute path at `to` to the install-tree path `from`. */
	| { kind: "symlink"; from: string; to: string }
	/** Symlink every entry of install-tree dir `from` into root-absolute dir `to` (JDK/Node bin). */
	| { kind: "symlink_dir_files"; from: string; to: string }
	/** Copy the contents of install-tree dir `from` into root-absolute dir `to` (LibreOffice /usr). */
	| { kind: "copy_tree"; from: string; to: string }
	/** Delete files in root-absolute `dir` matching any of the glob `patterns` (LibreOffice's broken menu entries). */
	| { kind: "delete_matching"; dir: string; patterns: string[] }
	/** Refresh a system index after placement. Only runs on a live root. */
	| { kind: "hook"; hook: HookName };

export type HookName = "ldconfig" | "update_desktop_database" | "update_mime_database";

/**
 * The `setup_*_config` half of the install scripts, as data (HLD §9 absorption: config placement
 * is catalog data, executed by atomic_deploy). `in_tree` steps land inside the component tree
 * before it is committed to the read-only store; `system` steps land in the root filesystem after
 * the symlink flip and are snapshotted for rollback.
 */
export interface DeployProfile {
	in_tree: DeployStep[];
	system: DeployStep[];
}

/** One catalog entry. `url_pattern` holds `{tarball}`/`{version}` placeholders; `versions` is separate so a bump touches only the list. */
export interface CatalogEntry {
	name: string;
	description: string;
	source_type: SourceType;
	origin: "official";
	/** In-image components ship with the OS and are updated in place; optional ones are installed on demand. */
	image_class: ImageClass;
	tarball_pattern: string;
	url_pattern: string;
	versions: string[];
	default_version: string;
	install_root: string;
	extract_root: string;
	extract: ExtractSpec;
	/** Layout fixups applied after extraction. */
	fixups?: FixupSpec[];
	/** Accepted input prefixes stripped before version matching ("go", "rust-", "v", ...). */
	version_prefixes?: string[];
	/** Fills `{target}` in the tarball/url patterns at resolve time. */
	target_probe?: TargetProbe;
	/** Health check: the first token is a path inside the install root ("bin/go") or a bare
	 *  binary name resolved in `bin/` then at the tree root ("firefox", "go"). */
	verify_cmd?: string;
	/** Install-root-relative paths that must exist after deploy (when there is no runnable check). */
	verify_exists?: string[];
	/** Human/model-readable summary of where config lands (sys_inspect, audit). */
	config_placement: string[];
	/** The declarative setup_*_config steps executed by atomic_deploy. */
	deploy_profile?: DeployProfile;
	dependencies: string[];
	/** Optional. Absence means integrity rests on the official-source allowlist plus human audit. */
	sha256?: Record<string, string>;
}

/** Options the catalog file carries besides the component list. */
export interface CatalogOptions {
	/** Free-space preflight on the install filesystem, in MiB (install-prebuilts.sh: ~10G). */
	free_space_preflight_mb: number;
}

const DEFAULT_FREE_SPACE_PREFLIGHT_MB = 10240;

interface CatalogFile {
	schema_version: string;
	status: string;
	description: string;
	principles: string[];
	free_space_preflight_mb?: number;
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

function defaultCatalogPath(): string | undefined {
	// The catalog is data, not code: it ships as a file so it can be updated without recompiling
	// (which is the direction of the design's runtime-queryable data file). Candidates cover each
	// run shape — a Bun binary has no real filesystem at import.meta.url (it is /$bunfs/...), so
	// the compiled form resolves the file shipped next to the executable by copy-binary-assets.
	const candidates = [
		process.env.PI_KAN_CATALOG,
		join(dirname(process.execPath), "config", "component-catalog.json"),
		join(dirname(fileURLToPath(import.meta.url)), "..", "config", "component-catalog.json"),
	].filter((p): p is string => p !== undefined);
	return candidates.find((p) => existsSync(p));
}

/** The in-memory catalog. */
export class ComponentCatalog {
	private readonly byName: Map<string, CatalogEntry>;
	readonly freeSpacePreflightMb: number;

	constructor(entries: CatalogEntry[], options?: Partial<CatalogOptions>) {
		this.byName = new Map();
		this.freeSpacePreflightMb = options?.free_space_preflight_mb ?? DEFAULT_FREE_SPACE_PREFLIGHT_MB;
		for (const entry of entries) {
			if (this.byName.has(entry.name)) {
				throw new CatalogError("duplicate_component", `duplicate catalog component: ${entry.name}`);
			}
			if (entry.origin !== "official") {
				throw new CatalogError(
					"origin_not_official",
					`${entry.name}: origin must be "official", got ${entry.origin}`,
				);
			}
			validateDeployProfile(entry);
			this.byName.set(entry.name, entry);
		}
	}

	static load(path: string | undefined = defaultCatalogPath()): ComponentCatalog {
		if (path === undefined) {
			throw new CatalogError(
				"catalog_unreadable",
				"component catalog not found. Set PI_KAN_CATALOG to its path, or ship config/component-catalog.json next to the executable.",
			);
		}
		let file: CatalogFile;
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (e) {
			throw new CatalogError(
				"catalog_unreadable",
				`cannot read component catalog at ${path}: ${(e as Error).message}`,
			);
		}
		try {
			file = JSON.parse(raw) as CatalogFile;
		} catch (e) {
			throw new CatalogError("catalog_malformed", `component catalog is not valid JSON: ${(e as Error).message}`);
		}
		if (!Array.isArray(file.components)) {
			throw new CatalogError("catalog_malformed", "component catalog has no components array");
		}
		return new ComponentCatalog(file.components, {
			free_space_preflight_mb: file.free_space_preflight_mb ?? DEFAULT_FREE_SPACE_PREFLIGHT_MB,
		});
	}

	/** Component names in catalog order. */
	names(): string[] {
		return [...this.byName.keys()];
	}

	/** All entries in catalog order. */
	entries(): CatalogEntry[] {
		return [...this.byName.values()];
	}

	/** The entry for `name`, or undefined. */
	get(name: string): CatalogEntry | undefined {
		return this.byName.get(name);
	}

	/**
	 * Resolve a component to a fetchable URL. `version` defaults to the entry's default and must be
	 * one of `versions`; nothing outside the catalog is ever resolvable. Accepted input forms like
	 * "go1.27.4" or "v0.1.17" are normalized via the entry's `version_prefixes`.
	 */
	resolve(name: string, version?: string): ResolvedSource {
		const entry = this.byName.get(name);
		if (!entry) {
			const known = this.names().join(", ") || "(catalog is empty)";
			throw new CatalogError(
				"unknown_component",
				`component "${name}" is not in the official component catalog. Known: ${known}`,
			);
		}
		const picked = normalizeVersion(entry, version ?? entry.default_version);
		if (!entry.versions.includes(picked)) {
			throw new CatalogError(
				"unknown_version",
				`${name}: version "${picked}" is not in the catalog. Available: ${entry.versions.join(", ")}`,
			);
		}
		const target = resolveTarget(entry);
		const tarball = entry.tarball_pattern.replaceAll("{version}", picked).replaceAll("{target}", target);
		const url = entry.url_pattern
			.replaceAll("{version}", picked)
			.replaceAll("{target}", target)
			.replaceAll("{tarball}", tarball);
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
				return `- ${e.name} [source_type=${e.source_type}] [image_class=${e.image_class}] ${e.description}\n    versions: ${e.versions.join(", ")} (default ${e.default_version})\n    install_root: ${e.install_root}${hashNote}`;
			})
			.join("\n");
	}
}

/** Strip the entry's accepted version prefixes ("go1.27.4" -> "1.27.4", "v0.1.17" -> "0.1.17"). */
function normalizeVersion(entry: CatalogEntry, version: string): string {
	let picked = version;
	for (;;) {
		const prefix = entry.version_prefixes?.find((p) => picked.startsWith(p));
		if (prefix === undefined) return picked;
		picked = picked.slice(prefix.length);
	}
}

/** Fill `{target}` from the entry's probe (mimocode selects its build by CPU flag). */
function resolveTarget(entry: CatalogEntry): string {
	const probe = entry.target_probe;
	if (!probe) return "";
	return cpuHasFlag(probe.flag) ? probe.if_present : probe.if_absent;
}

function cpuHasFlag(flag: string): boolean {
	try {
		const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
		return new RegExp(`^flags.*\\b${flag}\\b`, "m").test(cpuinfo);
	} catch {
		return false;
	}
}

const IN_TREE_STEP_KINDS = ["file", "copy_file"] as const;

/**
 * Structural check of a deploy profile: each section may only use its own step kinds, and paths
 * must follow the root-absolute / install-relative convention so the engine can route them.
 */
function validateDeployProfile(entry: CatalogEntry): void {
	const profile = entry.deploy_profile;
	if (!profile) return;
	for (const step of profile.in_tree) {
		if (!(IN_TREE_STEP_KINDS as readonly string[]).includes(step.kind)) {
			throw new CatalogError(
				"bad_deploy_profile",
				`${entry.name}: deploy_profile.in_tree may not contain a "${step.kind}" step`,
			);
		}
	}
	for (const step of profile.system) {
		const offending = systemStepOffender(step);
		if (offending !== undefined) {
			throw new CatalogError(
				"bad_deploy_profile",
				`${entry.name}: deploy_profile.system step "${step.kind}" must use a root-absolute path, got ${offending}`,
			);
		}
		// Deletion is bounded tighter than write placement: only menu entries under
		// /usr/share/applications are ever pruned (LibreOffice's broken .desktop files).
		if (step.kind === "delete_matching" && !step.dir.startsWith("/usr/share/")) {
			throw new CatalogError(
				"bad_deploy_profile",
				`${entry.name}: delete_matching is bounded to /usr/share/ (got ${step.dir})`,
			);
		}
	}
}

/** The offending path of a system step whose target is not root-absolute, if any. */
function systemStepOffender(step: DeployStep): string | undefined {
	switch (step.kind) {
		case "file":
			return step.path.startsWith("/") ? undefined : step.path;
		case "delete_matching":
			return step.dir.startsWith("/") ? undefined : step.dir;
		case "symlink":
		case "symlink_dir_files":
		case "copy_tree":
			return step.to.startsWith("/") ? undefined : step.to;
		case "copy_file":
		case "hook":
			return undefined;
	}
}
