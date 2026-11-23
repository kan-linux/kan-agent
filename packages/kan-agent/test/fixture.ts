/**
 * Shared fixtures for the Kan-Agent install-pipeline tests.
 *
 * Deploy tests use a synthetic tarball rather than a real download: the bugs that matter here (a
 * stripped execute bit, a dangling generation pointer) are properties of the store, not of the
 * upstream artifact, and a synthetic artifact keeps the suite fast and offline.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeWritable } from "../src/store.ts";

/**
 * A clean staging root plus the env var that selects it. Returns the root path; the caller must
 * point `PI_KAN_ROOT` at it (or set it before constructing KanPaths).
 */
export function makeStagingRoot(baseDir: string, name: string): string {
	const root = join(baseDir, name);
	removeStagingRoot(root);
	mkdirSync(root, { recursive: true });
	return root;
}

/**
 * Delete a staging root. The store inside is read-only by construction, so write permission has to
 * come back before anything can be removed — the same step commitToStore performs internally.
 */
export function removeStagingRoot(root: string): void {
	try {
		makeWritable(root);
	} catch {
		// not there, or not a tree we own
	}
	rmSync(root, { recursive: true, force: true });
}

/**
 * Build a tarball whose single top-level directory holds a runnable `bin/<binary>`.
 *
 * The script echoes `report`, so a health check that runs the DEPLOYED binary produces `report`,
 * while a host binary of the same name would produce something else — which is exactly how the
 * "verify silently checked the host's program" bug gets caught.
 */
export function makeFakeTarball(
	baseDir: string,
	options: { name: string; binary: string; report: string; output?: string },
): string {
	const staging = join(baseDir, `${options.name}-src`);
	rmSync(staging, { recursive: true, force: true });
	const binDir = join(staging, options.name, "bin");
	mkdirSync(binDir, { recursive: true });

	const script = join(binDir, options.binary);
	// Behaves like a real tool: prints `report` and succeeds, but rejects an unknown flag with a
	// non-zero exit. That gives the health-check tests a command that passes and one that fails
	// without needing two different binaries.
	writeFileSync(
		script,
		[
			"#!/bin/sh",
			'for a in "$@"; do',
			'  case "$a" in',
			'    --not-a-real-flag) echo "unknown flag: $a" >&2; exit 2 ;;',
			"  esac",
			"done",
			`echo "${options.report}"`,
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(script, 0o755);

	const tarball = options.output ?? join(baseDir, `${options.name}.tar.gz`);
	mkdirSync(dirname(tarball), { recursive: true });
	rmSync(tarball, { force: true });
	execFileSync("tar", ["-czf", tarball, "-C", staging, options.name], { stdio: "pipe" });
	rmSync(staging, { recursive: true, force: true });
	return tarball;
}

/** A fetched artifact at the path repo_fetch would have left it: <root>/workspace/<component>/... */
export function fetchedArtifact(root: string, component: string, tarball: string): string {
	return join(root, "var", "lib", "kan-agent", "workspace", component, tarball);
}
