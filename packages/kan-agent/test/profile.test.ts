/**
 * The deploy-profile engine, driven through atomicDeployBinary (HLD §9 absorption: setup_*_config
 * placement). The point of this file is the rollback half: system config written outside the store
 * must come back to its pre-deploy state when a deploy is rolled back — that is what makes the
 * /etc/ld.so.conf.d, /usr/local/bin and /usr/share writes of install-prebuilts.sh revertible.
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CatalogEntry, ComponentCatalog } from "../src/catalog.ts";
import { atomicDeployBinary, systemRollback } from "../src/deploy.ts";
import { KanPaths } from "../src/root.ts";
import { makeFakeTarball, makeStagingRoot, removeStagingRoot } from "./fixture.ts";

const base = join(import.meta.dirname, ".tmp");

let root: string;
let paths: KanPaths;

beforeEach(() => {
	root = makeStagingRoot(base, "profile-test");
	process.env.PI_KAN_ROOT = root;
	paths = new KanPaths(root);
});

afterEach(() => {
	removeStagingRoot(root);
	delete process.env.PI_KAN_ROOT;
});

function catalogWith(entry: CatalogEntry): ComponentCatalog {
	return new ComponentCatalog([entry], { free_space_preflight_mb: 0 });
}

/** A component whose deploy profile mirrors install-prebuilts.sh's setup_*_config shapes. */
function profileEntry(): CatalogEntry {
	return {
		name: "profiled",
		description: "deploy-profile fixture",
		source_type: "binary",
		origin: "official",
		image_class: "in-image",
		tarball_pattern: "profiled-{version}.tar.gz",
		url_pattern: "https://example.com/{tarball}",
		versions: ["1.0", "2.0"],
		default_version: "1.0",
		install_root: "/opt/profiled",
		extract_root: "/opt",
		extract: { kind: "tar_topdir" },
		verify_cmd: "profiled --version",
		config_placement: ["fixture"],
		deploy_profile: {
			in_tree: [
				{ kind: "file", path: "defaults/pref.js", content: "base\n", vm_append: "vm-only\n" },
				{ kind: "copy_file", from: "/etc/fixture-source", to: "extras/copied", optional: true },
			],
			system: [
				{ kind: "file", path: "/etc/profile.d/profiled.sh", content: "export PROFILED=1\n" },
				{ kind: "symlink", from: "bin/profiled", to: "/usr/local/bin/profiled" },
				{ kind: "symlink_dir_files", from: "bin", to: "/usr/local/bin" },
			],
		},
		dependencies: [],
	};
}

function stageArtifact(name: string, version: string, report = `report-${version}`): string {
	const artifact = join(root, "var", "lib", "kan-agent", "workspace", name, `${name}-${version}.tar.gz`);
	makeFakeTarball(base, { name, binary: name, report, output: artifact });
	return artifact;
}

describe("deploy profile placement", () => {
	it("places in-tree config into the store tree and system config outside it", async () => {
		const catalog = catalogWith(profileEntry());
		const outcome = await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: false },
		);
		expect(outcome.kind).toBe("ok");
		const store = paths.storePath("profiled", "1.0");
		expect(readFileSync(join(store, "defaults", "pref.js"), "utf8")).toBe("base\n");
		expect(readFileSync(join(root, "/etc/profile.d/profiled.sh"), "utf8")).toBe("export PROFILED=1\n");
		// The launcher symlink points at the install root (itself a symlink into the store), so
		// one flip retargets the whole chain.
		expect(readlinkSync(join(root, "/usr/local/bin/profiled"))).toBe(
			join(paths.installRoot("profiled"), "bin", "profiled"),
		);
		expect(readlinkSync(paths.installRoot("profiled"))).toContain("store");
	});

	it("appends the vm block to in-tree prefs only on a VM", async () => {
		const catalog = catalogWith(profileEntry());
		await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: true },
		);
		const prefs = readFileSync(join(paths.storePath("profiled", "1.0"), "defaults", "pref.js"), "utf8");
		expect(prefs).toBe("base\nvm-only\n");
	});

	it("copies an optional host file into the tree and tolerates its absence", async () => {
		const catalog = catalogWith(profileEntry());
		mkdirSync(join(root, "/etc"), { recursive: true });
		writeFileSync(join(root, "/etc/fixture-source"), "widevine-like", "utf8");
		await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: false },
		);
		expect(readFileSync(join(paths.storePath("profiled", "1.0"), "extras", "copied"), "utf8")).toBe("widevine-like");
	});
});

describe("config rollback", () => {
	it("rolls a failed deploy's config writes back to the pre-deploy state", async () => {
		const catalog = catalogWith(profileEntry());
		const outcome = await atomicDeployBinary(
			{
				component: "profiled",
				version: "1.0",
				artifact: stageArtifact("profiled", "1.0"),
				verify_cmd: "profiled --not-a-real-flag",
			},
			paths,
			catalog,
			{ vm: false },
		);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("config writes of this deploy were rolled back");
		// Created paths go away again...
		expect(existsSync(join(root, "/etc/profile.d/profiled.sh"))).toBe(false);
		expect(existsSync(join(root, "/usr/local/bin/profiled"))).toBe(false);
	});

	it("restores the replaced file content when rolling back across two deploys", async () => {
		const catalog = catalogWith(profileEntry());
		mkdirSync(join(root, "/etc/profile.d"), { recursive: true });
		writeFileSync(join(root, "/etc/profile.d/profiled.sh"), "generation-zero\n", "utf8");

		await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: false },
		);
		await atomicDeployBinary(
			{ component: "profiled", version: "2.0", artifact: stageArtifact("profiled", "2.0") },
			paths,
			catalog,
			{ vm: false },
		);

		const rolled = await systemRollback({ component: "profiled", generation: "1" }, paths, catalog);
		expect(rolled.kind).toBe("ok");
		// Undoing gen 2 restores its pre-image, which is gen 1's file content.
		expect(readFileSync(join(root, "/etc/profile.d/profiled.sh"), "utf8")).toBe("export PROFILED=1\n");
		expect(readlinkSync(paths.installRoot("profiled"))).toContain("1.0");
	});

	it("leaves gen 1's writes in place when the failed gen 2 is rolled back", async () => {
		const catalog = catalogWith(profileEntry());
		mkdirSync(join(root, "/etc/profile.d"), { recursive: true });
		writeFileSync(join(root, "/etc/profile.d/profiled.sh"), "user-owned\n", "utf8");

		await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: false },
		);
		const failed = await atomicDeployBinary(
			{
				component: "profiled",
				version: "2.0",
				artifact: stageArtifact("profiled", "2.0"),
				verify_cmd: "profiled --not-a-real-flag",
			},
			paths,
			catalog,
			{ vm: false },
		);
		expect(failed.kind).toBe("error");
		// Only the failed deploy's writes are reversed: gen 1's profile text stays, not the
		// user's pre-gen-1 content.
		expect(readFileSync(join(root, "/etc/profile.d/profiled.sh"), "utf8")).toBe("export PROFILED=1\n");
		expect(readlinkSync(paths.installRoot("profiled"))).toContain("1.0");
	});
});

describe("legacy install root adoption", () => {
	it("replaces a real /opt/<tool> directory left by install-prebuilts.sh", async () => {
		const catalog = catalogWith(profileEntry());
		const legacy = paths.installRoot("profiled");
		mkdirSync(join(legacy, "bin"), { recursive: true });
		writeFileSync(join(legacy, "bin", "profiled"), "old script install", "utf8");

		const outcome = await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: false },
		);
		expect(outcome.kind).toBe("ok");
		expect(readlinkSync(legacy)).toContain("store");
		expect(readFileSync(join(legacy, "bin", "profiled"), "utf8")).toContain("report-1.0");
	});
});

describe("delete_matching and copy_tree", () => {
	it("restores deleted files and removes copied ones when the deploy fails", async () => {
		const entry = profileEntry();
		entry.deploy_profile = {
			in_tree: [{ kind: "file", path: "usr/share/applications/keep.desktop", content: "keep\n" }],
			system: [
				{ kind: "copy_tree", from: "usr", to: "/usr" },
				{
					kind: "delete_matching",
					dir: "/usr/share/applications",
					patterns: ["libreoffice*-draw.desktop"],
				},
			],
		};
		// A pre-existing broken menu entry: copy_tree merges over the dir, delete_matching drops it.
		mkdirSync(join(root, "/usr/share/applications"), { recursive: true });
		writeFileSync(join(root, "/usr/share/applications/libreoffice-x-draw.desktop"), "broken\n", "utf8");

		const catalog = catalogWith(entry);
		const outcome = await atomicDeployBinary(
			{
				component: "profiled",
				version: "1.0",
				artifact: stageArtifact("profiled", "1.0"),
				verify_cmd: "profiled --not-a-real-flag",
			},
			paths,
			catalog,
			{ vm: false },
		);
		expect(outcome.kind).toBe("error");
		// The delete's backup comes back and the copied file goes away again.
		expect(readFileSync(join(root, "/usr/share/applications/libreoffice-x-draw.desktop"), "utf8")).toBe("broken\n");
		expect(existsSync(join(root, "/usr/share/applications/keep.desktop"))).toBe(false);
	});

	it("keeps placed files and drops matching ones on a successful deploy", async () => {
		const entry = profileEntry();
		entry.deploy_profile = {
			in_tree: [{ kind: "file", path: "usr/share/applications/keep.desktop", content: "keep\n" }],
			system: [
				{ kind: "copy_tree", from: "usr", to: "/usr" },
				{
					kind: "delete_matching",
					dir: "/usr/share/applications",
					patterns: ["libreoffice*-draw.desktop"],
				},
			],
		};
		mkdirSync(join(root, "/usr/share/applications"), { recursive: true });
		writeFileSync(join(root, "/usr/share/applications/libreoffice-x-draw.desktop"), "broken\n", "utf8");

		const catalog = catalogWith(entry);
		const outcome = await atomicDeployBinary(
			{ component: "profiled", version: "1.0", artifact: stageArtifact("profiled", "1.0") },
			paths,
			catalog,
			{ vm: false },
		);
		expect(outcome.kind).toBe("ok");
		expect(readFileSync(join(root, "/usr/share/applications/keep.desktop"), "utf8")).toBe("keep\n");
		expect(existsSync(join(root, "/usr/share/applications/libreoffice-x-draw.desktop"))).toBe(false);
	});
});
