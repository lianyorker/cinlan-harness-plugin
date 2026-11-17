/**
 * @cinlan/knowledge-sync 主插件行。
 *
 * 提供 ctx.knowledgeSync 服务（push/pull/search/status/doctor + 状态快照），
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
export const name = 'cinlan-knowledge-sync';
export const Config = buildConfigSchema(Schema);
/** loader 以模块整体为插件：先经 Config 校验，再挂 Service 类（constructor 收到校验后的 config）。 */
export function apply(ctx, config) {
    ctx.plugin(knowledgeSyncService, config);
}
export class knowledgeSyncService extends Service {
    resolved;
    logger;
    client;
    local;
    engine;
    initialized = false;
    /**
     * Typert Gateway 绑定：等价于 typert-protocol 的 bindTypertRemote 产物
     * （本插件不依赖该包，手工构造同形 frozen 对象）。api/gateway 的 SRC 发现
     * 靠它把 knowledgeSync/* 端点认领进 /api RPC；仅 owner Peer 可调
     * （无 resources 声明的方法对非 owner 一律 deny）。
     */
    typertRemote = Object.freeze({
        service: this,
        serviceKey: 'knowledgeSync',
        namespace: 'knowledgeSync',
    });
    constructor(ctx, config) {
        super(ctx, 'knowledgeSync');
        if (!config) {
            // 不静默兜底：组合里挂了本插件但没给配置 → 直接 FAILED 并说明怎么配
            throw new SyncError('invalid-config', 'cinlan-knowledge-sync 缺少配置。请在 cordis 配置项的 config 块提供 node(id/token)、hub.profiles(内网 http / 外网 https)、sync.memoryDir；示例见 @cinlan/knowledge-sync/config/*.json');
        }
        this.configure(resolveNodeConfig(config, process.cwd()), 'service-created');
        // volatile 配置项经 settings UI/补丁热更时不 remount fiber：接 internal/update 重建运行时
        ctx.on('internal/update', (nextConfig, next) => {
            this.applyUpdate(nextConfig);
            return next();
        });
    }
    /** 热更新语义（规范对齐）：按配置 diff 分域增量重建——
     *  只改 hub 连接才换 client；只改本地目录才换 local/store；
     *  只改间隔/开关仅调整定时器；都不变则零重建。连接与同步状态全程保留。 */
    applyUpdate(raw) {
        let next;
        try {
            next = resolveNodeConfig(raw, process.cwd());
        }
        catch (err) {
            this.logger.warn('config-update-rejected', `volatile 配置更新无效，保留当前运行时: ${err.message}`);
            return;
        }
        const prev = this.resolved;
        const diff = diffResolvedConfig(prev, next);
        if (!diff.length) {
            this.logger.info('config-unchanged', '配置无实质变化，跳过重建');
            return;
        }
        this.logger.info('config-updating', '配置变更（增量重建）', { domains: diff });
        // 需要换 client：hub 连接参数变化
        if (diff.includes('client')) {
            this.client = new HubClient(next.profile, this.logger);
        }
        // 需要换 local：本地目录/scope 变化（同步状态目录随 memoryDir 走，必须重载）
        if (diff.includes('local')) {
            this.local = new LocalStore(next, this.logger);
            this.engine = new SyncEngine(next, this.client, this.local, this.logger);
            void this.engine.loadState().then(() => {
                if (this.initialized && this.resolved.auto)
                    this.engine.startAuto();
            }).catch((err) => this.logger.error('state-load-failed', '状态恢复失败', { error: err.message }));
        }
        // 定时器参数变化：仅重启 auto 循环，连接保留
        if (diff.includes('timer') && !diff.includes('local')) {
            this.engine.stopAuto();
            if (this.initialized && next.auto)
                this.engine.startAuto();
        }
        // 日志级别变化：只换 logger
        if (diff.includes('logger')) {
            this.logger = createLogger({
                component: `clh-knowledge-sync:${next.nodeId}`,
                level: next.logLevel,
                filePath: logFilePathFor(next.logDir, 'sync'),
            });
            this.engine && (this.engine.logger = this.logger);
            this.client && (this.client.logger = this.logger);
        }
        this.resolved = next;
        this.logger.info('config-reloaded', '配置已热更新', {
            domains: diff,
            hub: next.profile.protocol + '://' + next.profile.host + ':' + next.profile.port,
            memoryDir: next.memoryDir,
        });
    }
    /** 按已解析配置重建运行时对象（logger/client/local/engine）。 */
    configure(next, event) {
        this.resolved = next;
        void ensureLogDir(this.resolved.logDir);
        this.logger = createLogger({
            component: `cinlan-knowledge-sync:${this.resolved.nodeId}`,
            level: this.resolved.logLevel,
            filePath: logFilePathFor(this.resolved.logDir, 'sync'),
        });
        this.client = new HubClient(this.resolved.profile, this.logger);
        this.local = new LocalStore(this.resolved, this.logger);
        this.engine = new SyncEngine(this.resolved, this.client, this.local, this.logger);
        this.logger.info(event, 'cinlan-knowledge-sync 服务已创建/重载', {
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
        }, 'cinlan-knowledge-sync runtime');
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
        this.logger.info('service-stopped', 'cinlan-knowledge-sync 服务已卸载');
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
    search(query, limit, opts = {}) {
        return this.engine.search(query, limit, opts);
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
    // ---- Typert Remote 代理方法：经 hub admin API（profiles.<p>.adminToken）给面板用 ----
    // 方法签名参数即 wire 字段名（gateway 反射函数签名）；参数必须是简单标识符，
    // 不得解构/默认值/rest。返回与参数都只允许 JSON-safe 值。
    /** 待审批队列。 */
    adminPending() {
        return this.client.adminRequest('GET', '/api/v1/admin/pending');
    }
    /** 已拒绝队列。 */
    adminRejected() {
        return this.client.adminRequest('GET', '/api/v1/admin/rejected');
    }
    /** 审批决定。action = 'approve' | 'reject'；reject 必填 reason。 */
    adminDecide(queueId, action, reason) {
        if (action !== 'approve' && action !== 'reject') {
            throw new SyncError('bad-request', `action 必须是 approve 或 reject，收到 ${String(action)}`);
        }
        if (action === 'reject' && !reason) {
            throw new SyncError('reason-required', '拒绝审批必须给出 reason');
        }
        return this.client.adminRequest('POST', '/api/v1/admin/decisions', {
            body: { queueId, action, reason: reason || undefined },
        });
    }
    /** 总库轻量列表；kinds 传 'memory,skill' 的逗号串或空串，q 为包含过滤，scope 精确过滤（'' 或 '*' = 全部）。 */
    adminEntries(kinds, q, scope) {
        const query = {};
        if (kinds)
            query.kinds = kinds;
        if (q)
            query.q = q;
        if (scope && scope !== '*')
            query.scope = scope;
        return this.client.adminRequest('GET', '/api/v1/admin/entries', { query });
    }
    /** 总库单条详情（含正文/文件）；scope 缺省为全局 ''——同 id 跨 scope 时必须传。 */
    adminEntry(kind, id, scope) {
        if (kind !== 'memory' && kind !== 'skill') {
            throw new SyncError('bad-request', `kind 必须是 memory 或 skill，收到 ${String(kind)}`);
        }
        const s = scope || '';
        return this.client.adminRequest('GET', `/api/v1/admin/entries/${kind}/${encodeURIComponent(id)}`, {
            query: s ? { scope: s } : {},
        });
    }
    /** 存储统计。 */
    adminStats() {
        return this.client.adminRequest('GET', '/api/v1/admin/stats');
    }
}
// Typert Gateway SRC 发现：把 admin* 方法标记为可经 /api 调用的 Remote 方法。
// 等价于 @deepseek-ai/dsh-typert-protocol 的 @Remote 装饰器产物
// （descriptor key 与 {version,methods} 形状一致）；本插件不依赖该包，直接写死。
// 未列在此的方法（push/pull/search/status/doctor/state）不对客户端开放。
Object.defineProperty(knowledgeSyncService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
    value: Object.freeze({
        version: 1,
        methods: Object.freeze([
            { method: 'adminPending', invocation: Object.freeze({ kind: 'direct' }) },
            { method: 'adminRejected', invocation: Object.freeze({ kind: 'direct' }) },
            { method: 'adminDecide', invocation: Object.freeze({ kind: 'direct' }) },
            { method: 'adminEntries', invocation: Object.freeze({ kind: 'direct' }) },
            { method: 'adminEntry', invocation: Object.freeze({ kind: 'direct' }) },
            { method: 'adminStats', invocation: Object.freeze({ kind: 'direct' }) },
        ]),
    }),
});
