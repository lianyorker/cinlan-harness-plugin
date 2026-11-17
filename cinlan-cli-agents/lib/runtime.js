/**
 * AgentRuntime：外部 CLI agent 的探测与 headless 运行。
 *
 * prompt 注入语义照搬 stablyai/orca 的 promptInjectionMode（argv / flag-prompt /
 * stdin-after-start），但目标是一次性 headless 运行（注入 → 收集输出 → 结构化返回），
 * 不做 TUI 交互（粘贴时机、composer ready 信号那些字段因此不需要）。
 *
 * 关键决定：spawn 不走 shell——prompt 作为独立 argv 元素传给子进程，避免 shell 转义/注入；
 * 代价是 Windows 上 .cmd/.bat 包装无法直接执行（Node spawn 会 EINVAL），只能显式拒绝并
 * 提示把 command 指到真实可执行文件（claude.exe 原生安装、或 node + js 入口）。
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { CliAgentError } from './config.js';
// 探测限 10 秒：--version 类命令远快于此，超长说明命令卡住（如等待 stdin），不该拖住启动
const DETECT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_500;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const WINDOWS_EXECUTABLE_EXTS = ['.com', '.exe'];
const WINDOWS_REJECTED_EXTS = ['.bat', '.cmd'];
class Semaphore {
    max;
    active = 0;
    waiters = [];
    constructor(max) {
        this.max = max;
    }
    async acquire() {
        if (this.active < this.max) {
            this.active += 1;
            return;
        }
        await new Promise((resolve) => this.waiters.push(resolve));
        this.active += 1;
    }
    release() {
        this.active -= 1;
        const next = this.waiters.shift();
        if (next)
            next();
    }
}
/** PATH 解析（Windows 遵循 PATHEXT 的 .com/.exe；.bat/.cmd 拒绝，见文件头说明）。 */
export function resolveCommand(command) {
    const isWindows = process.platform === 'win32';
    const hasDir = command.includes('/') || command.includes('\\');
    const candidates = [];
    if (hasDir) {
        candidates.push(command);
        if (isWindows && !path.extname(command)) {
            for (const ext of WINDOWS_EXECUTABLE_EXTS)
                candidates.push(command + ext);
        }
    }
    else {
        const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
        const exts = isWindows ? (path.extname(command) ? [''] : WINDOWS_EXECUTABLE_EXTS) : [''];
        for (const dir of dirs) {
            for (const ext of exts)
                candidates.push(path.join(dir, command + ext));
        }
    }
    for (const file of candidates) {
        try {
            accessSync(file, fsConstants.X_OK);
            const ext = path.extname(file).toLowerCase();
            if (isWindows && WINDOWS_REJECTED_EXTS.includes(ext)) {
                throw new CliAgentError('unsupported-wrapper', `command "${command}" 解析到 ${file}：Windows 上 .cmd/.bat 包装无法被无 shell 的 spawn 直接执行，`
                    + '请把 command 指到真实可执行文件（如 claude 原生安装的 claude.exe，或 command: "node" + args 指向 js 入口）');
            }
            return file;
        }
        catch (err) {
            if (err instanceof CliAgentError)
                throw err;
            // ENOENT/EACCES → 试下一个候选
        }
    }
    throw new CliAgentError('command-not-found', `command "${command}" 在 PATH 中找不到可执行文件`);
}
/** 按 orca 语义把 prompt 组进 argv；stdin-after-start 返回不带 prompt 的 argv。 */
export function buildArgv(agent, prompt) {
    const argv = [...agent.args];
    switch (agent.promptInjectionMode) {
        case 'argv':
            if (agent.argvSeparator)
                argv.push(agent.argvSeparator);
            argv.push(prompt);
            break;
        case 'flag-prompt':
            argv.push(agent.promptFlag, prompt);
            break;
        case 'stdin-after-start':
            break;
    }
    return argv;
}
/** 从 stdout 提取 JSON 值：整体解析失败则取第一个 {/[ 到最后一个 }/] 的子串再试。 */
export function extractJson(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return { failed: true };
    try {
        return { value: JSON.parse(trimmed) };
    }
    catch { /* 落到子串提取 */ }
    const first = trimmed.search(/[[{]/);
    const last = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (first >= 0 && last > first) {
        try {
            return { value: JSON.parse(trimmed.slice(first, last + 1)) };
        }
        catch { /* 保持失败 */ }
    }
    return { failed: true };
}
export class AgentRuntime {
    config;
    logger;
    semaphores = new Map();
    running = new Set();
    disposed = false;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    list() {
        return [...this.config.agents.values()];
    }
    get(id) {
        return this.config.agents.get(id);
    }
    runningCount() {
        return this.running.size;
    }
    semaphoreFor(agent) {
        let sem = this.semaphores.get(agent.id);
        if (!sem) {
            sem = new Semaphore(agent.maxConcurrent);
            this.semaphores.set(agent.id, sem);
        }
        return sem;
    }
    /** 探测 agent 是否在位：跑 detect 命令（配置受信，走 shell；prompt 不经此路径）。 */
    async detect(id) {
        const agent = this.config.agents.get(id);
        if (!agent)
            throw new CliAgentError('unknown-agent', `未配置的 agent: ${id}`);
        const started = Date.now();
        try {
            resolveCommand(agent.command);
        }
        catch (err) {
            return {
                agent: id,
                installed: false,
                error: err.message,
                durationMs: Date.now() - started,
            };
        }
        try {
            const collected = await this.spawnAndCollect(agent.detect, {
                cwd: agent.cwd ?? process.cwd(),
                env: agent.env,
                timeoutMs: DETECT_TIMEOUT_MS,
            });
            const version = collected.stdout.trim().split('\n')[0]?.trim() || undefined;
            return {
                agent: id,
                installed: collected.code === 0,
                version: collected.code === 0 ? version : undefined,
                exitCode: collected.code,
                durationMs: Date.now() - started,
                error: collected.code === 0 ? undefined : collected.stderr.trim() || `退出码 ${collected.code}`,
            };
        }
        catch (err) {
            return {
                agent: id,
                installed: false,
                error: err.message,
                durationMs: Date.now() - started,
            };
        }
    }
    /**
     * 探测专用收集器：整条命令行走 shell（detect 是配置里的受信串，可能含路径与参数），
     * 与 run 的无 shell spawn 分离——prompt 永远不经此路径。
     */
    async spawnAndCollect(commandLine, opts) {
        const child = spawn(commandLine, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
        try {
            const code = await new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', (code) => resolve(code));
            });
            return { code, stdout, stderr };
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** 派任务给 agent：注入 prompt → headless 运行 → 结构化结果。同 agent 并发受 maxConcurrent 限制。 */
    async run(id, prompt, options = {}) {
        if (this.disposed)
            throw new CliAgentError('runtime-disposed', 'AgentRuntime 已释放，不再接受新任务');
        const agent = this.config.agents.get(id);
        if (!agent) {
            throw new CliAgentError('unknown-agent', `未配置的 agent: ${id}；已配置: ${[...this.config.agents.keys()].join(', ') || '（无）'}`);
        }
        if (typeof prompt !== 'string' || prompt.trim() === '') {
            throw new CliAgentError('invalid-prompt', 'prompt 不能为空');
        }
        const sem = this.semaphoreFor(agent);
        await sem.acquire();
        try {
            return await this.runAgent(agent, prompt, options);
        }
        finally {
            sem.release();
        }
    }
    async runAgent(agent, prompt, options) {
        const started = Date.now();
        const timeoutMs = options.timeoutMs ?? agent.timeoutMs;
        const file = resolveCommand(agent.command);
        const argv = buildArgv(agent, prompt);
        const cwd = options.cwd ?? agent.cwd ?? process.cwd();
        this.logger.info('agent-run-start', `agent ${agent.id} 启动`, { argv, cwd, timeoutMs });
        let child;
        try {
            child = spawn(file, argv, {
                cwd,
                env: { ...process.env, ...agent.env },
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            throw new CliAgentError('spawn-failed', `agent ${agent.id} 启动失败: ${err.message}`);
        }
        this.running.add(child);
        const timedOut = { value: false };
        let timedOutAt = 0;
        const timer = setTimeout(() => {
            timedOut.value = true;
            timedOutAt = Date.now();
            this.logger.warn('agent-run-timeout', `agent ${agent.id} 超过 ${timeoutMs}ms，发送终止信号`, {});
            child.kill('SIGTERM');
            setTimeout(() => {
                if (this.running.has(child))
                    child.kill('SIGKILL');
            }, KILL_GRACE_MS).unref();
        }, timeoutMs);
        if (agent.promptInjectionMode === 'stdin-after-start') {
            // 一次性语义：写完立即关 stdin，读 stdin 的 CLI 收到 EOF 后自行完成
            child.stdin?.on('error', () => { });
            child.stdin?.write(prompt);
            child.stdin?.end();
        }
        else {
            child.stdin?.end();
        }
        const failure = new Promise((_, reject) => {
            child.on('error', (err) => reject(new CliAgentError('spawn-failed', `agent ${agent.id} 进程错误: ${err.message}`)));
        });
        try {
            const collected = await Promise.race([
                this.waitForClose(child),
                failure,
            ]);
            const durationMs = Date.now() - started;
            const result = {
                agent: agent.id,
                ok: collected.code === 0 && !timedOut.value,
                exitCode: collected.code,
                signal: collected.signal,
                timedOut: timedOut.value,
                durationMs,
                stdout: collected.stdout,
                stderr: collected.stderr,
                truncated: collected.truncated,
                argv: [agent.command, ...argv],
                cwd,
            };
            if (timedOut.value) {
                result.error = `超过 ${timeoutMs}ms 超时（${Math.round((timedOutAt - started) / 100) / 10}s 时终止）`;
            }
            if (agent.outputFormat === 'json') {
                const extracted = extractJson(collected.stdout);
                if (extracted.failed) {
                    result.parseFailed = true;
                }
                else {
                    result.parsed = extracted.value;
                }
            }
            this.logger.info(timedOut.value ? 'agent-run-timeout-done' : 'agent-run-done', `agent ${agent.id} 结束`, {
                exitCode: collected.code,
                durationMs,
                truncated: collected.truncated,
            });
            return result;
        }
        finally {
            clearTimeout(timer);
            this.running.delete(child);
        }
    }
    waitForClose(child) {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let truncated = false;
            child.stdout?.on('data', (chunk) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes <= MAX_OUTPUT_BYTES)
                    stdout += chunk.toString('utf8');
                else
                    truncated = true;
            });
            child.stderr?.on('data', (chunk) => {
                stderrBytes += chunk.length;
                if (stderrBytes <= MAX_OUTPUT_BYTES)
                    stderr += chunk.toString('utf8');
                else
                    truncated = true;
            });
            child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, truncated }));
            child.on('error', (err) => reject(new CliAgentError('spawn-failed', `进程错误: ${err.message}`)));
        });
    }
    /** 释放：终止全部运行中子进程并等待落定（服务 fiber 卸载时调用）。 */
    async dispose() {
        this.disposed = true;
        const pending = [...this.running];
        for (const child of pending)
            child.kill('SIGTERM');
        if (pending.length === 0)
            return;
        const deadline = Date.now() + KILL_GRACE_MS;
        while (this.running.size > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        for (const child of this.running)
            child.kill('SIGKILL');
        this.logger.info('runtime-disposed', `AgentRuntime 已释放（终止 ${pending.length} 个运行中进程）`, {});
    }
}
