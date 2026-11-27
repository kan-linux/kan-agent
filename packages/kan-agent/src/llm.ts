/**
 * Managed llama-server runtime (HLD §4.3: "llama-server is spawned on demand as a resident
 * process ... startup parameters are fixed to --jinja, a low default temperature,
 * --reasoning-budget 128, and KV-cache prefix reuse (--cache-reuse)").
 *
 * kan-agent owns the inference process so a bare `kan-agent "<request>"` works with no setup:
 * the server binary is discovered by convention (KAN_AGENT_LLAMA_SERVER -> /opt/kan-agent/bin ->
 * PATH), the model is the single *.gguf under /opt/kan-agent/llm, and the runtime libraries come
 * from the server's own directory (ggml-hexagon builds lay binaries and .so files flat together
 * and load them via LD_LIBRARY_PATH — the Firefox-style self-contained tree).
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The project's conventional llama-server port (models.json uses it). */
export const DEFAULT_LLM_PORT = 8091;

/** Where the model tree lives (the user places the GGUF here). */
export const DEFAULT_LLM_DIR = "/opt/kan-agent/llm";

const HEALTH_TIMEOUT_MS = 120_000;

export interface ManagedLlm {
	/** OpenAI-compatible endpoint, e.g. http://127.0.0.1:8091/v1 */
	baseUrl: string;
	/** PID of the spawned server; undefined when an already-running server was reused. */
	pid?: number;
	/** Kill the spawned server. No-op when a running server was reused. */
	stop: () => void;
}

/** The managed runtime's fixed startup baseline: the ggml-hexagon x86 run script + HLD §4.3. */
function serverArgs(model: string, port: number): string[] {
	return [
		"-ngl",
		"99",
		"-t",
		"6",
		"--ctx-size",
		"8192",
		"--ubatch-size",
		"64",
		"--poll",
		"1000",
		"--no-warmup",
		"--load-mode",
		"none",
		"-fa",
		"on",
		"-np",
		"1",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--jinja",
		"--reasoning-budget",
		"128",
		"--temp",
		"0.2",
		"--top-p",
		"0.9",
		"--cache-reuse",
		"256",
		"-m",
		model,
	];
}

/** The llama-server binary: KAN_AGENT_LLAMA_SERVER -> /opt/kan-agent/bin -> <release tree>/bin -> PATH. */
export function findLlamaServer(): string | undefined {
	const candidates = [
		process.env.KAN_AGENT_LLAMA_SERVER,
		"/opt/kan-agent/bin/llama-server",
		join(dirname(process.execPath), "bin", "llama-server"),
		...(process.env.PATH?.split(delimiter).map((dir) => join(dir, "llama-server")) ?? []),
	].filter((p): p is string => p !== undefined);
	return candidates.find((p) => existsSync(p) && statSync(p).isFile());
}

/** The single *.gguf under the model dir (KAN_AGENT_LLM_DIR -> /opt/kan-agent/llm). */
export function findModel(): string | undefined {
	const candidates = [process.env.KAN_AGENT_LLM_DIR ?? DEFAULT_LLM_DIR, join(dirname(process.execPath), "llm")];
	for (const dir of candidates) {
		if (!existsSync(dir)) continue;
		const models = readdirSync(dir)
			.filter((name) => name.endsWith(".gguf"))
			.sort()
			.map((name) => join(dir, name));
		if (models.length === 0) continue;
		if (models.length > 1) {
			throw new Error(
				`${dir} holds ${models.length} .gguf files; keep exactly one (found: ${models.map((m) => m.split("/").pop()).join(", ")})`,
			);
		}
		return models[0];
	}
	return undefined;
}

/**
 * Make sure a healthy llama-server is reachable and return its endpoint. Reuses one that is
 * already serving (`baseUrl` from an existing config when given, else the conventional port);
 * otherwise spawns the managed one and waits for /health.
 */
export async function ensureLlm(options?: { baseUrl?: string; logPath?: string }): Promise<ManagedLlm> {
	const serverPath = findLlamaServer();
	const model = findModel();
	if (!serverPath) {
		throw new Error(
			"llama-server not found (looked at KAN_AGENT_LLAMA_SERVER, /opt/kan-agent/bin/llama-server, PATH)",
		);
	}
	if (!model) {
		throw new Error(`no .gguf model in ${process.env.KAN_AGENT_LLM_DIR ?? DEFAULT_LLM_DIR}`);
	}

	const preferred = options?.baseUrl ? portOf(options.baseUrl) : DEFAULT_LLM_PORT;
	if (preferred !== undefined && (await isHealthy(`http://127.0.0.1:${preferred}`))) {
		return { baseUrl: `http://127.0.0.1:${preferred}/v1`, stop: () => {} };
	}

	const port = preferred ?? (await freePort());
	const child = spawn(serverPath, serverArgs(model, port), {
		env: {
			...process.env,
			// The runtime tree is self-contained (binaries and non-system .so flat together,
			// Firefox-style); the Vulkan loader may live in the tree or come from the kan-linux
			// Vulkan SDK component. GPU driver ICDs stay system-provided.
			LD_LIBRARY_PATH: [dirname(serverPath), vulkanLibDir(), process.env.LD_LIBRARY_PATH]
				.filter(Boolean)
				.join(delimiter),
			GGML_VK_ALLOW_SYSMEM_FALLBACK: "1",
		},
		stdio: ["ignore", "ignore", options?.logPath ? "pipe" : "ignore"],
		detached: true,
	});
	if (options?.logPath && child.stderr) {
		mkdirSync(dirname(options.logPath), { recursive: true });
		child.stderr.pipe(createWriteStream(options.logPath, { flags: "a" }));
	}
	child.unref();

	const stop = (): void => {
		if (child.exitCode === null && child.pid !== undefined) {
			try {
				// The server is its own process group (detached), so the group goes together.
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		}
	};
	process.once("exit", stop);
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`llama-server exited with code ${child.exitCode} before becoming healthy`);
		}
		if (await isHealthy(baseUrl)) {
			return { baseUrl: `${baseUrl}/v1`, pid: child.pid, stop };
		}
		await sleep(500);
	}
	stop();
	throw new Error(`llama-server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s at ${baseUrl}`);
}

/** Whether a llama-server answers /health on `origin`. */
export async function isHealthy(origin: string): Promise<boolean> {
	try {
		const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
		return response.ok;
	} catch {
		return false;
	}
}

function portOf(baseUrl: string): number | undefined {
	const match = /:(\d+)/.exec(new URL(baseUrl).host);
	return match ? Number(match[1]) : undefined;
}

/** Extra lib dir for the Vulkan loader when the runtime tree does not carry it: the SDK component. */
function vulkanLibDir(): string | undefined {
	const dir = process.env.KAN_AGENT_VULKAN_LIB_DIR ?? "/opt/vulkan/lib";
	return existsSync(join(dir, "libvulkan.so.1")) ? dir : undefined;
}

/**
 * Point the agent dir's models.json at the managed endpoint (pi resolves its provider list from
 * `<agentDir>/models.json`). A missing file is seeded from the shipped template; a file with our
 * llama-server provider has its baseUrl refreshed; any other config is left untouched.
 * Returns the path pi will read.
 */
export function seedModelsJson(baseUrl: string, agentDir: string): string {
	const modelsPath = join(agentDir, "models.json");
	if (existsSync(modelsPath)) {
		const config = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers?: Record<string, { baseUrl?: string }>;
		};
		const provider = config.providers?.["llama-server"];
		if (!provider) return modelsPath;
		if (provider.baseUrl !== baseUrl) {
			provider.baseUrl = baseUrl;
			writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		}
		return modelsPath;
	}

	const template = readModelsTemplate();
	const config = JSON.parse(template) as { providers: Record<string, { baseUrl?: string }> };
	config.providers["llama-server"].baseUrl = baseUrl;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return modelsPath;
}

/** The shipped models.json template, next to the executable (binary) or the module (source run). */
function readModelsTemplate(): string {
	const candidates = [
		join(dirname(process.execPath), "config", "models.json"),
		join(dirname(fileURLToPath(import.meta.url)), "..", "config", "models.json"),
	];
	const path = candidates.find((p) => existsSync(p));
	if (!path) {
		throw new Error(`models.json template not found (looked at: ${candidates.join(", ")})`);
	}
	return readFileSync(path, "utf8");
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (address === null || typeof address === "string") {
				probe.close(() => reject(new Error("cannot determine a free port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
