/**
 * @cinlan/clh-knowledge-sync 主插件行。
 *
 * 提供 ctx.clhKnowledgeSync 服务（push/pull/search/status/doctor + 状态快照），
 * 并按配置启动：oneshot 模式（跑完指定指令落结果文件后退出）或
 * 常驻模式（syncOnStart 首轮同步 + auto 定时循环）。
 * 定时器与日志随插件 fiber 卸载一并清理（ctx.effect）。
 */
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { buildConfigSchema, resolveNodeConfig } from './config.js';
import { createLogger, ensureLogDir, logFilePathFor } from './logger.js';
import { SyncError } from './util.js';
import { HubClient } from './node/http-client.js';
import { LocalStore } from './node/local-store.js';
import { SyncEngine } from './node/engine.js';
export const name = 'clh-knowledge-sync';
export const Config = buildConfigSchema(Schema);
/** loader 以模块整体为插件：先经 Config 校验，再挂 Service 类（constructor 收到校验后的 config）。 */
export function apply(ctx, config) {
    ctx.plugin(clhKnowledgeSyncService, config);
}
export class clhKnowledgeSyncService extends Service {
    resolved;
    logger;
    client;
    local;
    engine;
    initialized = false;
    constructor(ctx, config) {
        super(ctx, 'clhKnowledgeSync');
        if (!config) {
            // 不静默兜底：组合里挂了本插件但没给配置 → 直接 FAILED 并说明怎么配
            throw new SyncError('invalid-config', 'clh-knowledge-sync 缺少配置。请在 cordis 配置项的 config 块提供 node(id/token)、hub.profiles(内网 http / 外网 https)、sync.memoryDir；示例见 @cinlan/clh-knowledge-sync/config/*.json');
        }
        this.configure(resolveNodeConfig(config, process.cwd()), 'service-created');
        // volatile 配置项经 settings UI/补丁热更时不 remount fiber：接 internal/update 重建运行时
        ctx.on('internal/update', (nextConfig, next) => {
            this.applyUpdate(nextConfig);
            return next();
        });
    }
    /** 停旧运行时并按新配置重建 client/local/engine；已初始化时恢复同步循环。 */
    applyUpdate(raw) {
        let next;
        try {
            next = resolveNodeConfig(raw, process.cwd());
        }
        catch (err) {
            this.logger.warn('config-update-rejected', `volatile 配置更新无效，保留当前运行时: ${err.message}`);
            return;
        }
        const wasRunning = this.initialized;
        this.stopRuntime();
        this.configure(next, 'config-reloaded');
        if (!wasRunning)
            return;
        void this.engine.loadState().then(() => {
            if (this.resolved.syncOnStart)
                void this.engine.runCycle().catch(() => { });
            if (this.resolved.auto)
                this.engine.startAuto();
        }).catch((err) => this.logger.error('state-load-failed', '状态恢复失败', { error: err.message }));
    }
    /** 按已解析配置重建运行时对象（logger/client/local/engine）。 */
    configure(next, event) {
        this.resolved = next;
        void ensureLogDir(this.resolved.logDir);
        this.logger = createLogger({
            component: `clh-knowledge-sync:${this.resolved.nodeId}`,
            level: this.resolved.logLevel,
            filePath: logFilePathFor(this.resolved.logDir, 'sync'),
        });
        this.client = new HubClient(this.resolved.profile, this.logger);
        this.local = new LocalStore(this.resolved, this.logger);
        this.engine = new SyncEngine(this.resolved, this.client, this.local, this.logger);
        this.logger.info(event, 'clh-knowledge-sync 服务已创建/重载', {
            hub: this.resolved.profile.protocol + '://' + this.resolved.profile.host + ':' + this.resolved.profile.port,
            profile: this.resolved.profile.name,
            memoryDir: this.resolved.memoryDir,
        });
    }
    async [Service.init]() {
        const ctx = this.ctx;
        const self = this;
        await this.engine.loadState();
        // 资源清理：随 fiber 卸载停定时器、关日志
        ctx.effect(function* () {
            yield () => self.stopRuntime();
        }, 'clh-knowledge-sync runtime');
        if (this.resolved.oneshot.enabled) {
            // 无界面驱动：跑完指令写结果文件，退出码反映成败
            const { ok } = await this.engine.oneshot(this.resolved.oneshot.commands, this.resolved.oneshot.resultFile);
            this.logger.info('oneshot-done', `oneshot 完成: ${ok ? '全部成功' : '存在失败'}`, { ok });
            setImmediate(() => process.exit(ok ? 0 : 1));
            return;
        }
        this.initialized = true;
        if (this.resolved.syncOnStart) {
            void this.engine.runCycle().catch(() => { });
        }
        if (this.resolved.auto) {
            this.engine.startAuto();
        }
    }
    stopRuntime() {
        this.engine.stopAuto();
        this.logger.info('service-stopped', 'clh-knowledge-sync 服务已卸载');
    }
    // ---- 对 harness 其他插件 / 模型工具暴露的能力 ----
    get nodeId() {
        return this.resolved.nodeId;
    }
    get hub() {
        return this.client.describe();
    }
    push(force = false, kind) {
        return this.engine.pushCycle(force, kind);
    }
    pull(kind) {
        return this.engine.pullCycle(kind);
    }
    search(query, limit) {
        return this.engine.search(query, limit);
    }
    status() {
        return this.engine.statusCycle();
    }
    doctor() {
        return this.engine.doctor();
    }
    state() {
        return this.engine.stateSnapshot();
    }
}
