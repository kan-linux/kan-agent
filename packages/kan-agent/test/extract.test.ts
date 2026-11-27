/**
 * The extract engine (HLD §9 absorption: install-prebuilts.sh's per-component extract layouts).
 *
 * Each catalog extract kind has a different tarball shape; the engine must normalize all of them
 * to a content directory whose root is the tool tree. The fixtures are synthetic tarballs because
 * the bugs that matter here are layout bugs (a wrapper dir not stripped, rust-std not merged), not
 * upstream content bugs.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogEntry, ExtractSpec } from "../src/catalog.ts";
import { extractArtifact } from "../src/extract.ts";
import { makeStagingRoot, removeStagingRoot } from "./fixture.ts";

const base = join(import.meta.dirname, ".tmp");

function entryWith(extract: ExtractSpec, fixups?: CatalogEntry["fixups"]): CatalogEntry {
	return {
		name: "x",
		description: "x",
		source_type: "binary",
		origin: "official",
		image_class: "optional",
		tarball_pattern: "x-{version}.tar.gz",
		url_pattern: "https://example.com/{tarball}",
		versions: ["1.0"],
		default_version: "1.0",
		install_root: "/opt/x",
		extract_root: "/opt",
		extract,
		fixups,
		config_placement: [],
		dependencies: [],
	};
}

/** Build a tarball from a map of relative path -> content (or "dir" for an empty directory). */
function makeTarball(name: string, files: Record<string, string>): string {
	const staging = join(base, `${name}-tree`);
	rmSync(staging, { recursive: true, force: true });
	const tops = new Set<string>();
	for (const [rel, content] of Object.entries(files)) {
		tops.add(rel.split("/")[0]);
		const path = join(staging, rel);
		if (content === "dir") {
			mkdirSync(path, { recursive: true });
		} else {
			mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
			writeFileSync(path, content, "utf8");
		}
	}
	const tarball = join(base, name);
	rmSync(tarball, { force: true });
	// Explicit top-level names, not ".": a "./" entry prefix would eat one --strip-components.
	execFileSync("tar", ["-czf", tarball, "-C", staging, ...tops], { stdio: "pipe" });
	rmSync(staging, { recursive: true, force: true });
	return tarball;
}

describe("extractArtifact", () => {
	it("tar_topdir: the single top directory becomes the tree", async () => {
		const artifact = makeTarball("topdir.tar.gz", { "go/bin/go": "binary", "go/VERSION": "1.0" });
		const staging = makeStagingRoot(base, "extract-topdir");
		const result = await extractArtifact(entryWith({ kind: "tar_topdir" }), artifact, staging, "1.0");
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(readdirSync(result.contentDir).sort()).toEqual(["VERSION", "bin"]);
		removeStagingRoot(staging);
	});

	it("tar_strip: the wrapper directory is stripped", async () => {
		const artifact = makeTarball("strip.tar.gz", { "jdk-1.0/bin/java": "binary", "jdk-1.0/lib/": "dir" });
		const staging = makeStagingRoot(base, "extract-strip");
		const result = await extractArtifact(entryWith({ kind: "tar_strip", strip: 1 }), artifact, staging, "1.0");
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(readdirSync(result.contentDir).sort()).toEqual(["bin", "lib"]);
		expect(existsSync(join(result.contentDir, "bin", "java"))).toBe(true);
		removeStagingRoot(staging);
	});

	it("tar_subdir: only the arch subdirectory's contents become the tree", async () => {
		const artifact = makeTarball("subdir.tar.gz", {
			"1.0/x86_64/bin/vulkaninfo": "binary",
			"1.0/x86_64/include/vulkan.h": "header",
			"1.0/README": "readme",
		});
		const staging = makeStagingRoot(base, "extract-subdir");
		const result = await extractArtifact(
			entryWith({ kind: "tar_subdir", subdir: "{version}/x86_64" }),
			artifact,
			staging,
			"1.0",
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(readdirSync(result.contentDir).sort()).toEqual(["bin", "include"]);
		expect(existsSync(join(result.contentDir, "README"))).toBe(false);
		removeStagingRoot(staging);
	});

	it("tar_subdir: falls back to any wrapper's arch dir (install-prebuilts.sh tolerance)", async () => {
		const artifact = makeTarball("subdir-fb.tar.gz", {
			"vulkansdk-x86_64-1.0/x86_64/bin/vulkaninfo": "binary",
		});
		const staging = makeStagingRoot(base, "extract-subdir-fb");
		const result = await extractArtifact(
			entryWith({ kind: "tar_subdir", subdir: "{version}/x86_64" }),
			artifact,
			staging,
			"1.0",
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(existsSync(join(result.contentDir, "bin", "vulkaninfo"))).toBe(true);
		expect(result.notes.join(" ")).toContain("using vulkansdk-x86_64-1.0/x86_64");
		removeStagingRoot(staging);
	});

	it("tar_single_file: the lone file lands at the target path", async () => {
		const artifact = makeTarball("single.tar.gz", { mimo: "binary" });
		const staging = makeStagingRoot(base, "extract-single");
		const result = await extractArtifact(
			entryWith({ kind: "tar_single_file", target: "bin/mimo" }),
			artifact,
			staging,
			"1.0",
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(existsSync(join(result.contentDir, "bin", "mimo"))).toBe(true);
		removeStagingRoot(staging);
	});

	it("appimage: the tree glob contents become the tree, the usr payload is kept", async () => {
		const staging = makeStagingRoot(base, "extract-appimage");
		// A stand-in AppImage: the engine runs `<artifact> --appimage-extract`, and this script
		// produces the squashfs-root layout a real AppImage would.
		const artifact = join(staging, "LibreOffice-1.0.basic-x86_64.AppImage");
		writeFileSync(
			artifact,
			[
				"#!/bin/sh",
				"mkdir -p squashfs-root/opt/libreoffice1.0/program squashfs-root/usr/share/applications",
				"echo soffice > squashfs-root/opt/libreoffice1.0/program/soffice",
				"echo desktop > squashfs-root/usr/share/applications/libreoffice-writer.desktop",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(artifact, 0o755);
		const result = await extractArtifact(
			entryWith({ kind: "appimage", tree_glob: "opt/libreoffice*", usr_dir: "usr" }),
			artifact,
			staging,
			"1.0",
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(existsSync(join(result.contentDir, "program", "soffice"))).toBe(true);
		expect(existsSync(join(result.contentDir, "usr", "share", "applications", "libreoffice-writer.desktop"))).toBe(
			true,
		);
		removeStagingRoot(staging);
	});

	it("rust_std_merge: rust-std is merged into the rustc sysroot", async () => {
		const artifact = makeTarball("rust.tar.gz", {
			"rust-1.0-x86_64/rustc/bin/rustc": "binary",
			"rust-1.0-x86_64/rust-std-x86_64/lib/rustlib/x86_64-unknown-linux-gnu/lib/libstd.rlib": "std",
			"rust-1.0-x86_64/cargo/bin/cargo": "binary",
		});
		const staging = makeStagingRoot(base, "extract-rust");
		const result = await extractArtifact(
			entryWith({ kind: "tar_strip", strip: 1 }, [{ kind: "rust_std_merge" }]),
			artifact,
			staging,
			"1.0",
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const sysroot = join(result.contentDir, "rustc", "lib", "rustlib", "x86_64-unknown-linux-gnu", "lib");
		expect(existsSync(join(sysroot, "libstd.rlib"))).toBe(true);
		expect(result.notes.join(" ")).toContain("rust_std_merge");
		removeStagingRoot(staging);
	});

	it("reports a layout error instead of deploying a wrong tree", async () => {
		const artifact = makeTarball("bad-topdir.tar.gz", { "a/one": "1", "b/two": "2" });
		const staging = makeStagingRoot(base, "extract-bad");
		const result = await extractArtifact(entryWith({ kind: "tar_topdir" }), artifact, staging, "1.0");
		expect(result.kind).toBe("error");
		removeStagingRoot(staging);
	});

	it("refuses archives with absolute or parent-escaping members", async () => {
		// GNU tar strips these on create but keeps them in the member list with -P — exactly the
		// crafted shape the guard must reject before extraction (the pipeline runs as root).
		const sources = join(base, "evil-src");
		mkdirSync(join(sources, "nested"), { recursive: true });
		writeFileSync(join(sources, "nested", "payload"), "evil", "utf8");
		for (const [name, cwd, member] of [
			["evil-abs.tar.gz", base, join(sources, "nested", "payload")],
			["evil-dotdot.tar.gz", join(sources, "nested"), "../nested/payload"],
		] as const) {
			const artifact = join(base, name);
			rmSync(artifact, { force: true });
			execFileSync("tar", ["-czf", artifact, "-P", member], { cwd, stdio: "pipe" });
			const staging = makeStagingRoot(base, `extract-${name}`);
			const result = await extractArtifact(entryWith({ kind: "tar_topdir" }), artifact, staging, "1.0");
			expect(result.kind, name).toBe("error");
			if (result.kind === "error") expect(result.reason, name).toContain("unsafe archive member");
			removeStagingRoot(staging);
		}
		rmSync(sources, { recursive: true, force: true });
	});
});
