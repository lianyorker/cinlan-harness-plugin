/**
 * 节点与管理 CLI。
 * 节点侧：读取与插件同构的 JSON 配置，直接走引擎（不经 cordis）——
 *   clh-knowledge-sync --config node.config.json <doctor|push|pull|search|status|skills-pull>
 * 管理侧：对运行中的 hub 发 HTTP admin 请求——
 *   clh-knowledge-sync admin --hub-config hub.config.json <pending|decide|stats|cleanup-...>
 * 任何失败都打印错误并以非零码退出。
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createLogger, ensureLogDir, logFilePathFor } from '../logger.js';
import { loadHubConfig, resolveNodeConfig, interpolateEnv } from '../config.js';
import { SyncError, nowIso } from '../util.js';
import { HubClient } from '../node/http-client.js';
import { LocalStore } from '../node/local-store.js';
import { SyncEngine } from '../node/engine.js';
function parseArgs(argv) {
    const args = { flags: new Set(), positional: [] };
    const copy = [...argv];
    while (copy.length) {
        const a = copy.shift();
        if (a === '--config')
            args.config = copy.shift();
        else if (a === '--hub-config')
            args.hubConfig = copy.shift();
        else if (a.startsWith('--'))
            args.flags.add(a.slice(2));
        else
            args.positional.push(a);
    }
    return args;
}
async function loadNodeConfigFile(file) {
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    }
    catch (err) {
        throw new SyncError('io-error', `无法读取节点配置 ${file}: ${err.message}`);
    }
    let raw;
    try {
        raw = JSON.parse(interpolateEnv(text, path.basename(file)));
    }
    catch (err) {
        if (err instanceof SyncError)
            throw err;
        throw new SyncError('invalid-config', `节点配置不是合法 JSON: ${file}: ${err.message}`);
    }
    return resolveNodeConfig(raw, path.dirname(path.resolve(file)));
}
async function makeEngine(cfg) {
    await ensureDirShim(cfg.stateDir);
    await ensureLogDir(cfg.logDir);
    const logger = createLogger({
        component: `node:${cfg.nodeId}`,
        level: cfg.logLevel,
        filePath: logFilePathFor(cfg.logDir, 'sync'),
    });
    const client = new HubClient(cfg.profile, logger);
    const local = new LocalStore(cfg, logger);
    const engine = new SyncEngine(cfg, client, local, logger);
    return { engine, logger };
}
async function ensureDirShim(dir) {
    const { ensureDir } = await import('../util.js');
    await ensureDir(dir);
}
export async function runNodeCli(argv) {
    const args = parseArgs(argv);
    const cmd = args.positional[0];
    if (!cmd || cmd === 'help') {
        printUsage();
        return cmd ? 0 : 2;
    }
    if (cmd === 'admin') {
        // admin 走 hub 侧，不需要节点配置
        try {
            return await runAdmin(args);
        }
        catch (err) {
            const message = err instanceof SyncError ? `${err.code}: ${err.message}` : err.message;
            console.error(`[clh-knowledge-sync] admin 失败: ${message}`);
            return 1;
        }
    }
    if (!args.config) {
        console.error('缺少 --config <node.config.json>');
        printUsage();
        return 2;
    }
    try {
        const cfg = await loadNodeConfigFile(args.config);
        if (cmd === 'admin') {
            // admin 子命令复用同一 config 文件里的 hub 地址不可靠（那是节点视角），要求 --hub-config
            return await runAdmin(args);
        }
        const { engine, logger } = await makeEngine(cfg);
        switch (cmd) {
            case 'doctor': {
                const result = await engine.doctor();
                console.log(JSON.stringify(result, null, 2));
                return result.ok ? 0 : 1;
            }
            case 'push': {
                const result = await engine.pushCycle(args.flags.has('force'), args.flags.has('skills') ? 'skill' : args.flags.has('memory') ? 'memory' : undefined);
                console.log(JSON.stringify(result, null, 2));
                return (result.errors?.length ?? 0) > 0 ? 1 : 0;
            }
            case 'pull': {
                const result = await engine.pullCycle();
                console.log(JSON.stringify(result, null, 2));
                return 0;
            }
            case 'skills-pull': {
                const result = await engine.pullCycle('skill');
                console.log(JSON.stringify(result, null, 2));
                return 0;
            }
            case 'search': {
                const query = args.positional.slice(1).join(' ');
                if (!query) {
                    console.error('用法: clh-knowledge-sync --config ... search <关键词>');
                    return 2;
                }
                const result = await engine.search(query);
                console.log(JSON.stringify(result, null, 2));
                return 0;
            }
            case 'status': {
                const result = await engine.statusCycle();
                const state = engine.stateSnapshot();
                console.log(JSON.stringify({ status: result, state }, null, 2));
                return 0;
            }
            default:
                console.error(`未知命令: ${cmd}`);
                printUsage();
                return 2;
        }
    }
    catch (err) {
        if (err instanceof SyncError) {
            console.error(`[clh-knowledge-sync] ${cmd} 失败: ${err.code}: ${err.message}`);
        }
        else {
            console.error(`[clh-knowledge-sync] ${cmd} 失败: ${err.message}`);
        }
        return 1;
    }
}
async function runAdmin(args) {
    if (!args.hubConfig) {
        console.error('admin 命令需要 --hub-config <hub.config.json>（从中读取监听地址与管理 token）');
        return 2;
    }
    const cfg = await loadHubConfig(path.resolve(args.hubConfig));
    const protocol = cfg.listen.protocol;
    const base = `${protocol}://127.0.0.1:${cfg.listen.port}`;
    const sub = args.positional[1];
    const client = new HubClient({
        name: 'admin-cli', protocol, host: '127.0.0.1', port: cfg.listen.port,
        basePath: '', timeoutMs: 10000, token: cfg.auth.adminToken, rejectUnauthorized: false,
    }, createLogger({ component: 'admin-cli', quiet: true }));
    const adminHeaders = { authorization: `Bearer ${cfg.auth.adminToken}` };
    const out = (v) => console.log(JSON.stringify(v, null, 2));
    switch (sub) {
        case 'pending': {
            out(await client.request('GET', '/api/v1/admin/pending', { headers: adminHeaders }));
            return 0;
        }
        case 'stats': {
            out(await client.request('GET', '/api/v1/admin/stats', { headers: adminHeaders }));
            return 0;
        }
        case 'decide': {
            const queueId = args.positional[2];
            const action = args.positional[3];
            const reason = args.positional.slice(4).join(' ');
            if (!queueId || (action !== 'approve' && action !== 'reject')) {
                console.error('用法: admin decide <queueId> <approve|reject> [拒绝原因]');
                return 2;
            }
            out(await client.request('POST', '/api/v1/admin/decisions', { headers: adminHeaders, body: { queueId, action, reason } }));
            return 0;
        }
        case 'cleanup-scan': {
            const q = new URLSearchParams();
            if (args.flags.has('expired-only'))
                q.set('expiredOnly', 'true');
            for (const f of args.flags) {
                if (/^older-than-days=.+$/.test(f))
                    q.set('olderThanDays', f.split('=')[1]);
            }
            out(await client.request('GET', `/api/v1/admin/cleanup-candidates?${q}`, { headers: adminHeaders }));
            return 0;
        }
        case 'cleanup-propose': {
            const targets = parseTargets(args.positional.slice(2));
            const reason = flagValue(args.flags, 'reason') ?? 'admin cleanup';
            out(await client.request('POST', '/api/v1/admin/cleanup/propose', { headers: adminHeaders, body: { ids: targets, reason } }));
            return 0;
        }
        case 'cleanup-flagged': {
            out(await client.request('GET', '/api/v1/admin/cleanup/flagged', { headers: adminHeaders }));
            return 0;
        }
        case 'cleanup-decide': {
            const action = args.positional[2];
            if (action !== 'approve' && action !== 'reject') {
                console.error('用法: admin cleanup-decide <approve|reject> --ids kind:id,... [--reason ...]');
                return 2;
            }
            const idsFlag = flagValue(args.flags, 'ids');
            if (!idsFlag) {
                console.error('缺少 --ids kind:id,kind:id');
                return 2;
            }
            const targets = idsFlag.split(',').filter(Boolean).map((s) => {
                const [kind, id] = s.split(':');
                return { kind: kind, id: id };
            });
            const reason = flagValue(args.flags, 'reason') ?? '';
            out(await client.request('POST', '/api/v1/admin/cleanup/decide', { headers: adminHeaders, body: { ids: targets, action, reason } }));
            return 0;
        }
        default:
            console.error(`未知 admin 子命令: ${sub}`);
            return 2;
    }
}
function parseTargets(list) {
    const out = [];
    for (const item of list) {
        const [kind, id] = item.split(':');
        if ((kind !== 'memory' && kind !== 'skill') || !id) {
            throw new SyncError('bad-request', `条目参数应为 kind:id（memory|skill），收到 "${item}"`);
        }
        out.push({ kind, id });
    }
    return out;
}
function flagValue(flags, name) {
    for (const f of flags) {
        if (f.startsWith(`${name}=`))
            return f.slice(name.length + 1);
    }
    return undefined;
}
function printUsage() {
    console.log(`用法:
  clh-knowledge-sync --config <node.config.json> doctor
  clh-knowledge-sync --config <node.config.json> push [--force] [--memory|--skills]
  clh-knowledge-sync --config <node.config.json> pull|skills-pull
  clh-knowledge-sync --config <node.config.json> search <关键词>
  clh-knowledge-sync --config <node.config.json> status
  clh-knowledge-sync admin --hub-config <hub.config.json> pending|stats
  clh-knowledge-sync admin --hub-config <hub.config.json> decide <queueId> <approve|reject> [原因]
  clh-knowledge-sync admin --hub-config <hub.config.json> cleanup-scan [--older-than-days=N] [--expired-only]
  clh-knowledge-sync admin --hub-config <hub.config.json> cleanup-propose kind:id,... --reason=...
  clh-knowledge-sync admin --hub-config <hub.config.json> cleanup-flagged
  clh-knowledge-sync admin --hub-config <hub.config.json> cleanup-decide <approve|reject> --ids kind:id,... [--reason=...]

说明: ${nowIso()} 时点状态以 status 输出为准；审批被拒时 status 会带 reason。`);
}
void fsp;
