/**
 * Artifact extraction for the binary install pipeline (HLD §9 absorption: the per-component
 * extract layouts of install-prebuilts.sh's `install_*` functions become one engine driven by the
 * catalog's `extract` spec).
 *
 * Each component's tarball has a different shape: go/firefox wrap one top directory, jdk/node/rust
 * wrap a versioned directory that gets stripped, vulkan nests its tree under `<ver>/x86_64`,
 * mimocode ships a single binary, libreoffice is an AppImage. The engine normalizes all of them to
 * the same output: a content directory whose root is the tool tree, ready for the store.
 */

import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CatalogEntry } from "./catalog.ts";

const run = promisify(execFile);

export type ExtractOutcome = { kind: "ok"; contentDir: string; notes: string[] } | { kind: "error"; reason: string };

/**
 * Extract `artifact` into `staging` according to the entry's extract spec and fixups. On success
 * `contentDir` holds the tool tree: its contents are what become the store entry.
 */
export async function extractArtifact(
	entry: CatalogEntry,
	artifact: string,
	staging: string,
	version: string,
): Promise<ExtractOutcome> {
	const notes: string[] = [];
	try {
		const contentDir = await extractByKind(entry, artifact, staging, version, notes);
		for (const fixup of entry.fixups ?? []) {
			if (fixup.kind === "rust_std_merge") rustStdMerge(contentDir, notes);
		}
		return { kind: "ok", contentDir, notes };
	} catch (e) {
		return { kind: "error", reason: (e as Error).message };
	}
}

async function extractByKind(
	entry: CatalogEntry,
	artifact: string,
	staging: string,
	version: string,
	notes: string[],
): Promise<string> {
	const spec = entry.extract;
	switch (spec.kind) {
		case "tar_topdir": {
			await untar(artifact, staging);
			const top = singleChildDir(staging);
			if (!top) throw new Error(`${basename(artifact)}: expected a single top-level directory`);
			return top;
		}
		case "tar_strip": {
			const contentDir = join(staging, "content");
			mkdirSync(contentDir, { recursive: true });
			await untar(artifact, contentDir, ["--strip-components=1"]);
			return contentDir;
		}
		case "tar_subdir": {
			const work = join(staging, "work");
			mkdirSync(work, { recursive: true });
			await untar(artifact, work);
			const subdir = findSubdir(work, spec.subdir.replaceAll("{version}", version), notes);
			if (!subdir) {
				throw new Error(`${basename(artifact)}: layout unexpected, no ${spec.subdir} under the extracted tree`);
			}
			const contentDir = join(staging, "content");
			cpSync(subdir, contentDir, { recursive: true });
			return contentDir;
		}
		case "tar_single_file": {
			const work = join(staging, "work");
			mkdirSync(work, { recursive: true });
			await untar(artifact, work);
			const file = singleChildFile(work);
			if (!file) throw new Error(`${basename(artifact)}: expected a single file at the tarball root`);
			const contentDir = join(staging, "content");
			const target = join(contentDir, spec.target);
			mkdirSync(dirname(target), { recursive: true });
			renameSync(file, target);
			return contentDir;
		}
		case "appimage": {
			const work = join(staging, "work");
			mkdirSync(work, { recursive: true });
			// The AppImage runtime unpacks itself with --appimage-extract; no FUSE needed.
			const local = join(work, basename(artifact));
			cpSync(artifact, local);
			chmodSync(local, 0o755);
			await run(local, ["--appimage-extract"], { cwd: work, timeout: 300_000 });
			const squashfs = join(work, "squashfs-root");
			if (!existsSync(squashfs))
				throw new Error(`${basename(artifact)}: --appimage-extract produced no squashfs-root`);
			const tree = matchGlobDirs(squashfs, spec.tree_glob);
			if (!tree) throw new Error(`${basename(artifact)}: no ${spec.tree_glob} under squashfs-root`);
			const contentDir = join(staging, "content");
			cpSync(tree, contentDir, { recursive: true });
			const usr = join(squashfs, spec.usr_dir);
			if (existsSync(usr)) {
				// Keep the AppImage's /usr payload inside the tree so the deploy profile can place
				// it (desktop entries, icons, mime data) without re-reading the artifact.
				cpSync(usr, join(contentDir, spec.usr_dir), { recursive: true });
				notes.push(`${spec.usr_dir}/ payload kept in the tree for deploy-profile placement`);
			}
			return contentDir;
		}
	}
}

async function untar(artifact: string, dest: string, extra: string[] = []): Promise<void> {
	mkdirSync(dest, { recursive: true });
	try {
		await assertSafeArchive(artifact);
		await run("tar", ["-xf", artifact, "-C", dest, ...extra]);
	} catch (e) {
		throw new Error(`could not extract ${artifact}: ${(e as Error).message}`);
	}
}

/**
 * Refuse archives with absolute or parent-escaping members (path traversal). The pipeline runs as
 * root on a live system, so a crafted tarball must never write outside the staging directory:
 * this is the last line of defense behind the official-source allowlist and install_audit.
 */
async function assertSafeArchive(artifact: string): Promise<void> {
	const { stdout } = await run("tar", ["-tf", artifact]);
	for (const member of stdout.split("\n")) {
		if (!member) continue;
		if (member.startsWith("/") || member.split("/").includes("..")) {
			throw new Error(`unsafe archive member "${member}" (absolute or .. path)`);
		}
	}
}

/** The single directory inside `dir`, if there is exactly one and it is a directory. */
function singleChildDir(dir: string): string | undefined {
	const entries = readdirSync(dir, { withFileTypes: true });
	if (entries.length !== 1) return undefined;
	const only = entries[0];
	if (!only.isDirectory()) return undefined;
	return join(dir, only.name);
}

/** The single regular file inside `dir`, if there is exactly one. */
function singleChildFile(dir: string): string | undefined {
	const entries = readdirSync(dir, { withFileTypes: true });
	if (entries.length !== 1) return undefined;
	const only = entries[0];
	if (!only.isFile()) return undefined;
	return join(dir, only.name);
}

/**
 * Resolve a tar_subdir pattern inside the extracted work dir. The primary form is `<ver>/x86_64`;
 * install-prebuilts.sh also accepts a build that ships a bare `x86_64`/`amd64` dir, so fall back to
 * a shallow search for one.
 */
function findSubdir(work: string, pattern: string, notes: string[]): string | undefined {
	const primary = join(work, pattern);
	if (existsSync(primary) && statSync(primary).isDirectory()) return primary;
	for (const entry of readdirSync(work, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		for (const arch of readdirSync(join(work, entry.name), { withFileTypes: true })) {
			if (arch.isDirectory() && (arch.name === "x86_64" || arch.name === "amd64")) {
				notes.push(`extract: ${pattern} not found, using ${entry.name}/${arch.name}`);
				return join(work, entry.name, arch.name);
			}
		}
	}
	return undefined;
}

/**
 * The first directory under `base` matching a path pattern with `*` wildcards per segment
 * (e.g. `opt/libreoffice*` — install-prebuilts.sh's squashfs-root lookup).
 */
function matchGlobDirs(base: string, pattern: string): string | undefined {
	let current = base;
	for (const segment of pattern.split("/")) {
		const re = new RegExp(`^${segment.split("*").map(escapeRegex).join(".*")}$`);
		const hit = readdirSync(current, { withFileTypes: true })
			.filter((e) => e.isDirectory() && re.test(e.name))
			.map((e) => e.name)
			.sort()[0];
		if (hit === undefined) return undefined;
		current = join(current, hit);
	}
	return current;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Merge rust-std's lib/rustlib tree into rustc's sysroot (install-prebuilts.sh does this inline).
 * Without it rustc fails with E0463: it only looks in its own sysroot for `std`.
 */
function rustStdMerge(contentDir: string, notes: string[]): void {
	for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("rust-std-")) continue;
		const rustlib = join(contentDir, entry.name, "lib", "rustlib");
		if (!existsSync(rustlib)) continue;
		for (const triple of readdirSync(rustlib, { withFileTypes: true })) {
			if (!triple.isDirectory()) continue;
			const stdLib = join(rustlib, triple.name, "lib");
			if (!existsSync(stdLib)) continue;
			const sysroot = join(contentDir, "rustc", "lib", "rustlib", triple.name, "lib");
			if (existsSync(sysroot)) continue;
			mkdirSync(dirname(sysroot), { recursive: true });
			cpSync(stdLib, sysroot, { recursive: true });
			notes.push(`rust_std_merge: ${entry.name}/lib/rustlib/${triple.name}/lib -> rustc sysroot`);
		}
	}
}
