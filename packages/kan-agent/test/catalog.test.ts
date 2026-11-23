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
						tarball_pattern: "x-{version}.tar.gz",
						url_pattern: "https://mirror.example.com/{tarball}",
						versions: ["1"],
						default_version: "1",
						install_root: "/opt/x",
						extract_root: "/opt",
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
