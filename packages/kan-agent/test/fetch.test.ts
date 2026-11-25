/**
 * The substrate fetch primitive (HLD §9 absorption: fetch = temp-then-rename + retry + timeouts).
 * The stall case is the point here: a live environment with a flaky link must fail the attempt and
 * retry, never hang the install run — install-prebuilts.sh bounds the same case with --timeout.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchToFile } from "../src/fetch.ts";

const base = join(import.meta.dirname, ".tmp", "fetch-test");
let server: Server;
let baseUrl: string;

beforeAll(async () => {
	mkdirSync(base, { recursive: true });
	server = createServer((req, res) => {
		if (req.url === "/stall") {
			// Announce a body, send one byte, then go silent: the idle watchdog must fire.
			res.writeHead(200, { "content-length": "1024" });
			res.write("x");
			return;
		}
		if (req.url === "/ok") {
			res.writeHead(200, { "content-length": "5" });
			res.end("hello");
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(base, { recursive: true, force: true });
});

describe("fetchToFile", () => {
	it("fetches to a complete file and reports its hash", async () => {
		const dest = join(base, "ok.bin");
		const outcome = await fetchToFile(`${baseUrl}/ok`, dest);
		expect(outcome.kind).toBe("fetched");
		expect(statSync(dest).size).toBe(5);
	});

	it("aborts a stalled download instead of hanging, and retries before failing", async () => {
		const dest = join(base, "stall.bin");
		const outcome = await fetchToFile(`${baseUrl}/stall`, dest, { idleTimeoutMs: 150, attempts: 2 });
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.reason).toContain("stalled");
		expect(outcome.reason).toContain("2 attempts");
		// No truncated artifact may survive a failed fetch.
		expect(() => statSync(dest)).toThrow();
	});
});
