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
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The project's conventional llama-server port (models.json uses it). */
export const DEFAULT_LLM_PORT = 8091;

/** Where the model tree lives (the user places the GGUF here). */
export const DEFAULT_LLM_DIR = "/opt/kan-agent/llm";

/** The installed-convention root; the running tree (next to the binary) wins when present. */
const INSTALL_ROOT = "/opt/kan-agent";

const HEALTH_TIMEOUT_MS = 120_000;

export interface ManagedLlm {
	/** OpenAI-compatible endpoint, e.g. http://127.0.0.1:8091/v1 */
	baseUrl: string;
	/** The .gguf in use, for startup reporting. */
	modelPath: string;
	/** The llama-server binary in use, for startup reporting. */
	serverPath: string;
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
		// 16k, not the model's full 128k: pi's request clamp reserves a fixed 4096-token
		// margin, so an 8k window left the answer sharing less than 4k with the thinking —
		// by the summary turn the budget collapsed and the reply was cut mid-sentence.
		"--ctx-size",
		"16384",
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

/**
 * The llama-server binary: KAN_AGENT_LLAMA_SERVER -> the running tree's bin/ -> /opt/kan-agent/bin
 * -> PATH. A running tree that has its own bin/ is authoritative: it must not silently borrow
 * another installation's server.
 */
export function findLlamaServer(execDir = dirname(process.execPath)): string | undefined {
	const override = process.env.KAN_AGENT_LLAMA_SERVER;
	if (override !== undefined) return isFile(override) ? override : undefined;
	const treeBin = join(execDir, "bin");
	const candidates = existsSync(treeBin)
		? [join(treeBin, "llama-server")]
		: [
				join(INSTALL_ROOT, "bin", "llama-server"),
				...(process.env.PATH?.split(delimiter).map((dir) => join(dir, "llama-server")) ?? []),
			];
	return candidates.find((p) => isFile(p));
}

/**
 * The single *.gguf for this run: KAN_AGENT_LLM_DIR -> the running tree's llm/ -> /opt/kan-agent/llm.
 * The directory that applies is the ONLY source — an empty one means "put the model here", never
 * "borrow one from another tree".
 */
export function findModel(execDir = dirname(process.execPath)): string {
	const treeLlm = join(execDir, "llm");
	const dir = process.env.KAN_AGENT_LLM_DIR ?? (existsSync(treeLlm) ? treeLlm : join(INSTALL_ROOT, "llm"));
	if (!existsSync(dir)) {
		throw new Error(`no model directory at ${dir}; place exactly one .gguf model there\n${MODEL_ADVICE}`);
	}
	const models = readdirSync(dir)
		.filter((name) => name.endsWith(".gguf"))
		.sort()
		.map((name) => join(dir, name));
	const unusable = models.filter((path) => !isFile(path));
	if (unusable.length > 0) {
		const why = unusable.map((path) => {
			if (lstatSync(path).isSymbolicLink()) {
				const target = readlinkSync(path);
				return existsSync(path)
					? `${path} is a symlink to ${target}, which is not a regular file`
					: `${path} is a symlink to ${target}, which does not exist`;
			}
			return `${path} is not a regular file`;
		});
		throw new Error(`${why.join("\n")}\n${MODEL_ADVICE}`);
	}
	if (models.length === 0) {
		throw new Error(`${dir} holds no .gguf model; place exactly one there\n${MODEL_ADVICE}`);
	}
	if (models.length > 1) {
		throw new Error(
			`${dir} holds ${models.length} .gguf files; keep exactly one (found: ${models.map((m) => m.split("/").pop()).join(", ")})`,
		);
	}
	return models[0];
}

/** What to do when the model dir cannot serve a request: what to get and where. */
const MODEL_ADVICE = [
	"  current base model: Gemma4-e4b Q4_0 (we will provide our fine-tuned model in the future)",
	"  download: https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/blob/main/gemma-4-E4B_q4_0-it.gguf",
].join("\n");

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

/**
 * Make sure a healthy llama-server is reachable and return its endpoint. Reuses one that is
 * already serving (`baseUrl` from an existing config when given, else the conventional port);
 * otherwise spawns the managed one and waits for /health.
 */
export async function ensureLlm(options?: { baseUrl?: string; logPath?: string }): Promise<ManagedLlm> {
	const serverPath = findLlamaServer();
	if (!serverPath) {
		throw new Error(
			"llama-server not found (looked at KAN_AGENT_LLAMA_SERVER, the tree's bin/, /opt/kan-agent/bin, PATH)",
		);
	}
	const model = findModel();

	const preferred = options?.baseUrl ? portOf(options.baseUrl) : DEFAULT_LLM_PORT;
	if (preferred !== undefined && (await isHealthy(`http://127.0.0.1:${preferred}`))) {
		return {
			baseUrl: `http://127.0.0.1:${preferred}/v1`,
			modelPath: model,
			serverPath,
			stop: () => {},
		};
	}

	const port = preferred ?? (await freePort());
	let logFd: number | undefined;
	if (options?.logPath) {
		mkdirSync(dirname(options.logPath), { recursive: true });
		logFd = openSync(options.logPath, "a");
	}
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
		// The log gets an inherited fd, not a pipe: a piped stdio handle keeps the parent's
		// event loop alive and kan-agent would never exit back to the shell after its reply.
		stdio: ["ignore", "ignore", logFd ?? "ignore"],
		detached: true,
	});
	if (logFd !== undefined) closeSync(logFd);
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
	const logHint = options?.logPath ? `; see ${options.logPath}` : "";
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		// A signal-killed server leaves exitCode null (signalCode carries the verdict); without
		// this check a crash would spin out the full timeout and report a bogus "not healthy".
		if (child.signalCode !== null) {
			throw new Error(`llama-server was killed by ${child.signalCode} before becoming healthy${logHint}`);
		}
		if (child.exitCode !== null) {
			throw new Error(`llama-server exited with code ${child.exitCode} before becoming healthy${logHint}`);
		}
		if (await isHealthy(baseUrl)) {
			return { baseUrl: `${baseUrl}/v1`, modelPath: model, serverPath, pid: child.pid, stop };
		}
		await sleep(500);
	}
	stop();
	throw new Error(`llama-server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s at ${baseUrl}${logHint}`);
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

/** The llama-server provider's models.json shape (pi reads `<agentDir>/models.json`). */
interface ModelsFile {
	providers: Record<
		string,
		{ baseUrl?: string; models?: Array<{ id: string; contextWindow?: number; maxTokens?: number }> }
	>;
}

/**
 * Point the agent dir's models.json at the managed endpoint (pi resolves its provider list from
 * `<agentDir>/models.json`). A missing file is seeded from the shipped template; a file with our
 * llama-server provider gets its baseUrl refreshed and our shipped model's capability fields
 * (contextWindow/maxTokens) synced from the template — a stale seeded copy would silently starve
 * the request budget. Any other config is left untouched.
 * Returns the path pi will read.
 */
export function seedModelsJson(baseUrl: string, agentDir: string): string {
	const modelsPath = join(agentDir, "models.json");
	const template = JSON.parse(readModelsTemplate()) as ModelsFile;
	if (existsSync(modelsPath)) {
		const config = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsFile;
		const provider = config.providers?.["llama-server"];
		if (!provider) return modelsPath;
		let changed = false;
		if (provider.baseUrl !== baseUrl) {
			provider.baseUrl = baseUrl;
			changed = true;
		}
		const shipped = new Map((template.providers["llama-server"]?.models ?? []).map((m) => [m.id, m]));
		provider.models = (provider.models ?? []).map((model) => {
			const want = shipped.get(model.id);
			if (!want || (model.contextWindow === want.contextWindow && model.maxTokens === want.maxTokens)) return model;
			changed = true;
			return { ...model, contextWindow: want.contextWindow, maxTokens: want.maxTokens };
		});
		if (changed) writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		return modelsPath;
	}

	const config = template;
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
