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
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CatalogEntry } from "./catalog.ts";

const run = promisify(execFile);

export type ExtractOutcome =
	| { kind: "ok"; contentDir: string; notes: string[]; version?: string }
	| { kind: "error"; reason: string };

/**
 * Extract `artifact` into `staging` according to the entry's extract spec and fixups. On success
 * `contentDir` holds the tool tree: its contents are what become the store entry. `version` is the
 * package version the artifact itself declares, when its format carries one — a rolling download
 * link resolves to a filename with no version in it, so the store key must come from the payload.
 */
export async function extractArtifact(
	entry: CatalogEntry,
	artifact: string,
	staging: string,
	version: string,
): Promise<ExtractOutcome> {
	const notes: string[] = [];
	try {
		const extracted = await extractByKind(entry, artifact, staging, version, notes);
		const contentDir = extracted.contentDir;
		for (const fixup of entry.fixups ?? []) {
			switch (fixup.kind) {
				case "rust_std_merge":
					rustStdMerge(contentDir, notes);
					break;
				case "setuid":
					// The deb ships chrome-sandbox setuid root and Chrome needs that for its
					// sandbox; assert the bit regardless of what the artifact or a copy step
					// preserved on the way.
					chmodSync(join(contentDir, fixup.path), 0o4755);
					notes.push(`setuid: ${fixup.path}`);
					break;
			}
		}
		return { kind: "ok", contentDir, notes, version: extracted.version };
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
): Promise<{ contentDir: string; version?: string }> {
	const spec = entry.extract;
	switch (spec.kind) {
		case "tar_topdir": {
			await untar(artifact, staging);
			const top = singleChildDir(staging);
			if (!top) throw new Error(`${basename(artifact)}: expected a single top-level directory`);
			return { contentDir: top };
		}
		case "tar_strip": {
			const contentDir = join(staging, "content");
			mkdirSync(contentDir, { recursive: true });
			await untar(artifact, contentDir, ["--strip-components=1"]);
			return { contentDir };
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
			cpSync(subdir, contentDir, { recursive: true, verbatimSymlinks: true });
			return { contentDir };
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
			return { contentDir };
		}
		case "zip_topdir": {
			await assertSafeZipArchive(artifact);
			const work = join(staging, "work");
			mkdirSync(work, { recursive: true });
			try {
				await run("unzip", ["-q", artifact, "-d", work]);
			} catch (e) {
				throw new Error(`could not extract ${artifact}: ${(e as Error).message}`);
			}
			const top = singleChildDir(work);
			if (!top) throw new Error(`${basename(artifact)}: expected a single top-level directory`);
			return { contentDir: top };
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
			cpSync(tree, contentDir, { recursive: true, verbatimSymlinks: true });
			const usr = join(squashfs, spec.usr_dir);
			if (existsSync(usr)) {
				// Keep the AppImage's /usr payload inside the tree so the deploy profile can place
				// it (desktop entries, icons, mime data) without re-reading the artifact.
				cpSync(usr, join(contentDir, spec.usr_dir), { recursive: true, verbatimSymlinks: true });
				notes.push(`${spec.usr_dir}/ payload kept in the tree for deploy-profile placement`);
			}
			return { contentDir };
		}
		case "deb": {
			// A .deb is an ar archive (debian-binary, control.tar.*, data.tar.*); unpack it
			// with ar + tar, the way install-prebuilts.sh handles a .deb payload.
			const work = join(staging, "work");
			mkdirSync(work, { recursive: true });
			try {
				await run("ar", ["x", artifact], { cwd: work });
			} catch (e) {
				throw new Error(`could not unpack ${basename(artifact)}: ${(e as Error).message}`);
			}
			const members = readdirSync(work);
			const dataTar = members.find((n) => n.startsWith("data.tar."));
			if (!dataTar) throw new Error(`${basename(artifact)}: no data.tar.* member`);
			await untar(join(work, dataTar), work);
			const tree = matchGlobDirs(work, spec.tree_glob);
			if (!tree) throw new Error(`${basename(artifact)}: no ${spec.tree_glob} under the extracted tree`);
			const contentDir = join(staging, "content");
			cpSync(tree, contentDir, { recursive: true, verbatimSymlinks: true });
			const usr = join(work, spec.usr_dir);
			if (existsSync(usr)) {
				// Keep the .deb's /usr payload inside the tree so the deploy profile can place
				// it (launcher symlink, desktop entries) without re-reading the artifact.
				cpSync(usr, join(contentDir, spec.usr_dir), { recursive: true, verbatimSymlinks: true });
				notes.push(`${spec.usr_dir}/ payload kept in the tree for deploy-profile placement`);
			}
			// The control metadata declares the real package version; it keys the store entry so
			// successive deploys of a rolling download link keep their own trees.
			const controlTar = members.find((n) => n.startsWith("control.tar."));
			let debVersion: string | undefined;
			if (controlTar) {
				await untar(join(work, controlTar), work);
				debVersion = readDebVersion(join(work, "control"));
			}
			return { contentDir, version: debVersion };
		}
	}
}

/**
 * The `Version:` field of an extracted .deb control file. Artifact bytes are a trust boundary and
 * the version becomes a store path segment, so only a Debian version string is accepted — never a
 * path separator or a parent segment.
 */
function readDebVersion(controlFile: string): string | undefined {
	if (!existsSync(controlFile)) return undefined;
	const match = /^Version: (.+)$/m.exec(readFileSync(controlFile, "utf8"));
	if (!match) return undefined;
	const version = match[1].trim();
	if (!/^\d[A-Za-z0-9.+:~_-]*$/.test(version)) {
		throw new Error(`unsafe version string in deb control metadata: ${version}`);
	}
	return version;
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
	let listing: string;
	try {
		({ stdout: listing } = await run("tar", ["-tf", artifact]));
	} catch {
		throw new Error(`not a readable package archive: ${basename(artifact)}`);
	}
	assertSafeMembers(artifact, listing.split("\n"));
}

/** The same member guard for ZIP packages, via unzip's name listing. */
async function assertSafeZipArchive(artifact: string): Promise<void> {
	let listing: string;
	try {
		({ stdout: listing } = await run("unzip", ["-Z1", artifact]));
	} catch {
		throw new Error(`not a readable package archive: ${basename(artifact)}`);
	}
	assertSafeMembers(artifact, listing.split("\n"));
}

function assertSafeMembers(artifact: string, members: string[]): void {
	for (const member of members) {
		if (!member) continue;
		if (member.startsWith("/") || member.split("/").includes("..")) {
			throw new Error(`unsafe archive member "${member}" in ${basename(artifact)} (absolute or .. path)`);
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
			cpSync(stdLib, sysroot, { recursive: true, verbatimSymlinks: true });
			notes.push(`rust_std_merge: ${entry.name}/lib/rustlib/${triple.name}/lib -> rustc sysroot`);
		}
	}
}
