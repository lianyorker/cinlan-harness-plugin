import { registerHooks } from "node:module";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { StartupError, loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from "@deepseek-ai/dsh-app-boot";
import { runProfile } from "@deepseek-ai/dsh/profile-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as officeSkills from "@deepseek-ai/dsh-skill-office";
import * as workspaceDependencies from "@deepseek-ai/dsh-tool-workspace-dependencies";
import { parsePluginOperationRecord } from "@deepseek-ai/dsh-plugin-manager/diagnostic";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region lib/types/fatal-diagnostic.js
/** Bounded Host failure details sent to the Desktop crash reporter. */
/** Maximum characters carried by one fatal diagnostic, including its truncation notice. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024;
/** Original-error budget when startup metadata needs space in the same report. */
const MAX_ORIGINAL_ERROR_CHARS = 8 * 1024;
/** Startup entry details leave room for composition and provider observations. */
const MAX_STARTUP_ENTRY_CHARS = 8 * 1024;
/**
* Render the original error and explicitly selected startup metadata.
* Selected metadata excludes configuration values and arbitrary startup logger arguments.
* @param error - Failure received by the Host entry point.
* @returns Bounded text with an explicit notice when the report is shortened.
*/
function formatFatalDiagnostic(error) {
	const original = inspect(error, {
		depth: 4,
		maxArrayLength: 50
	});
	const sections = [];
	const seen = /* @__PURE__ */ new Set();
	function visit(value) {
		if (!(value instanceof Error) || seen.has(value)) return;
		seen.add(value);
		if (value instanceof StartupError) {
			if (value.startup !== void 0) sections.push(`Configuration file: ${value.startup.configurationPath}`);
			const entries = inspect(value.entries, {
				depth: 6,
				maxArrayLength: null,
				maxStringLength: 4096
			});
			sections.push("--- startup entries ---", entries.length <= MAX_STARTUP_ENTRY_CHARS ? entries : `${entries.slice(0, MAX_STARTUP_ENTRY_CHARS).replace(/[\uD800-\uDBFF]$/u, "")}\n… (startup entries truncated at ${MAX_STARTUP_ENTRY_CHARS} characters)`);
			if (value.composition !== void 0) {
				const { plugins, services, omittedPlugins, omittedServices } = value.composition;
				const sources = [...new Set(plugins.map((plugin) => plugin.source))];
				sections.push("--- startup composition ---", "Provider lists contain observed registrations only; an empty list means the provider is unknown.", "Source identifies the Loader tree, not necessarily the overriding patch.", `Omitted plugin rows: ${omittedPlugins}; omitted missing-service observations: ${omittedServices}.`, "--- missing services ---", ...services.map((service) => JSON.stringify(service)), "--- plugin sources (sourceIndex) ---", ...sources.map((source, index) => JSON.stringify({
					index,
					source
				})), "--- plugins (inactive first) ---", ...plugins.map(({ source, ...plugin }) => JSON.stringify({
					...plugin,
					sourceIndex: sources.indexOf(source)
				})));
			} else sections.push("Startup composition diagnostic unavailable.");
		}
		visit(value.cause);
		if (value instanceof AggregateError) value.errors.forEach(visit);
	}
	visit(error);
	sections.unshift(sections.length === 0 || original.length <= MAX_ORIGINAL_ERROR_CHARS ? original : `${original.slice(0, MAX_ORIGINAL_ERROR_CHARS).replace(/[\uD800-\uDBFF]$/u, "")}\n… (original error truncated at ${MAX_ORIGINAL_ERROR_CHARS} characters)`);
	const text = sections.join("\n");
	if (text.length <= 65536) return text;
	const notice = `\n… (Host diagnostic truncated at ${MAX_FATAL_DIAGNOSTIC_CHARS} characters)`;
	return text.slice(0, MAX_FATAL_DIAGNOSTIC_CHARS - notice.length).replace(/[\uD800-\uDBFF]$/u, "") + notice;
}
//#endregion
//#region lib/types/office-engine.js
/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
/**
* Locate the archive containing a packaged runtime.
* @param runtimeDir - Prepared or ASAR-contained runtime directory.
* @returns Parent archive path, or undefined for a prepared directory.
*/
function runtimeArchivePath(runtimeDir) {
	const parent = dirname(runtimeDir);
	return basename(parent) === "app.asar" ? parent : void 0;
}
/**
* Keep engine executable and resource paths usable by native child processes outside Electron.
* Hooks apply only to this thread; worker threads must install their own resolver.
* @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
* @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
*/
function installOfficeEngineResolution(runtimeDir) {
	if (runtimeArchivePath(runtimeDir) === void 0) return void 0;
	const root = realpathSync(runtimeDir);
	const archive = dirname(root);
	const source = pathToFileURL(join(root, "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
	const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
	return registerHooks({ resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		if (!resolved.url.startsWith("file:")) return resolved;
		const engineRequest = /^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u.test(specifier);
		const engineTarget = /\/node_modules\/@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\//u.test(new URL(resolved.url).pathname);
		if (!engineRequest && !engineTarget) return resolved;
		const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href;
		if (!canonical.startsWith(source)) {
			if (canonical.startsWith(pathToFileURL(archive + "/").href)) throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved.url}`);
			return resolved;
		}
		const physical = realpathSync(fileURLToPath(destination + canonical.slice(source.length)));
		return {
			...resolved,
			url: pathToFileURL(physical).href
		};
	} });
}
//#endregion
//#region lib/types/office.js
/** Desktop Office skills and bundled authoring dependencies. */
var office_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply,
	name: () => name
});
/** Loader identity for the application-owned Office composition. */
const name = "desktop-office";
/**
* Enable offline Office authoring and LibreOffice Kit operations in the Desktop profile.
* @param ctx - Profile scope; child plugins declare their own service requirements.
* @param config - Bundled payload source and Harness-home installation root.
*/
async function apply(ctx, config) {
	await ctx.plugin(workspaceDependencies, config);
	const archive = runtimeArchivePath(config.runtimeDir) === void 0 ? void 0 : dirname(realpathSync(config.runtimeDir));
	const manifest = fileURLToPath(import.meta.resolve("@deepseek-ai/libreoffice-kit/package.json"));
	const packageRoot = dirname(archive === void 0 ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)));
	await ctx.plugin(officeSkills, {
		assetRoot: join(dirname(config.source), "office-skills"),
		node: join(config.source, "dependencies", "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
		cli: join(packageRoot, "lib", "cli.js")
	});
}
//#endregion
//#region ../../packages/util/workspace-path/src/file-address.ts
/** The scheme and type every file address opens with. */
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
/** Whether a decoded first path segment is a Windows drive (`C:`). */
function isDriveSegment(segment) {
	return segment !== void 0 && /^[A-Za-z]:$/.test(segment);
}
/**
* Read a file address back into its parts without resolving `.` or `..`.
* Query and fragment suffixes are ignored; encoded path segments are decoded.
* @param address - a candidate address.
* @returns the parts, or `undefined` when the string is not a `dsh-resource://file/` URI in a known scope with a path, or a segment is not validly encoded.
*/
function parseFileAddress(address) {
	try {
		if (!address.startsWith(FILE_ADDRESS_PREFIX)) return void 0;
		const end = address.search(/[?#]/);
		const [scope, ...rest] = address.slice(20, end === -1 ? void 0 : end).split("/");
		if (scope === "session") {
			const [id, ...segments] = rest;
			if (id === void 0 || id === "" || segments.length === 0) return void 0;
			return {
				scope,
				sessionId: decodeURIComponent(id),
				path: segments.map(decodeURIComponent).join("/")
			};
		}
		if (scope === "absolute") {
			const unc = rest[0] === "" && rest.length > 1;
			const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
			if (segments.length === 0 || segments[0] === "") return void 0;
			if (unc) return {
				scope,
				path: `//${segments.join("/")}`
			};
			return {
				scope,
				path: isDriveSegment(segments[0]) ? segments.join("/") : `/${segments.join("/")}`
			};
		}
		return;
	} catch {
		return;
	}
}
//#endregion
//#region lib/types/file-drag.js
/** Resolve desktop-only file references through the active Host filesystem and Session. */
/**
* Authorize an unmodified local file through the composed filesystem's actual read operations.
* @param ctx - booted Desktop Host.
* @param address - Session-scoped resource reference.
* @param cancellation - caller cancellation, combined with the read deadline.
* @returns verified Host-local path and content identity, or null for nonlocal resources.
*/
async function localDragResource(ctx, address, cancellation) {
	const resource = parseFileAddress(address);
	if (resource?.scope !== "session") throw new Error("File drag requires a Session resource");
	const sessions = ctx.get("sessions");
	const persistence = ctx.get("sessionPersistence");
	const fs = ctx.get("fs");
	const policy = ctx.get("sandboxPolicy");
	if (fs === void 0 || sessions === void 0 || policy === void 0) throw new Error("File access unavailable");
	const sessionId = resource.sessionId;
	const header = sessions.get(sessionId)?.header ?? (await persistence?.stat(sessionId))?.header;
	if (header === void 0) throw new Error("File drag Session unavailable");
	const signal = cancellation === void 0 ? AbortSignal.timeout(1e4) : AbortSignal.any([cancellation, AbortSignal.timeout(1e4)]);
	signal.throwIfAborted();
	const cwd = header.cwd ?? policy.workspaceRoot;
	if ((await fs.lstat(resource.path, { cwd }, signal))?.type !== "file") return null;
	const target = await fs.resolve(resource.path, {
		cwd,
		signal
	});
	const path = fs.processPath(target);
	const mapped = fs.processPathFromHostPath(path);
	if (mapped === void 0) return null;
	if ((await fs.resolve(mapped, { signal })).targetKey !== target.targetKey) return null;
	const info = await fs.stat(target, signal);
	if (info?.type !== "file" || info.size === void 0) return null;
	const hash = createHash("sha256");
	let size = 0;
	while (size < info.size) {
		signal.throwIfAborted();
		const data = await fs.readByteRange(target, {
			offset: size,
			length: Math.min(64 * 1024, info.size - size)
		}, signal);
		if (data.length === 0) return null;
		hash.update(data);
		size += data.length;
	}
	if (size === 0) await fs.readByteRange(target, {
		offset: 0,
		length: 1
	}, signal);
	const after = await fs.stat(target, signal);
	signal.throwIfAborted();
	if (after?.version !== info.version || after.size !== size) return null;
	return {
		path,
		size,
		sha256: hash.digest("hex")
	};
}
//#endregion
//#region lib/types/update-tasks.js
/** Desktop installation admission and task inspection for the shared Web Host. */
/**
* Whether stopping the Host now would interrupt work: a generating or tool-running
* agent (including subagents and turns waiting for approval), queued inbox
* messages, or a running or stopping background job.
* @param liveAgents - Current agent roster.
* @param jobs - Job registry queried for the global roster and each agent's own jobs.
* @returns true when any of those conditions holds.
*/
function hasDesktopActiveTasks(liveAgents, jobs) {
	return liveAgents.some((agent) => agent.status === "running" || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) || [void 0, ...liveAgents].some((agent) => jobs.list(agent?.id).some((job) => job.status === "running" || job.status === "stopping"));
}
/**
* Register update admission on the owning Host context.
* @param ctx - Booted Desktop profile context; disposal removes the request listener.
* @returns Task inspector whose lock refuses new API requests, drains admitted requests, and rechecks work.
*/
function installDesktopUpdateTaskControl(ctx) {
	let locked = false;
	let lockGeneration = 0;
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
	});
	const pendingRequests = /* @__PURE__ */ new Set();
	ctx.on("connection/request", async (_request, response, next) => {
		if (locked) {
			response.writeHead(503);
			response.end();
			return;
		}
		const finished = Promise.withResolvers();
		pendingRequests.add(finished.promise);
		try {
			await next();
		} finally {
			pendingRequests.delete(finished.promise);
			finished.resolve();
		}
	});
	return async (action) => {
		if (stopped) throw new Error("desktop update: Host is stopping");
		if (action === "unlock") {
			locked = false;
			lockGeneration++;
		}
		const agents = ctx.get("agents");
		const jobs = ctx.get("jobs");
		if (agents === void 0 || jobs === void 0) throw new Error("desktop update: task services are unavailable");
		if (action === "lock") {
			locked = true;
			const generation = ++lockGeneration;
			await Promise.all(pendingRequests);
			if (stopped) throw new Error("desktop update: Host is stopping");
			if (generation !== lockGeneration) throw new Error("desktop update: admission lock was superseded");
		}
		return hasDesktopActiveTasks(agents.list(), jobs);
	};
}
//#endregion
//#region lib/types/quit-inspection.js
/** Quit-time inspection of interruptible work and armed scheduled reminders for the Electron shell. */
/**
* Register the quit inspector on the owning Host context.
* @param ctx - Booted Desktop profile context; disposal makes the inspector reject.
* @returns Inspector reporting active tasks together with armed reminders of the loaded sessions
*   (the `schedule` family of `workspace/session-activity`); reminders in sessions that were never
*   loaded during this run cannot fire and are not counted.
*/
function installDesktopQuitInspection(ctx) {
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
	});
	return async () => {
		if (stopped) throw new Error("desktop quit: Host is stopping");
		const agents = ctx.get("agents");
		const jobs = ctx.get("jobs");
		if (agents === void 0 || jobs === void 0) throw new Error("desktop quit: task services are unavailable");
		const liveAgents = agents.list();
		const activeTasks = hasDesktopActiveTasks(liveAgents, jobs);
		let scheduledTasks = false;
		for (const agent of liveAgents) if ((await ctx.waterfall("workspace/session-activity", { sessionId: agent.id }, () => Promise.resolve([]))).some((entry) => entry.kind === "schedule")) {
			scheduledTasks = true;
			break;
		}
		return {
			activeTasks,
			scheduledTasks
		};
	};
}
//#endregion
//#region lib/types/platform-session.js
/**
* Publish account sessions for each provider lifetime, clearing them on removal or stream termination.
* @param ctx - Host context owning the account dependency subscription.
* @param publish - Synchronous private IPC delivery; never forwards credentials to the renderer.
*/
function installPlatformSessionPublisher(ctx, publish) {
	ctx.inject(["deepseekAccount"], (accountCtx) => {
		const account = accountCtx.deepseekAccount;
		accountCtx.effect(() => {
			const lifetime = new AbortController();
			const updates = (async () => {
				try {
					for await (const _state of account.watch(lifetime.signal, true)) {
						if (lifetime.signal.aborted) break;
						const session = await account.getPlatformSession();
						if (!lifetime.signal.aborted) publish(session);
					}
				} catch {
					if (!lifetime.signal.aborted) accountCtx.logger("desktop-platform").warn("Account session subscription failed");
				} finally {
					if (!lifetime.signal.aborted) publish(null);
				}
			})();
			return async () => {
				lifetime.abort();
				publish(null);
				await updates;
			};
		});
	});
}
//#endregion
//#region lib/types/operation-diagnostics.js
/**
* Observe manager operations after Host startup, with bounded concurrent IPC deliveries.
* @param ctx - Context owning the subscription and its pending deliveries.
* @param send - IPC transport promise which settles when delivery succeeds or fails.
* @param maxPending - Maximum number of outstanding deliveries; excess events are counted and omitted.
* @param runId - Host lifetime identity announced before profile startup.
*/
function installOperationDiagnostics(ctx, send, maxPending, runId) {
	if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new RangeError("Invalid diagnostic delivery budget");
	const pending = /* @__PURE__ */ new Set();
	let dropped = 0;
	let closed = false;
	ctx.on("plugin-manager/operation", (operation) => {
		if (closed || pending.size >= maxPending) {
			dropped++;
			return;
		}
		const record = parsePluginOperationRecord({
			runId,
			operation,
			transportDropped: dropped
		});
		if (record === void 0) {
			dropped++;
			return;
		}
		const delivery = Promise.resolve().then(async () => {
			try {
				await send(record);
			} catch (_error) {
				dropped++;
			}
		});
		pending.add(delivery);
		delivery.then(() => {
			pending.delete(delivery);
		});
	});
	ctx.effect(() => async () => {
		closed = true;
		await Promise.allSettled(pending);
	});
}
//#endregion
//#region lib/types/index.js
/** Launch the Desktop profile through the Web application and report its URL to Electron. */
async function main() {
	const runId = randomUUID();
	if (process.connected) process.send?.({
		type: "starting",
		runId
	}, (error) => {
		if (error !== null) console.error(error);
	});
	const runtimeDir = process.argv[2];
	const projectDir = process.argv[3];
	installOfficeEngineResolution(runtimeDir);
	const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
	const profile = loadProfileDirectory("dsh", projectDir, installAnchor);
	reportSkippedBundles("dsh", profile);
	const application = runProfile({
		environment: loadLayeredEnv("dsh"),
		profile: "desktop",
		resolvedProfile: {
			profile,
			installAnchor
		},
		patchFiles: [],
		args: [
			"--no-open",
			"--host",
			"127.0.0.1",
			"--port",
			"0"
		],
		...process.argv[5] === void 0 ? {} : { packageManager: {
			command: process.execPath,
			args: ["--expose-internals", process.argv[5]],
			env: {
				ELECTRON_RUN_AS_NODE: "1",
				DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
				PATH: `${process.argv[6] ?? ""}${delimiter}${process.env.PATH ?? ""}`
			}
		} }
	});
	let stopping;
	const dragReads = /* @__PURE__ */ new Map();
	const dragTasks = /* @__PURE__ */ new Set();
	const control = {};
	const send = (message) => new Promise((resolve, reject) => {
		if (!process.connected || process.send === void 0) {
			resolve();
			return;
		}
		process.send(message, (error) => {
			if (error === null) resolve();
			else reject(error);
		});
	});
	const stop = () => stopping ??= (async () => {
		for (const abort of dragReads.values()) abort.abort();
		await Promise.allSettled(dragTasks);
		const running = await application.catch(() => void 0);
		await running?.shutdown.shutdown(0);
		await send({ type: "shutdown-complete" });
		if (process.connected) process.disconnect();
		if (running !== void 0) process.exit();
	})();
	process.on("message", (message) => {
		if (typeof message !== "object" || message === null || !("type" in message)) return;
		if (message.type === "shutdown") {
			stop();
			return;
		}
		if (message.type === "file-drag-cancel") {
			if ("requestId" in message && typeof message.requestId === "number") dragReads.get(message.requestId)?.abort();
			return;
		}
		if (message.type === "file-drag-resource") {
			if (!("requestId" in message) || typeof message.requestId !== "number" || !Number.isSafeInteger(message.requestId) || !("address" in message) || typeof message.address !== "string") return;
			const { requestId, address } = message;
			const abort = new AbortController();
			dragReads.set(requestId, abort);
			const task = (async () => {
				try {
					if (stopping !== void 0) throw new Error("Host stopping");
					const { ctx } = await application;
					await send({
						type: "file-drag-resource",
						requestId,
						resource: await localDragResource(ctx, address, abort.signal)
					});
				} catch (error) {
					if (!abort.signal.aborted) console.error(error);
					await send({
						type: "file-drag-resource",
						requestId,
						resource: null,
						error: "File drag resource unavailable"
					});
				} finally {
					dragReads.delete(requestId);
				}
			})().catch((error) => {
				console.error(error);
			});
			dragTasks.add(task);
			task.finally(() => {
				dragTasks.delete(task);
			});
			return;
		}
		if (message.type === "quit-inspection") {
			if (!("requestId" in message) || !Number.isSafeInteger(message.requestId)) return;
			const requestId = message.requestId;
			(async () => {
				try {
					if (stopping !== void 0 || control.quitInspection === void 0) throw new Error("desktop quit: Host is unavailable");
					await send({
						type: "quit-inspection",
						requestId,
						...await control.quitInspection()
					});
				} catch (error) {
					await send({
						type: "quit-inspection",
						requestId,
						activeTasks: true,
						scheduledTasks: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			})().catch((error) => {
				console.error(error);
			});
			return;
		}
		if (message.type !== "update-tasks" || !("requestId" in message) || !Number.isSafeInteger(message.requestId) || !("action" in message) || ![
			"inspect",
			"lock",
			"unlock"
		].includes(String(message.action))) return;
		(async () => {
			try {
				if (stopping !== void 0 || control.updateTasks === void 0) throw new Error("desktop update: Host is unavailable");
				const active = await control.updateTasks(message.action);
				await send({
					type: "update-tasks",
					requestId: message.requestId,
					active
				});
			} catch (error) {
				await send({
					type: "update-tasks",
					requestId: message.requestId,
					active: true,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		})().catch((error) => {
			console.error(error);
		});
	});
	process.once("disconnect", () => {
		stop();
	});
	const { ctx } = await application;
	installOperationDiagnostics(ctx, (record) => send({
		type: "plugin-operation",
		record
	}), 32, runId);
	control.updateTasks = installDesktopUpdateTaskControl(ctx);
	control.quitInspection = installDesktopQuitInspection(ctx);
	await ctx.plugin(office_exports, {
		runtimeDir,
		source: process.argv[4] ?? join(runtimeDir, "..", "runtime", "primary-runtime"),
		root: join(resolveDshHome(), "dsh-runtimes", "dsh-primary-runtime")
	});
	installPlatformSessionPublisher(ctx, (session) => {
		if (process.connected) process.send?.({
			type: "platform-session",
			session
		});
	});
	const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`);
	if (process.connected) process.send?.({
		type: "ready",
		url,
		injections: ctx.webServer.collectIndexInjections(ctx.connection.browserPeer)
	}, (error) => {
		if (error !== null) console.error(error);
	});
}
if (import.meta.main) main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	const diagnostic = formatFatalDiagnostic(error);
	if (process.connected) process.send?.({
		type: "fatal",
		message,
		diagnostic
	}, (error) => {
		if (error !== null) console.error(error);
	});
	console.error(error);
	process.exitCode = 1;
	if (process.connected) process.disconnect();
});
//#endregion
export {};
