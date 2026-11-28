/**
 * Deploy-profile engine (HLD §9 absorption: install-prebuilts.sh's `setup_*_config` placement
 * becomes `atomic_deploy`'s deploy profile, driven by the catalog's declarative steps).
 *
 * Two phases, matching where the bytes can live. `in_tree` steps write into the component tree
 * before it is committed to the read-only store, so the config is versioned with the artifact and
 * a rollback that flips the symlink restores it for free. `system` steps write outside the store
 * (/etc, /usr/local/bin, /usr/share) after the flip; each write's pre-image is captured so a
 * rollback can restore it.
 */

import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { CatalogEntry, DeployStep, HookName } from "./catalog.ts";
import { assertSystemWriteAllowed, type KanPaths } from "./root.ts";
import type { ConfigUndoEntry, GenerationStore } from "./store.ts";

const run = promisify(execFile);

/** Result of applying a system deploy profile: what to record for rollback and which hooks ran. */
export interface SystemPlacement {
	configUndo: ConfigUndoEntry[];
	hooks: HookName[];
	notes: string[];
}

/** Write the in-tree half of the profile into the staged component tree (before it is read-only). */
export function applyInTreeProfile(
	entry: CatalogEntry,
	contentDir: string,
	paths: KanPaths,
	vm: boolean,
): { notes: string[] } {
	const notes: string[] = [];
	for (const step of entry.deploy_profile?.in_tree ?? []) {
		switch (step.kind) {
			case "file": {
				const target = join(contentDir, step.path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, step.content + (vm && step.vm_append ? step.vm_append : ""), "utf8");
				notes.push(`in_tree file: ${step.path}`);
				break;
			}
			case "copy_file": {
				const from = rootPath(paths, step.from);
				if (!existsSync(from)) {
					if (step.optional) {
						notes.push(`in_tree copy skipped (not present): ${step.from}`);
						break;
					}
					throw new Error(`deploy profile: required source missing: ${step.from}`);
				}
				const target = join(contentDir, step.to);
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(from, target);
				notes.push(`in_tree copy: ${step.from} -> ${step.to}`);
				break;
			}
			default:
				throw new Error(`deploy profile: in_tree may not contain a "${(step as DeployStep).kind}" step`);
		}
	}
	return { notes };
}

/**
 * Capture the pre-images of every system-config path the profile will write. Runs before the
 * generation record is written so the undo data is durable before any write happens. `sourceRoot`
 * is the committed store path (the flip has not happened yet), which holds the same tree the
 * install root will point at.
 */
export function captureSystemConfig(entry: CatalogEntry, paths: KanPaths, sourceRoot: string): SystemPlacement {
	const steps = entry.deploy_profile?.system ?? [];
	const configUndo: ConfigUndoEntry[] = [];
	const hooks: HookName[] = [];
	const backupRoot = join(paths.stateDir, "/config-undo", entry.name, `${process.pid}-${Date.now()}`);
	let backupIndex = 0;

	const capture = (path: string): void => {
		assertSystemWriteAllowed(paths, path);
		configUndo.push(capturePreImage(paths, backupRoot, backupIndex++, path));
	};

	for (const step of steps) {
		switch (step.kind) {
			case "file":
				capture(rootPath(paths, step.path));
				break;
			case "symlink":
				capture(rootPath(paths, step.to));
				break;
			case "symlink_dir_files": {
				const linkDir = rootPath(paths, step.to);
				for (const item of readdirSync(join(sourceRoot, step.from), { withFileTypes: true })) {
					if (item.isDirectory()) continue;
					capture(join(linkDir, item.name));
				}
				break;
			}
			case "copy_tree": {
				const sourceDir = join(sourceRoot, step.from);
				if (!existsSync(sourceDir)) break;
				const destDir = rootPath(paths, step.to);
				for (const rel of walkRelPaths(sourceDir)) {
					capture(join(destDir, rel));
				}
				break;
			}
			case "delete_matching": {
				const dir = rootPath(paths, step.dir);
				for (const file of matchFiles(dir, step.patterns)) {
					capture(file);
				}
				break;
			}
			case "hook":
				hooks.push(step.hook);
				break;
			default:
				throw new Error(`deploy profile: system may not contain a "${(step as DeployStep).kind}" step`);
		}
	}
	return { configUndo, hooks, notes: [] };
}

/** Write the system half of the profile outside the store, after the symlink flip. */
export function writeSystemConfig(entry: CatalogEntry, paths: KanPaths, installRoot: string, vm: boolean): string[] {
	const notes: string[] = [];
	for (const step of entry.deploy_profile?.system ?? []) {
		switch (step.kind) {
			case "file": {
				const target = rootPath(paths, step.path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, step.content + (vm && step.vm_append ? step.vm_append : ""), "utf8");
				notes.push(`system file: ${step.path}`);
				break;
			}
			case "symlink": {
				const link = rootPath(paths, step.to);
				mkdirSync(dirname(link), { recursive: true });
				rmSync(link, { force: true });
				symlinkSync(join(installRoot, step.from), link);
				notes.push(`system symlink: ${step.to} -> ${step.from}`);
				break;
			}
			case "symlink_dir_files": {
				const sourceDir = join(installRoot, step.from);
				const linkDir = rootPath(paths, step.to);
				mkdirSync(linkDir, { recursive: true });
				for (const item of readdirSync(sourceDir, { withFileTypes: true })) {
					if (item.isDirectory()) continue;
					const link = join(linkDir, item.name);
					rmSync(link, { force: true });
					symlinkSync(join(sourceDir, item.name), link);
					notes.push(`system symlink: ${step.to}/${item.name} -> ${step.from}/${item.name}`);
				}
				break;
			}
			case "copy_tree": {
				const sourceDir = join(installRoot, step.from);
				if (!existsSync(sourceDir)) {
					notes.push(`system copy_tree skipped (not present): ${step.from}`);
					break;
				}
				const destDir = rootPath(paths, step.to);
				copyPlacedTree(sourceDir, destDir);
				notes.push(`system copy_tree: ${step.from} -> ${step.to}`);
				break;
			}
			case "delete_matching": {
				const dir = rootPath(paths, step.dir);
				for (const file of matchFiles(dir, step.patterns)) {
					rmSync(file, { force: true });
					notes.push(`system delete: ${file}`);
				}
				break;
			}
			case "hook":
				notes.push(`hook: ${step.hook}`);
				break;
			default:
				throw new Error(`deploy profile: system may not contain a "${(step as DeployStep).kind}" step`);
		}
	}
	return notes;
}

/**
 * Restore the system config to what it held after generation `afterGeneration`, undoing every
 * write made by generations up to `throughGeneration` (HLD §4.6: generation hosts the declarative
 * config snapshot; rollback restores it). Each path is restored from the pre-image of the first
 * generation after `afterGeneration` that wrote it — that pre-image is exactly the wanted state.
 * Returns the hooks whose indexes changed and should be re-run.
 */
export function restoreConfigState(
	paths: KanPaths,
	generations: GenerationStore,
	component: string,
	afterGeneration: number,
	throughGeneration: number,
): HookName[] {
	const records = generations
		.list(component)
		.filter((r) => r.generation > afterGeneration && r.generation <= throughGeneration);
	const firstWrite = new Map<string, ConfigUndoEntry>();
	const hooks = new Set<HookName>();
	for (const record of records) {
		for (const hook of record.hooks ?? []) hooks.add(hook);
		for (const undo of record.config_undo ?? []) {
			if (!firstWrite.has(undo.path)) firstWrite.set(undo.path, undo);
		}
	}
	for (const undo of firstWrite.values()) {
		restorePreImage(paths, undo);
	}
	return [...hooks];
}

/** Refresh the system indexes a deploy profile asked for. Only meaningful on a live root. */
export async function runHooks(hooks: HookName[], paths: KanPaths): Promise<string[]> {
	const outcomes: string[] = [];
	for (const hook of hooks) {
		if (paths.root !== "") {
			outcomes.push(`${hook}: skipped (not a live root)`);
			continue;
		}
		outcomes.push(await runHook(hook, paths));
	}
	return outcomes;
}

/** Detect a VM guest (install-prebuilts.sh's detect_vm): VM-only prefs must not hit bare metal. */
export function detectVm(): boolean {
	try {
		const virt = execFileSync("systemd-detect-virt", ["--vm"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (virt && virt !== "none") return true;
	} catch {
		// no systemd-detect-virt; fall through to DMI and cpuinfo probes
	}
	try {
		const dmi = ["/sys/class/dmi/id/product_name", "/sys/class/dmi/id/sys_vendor", "/sys/class/dmi/id/board_vendor"]
			.map((p) => {
				try {
					return readFileSync(p, "utf8");
				} catch {
					return "";
				}
			})
			.join("");
		if (
			/QEMU|KVM|Standard PC|VirtualBox|VMware|Virtual Machine|Hyper-V|Microsoft Corporation|Xen|Bochs|Parallels/.test(
				dmi,
			)
		) {
			return true;
		}
		const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
		return /^flags.*\shypervisor/m.test(cpuinfo);
	} catch {
		return false;
	}
}

async function runHook(hook: HookName, paths: KanPaths): Promise<string> {
	try {
		switch (hook) {
			case "ldconfig":
				await run("ldconfig", [], { timeout: 60_000 });
				return "ldconfig: ok";
			case "update_desktop_database":
				await run("update-desktop-database", [join(paths.root, "/usr/share/applications")], { timeout: 60_000 });
				return "update-desktop-database: ok";
			case "update_mime_database":
				await run("update-mime-database", [join(paths.root, "/usr/share/mime")], { timeout: 60_000 });
				return "update-mime-database: ok";
		}
	} catch (e) {
		// install-prebuilts.sh treats missing/broken index tools as non-fatal.
		return `${hook}: ${(e as Error).message} (ignored)`;
	}
}

/** Root-absolute step paths are relative to the target root; install-relative ones are not. */
function rootPath(paths: KanPaths, path: string): string {
	return path.startsWith("/") ? join(paths.root, path) : path;
}

/**
 * Place a store tree into the live system the way a package install does: directories merge into
 * their destination (it may hold entries this payload does not own), files and links replace any
 * stale entry an earlier deploy left there, and symlinks are copied verbatim — a relative link
 * must stay relative or it points into the throw-away staging tree and dangles the moment that
 * tree goes away. Every placed file is owner-writable again: the store is read-only by
 * construction and those modes must not leak into a live copy (read, execute and setuid bits
 * survive).
 */
function copyPlacedTree(sourceDir: string, destDir: string): void {
	mkdirSync(destDir, { recursive: true });
	for (const item of readdirSync(sourceDir, { withFileTypes: true })) {
		const source = join(sourceDir, item.name);
		const dest = join(destDir, item.name);
		if (item.isDirectory()) {
			copyPlacedTree(source, dest);
			continue;
		}
		rmSync(dest, { force: true });
		if (item.isSymbolicLink()) {
			symlinkSync(readlinkSync(source), dest);
			continue;
		}
		copyFileSync(source, dest);
		chmodSync(dest, statSync(source).mode | 0o200);
	}
}

/** The pre-image of `path`, captured as an undo entry with a backup file under the state dir. */
function capturePreImage(paths: KanPaths, backupRoot: string, index: number, path: string): ConfigUndoEntry {
	if (!existsSync(path) && !isSymlink(path)) {
		return { path, previous: { kind: "absent" } };
	}
	const st = lstatSync(path);
	if (st.isSymbolicLink()) {
		return { path, previous: { kind: "symlink", target: readlinkSync(path) } };
	}
	if (!st.isFile()) {
		throw new Error(`deploy profile: refusing to overwrite non-file config path: ${path}`);
	}
	const backup = join(backupRoot, `${index}.bak`);
	mkdirSync(backupRoot, { recursive: true });
	copyFileSync(path, backup);
	return { path, previous: { kind: "file", backup: relative(paths.stateDir, backup) } };
}

function restorePreImage(paths: KanPaths, undo: ConfigUndoEntry): void {
	assertSystemWriteAllowed(paths, undo.path);
	const previous = undo.previous;
	switch (previous.kind) {
		case "absent":
			rmSync(undo.path, { force: true });
			return;
		case "symlink":
			mkdirSync(dirname(undo.path), { recursive: true });
			rmSync(undo.path, { force: true });
			symlinkSync(previous.target, undo.path);
			return;
		case "file": {
			const backup = join(paths.stateDir, previous.backup);
			mkdirSync(dirname(undo.path), { recursive: true });
			rmSync(undo.path, { force: true });
			copyFileSync(backup, undo.path);
			return;
		}
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** All file and symlink paths under `dir`, relative to it. */
function walkRelPaths(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string, prefix: string): void => {
		for (const item of readdirSync(current, { withFileTypes: true })) {
			const rel = prefix ? join(prefix, item.name) : item.name;
			if (item.isDirectory()) {
				walk(join(current, item.name), rel);
			} else {
				out.push(rel);
			}
		}
	};
	walk(dir, "");
	return out;
}

/** Files in `dir` matching any of the shell-glob `patterns` (`*` wildcards only). */
function matchFiles(dir: string, patterns: string[]): string[] {
	if (!existsSync(dir)) return [];
	const regexes = patterns.map((p) => new RegExp(`^${p.split("*").map(escapeRegex).join(".*")}$`));
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() || e.isSymbolicLink())
		.filter((e) => regexes.some((re) => re.test(e.name)))
		.map((e) => join(dir, e.name));
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
