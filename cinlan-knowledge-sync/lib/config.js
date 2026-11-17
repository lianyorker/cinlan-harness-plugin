/**
 * 配置层。
 * - 插件侧：Schemastery schema（cordis loader 在 apply 前校验，配错即加载失败并给准确报错）。
 * - hub 侧：独立进程不走 cordis，用 loadHubConfig 读 JSON + ${ENV} 插值 + 显式校验。
 * 全部连接参数（协议/地址/端口/TLS/超时/token）来自配置文件或环境变量，零硬编码地址。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncError } from './util.js';
import { isValidGrant, isValidScope, scopeAncestors } from './scope.js';
/** 由 schemastery 校验后的插件配置（结构同 NodeSyncConfig，字段可能带默认值）。 */
export function buildConfigSchema(Schema) {
    const hubProfile = Schema.object({
        protocol: Schema.union(['http', 'https']).required(),
        host: Schema.string().required(),
        port: Schema.number(),
        basePath: Schema.string().default(''),
        timeoutMs: Schema.number().default(8000),
        token: Schema.string().role('secret'),
        adminToken: Schema.string().role('secret'),
        tls: Schema.object({
            rejectUnauthorized: Schema.boolean().default(true),
            caFile: Schema.string(),
        }),
    });
    // volatile 分组：settings UI 可直接编辑、写回后免 remount（knowledgeSyncService 接 internal/update 重建运行时）。
    // role('secret') 字段在 settings describe 输出里脱敏，配置页按只写处理。
    return Schema.object({
        node: Schema.object({
            id: Schema.string().required(),
            token: Schema.string().required().role('secret'),
        }).required().volatile(),
        hub: Schema.object({
            activeProfile: Schema.string().default('intranet'),
            // 任意名字的 profile 字典（intranet/extranet 只是约定俗成的示例名）
            profiles: Schema.dict(hubProfile),
        }).required().volatile(),
        sync: Schema.object({
            auto: Schema.boolean().default(true),
            intervalSec: Schema.number().default(300),
            syncOnStart: Schema.boolean().default(true),
            memoryDir: Schema.string(),
            skillRoots: Schema.array(Schema.string()).default([]),
            stateDirName: Schema.string().default('.cinlan-knowledge-sync'),
            scope: Schema.string().default(''),
            readScopes: Schema.array(Schema.string()).default([]),
        }).required().volatile(),
        oneshot: Schema.object({
            enabled: Schema.boolean().default(false),
            commands: Schema.array(Schema.string()).default([]),
            resultFile: Schema.string().default(''),
        }).volatile(),
        log: Schema.object({
            level: Schema.union(['debug', 'info', 'warn', 'error']).default('info'),
            dir: Schema.string().default(''),
        }).volatile(),
    });
}
function defaultPort(protocol) {
    return protocol === 'https' ? 443 : 80;
}
function unwrapVolatile(input) {
    return Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [
        key,
        typeof value?.get === 'function' ? value.get() : value,
    ]));
}
/**
 * 归并插件原始配置为运行时配置。
 * schema 已保证必填项存在；这里负责解析激活 profile、补默认端口、路径绝对化，
 * 并在引用不存在的 profile 或 token 为空时给出能直接定位问题的错误。
 */
/** 跟随 harness 目录派生默认同步根目录：
 *  优先 DSH_PROFILE_DIR（桌面端/CLI 注入的当前 profile 目录），其次 DSH_HOME/profiles/<DSH_PROFILE>，
 *  兜底 <DSH_HOME 或 ~/.dsh>/profiles/default。同一台机器装多套 harness / 多 profile 时，
 *  各实例的本地记忆天然隔离，不依赖写死的用户目录约定（Windows/Mac 双端一致）。 */
function harnessDefaultSyncRoot() {
    const { DSH_PROFILE_DIR, DSH_HOME, DSH_PROFILE } = process.env;
    if (DSH_PROFILE_DIR)
        return path.join(DSH_PROFILE_DIR, 'cinlan-knowledge-sync');
    const home = DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'profiles', DSH_PROFILE || 'default', 'cinlan-knowledge-sync');
}
export function resolveNodeConfig(input, cwd = process.cwd()) {
    const raw = unwrapVolatile(input);
    const problems = [];
    if (!raw.node?.id)
        problems.push('node.id 不能为空');
    const token = raw.node?.token ?? '';
    if (!token)
        problems.push('node.token 不能为空（可用 ${ENV} 或 !!js process.env.X 从环境变量注入）');
    const hubCfg = raw.hub;
    const activeName = hubCfg?.activeProfile || 'intranet';
    const profiles = hubCfg?.profiles ?? {};
    const chosen = profiles[activeName];
    if (!chosen) {
        problems.push(`hub.activeProfile="${activeName}" 在 hub.profiles 中不存在（可用: ${Object.keys(profiles).join(', ') || '无'}）`);
    }
    else {
        if (!chosen.host)
            problems.push(`hub.profiles.${activeName}.host 不能为空`);
        if (chosen.protocol !== 'http' && chosen.protocol !== 'https') {
            problems.push(`hub.profiles.${activeName}.protocol 必须是 http 或 https`);
        }
        const profileToken = chosen.token ?? token;
        if (!profileToken)
            problems.push(`hub.profiles.${activeName}.token 与 node.token 均为空`);
        if (chosen.protocol === 'https' && chosen.tls?.caFile) {
            // CA 文件存在性在连接前校验（http-client 里），这里只查路径非空
        }
    }
    const memoryDirRaw = raw.sync?.memoryDir || harnessDefaultSyncRoot();
    if (!raw.sync?.memoryDir)
        console.info('[cinlan-knowledge-sync] sync.memoryDir 未配置，跟随 harness 目录派生: ' + memoryDirRaw);
    const writeScope = (raw.sync?.scope ?? '').trim();
    if (!isValidScope(writeScope)) {
        problems.push(`sync.scope 非法: ${JSON.stringify(raw.sync?.scope)}（应为 "" 或 proj:<name>[:mod:<name>]，name 仅小写字母/数字/-/_）`);
    }
    // '' 是合法项（全局层）：保留，用户可显式写 readScopes: [''] 收窄到仅全局
    const readScopesRaw = (raw.sync?.readScopes ?? []).map((s) => String(s).trim());
    const badRead = readScopesRaw.filter((s) => !isValidScope(s));
    if (badRead.length) {
        problems.push(`sync.readScopes 有非法项: ${badRead.map((s) => JSON.stringify(s)).join(', ')}`);
    }
    if (problems.length) {
        throw new SyncError('invalid-config', `cinlan-knowledge-sync 配置有 ${problems.length} 处问题:\n  - ${problems.join('\n  - ')}`);
    }
    // 未显式给 readScopes 时取写 scope 的继承闭包：mod 层节点可读 ""+proj+mod
    const readScopes = [...new Set(readScopesRaw.length ? readScopesRaw : scopeAncestors(writeScope))];
    const profile = {
        name: activeName,
        protocol: chosen.protocol,
        host: chosen.host,
        port: chosen.port ?? defaultPort(chosen.protocol),
        basePath: (chosen.basePath ?? '').replace(/\/+$/, ''),
        timeoutMs: chosen.timeoutMs ?? 8000,
        token: chosen.token ?? token,
        adminToken: chosen.adminToken || undefined,
        rejectUnauthorized: chosen.tls?.rejectUnauthorized ?? true,
        caFile: chosen.tls?.caFile || undefined,
    };
    const memoryDir = path.resolve(memoryDirRaw);
    const skillRoots = (raw.sync.skillRoots ?? [path.join(harnessDefaultSyncRoot(), 'skills')]).map((r) => path.resolve(r));
    const stateDir = path.join(memoryDir, raw.sync.stateDirName || '.cinlan-knowledge-sync');
    return {
        nodeId: raw.node.id,
        token,
        profile,
        auto: raw.sync.auto ?? true,
        intervalSec: raw.sync.intervalSec ?? 300,
        syncOnStart: raw.sync.syncOnStart ?? true,
        memoryDir,
        skillRoots,
        writeScope,
        readScopes,
        stateDir,
        logLevel: raw.log?.level ?? 'info',
        logDir: raw.log?.dir ? path.resolve(cwd, raw.log.dir) : path.join(stateDir, 'logs'),
        oneshot: {
            enabled: raw.oneshot?.enabled ?? false,
            commands: raw.oneshot?.commands ?? [],
            resultFile: raw.oneshot?.resultFile ? path.resolve(cwd, raw.oneshot.resultFile) : '',
        },
    };
}
/** 展开 "${ENV_NAME}" 占位符；缺失的环境变量直接报错，不静默替换为空。 */
export function interpolateEnv(text, label) {
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
        const value = process.env[name];
        if (value === undefined || value === '') {
            throw new SyncError('missing-env', `${label}: 环境变量 ${name} 未设置（配置里的 \${${name}} 无法解析）`);
        }
        return value;
    });
}
/** 读取并校验 hub 配置；任何缺失/非法都逐条列出，不静默兜底。 */
export async function loadHubConfig(file, overrides = {}) {
    let rawText;
    try {
        rawText = await fsp.readFile(file, 'utf8');
    }
    catch (err) {
        throw new SyncError('io-error', `无法读取 hub 配置文件 ${file}: ${err.message}`);
    }
    let raw;
    try {
        raw = JSON.parse(interpolateEnv(rawText, path.basename(file)));
    }
    catch (err) {
        if (err instanceof SyncError)
            throw err;
        throw new SyncError('invalid-config', `hub 配置不是合法 JSON: ${file}: ${err.message}`);
    }
    return validateHubConfig(raw, file, overrides);
}
export function validateHubConfig(raw, sourceFile, overrides = {}) {
    const problems = [];
    const listenRaw = (raw.listen ?? {});
    const protocol = listenRaw.protocol;
    if (protocol !== 'http' && protocol !== 'https') {
        problems.push(`listen.protocol 必须是 http 或 https，收到 "${String(protocol)}"`);
    }
    const host = listenRaw.host;
    if (typeof host !== 'string' || !host)
        problems.push('listen.host 不能为空');
    const port = overrides.port ?? listenRaw.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push(`listen.port 必须是 1-65535 的整数，收到 "${String(port)}"`);
    }
    const tls = (listenRaw.tls ?? {});
    if (protocol === 'https') {
        if (!tls.certFile)
            problems.push('listen.protocol=https 时必须提供 listen.tls.certFile');
        if (!tls.keyFile)
            problems.push('listen.protocol=https 时必须提供 listen.tls.keyFile');
    }
    const authRaw = (raw.auth ?? {});
    const adminToken = authRaw.adminToken;
    if (typeof adminToken !== 'string' || !adminToken)
        problems.push('auth.adminToken 不能为空');
    // nodeTokens 两种形态："node": "<token>"（兼容旧配置=全 scope）或
    // "node": {"token": "...", "scopes": ["", "proj:x", "proj:x:*"]}（scope 授权）
    const nodeTokensRaw = (authRaw.nodeTokens ?? {});
    const nodeCredentials = {};
    for (const [node, v] of Object.entries(nodeTokensRaw)) {
        if (!node)
            continue;
        if (typeof v === 'string' && v) {
            nodeCredentials[node] = { token: v, scopes: ['*'] };
            continue;
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const rec = v;
            const t = rec.token;
            if (typeof t !== 'string' || !t) {
                problems.push(`auth.nodeTokens.${node}.token 不能为空`);
                continue;
            }
            const scopes = Array.isArray(rec.scopes) ? rec.scopes.map((s) => String(s)) : null;
            if (!scopes || scopes.length === 0) {
                problems.push(`auth.nodeTokens.${node}.scopes 必须是非空数组`);
                continue;
            }
            const bad = scopes.filter((s) => !isValidGrant(s));
            if (bad.length) {
                problems.push(`auth.nodeTokens.${node}.scopes 有非法授权项: ${bad.map((s) => JSON.stringify(s)).join(', ')}`);
                continue;
            }
            nodeCredentials[node] = { token: t, scopes };
            continue;
        }
        problems.push(`auth.nodeTokens.${node} 必须是 token 字符串或 {token, scopes} 对象`);
    }
    if (Object.keys(nodeCredentials).length === 0 && !problems.length)
        problems.push('auth.nodeTokens 至少要配置一个节点 token');
    const dataDir = typeof raw.dataDir === 'string' && raw.dataDir
        ? path.resolve(path.dirname(sourceFile), raw.dataDir)
        : '';
    if (!dataDir)
        problems.push('dataDir 不能为空');
    if (problems.length) {
        throw new SyncError('invalid-config', `hub 配置 ${sourceFile} 有 ${problems.length} 处问题:\n  - ${problems.join('\n  - ')}`);
    }
    const limitsRaw = (raw.limits ?? {});
    return {
        listen: {
            protocol: protocol,
            host: host,
            port: port,
            tls: protocol === 'https' ? { certFile: tls.certFile, keyFile: tls.keyFile } : undefined,
        },
        auth: { adminToken: adminToken, nodeTokens: nodeCredentials },
        dataDir: dataDir,
        limits: {
            maxBodyBytes: typeof limitsRaw.maxBodyBytes === 'number' ? limitsRaw.maxBodyBytes : 20 * 1024 * 1024,
            maxFileBytes: typeof limitsRaw.maxFileBytes === 'number' ? limitsRaw.maxFileBytes : 5 * 1024 * 1024,
            maxItemsPerPush: typeof limitsRaw.maxItemsPerPush === 'number' ? limitsRaw.maxItemsPerPush : 100,
        },
        log: {
            level: raw.log?.level ?? 'info',
            dir: raw.log?.dir ?? '',
        },
    };
}
/** 比较两份已解析配置，返回发生变化的域：client / local / timer / logger（空数组=无实质变化）。 */
export function diffResolvedConfig(prev, next) {
    const domains = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const hubChanged = !same(prev?.profile, next?.profile);
    const nodeChanged = !same(prev?.nodeId, next?.nodeId) || !same(prev?.token, next?.token);
    if (hubChanged || nodeChanged)
        domains.push('client');
    const localChanged = prev?.memoryDir !== next?.memoryDir
        || !same(prev?.skillRoots, next?.skillRoots)
        || prev?.stateDirName !== next?.stateDirName
        || !same(prev?.scope, next?.scope)
        || !same(prev?.readScopes, next?.readScopes);
    if (localChanged)
        domains.push('local');
    const timerChanged = prev?.auto !== next?.auto || prev?.intervalSec !== next?.intervalSec;
    if (timerChanged)
        domains.push('timer');
    const logChanged = prev?.logLevel !== next?.logLevel || prev?.logDir !== next?.logDir || prev?.nodeId !== next?.nodeId;
    if (logChanged)
        domains.push('logger');
    return domains;
}
