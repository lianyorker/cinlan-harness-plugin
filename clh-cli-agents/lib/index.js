/**
 * @cinlan/clh-cli-agents 主插件行。
 *
 * 提供 ctx.clhCliAgents 服务（list/detect/run/state）并在启动时可选探测全部 agent。
 * 运行时（子进程、并发信号量）随插件 fiber 卸载一并清理（ctx.effect → runtime.dispose）。
 * 参考：stablyai/orca 的声明式 agent 目录 + deepseek-harness 实验包的钩子桥思路
 * （外部工具生态接入 harness 扩展点），本插件把「外部 CLI agent」变成 harness 可派发的执行资源。
 */
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { CliAgentError, buildConfigSchema, resolveConfig, } from './config.js';
import { createLogger, ensureLogDir, logFilePathFor } from './logger.js';
import { AgentRuntime } from './runtime.js';
export const name = 'clh-cli-agents';
export const Config = buildConfigSchema(Schema);
/** loader 以模块整体为插件：先经 Config 校验，再挂 Service 类（constructor 收到校验后的 config）。 */
export function apply(ctx, config) {
    if (!config || typeof config !== 'object') {
        throw new CliAgentError('invalid-config', 'clh-cli-agents 缺少配置。请在 cordis 配置项的 config 块提供 agents 字典'
            + '（每个 agent：command/args/promptInjectionMode/...），示例见 @cinlan/clh-cli-agents/config/*.json');
    }
    ctx.plugin(clhCliAgentsService, config);
}
export class clhCliAgentsService extends Service {
    resolved;
    logger;
    runtime;
    /** 探测结果缓存（detectOnStart 时填充；detectAll 默认读缓存，refresh 时重跑） */
    detectCache = new Map();
    constructor(ctx, config) {
        super(ctx, 'clhCliAgents');
        if (!config) {
            // 不静默兜底：组合里挂了本插件但没给配置 → 直接失败并说明怎么配
            throw new CliAgentError('invalid-config', 'clh-cli-agents 缺少配置。请在 cordis 配置项的 config 块提供 agents 字典，'
                + '示例见 @cinlan/clh-cli-agents/config/*.json');
        }
        this.configure(resolveConfig(config, process.cwd()), 'service-created');
    }
    configure(next, event) {
        this.resolved = next;
        const logFile = next.logDir ? logFilePathFor(next.logDir, 'cli-agents') : undefined;
        if (logFile)
            void ensureLogDir(logFile);
        this.logger = createLogger({
            component: 'clh-cli-agents',
            level: next.logLevel,
            filePath: logFile,
        });
        this.runtime = new AgentRuntime(next, this.logger);
        this.detectCache.clear();
        this.logger.info(event, 'clh-cli-agents 服务已创建', { agents: [...next.agents.keys()] });
    }
    async [Service.init]() {
        const self = this;
        // 资源清理：随 fiber 卸载终止全部运行中子进程
        this.ctx.effect(function* () {
            yield () => self.runtime.dispose();
        }, 'clh-cli-agents runtime');
        if (this.resolved.detectOnStart) {
            const results = await Promise.all(this.runtime.list().map((a) => this.runtime.detect(a.id)));
            for (const r of results) {
                this.detectCache.set(r.agent, r);
                if (r.installed) {
                    this.logger.info('agent-detect-ok', `agent ${r.agent} 就绪`, { version: r.version });
                }
                else {
                    // 不在位只告警不失败：工具行仍可列出，run 时才报错
                    this.logger.warn('agent-detect-missing', `agent ${r.agent} 不在位`, { error: r.error });
                }
            }
        }
    }
    // ---- 对 harness 其他插件 / 模型工具暴露的能力 ----
    get agentIds() {
        return [...this.resolved.agents.keys()];
    }
    list() {
        return this.runtime.list();
    }
    async detect(id, refresh = false) {
        if (!refresh) {
            const cached = this.detectCache.get(id);
            if (cached)
                return cached;
        }
        const result = await this.runtime.detect(id);
        this.detectCache.set(id, result);
        return result;
    }
    async detectAll(refresh = false) {
        return Promise.all(this.list().map((a) => this.detect(a.id, refresh)));
    }
    run(id, prompt, options) {
        return this.runtime.run(id, prompt, options);
    }
    state() {
        return {
            agents: this.list().map((a) => ({ id: a.id, command: a.command, mode: a.promptInjectionMode, protocol: a.protocol })),
            running: this.runtime.runningCount(),
        };
    }
}
