/**
 * hub HTTP 服务：REST + JSON，Bearer token 双角色认证（node / admin）。
 * 每个请求都记日志；任何错误都以 {error:{code,message}} 返回并写日志，不静默。
 * listen.protocol=https 时加载 certFile/keyFile 以 TLS 对外服务（外网部署）。
 */
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { SyncError } from '../util.js';
import { HubStore } from './store.js';
const API = '/api/v1';
export async function startHubServer(cfg, logger) {
    const store = new HubStore(cfg.dataDir, logger, { maxFileBytes: cfg.limits.maxFileBytes, maxItemsPerPush: cfg.limits.maxItemsPerPush });
    await store.load();
    const startedAt = Date.now();
    // ---------- 路由表 ----------
    const routes = new Map();
    const paramRoutes = [];
    const on = (method, p, handler) => {
        routes.set(`${method} ${p}`, handler);
    };
    const onParamRoute = (method, re, handler) => {
        paramRoutes.push({ method, re, handler });
    };
    on('GET', '/healthz', async () => {
        const s = store.stats();
        return {
            ok: true,
            service: 'clh-knowledge-sync-hub',
            uptimeMs: Date.now() - startedAt,
            stats: s,
        };
    });
    // 节点：推送（一律进 pending）
    on('POST', `${API}/push`, async (ctx) => {
        const body = ctx.body;
        if (!body || !Array.isArray(body.items)) {
            throw new SyncError('bad-request', 'body 必须是 {items: [...]}');
        }
        if (body.items.length > cfg.limits.maxItemsPerPush) {
            throw new SyncError('too-many-items', `单次推送条目数超限: ${body.items.length} > ${cfg.limits.maxItemsPerPush}`);
        }
        const results = [];
        for (const payload of body.items) {
            try {
                results.push(await store.enqueuePush(ctx.node, payload));
            }
            catch (err) {
                results.push({
                    kind: payload?.kind ?? 'memory',
                    id: payload?.id ?? '?',
                    status: 'invalid',
                    message: err.message,
                });
            }
        }
        return { node: ctx.node, results };
    });
    // 节点：拉取已发布条目 + tombstone
    on('GET', `${API}/pull`, async (ctx) => {
        const sinceSeq = Number.parseInt(ctx.url.searchParams.get('sinceSeq') ?? '0', 10) || 0;
        const kinds = parseKinds(ctx.url.searchParams.get('kinds'));
        const data = store.pullSince(sinceSeq, kinds);
        return { node: ctx.node, sinceSeq, ...data };
    });
    // 节点：检索已发布条目
    on('GET', `${API}/search`, async (ctx) => {
        const q = ctx.url.searchParams.get('q') ?? '';
        const kinds = parseKinds(ctx.url.searchParams.get('kinds'));
        const limit = Math.min(Number.parseInt(ctx.url.searchParams.get('limit') ?? '20', 10) || 20, 100);
        const results = store.searchPublished(q, kinds, limit);
        return { query: q, total: results.length, results };
    });
    // 节点：取单条已发布内容（skill 全量文件 / memory 全文）
    onParamRoute('GET', /^\/api\/v1\/entries\/(memory|skill)\/(.+)$/, async (ctx, m) => {
        const entry = store.getEntry(m[1], decodeURIComponent(m[2]));
        if (!entry)
            throw new SyncError('not-found', `条目不存在或未过审批: ${m[2]}`);
        return entry;
    });
    // 节点：回读推送审批结果
    on('GET', `${API}/push-status`, async (ctx) => {
        const ids = (ctx.url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0)
            throw new SyncError('bad-request', '需要 ?ids=queueId1,queueId2');
        return { statuses: store.pushStatus(ids) };
    });
    // 管理：待审批列表
    on('GET', `${API}/admin/pending`, async () => ({ pending: store.listPending() }));
    on('GET', `${API}/admin/rejected`, async () => ({ rejected: store.listRejected() }));
    on('GET', `${API}/admin/stats`, async () => store.stats());
    on('POST', `${API}/admin/decisions`, async (ctx) => {
        const body = ctx.body;
        if (!body?.queueId || (body.action !== 'approve' && body.action !== 'reject')) {
            throw new SyncError('bad-request', 'body 必须是 {queueId, action: "approve"|"reject", reason?}');
        }
        return store.decide(body.queueId, body.action, 'admin', body.reason ?? '');
    });
    // 管理：清理流程
    on('GET', `${API}/admin/cleanup-candidates`, async (ctx) => {
        const olderThanDays = ctx.url.searchParams.get('olderThanDays');
        const expiredOnly = ctx.url.searchParams.get('expiredOnly') === 'true';
        return {
            candidates: store.cleanupScan({
                olderThanDays: olderThanDays ? Number.parseInt(olderThanDays, 10) : undefined,
                expiredOnly,
            }),
        };
    });
    on('POST', `${API}/admin/cleanup/propose`, async (ctx) => {
        const body = ctx.body;
        requireTargets(body);
        return { results: await store.cleanupPropose(body.ids, body.reason ?? '', 'admin') };
    });
    on('GET', `${API}/admin/cleanup/flagged`, async () => ({ flagged: store.listFlagged().map(toFlaggedView) }));
    on('POST', `${API}/admin/cleanup/decide`, async (ctx) => {
        const body = ctx.body;
        requireTargets(body);
        if (body.action !== 'approve' && body.action !== 'reject') {
            throw new SyncError('bad-request', 'action 必须是 approve 或 reject');
        }
        return { results: await store.cleanupDecide(body.ids, body.action, 'admin', body.reason ?? '') };
    });
    on('GET', `${API}/admin/integrity`, async () => store.integrityCheck());
    // ---------- 认证 ----------
    const adminDigest = digest(cfg.auth.adminToken).toString('hex');
    const nodeDigests = new Map(Object.entries(cfg.auth.nodeTokens).map(([node, token]) => [digest(token).toString('hex'), node]));
    function authenticate(ctx, needAdmin) {
        const header = ctx.req.headers.authorization ?? '';
        const m = /^Bearer\s+(.+)$/i.exec(header);
        if (!m) {
            throw new SyncError('unauthorized', '缺少 Authorization: Bearer <token>');
        }
        const d = digest(m[1]).toString('hex');
        if (d === adminDigest) {
            return;
        }
        const node = nodeDigests.get(d);
        if (node && !needAdmin) {
            ctx.node = node;
            return;
        }
        logger.warn('auth-denied', '认证失败', { remote: ctx.req.socket.remoteAddress, needAdmin });
        throw new SyncError('unauthorized', needAdmin ? '需要管理员 token' : '需要合法的节点 token');
    }
    // ---------- 请求处理 ----------
    const handle = async (req, res) => {
        const started = Date.now();
        const url = new URL(req.url ?? '/', 'http://hub.local');
        const method = (req.method ?? 'GET').toUpperCase();
        let status = 500;
        let event = 'request';
        try {
            if (url.pathname === '/healthz') {
                const handler = routes.get(`GET /healthz`);
                const data = await handler({ req, res, url, body: undefined });
                status = 200;
                sendJson(res, 200, data);
                return;
            }
            if (!url.pathname.startsWith(API)) {
                status = 404;
                throw new SyncError('not-found', `未知路径（API 前缀 ${API}）: ${url.pathname}`);
            }
            const body = method === 'POST' || method === 'PUT' ? await readBody(req, cfg.limits.maxBodyBytes) : undefined;
            const ctx = { req, res, url, body };
            const needAdmin = url.pathname.includes('/admin/');
            authenticate(ctx, needAdmin);
            const exact = routes.get(`${method} ${url.pathname}`);
            if (exact) {
                const data = await exact(ctx);
                status = 200;
                sendJson(res, 200, data);
                return;
            }
            const param = paramRoutes.find((r) => r.method === method && r.re.test(url.pathname));
            if (param) {
                const m = param.re.exec(url.pathname);
                const data = await param.handler(ctx, m);
                status = 200;
                sendJson(res, 200, data);
                return;
            }
            status = 404;
            throw new SyncError('not-found', `无此接口: ${method} ${url.pathname}`);
        }
        catch (err) {
            const syncErr = err instanceof SyncError ? err : null;
            const code = syncErr?.code ?? 'internal';
            const message = err.message ?? String(err);
            status = syncErr
                ? mapErrorStatus(syncErr)
                : 500;
            if (status === 500) {
                event = 'request-error';
                logger.error(event, `请求处理异常: ${method} ${url.pathname}`, { error: message, stack: err.stack });
            }
            else {
                event = 'request-rejected';
                logger.warn(event, `${method} ${url.pathname} -> ${status}`, { code, error: message });
            }
            sendJson(res, status, { error: { code, message } });
        }
        finally {
            logger.info('http', `${method} ${url.pathname} -> ${status}`, { ms: Date.now() - started });
        }
    };
    const server = cfg.listen.protocol === 'https'
        ? createHttpsServer({
            cert: readFileSync(absFromConfig(cfg.listen.tls.certFile)),
            key: readFileSync(absFromConfig(cfg.listen.tls.keyFile)),
        }, handle)
        : createServer(handle);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.listen.port, cfg.listen.host, () => resolve());
    });
    return {
        server,
        port: cfg.listen.port,
        store,
        async close() {
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
// ---------- 内部小工具 ----------
function parseKinds(raw) {
    if (!raw)
        return ['memory', 'skill'];
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
        if (p !== 'memory' && p !== 'skill')
            throw new SyncError('bad-request', `kinds 含非法值: ${p}（只允许 memory, skill）`);
    }
    return parts.length ? parts : ['memory', 'skill'];
}
function requireTargets(body) {
    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
        throw new SyncError('bad-request', 'body 必须是 {ids: [{kind, id}...], reason?}');
    }
}
function toFlaggedView(e) {
    return { kind: e.kind, id: e.id, title: e.title, cleanupFlag: e.cleanupFlag };
}
function mapErrorStatus(err) {
    switch (err.code) {
        case 'unauthorized': return 401;
        case 'not-found': return 404;
        case 'bad-request':
        case 'empty-query':
        case 'reason-required':
        case 'invalid-config':
        case 'too-many-items':
            return 400;
        case 'payload-too-large': return 413;
        default: return 400;
    }
}
function sendJson(res, status, data) {
    const buf = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
}
async function readBody(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
            throw new SyncError('payload-too-large', `请求体超过上限 ${maxBytes} 字节`);
        }
        chunks.push(chunk);
    }
    if (size === 0)
        return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new SyncError('bad-request', '请求体不是合法 JSON');
    }
}
function digest(token) {
    return createHash('sha256').update(token, 'utf8').digest();
}
function absFromConfig(file) {
    return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}
