/**
 * The 7 Kan-Agent atomic tool definitions registered into the customized Pi tool layer.
 *
 * Schemas mirror docs/TOOL_SCHEMA.json exactly (names, descriptions, enums, required fields) —
 * that file is the frozen contract shared by Pi integration and fine-tuning trajectory
 * construction, so the two must not drift. Executes are placeholders at the M2 skeleton stage:
 * the goal is a working tool-call chain (model -> schema -> dispatch -> result), not tool bodies.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { ComponentCatalog } from "./catalog.ts";
import { type AuditArgs, type FetchArgs, installAuditBinary, repoFetchBinary } from "./pipeline-binary.ts";

const sourceType = Type.Union([Type.Literal("binary"), Type.Literal("source")], {
	description: "Install class: official binary release vs source build.",
});

const repoFetchParams = Type.Object(
	{
		source_type: sourceType,
		component: Type.Optional(
			Type.String({
				description:
					"Component name in the official component catalog. Preferred over url: resolves URL and default version automatically.",
			}),
		),
		url: Type.Optional(
			Type.String({
				description:
					"Git repo or tarball URL. Used when component is absent or as an explicit override; for source_type=binary it is validated against the official-source allowlist.",
			}),
		),
		ref: Type.Optional(
			Type.String({
				description:
					"Git tag/branch/commit for source class, or release version for binary class. Defaults to the catalog default when omitted.",
			}),
		),
	},
	{ additionalProperties: false },
);

const installAuditParams = Type.Object(
	{
		source_type: Type.Union([Type.Literal("binary"), Type.Literal("source")], {
			description: "Install class being audited.",
		}),
		workspace: Type.String({ description: "Workspace path returned by repo_fetch." }),
		scan_scope: Type.Optional(
			Type.Union(
				[
					Type.Literal("scripts"),
					Type.Literal("build_files"),
					Type.Literal("origin"),
					Type.Literal("integrity"),
					Type.Literal("full"),
				],
				{ description: "Audit scope. Default: full." },
			),
		),
	},
	{ additionalProperties: false },
);

const sourcePatchParams = Type.Object(
	{
		workspace: Type.String({ description: "Workspace path returned by repo_fetch." }),
		file_path: Type.String({ description: "Target file path relative to the workspace." }),
		action: Type.Union(
			[
				Type.Literal("apply_diff"),
				Type.Literal("replace_content"),
				Type.Literal("create_file"),
				Type.Literal("delete_file"),
			],
			{ description: "Edit operation to perform on the target file." },
		),
		diff: Type.Optional(Type.String({ description: "Unified diff content. Required when action=apply_diff." })),
		content: Type.Optional(
			Type.String({ description: "Full new file content. Required when action=replace_content or create_file." }),
		),
	},
	{ additionalProperties: false },
);

const sandboxBuildParams = Type.Object(
	{
		workspace: Type.String({ description: "Workspace path returned by repo_fetch." }),
		build_system: Type.Union(
			[
				Type.Literal("make"),
				Type.Literal("cmake"),
				Type.Literal("meson"),
				Type.Literal("cargo"),
				Type.Literal("autotools"),
				Type.Literal("kbuild"),
				Type.Literal("other"),
			],
			{ description: "Build system detected or chosen for this component." },
		),
		configure_args: Type.Optional(
			Type.String({
				description:
					"Extra configure/cmake arguments (optional). Install prefix is forced into the sandbox/versioned dir.",
			}),
		),
		targets: Type.Optional(Type.String({ description: "Build targets (optional; default: all)." })),
	},
	{ additionalProperties: false },
);

const atomicDeployParams = Type.Object(
	{
		component: Type.String({ description: "Component name (must exist in the official component catalog)." }),
		version: Type.String({ description: "Version being deployed." }),
		artifact: Type.String({ description: "Path to build output (DESTDIR) or the fetched release package." }),
		verify_cmd: Type.Optional(
			Type.String({
				description:
					"Post-deploy health-check command (optional). Executed in a constrained environment: allowlisted binaries, no shell metacharacters. Failure triggers system_rollback.",
			}),
		),
	},
	{ additionalProperties: false },
);

const systemRollbackParams = Type.Object(
	{
		component: Type.Optional(
			Type.String({ description: "Component name. Optional: defaults to the component of the last failed deploy." }),
		),
		generation: Type.String({ description: "Target generation id to roll back to." }),
	},
	{ additionalProperties: false },
);

const sysInspectParams = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("check_env"),
				Type.Literal("check_deps"),
				Type.Literal("read_log"),
				Type.Literal("list_catalog"),
				Type.Literal("list_generations"),
				Type.Literal("inspect_file"),
			],
			{
				description:
					"Inspection operation to perform. Use list_catalog to see installable components and their source_type.",
			},
		),
		target: Type.Optional(
			Type.String({ description: "Path, component name, or log id depending on action (optional)." }),
		),
	},
	{ additionalProperties: false },
);

type RepoFetchParams = Static<typeof repoFetchParams>;
type InstallAuditParams = Static<typeof installAuditParams>;
type SourcePatchParams = Static<typeof sourcePatchParams>;
type SandboxBuildParams = Static<typeof sandboxBuildParams>;
type AtomicDeployParams = Static<typeof atomicDeployParams>;
type SystemRollbackParams = Static<typeof systemRollbackParams>;
type SysInspectParams = Static<typeof sysInspectParams>;

/**
 * Result returned by every M2 placeholder execute. Reports the arguments the tool boundary
 * validated and admits no work was done, so a skeleton run can never look like a real deploy.
 *
 * The STATUS line is deliberate: the model must be able to tell at a glance that the step did not
 * happen, and must not have to infer it from prose. A bare "accepted" reads like a success.
 */
function placeholder(toolName: string, params: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: [
					"STATUS: NOT_IMPLEMENTED",
					`step: ${toolName}`,
					"outcome: no action was taken on the system. This tool is an M2 skeleton stub.",
					`validated_arguments: ${JSON.stringify(params)}`,
					"Do not report this step as completed. Report it as not implemented.",
				].join("\n"),
			},
		],
		details: { skeleton: true, status: "not_implemented", tool: toolName, params },
	};
}

/**
 * Isolated workspace root for fetched artifacts (HLD §4.5: repo_fetch writes an isolated workspace).
 * Overridable for tests so a run never touches the live system.
 */
function workspaceRoot(): string {
	return process.env.PI_KAN_WORKSPACE ?? "/tmp/kan-agent-workspace";
}

/** The 7 Kan-Agent atomic tools. Order matches docs/TOOL_SCHEMA.json. */
export function createKanAgentTools(): ToolDefinition<any, any>[] {
	const catalog = ComponentCatalog.load();
	return [
		{
			name: "repo_fetch",
			label: "repo_fetch",
			description:
				"Fetch upstream source or an official release package from a git repo / tarball URL into an isolated workspace. For source_type=binary the URL must match the official component catalog allowlist (official distribution URLs only, no third-party mirrors). If you do not know a component's source_type, run sys_inspect with action=list_catalog first.",
			parameters: repoFetchParams,
			async execute(_toolCallId, params: RepoFetchParams) {
				if (params.source_type === "binary") {
					const outcome = await repoFetchBinary(params as FetchArgs, workspaceRoot(), catalog);
					return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
				}
				return placeholder("repo_fetch", params);
			},
		},
		{
			name: "install_audit",
			label: "install_audit",
			description:
				"Pre-execution security audit. For source: static behavior audit of source and build scripts (configure, Makefile, CMakeLists.txt, install scripts). For binary: official-origin allowlist and integrity verification. Read-only. High-risk findings block the pipeline and require user authorization.",
			parameters: installAuditParams,
			async execute(_toolCallId, params: InstallAuditParams) {
				if (params.source_type === "binary") {
					const outcome = await installAuditBinary(params as AuditArgs, catalog);
					return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
				}
				return placeholder("install_audit", params);
			},
		},
		{
			name: "source_patch",
			label: "source_patch",
			description:
				"Apply patches or edit build/source files in the workspace: fix compile errors or remove hazards. Writes are restricted to the workspace.",
			parameters: sourcePatchParams,
			async execute(_toolCallId, params: SourcePatchParams) {
				return placeholder("source_patch", params);
			},
		},
		{
			name: "sandbox_build",
			label: "sandbox_build",
			description:
				"Configure and compile source in an unprivileged isolated sandbox (namespace/chroot; no network; writable only workspace and DESTDIR). On failure, returns a budgeted log tail (error lines + surrounding context); the full log is persisted and retrievable via sys_inspect. Dependency ordering comes from catalog dependency declarations (topological sort); missing-dependency errors may trigger bounded recursive resolution (depth <= 2, catalog-only, fully audited).",
			parameters: sandboxBuildParams,
			async execute(_toolCallId, params: SandboxBuildParams) {
				return placeholder("sandbox_build", params);
			},
		},
		{
			name: "atomic_deploy",
			label: "atomic_deploy",
			description:
				"Atomically deploy build artifacts to the system store / install roots, flip symlinks, place declarative config (ld.so.conf.d, profile.d, systemd units per deploy profile) and create a new generation snapshot. Dangerous: requires confirmation.",
			parameters: atomicDeployParams,
			async execute(_toolCallId, params: AtomicDeployParams) {
				return placeholder("atomic_deploy", params);
			},
		},
		{
			name: "system_rollback",
			label: "system_rollback",
			description:
				"Atomically roll back component state to a historical generation: flip symlinks, restore the declarative config snapshot, run post-rollback hooks (ldconfig, systemd reload). Dangerous: requires confirmation. User data/documents are never touched.",
			parameters: systemRollbackParams,
			async execute(_toolCallId, params: SystemRollbackParams) {
				return placeholder("system_rollback", params);
			},
		},
		{
			name: "sys_inspect",
			label: "sys_inspect",
			description:
				"Read-only inspection of system environment, shared-library deps, toolchain, kernel logs, persisted build/audit logs, the official component catalog, and generation history. Use action=list_catalog to list installable components and their source_type before installing; there is no catalog_lookup action.",
			parameters: sysInspectParams,
			async execute(_toolCallId, params: SysInspectParams) {
				if (params.action === "list_catalog") {
					return {
						content: [
							{
								type: "text",
								text: ["STATUS: OK", "step: sys_inspect", "action: list_catalog", catalog.describe()].join(
									"\n",
								),
							},
						],
						details: { status: "ok", tool: "sys_inspect", action: "list_catalog", components: catalog.names() },
					};
				}
				return placeholder("sys_inspect", params);
			},
		},
	];
}
