/**
 * Component catalog resolution and the anti-fabrication boundary (HLD §4.6).
 *
 * The catalog is the only authority on official distribution URLs. These tests hold that line: a
 * caller-supplied URL must never reach the fetch for source_type=binary, and nothing outside the
 * catalog is resolvable.
 */

import { describe, expect, it } from "vitest";
import { CatalogError, ComponentCatalog } from "../src/catalog.ts";

const catalog = ComponentCatalog.load();

describe("ComponentCatalog.resolve", () => {
	it("resolves the default version from the catalog", () => {
		const resolved = catalog.resolve("go");
		expect(resolved.name).toBe("go");
		expect(resolved.version).toBe("1.27.4");
		expect(resolved.url).toBe("https://go.dev/dl/go1.27.4.linux-amd64.tar.gz");
		expect(resolved.tarball).toBe("go1.27.4.linux-amd64.tar.gz");
	});

	it("resolves an explicit version and substitutes it into the pattern", () => {
		const resolved = catalog.resolve("go", "1.27.3");
		expect(resolved.version).toBe("1.27.3");
		expect(resolved.url).toContain("go1.27.3");
	});

	it("carries the pinned sha256 when the catalog has one", () => {
		expect(catalog.resolve("go").sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("rejects a component that is not in the catalog", () => {
		expect(() => catalog.resolve("definitely-not-a-component")).toThrow(CatalogError);
		expect(() => catalog.resolve("definitely-not-a-component")).toThrow(/not in the official component catalog/);
	});

	it("rejects a version that is not in the catalog and lists the available ones", () => {
		expect(() => catalog.resolve("go", "99.99")).toThrow(/not in the catalog/);
		expect(() => catalog.resolve("go", "99.99")).toThrow(/Available/);
	});

	it("only carries official origins", () => {
		for (const name of catalog.names()) {
			expect(catalog.get(name)?.origin).toBe("official");
		}
	});

	it("normalizes version prefixes the script accepted (go1.x, v0.x, rust-x, ...)", () => {
		expect(catalog.resolve("go", "go1.27.3").version).toBe("1.27.3");
		expect(catalog.resolve("rust", "rust-1.99.1").version).toBe("1.99.1");
		expect(catalog.resolve("mimocode", "v0.1.17").version).toBe("0.1.17");
		expect(catalog.resolve("mimocode", "mimocode-0.1.17").version).toBe("0.1.17");
		expect(catalog.resolve("node", "node-v26.13.1").version).toBe("26.13.1");
		expect(catalog.resolve("vulkan", "vulkansdk-1.4.304.1").version).toBe("1.4.304.1");
		expect(catalog.resolve("jdk", "jdk-27.0.1.0.3").version).toBe("27.0.1.0.3");
		expect(catalog.resolve("libreoffice", "libreoffice-26.8.3.1").version).toBe("26.8.3.1");
		expect(catalog.resolve("firefox", "firefox-160.0.1").version).toBe("160.0.1");
	});

	it("resolves the mimocode target from the CPU flag probe", () => {
		const resolved = catalog.resolve("mimocode");
		// The probe fills {target}; either build name is valid, but never the placeholder.
		expect(resolved.tarball).toMatch(/^mimocode-linux-x64(-baseline)?\.tar\.gz$/);
		expect(resolved.url).toContain(resolved.tarball);
		expect(resolved.url).not.toContain("{target}");
	});
});

describe("catalog coverage of install-prebuilts.sh", () => {
	it("carries all 8 components the script installs", () => {
		expect(catalog.names().sort()).toEqual(
			["firefox", "go", "jdk", "libreoffice", "mimocode", "node", "rust", "vulkan"].sort(),
		);
	});

	it("marks the script's in-image and optional split", () => {
		const inImage = catalog
			.entries()
			.filter((e) => e.image_class === "in-image")
			.map((e) => e.name)
			.sort();
		const optional = catalog
			.entries()
			.filter((e) => e.image_class === "optional")
			.map((e) => e.name)
			.sort();
		expect(inImage).toEqual(["firefox", "jdk", "mimocode", "node"]);
		expect(optional).toEqual(["go", "libreoffice", "rust", "vulkan"]);
	});

	it("resolves every default version to an official distribution host", () => {
		const hosts = {
			go: "https://go.dev/dl/",
			rust: "https://static.rust-lang.org/dist/",
			firefox: "https://download-installer.cdn.mozilla.net/",
			mimocode: "https://github.com/XiaomiMiMo/MiMo-Code/releases/download/",
			vulkan: "https://sdk.lunarg.com/sdk/download/",
			jdk: "https://download.oracle.com/java/",
			node: "https://nodejs.org/dist/",
			libreoffice: "https://appimages.libreitalia.org/",
		};
		for (const [name, prefix] of Object.entries(hosts)) {
			expect(catalog.resolve(name).url.startsWith(prefix), name).toBe(true);
		}
	});

	it("pins the ~10G free-space preflight (install-prebuilts.sh convention)", () => {
		expect(catalog.freeSpacePreflightMb).toBe(10240);
	});

	it("gives every component a deploy profile or an explicit empty placement", () => {
		for (const entry of catalog.entries()) {
			expect(entry.config_placement, entry.name).toBeDefined();
			expect(entry.extract, entry.name).toBeDefined();
		}
		// The script's setup_*_config targets must exist as declarative placement data.
		expect(catalog.get("firefox")?.deploy_profile?.system.map((s) => s.kind)).toContain("hook");
		expect(catalog.get("jdk")?.deploy_profile?.system.map((s) => s.kind)).toContain("symlink_dir_files");
		expect(catalog.get("node")?.deploy_profile?.system.map((s) => s.kind)).toContain("symlink_dir_files");
		expect(catalog.get("mimocode")?.deploy_profile?.system.map((s) => s.kind)).toContain("symlink");
		expect(catalog.get("libreoffice")?.deploy_profile?.system.map((s) => s.kind)).toContain("delete_matching");
	});
});

describe("deploy profile validation", () => {
	const baseEntry = catalog.get("go")!;

	it("rejects an in_tree step kind that belongs to system placement", () => {
		expect(
			() =>
				new ComponentCatalog([
					{
						...baseEntry,
						name: "bad-in-tree",
						deploy_profile: {
							in_tree: [{ kind: "symlink", from: "bin/x", to: "/usr/local/bin/x" }],
							system: [],
						},
					},
				]),
		).toThrow(/in_tree may not contain/);
	});

	it("rejects system placement paths that are not root-absolute", () => {
		expect(
			() =>
				new ComponentCatalog([
					{
						...baseEntry,
						name: "bad-system",
						deploy_profile: {
							in_tree: [],
							system: [{ kind: "file", path: "etc/relative.conf", content: "x" }],
						},
					},
				]),
		).toThrow(/root-absolute/);
	});
});

describe("catalog load", () => {
	it("refuses a catalog entry whose origin is not official", () => {
		expect(
			() =>
				new ComponentCatalog([
					{
						name: "mirror-thing",
						description: "x",
						source_type: "binary",
						origin: "mirror" as "official",
						image_class: "optional",
						tarball_pattern: "x-{version}.tar.gz",
						url_pattern: "https://mirror.example.com/{tarball}",
						versions: ["1"],
						default_version: "1",
						install_root: "/opt/x",
						extract_root: "/opt",
						extract: { kind: "tar_topdir" },
						verify_cmd: "x --version",
						config_placement: [],
						dependencies: [],
					},
				]),
		).toThrow(/origin must be "official"/);
	});

	it("refuses a catalog with a duplicate component", () => {
		const entry = catalog.get("go");
		expect(entry).toBeDefined();
		expect(() => new ComponentCatalog([entry!, entry!])).toThrow(/duplicate catalog component/);
	});
});
