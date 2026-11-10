/**
 * hub 端存储与审批状态机。
 *
 * 写入路径受审批闸门控制：节点推送一律先进 pending/，只有管理员 approve 后
 * 才落进 published/ 进入检索与 pull 视野——未审批内容对其他节点完全不可见。
 * 清理流程：scan（过期/超龄）→ propose（标记，仍可见）→ approve（挪入 archive/
 * 软删除并落 tombstone 让节点同步删除）→ 全程写 audit.jsonl。
 * 每个区一份 JSON 文件，写盘用临时文件+rename 原子替换。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { canRead, isValidScope, scopeFilePrefix } from '../scope.js';
import { SyncError, contentHash, ensureDir, newId, nowIso, readJson, removePath, writeJson, } from '../util.js';
/** 条目唯一键：scope 参与主键——不同项目的同名 id 不再碰撞。 */
const entryKey = (kind, id, scope = '') => `${scope}|${kind}:${id}`;
/** published 磁盘文件名：scope 前缀保证同 id 跨 scope 不互相覆盖。 */
const publishedFileName = (entry) => `${scopeFilePrefix(entry.scope ?? '')}${entry.id}.json`;
export class HubStore {
    dataDir;
    logger;
    limits;
    published = new Map();
    pending = new Map();
    rejected = new Map();
    approvals = new Map();
    tombstones = new Map();
    seq = 0;
    corruptFiles = 0;
    archivedCount = 0;
    constructor(dataDir, logger, limits) {
        this.dataDir = dataDir;
        this.logger = logger;
        this.limits = limits;
    }
    dirFor(kind, area) {
        return path.join(this.dataDir, kind === 'memory' ? 'memory' : 'skills', area);
    }
    auditFile() {
        return path.join(this.dataDir, 'state', 'audit.jsonl');
    }
    async audit(op, fields) {
        await appendAudit(this.auditFile(), { op, ...fields });
    }
    /** 启动时从磁盘恢复全部状态；损坏文件计入 corruptFiles 并在 stats 中暴露，不静默丢弃。 */
    async load() {
        for (const kind of ['memory', 'skill']) {
            for (const area of ['published', 'pending', 'rejected', 'archive']) {
                await ensureDir(this.dirFor(kind, area));
            }
        }
        await ensureDir(path.join(this.dataDir, 'state'));
        for (const kind of ['memory', 'skill']) {
            for (const file of await listJsonFiles(this.dirFor(kind, 'published'))) {
                try {
                    const entry = await readJson(file);
                    // 迁移：scope 引入前的文件视为全局层
                    entry.scope ??= '';
                    this.published.set(entryKey(entry.kind, entry.id, entry.scope), entry);
                    if (entry.seq > this.seq)
                        this.seq = entry.seq;
                    this.archivedCount = this.archivedCount;
                }
                catch (err) {
                    this.corruptFiles++;
                    this.logger.error('store-corrupt', `published 文件损坏，已跳过: ${file}`, { error: err.message });
                }
            }
            for (const file of await listJsonFiles(this.dirFor(kind, 'pending'))) {
                try {
                    const item = await readJson(file);
                    item.payload.scope ??= '';
                    item.scope ??= item.payload.scope;
                    this.pending.set(item.queueId, item);
                }
                catch (err) {
                    this.corruptFiles++;
                    this.logger.error('store-corrupt', `pending 文件损坏，已跳过: ${file}`, { error: err.message });
                }
            }
            for (const file of await listJsonFiles(this.dirFor(kind, 'rejected'))) {
                try {
                    const item = await readJson(file);
                    item.payload.scope ??= '';
                    item.scope ??= item.payload.scope;
                    this.rejected.set(item.queueId, item);
                }
                catch (err) {
                    this.corruptFiles++;
                    this.logger.error('store-corrupt', `rejected 文件损坏，已跳过: ${file}`, { error: err.message });
                }
            }
            this.archivedCount = (await listJsonFiles(this.dirFor(kind, 'archive'))).length;
        }
        try {
            const seqState = await readJson(path.join(this.dataDir, 'state', 'seq.json'));
            this.seq = Math.max(this.seq, seqState.seq ?? 0);
        }
        catch {
            /* 首次启动无 seq.json，属正常 */
        }
        try {
            const tomb = await readJson(path.join(this.dataDir, 'state', 'tombstones.json'));
            // 迁移：旧 key 为 kind:id（scope 缺失视为全局），重键到 scope|kind:id
            for (const t of Object.values(tomb)) {
                t.scope ??= '';
                this.tombstones.set(entryKey(t.kind, t.id, t.scope), t);
            }
            for (const t of this.tombstones.values())
                if (t.seq > this.seq)
                    this.seq = t.seq;
        }
        catch {
            /* 无 tombstones 亦正常 */
        }
        try {
            const appr = await readJson(path.join(this.dataDir, 'state', 'approvals.json'));
            for (const [k, v] of Object.entries(appr))
                this.approvals.set(k, v);
        }
        catch {
            /* 同上 */
        }
        this.logger.info('store-loaded', 'hub 存储已加载', {
            published: this.published.size,
            pending: this.pending.size,
            rejected: this.rejected.size,
            tombstones: this.tombstones.size,
            corrupt: this.corruptFiles,
        });
    }
    async persistSeq() {
        await writeJson(path.join(this.dataDir, 'state', 'seq.json'), { seq: this.seq });
    }
    async persistApprovals() {
        await writeJson(path.join(this.dataDir, 'state', 'approvals.json'), Object.fromEntries(this.approvals.entries()));
    }
    // ---------------- 推送（进 pending，不直接发布） ----------------
    validatePayload(payload) {
        if (payload.kind !== 'memory' && payload.kind !== 'skill')
            return `kind 非法: ${String(payload.kind)}`;
        if (!payload.id || typeof payload.id !== 'string')
            return 'id 不能为空';
        if (payload.scope !== undefined && !isValidScope(payload.scope)) {
            return `scope 非法: ${JSON.stringify(payload.scope)}（应为 "" 或 proj:<name>[:mod:<name>]）`;
        }
        if (!payload.hash || typeof payload.hash !== 'string')
            return 'hash 不能为空';
        if (payload.kind === 'memory') {
            if (!payload.title)
                return 'memory 条目缺少 title';
            if (typeof payload.content !== 'string')
                return 'memory 条目缺少 content';
        }
        else {
            if (!payload.title)
                return 'skill 条目缺少 title（即 skill 名）';
            if (!Array.isArray(payload.files) || payload.files.length === 0)
                return 'skill 条目缺少 files';
            for (const f of payload.files) {
                if (!f.path || typeof f.content !== 'string' || (f.encoding !== 'utf8' && f.encoding !== 'base64')) {
                    return `skill 文件非法: ${JSON.stringify(f.path)}`;
                }
                const size = f.encoding === 'base64' ? Math.floor(f.content.length * 3 / 4) : Buffer.byteLength(f.content, 'utf8');
                if (size > this.limits.maxFileBytes) {
                    return `skill 文件超出单文件上限 ${this.limits.maxFileBytes} 字节: ${f.path}`;
                }
            }
        }
        return null;
    }
    async enqueuePush(node, payload) {
        const invalid = this.validatePayload(payload);
        if (invalid)
            return { kind: payload.kind ?? 'memory', id: payload.id ?? '?', scope: payload.scope ?? '', status: 'invalid', message: invalid };
        payload.scope ??= '';
        const key = entryKey(payload.kind, payload.id, payload.scope);
        const existing = this.published.get(key);
        if (existing && existing.hash === payload.hash) {
            return { kind: payload.kind, id: payload.id, scope: payload.scope, status: 'duplicate', serverVersion: existing.version };
        }
        if (existing && !payload.force) {
            const stale = payload.baseVersion !== undefined && payload.baseVersion < existing.version;
            const blindside = payload.baseVersion === undefined;
            if (stale || blindside) {
                this.logger.warn('push-conflict', '推送与已发布版本冲突，要求节点先拉取或显式 force', {
                    node, kind: payload.kind, id: payload.id, serverVersion: existing.version, clientBaseVersion: payload.baseVersion ?? null,
                });
                return {
                    kind: payload.kind,
                    id: payload.id,
                    scope: payload.scope,
                    status: 'conflict',
                    message: stale
                        ? `服务端已有更新版本 v${existing.version}（本地 base v${payload.baseVersion}）；先 pull 合并后重推，或 force 覆盖`
                        : `服务端已存在该 id（v${existing.version}）且内容不同；先 pull 确认后重推，或 force 覆盖`,
                    serverVersion: existing.version,
                    serverHash: existing.hash,
                };
            }
        }
        for (const item of this.pending.values()) {
            // 去重以 scope|kind:id 为准：跨 scope 的同 id 是不同条目
            if (item.kind === payload.kind && item.id === payload.id && item.scope === payload.scope) {
                if (item.payload.hash === payload.hash) {
                    return { kind: payload.kind, id: payload.id, scope: payload.scope, status: 'pending-duplicate', queueId: item.queueId };
                }
                // 同 id 新内容顶掉旧 pending（尚未审批，替换不算覆盖已发布数据）
                await removePath(path.join(this.dirFor(payload.kind, 'pending'), `${item.queueId}.json`));
                this.pending.delete(item.queueId);
                await this.audit('pending-replaced', { node, kind: payload.kind, id: payload.id, scope: payload.scope, oldQueueId: item.queueId });
                break;
            }
        }
        const queueId = newId('q');
        const item = { queueId, kind: payload.kind, id: payload.id, scope: payload.scope, node, payload, receivedAt: nowIso() };
        await writeJson(path.join(this.dirFor(payload.kind, 'pending'), `${queueId}.json`), item);
        this.pending.set(queueId, item);
        if (payload.force && existing) {
            await this.audit('push-force', { node, kind: payload.kind, id: payload.id, scope: payload.scope, overVersion: existing.version, hash: payload.hash });
        }
        this.logger.info('push-queued', '推送进入待审批队列', {
            node, kind: payload.kind, id: payload.id, scope: payload.scope, queueId, hash: payload.hash,
        });
        return { kind: payload.kind, id: payload.id, scope: payload.scope, status: 'queued', queueId };
    }
    // ---------------- 审批 ----------------
    listPending() {
        return [...this.pending.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    }
    listRejected() {
        return [...this.rejected.values()].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    }
    async decide(queueId, action, admin, reason) {
        const item = this.pending.get(queueId);
        if (!item) {
            throw new SyncError('not-found', `待审批项不存在（可能已处理）: ${queueId}`);
        }
        if (action === 'reject') {
            if (!reason)
                throw new SyncError('reason-required', '拒绝审批必须给出 reason（节点要能看见被拒原因）');
            const rejected = {
                ...item,
                decidedAt: nowIso(),
                decidedBy: admin,
                reason,
            };
            await writeJson(path.join(this.dirFor(item.kind, 'rejected'), `${queueId}.json`), rejected);
            await removePath(path.join(this.dirFor(item.kind, 'pending'), `${queueId}.json`));
            this.pending.delete(queueId);
            this.rejected.set(queueId, rejected);
            this.approvals.set(queueId, { status: 'rejected', reason, at: rejected.decidedAt, by: admin });
            await this.persistApprovals();
            await this.audit('reject', { queueId, kind: item.kind, id: item.id, node: item.node, by: admin, reason });
            this.logger.warn('approval-rejected', '审批拒绝，内容未进入总库', { queueId, kind: item.kind, id: item.id, reason, by: admin });
            return { status: 'rejected', queueId, id: item.id, reason };
        }
        // approve：发布，版本号按已存在记录递增
        const key = entryKey(item.kind, item.id, item.scope);
        const existing = this.published.get(key);
        const version = (existing?.version ?? 0) + 1;
        this.seq += 1;
        const entry = {
            kind: item.kind,
            id: item.id,
            scope: item.scope,
            title: item.payload.title ?? item.id,
            description: item.payload.description,
            content: item.payload.content,
            files: item.payload.files,
            tags: item.payload.tags ?? [],
            meta: item.payload.meta ?? {},
            expires: item.payload.expires,
            hash: item.payload.hash,
            version,
            seq: this.seq,
            sourceNode: item.node,
            updatedAt: item.payload.updatedAt ?? item.receivedAt,
            approvedBy: admin,
            approvedAt: nowIso(),
            cleanupFlag: null,
        };
        await writeJson(path.join(this.dirFor(item.kind, 'published'), publishedFileName(entry)), entry);
        await removePath(path.join(this.dirFor(item.kind, 'pending'), `${queueId}.json`));
        this.pending.delete(queueId);
        this.published.set(key, entry);
        this.approvals.set(queueId, { status: 'approved', kind: item.kind, id: item.id, version, seq: entry.seq, at: entry.approvedAt, by: admin });
        await this.persistSeq();
        await this.persistApprovals();
        await this.audit('approve', { queueId, kind: item.kind, id: item.id, scope: item.scope, node: item.node, version, seq: entry.seq, by: admin });
        this.logger.info('approval-approved', '审批通过，内容已发布', { queueId, kind: item.kind, id: item.id, scope: item.scope, version, seq: entry.seq, by: admin });
        return { status: 'approved', queueId, id: item.id, scope: item.scope, version, seq: entry.seq };
    }
    /** 节点回读自己推送的审批结果。 */
    pushStatus(queueIds) {
        return queueIds.map((queueId) => {
            if (this.pending.has(queueId))
                return { queueId, status: 'pending' };
            const appr = this.approvals.get(queueId);
            if (!appr)
                return { queueId, status: 'unknown', message: '队列项不存在或已被清理' };
            if (appr.status === 'rejected')
                return { queueId, status: 'rejected', reason: appr.reason, at: appr.at };
            return { queueId, status: 'approved', id: appr.id, kind: appr.kind, version: appr.version, seq: appr.seq, at: appr.at };
        });
    }
    // ---------------- 拉取与检索（只针对 published） ----------------
    /**
     * readScopes：grant-like 可见性集（服务端已做过 授权∩请求 求交，可含通配）。
     * undefined = 不过滤（hub 内部/管理员路径）；[] = 全不可见。
     */
    pullSince(sinceSeq, kinds, readScopes) {
        const visible = (scope) => readScopes === undefined || canRead(readScopes, scope);
        const entries = [...this.published.values()]
            .filter((e) => e.seq > sinceSeq && kinds.includes(e.kind) && visible(e.scope))
            .sort((a, b) => a.seq - b.seq);
        const tombs = [...this.tombstones.values()]
            .filter((t) => t.seq > sinceSeq && kinds.includes(t.kind) && visible(t.scope))
            .sort((a, b) => a.seq - b.seq);
        return { entries, cursor: this.seq, tombstones: tombs };
    }
    getEntry(kind, id, scope = '') {
        return this.published.get(entryKey(kind, id, scope));
    }
    /**
     * 总库轻量列表（管理面板浏览用）：不带 content/files 正文。
     * q 可选：对 id/title/description/tags 做不区分大小写的包含过滤（非打分检索）。
     */
    listEntries(opts = {}) {
        const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : undefined;
        const q = (opts.q ?? '').trim().toLowerCase();
        const out = [];
        for (const entry of this.published.values()) {
            if (kinds !== undefined && !kinds.includes(entry.kind))
                continue;
            if (opts.scope !== undefined && entry.scope !== opts.scope)
                continue;
            if (q !== '') {
                const hay = [entry.id, entry.title, entry.description ?? '', ...entry.tags].join('\n').toLowerCase();
                if (!hay.includes(q))
                    continue;
            }
            out.push({
                kind: entry.kind,
                id: entry.id,
                scope: entry.scope,
                title: entry.title,
                description: entry.description,
                tags: entry.tags,
                version: entry.version,
                seq: entry.seq,
                sourceNode: entry.sourceNode,
                updatedAt: entry.updatedAt,
                expires: entry.expires,
                cleanupFlag: entry.cleanupFlag ?? null,
            });
        }
        out.sort((a, b) => b.seq - a.seq);
        return out;
    }
    /**
     * 检索已发布条目。opts.budget 为 token 预算：按打分排序后累计 estTokens 填满为止
     * （第一条哪怕超预算也放行，保证非空）；带 budget 时命中附 content 全文，
     * 供调用方直接塞进 context（hindsight recall 的 token-budget 语义）。
     * since/before（ms）对 updatedAt 过滤；expiredOnly 只回已过期条目。
     */
    searchPublished(query, kinds, limit = 20, readScopes, opts = {}) {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
            throw new SyncError('empty-query', '检索关键词不能为空');
        }
        const now = Date.now();
        const hits = [];
        for (const entry of this.published.values()) {
            if (!kinds.includes(entry.kind))
                continue;
            if (readScopes !== undefined && !canRead(readScopes, entry.scope))
                continue;
            if (opts.since !== undefined || opts.before !== undefined) {
                const t = Date.parse(entry.updatedAt);
                if (Number.isNaN(t))
                    continue;
                if (opts.since !== undefined && t < opts.since)
                    continue;
                if (opts.before !== undefined && t > opts.before)
                    continue;
            }
            if (opts.expiredOnly) {
                const exp = entry.expires ? Date.parse(entry.expires) : NaN;
                if (!Number.isNaN(exp) && exp > now)
                    continue;
                if (Number.isNaN(exp))
                    continue;
            }
            const titleLc = entry.title.toLowerCase();
            const descLc = (entry.description ?? '').toLowerCase();
            const contentLc = (entry.content ?? '').toLowerCase();
            const tagsLc = entry.tags.map((t) => t.toLowerCase());
            let score = 0;
            for (const token of tokens) {
                if (titleLc === token)
                    score += 8;
                else if (titleLc.includes(token))
                    score += 5;
                if (tagsLc.some((t) => t === token))
                    score += 4;
                else if (tagsLc.some((t) => t.includes(token)))
                    score += 2;
                if (descLc.includes(token))
                    score += 3;
                if (contentLc.includes(token))
                    score += 1;
            }
            if (score <= 0)
                continue;
            const snippet = (entry.content ?? entry.description ?? '').slice(0, 160).replace(/\s+/g, ' ');
            const estTokens = Math.ceil([entry.title, entry.description ?? '', entry.content ?? '', entry.tags.join(' ')].join('\n').length / 3);
            hits.push({
                kind: entry.kind, id: entry.id, scope: entry.scope, title: entry.title, description: entry.description,
                tags: entry.tags, score, version: entry.version, seq: entry.seq, snippet, estTokens,
                content: opts.budget !== undefined ? entry.content : undefined,
                updatedAt: entry.updatedAt, sourceNode: entry.sourceNode, expires: entry.expires,
            });
        }
        hits.sort((a, b) => b.score - a.score || b.seq - a.seq);
        let out = hits.slice(0, limit);
        if (opts.budget !== undefined) {
            let used = 0;
            const capped = [];
            for (const h of out) {
                if (capped.length > 0 && used + h.estTokens > opts.budget)
                    break;
                used += h.estTokens;
                capped.push(h);
            }
            out = capped;
        }
        return out;
    }
    // ---------------- 清理流程（scan → propose → decide → archive/tombstone） ----------------
    cleanupScan(opts) {
        const now = Date.now();
        const out = [];
        for (const entry of this.published.values()) {
            const reasons = [];
            if (entry.expires) {
                const exp = Date.parse(entry.expires);
                if (!Number.isNaN(exp) && exp < now)
                    reasons.push(`已过期（expires=${entry.expires}）`);
            }
            if (!opts.expiredOnly && opts.olderThanDays !== undefined) {
                const base = Date.parse(entry.updatedAt) || Date.parse(entry.approvedAt);
                if (!Number.isNaN(base) && now - base > opts.olderThanDays * 86_400_000) {
                    reasons.push(`超过 ${opts.olderThanDays} 天未更新（updatedAt=${entry.updatedAt}）`);
                }
            }
            if (reasons.length) {
                out.push({ kind: entry.kind, id: entry.id, scope: entry.scope, title: entry.title, reasons, expires: entry.expires, updatedAt: entry.updatedAt });
            }
        }
        return out;
    }
    async cleanupPropose(targets, reason, admin) {
        if (!reason)
            throw new SyncError('reason-required', '清理提议必须给出 reason');
        const results = [];
        for (const t of targets) {
            const entry = this.published.get(entryKey(t.kind, t.id, t.scope ?? ''));
            if (!entry) {
                results.push({ ...t, status: 'not-found', message: '总库中不存在该条目' });
                continue;
            }
            entry.cleanupFlag = { proposedAt: nowIso(), reason, by: admin };
            await writeJson(path.join(this.dirFor(t.kind, 'published'), publishedFileName(entry)), entry);
            await this.audit('cleanup-propose', { kind: t.kind, id: t.id, scope: entry.scope, by: admin, reason });
            this.logger.warn('cleanup-flagged', '条目被标记待清理（仍可见，删除需审批）', { kind: t.kind, id: t.id, scope: entry.scope, reason, by: admin });
            results.push({ ...t, status: 'flagged' });
        }
        return results;
    }
    listFlagged() {
        return [...this.published.values()].filter((e) => e.cleanupFlag);
    }
    async cleanupDecide(targets, action, admin, reason) {
        const results = [];
        for (const t of targets) {
            const key = entryKey(t.kind, t.id, t.scope ?? '');
            const entry = this.published.get(key);
            if (!entry) {
                results.push({ ...t, status: 'not-found', message: '总库中不存在该条目' });
                continue;
            }
            if (action === 'reject') {
                if (!entry.cleanupFlag) {
                    results.push({ ...t, status: 'not-flagged', message: '该条目未被标记待清理' });
                    continue;
                }
                entry.cleanupFlag = null;
                await writeJson(path.join(this.dirFor(t.kind, 'published'), publishedFileName(entry)), entry);
                await this.audit('cleanup-reject', { kind: t.kind, id: t.id, scope: entry.scope, by: admin, reason });
                this.logger.info('cleanup-rejected', '清理被否决，条目保留', { kind: t.kind, id: t.id, scope: entry.scope, by: admin });
                results.push({ ...t, status: 'kept' });
                continue;
            }
            // approve：挪入 archive（软删除）+ 落 tombstone，节点据此删除本地共享副本
            const archivedAt = nowIso();
            const archiveFile = path.join(this.dirFor(t.kind, 'archive'), `${scopeFilePrefix(entry.scope)}${entry.id}-${archivedAt.replace(/[:.]/g, '-')}.json`);
            await writeJson(archiveFile, { ...entry, archivedAt, archivedBy: admin, archiveReason: (reason || entry.cleanupFlag?.reason) ?? '' });
            await removePath(path.join(this.dirFor(t.kind, 'published'), publishedFileName(entry)));
            this.published.delete(key);
            this.archivedCount++;
            this.seq += 1;
            const tomb = { kind: t.kind, id: t.id, scope: entry.scope, seq: this.seq, reason: (reason || entry.cleanupFlag?.reason) ?? '', at: archivedAt, by: admin };
            this.tombstones.set(key, tomb);
            await writeJson(path.join(this.dataDir, 'state', 'tombstones.json'), Object.fromEntries(this.tombstones.entries()));
            await this.persistSeq();
            await this.audit('cleanup-approve', { kind: t.kind, id: t.id, by: admin, reason: tomb.reason, seq: tomb.seq });
            this.logger.warn('cleanup-archived', '条目已审批清理，移入归档并广播 tombstone', { kind: t.kind, id: t.id, seq: tomb.seq, by: admin });
            results.push({ ...t, status: 'archived' });
        }
        return results;
    }
    stats() {
        const published = { memory: 0, skill: 0 };
        let flagged = 0;
        for (const e of this.published.values()) {
            published[e.kind]++;
            if (e.cleanupFlag)
                flagged++;
        }
        return {
            published,
            pending: this.pending.size,
            rejected: this.rejected.size,
            archived: this.archivedCount,
            flagged,
            tombstones: this.tombstones.size,
            seq: this.seq,
            corruptFiles: this.corruptFiles,
        };
    }
    /** 自检：published 内容哈希应与内容一致，暴露静默篡改/损坏。 */
    async integrityCheck() {
        const mismatched = [];
        let checked = 0;
        for (const entry of this.published.values()) {
            checked++;
            const recomputed = contentHash({
                title: entry.title,
                content: entry.content,
                files: entry.files,
                tags: entry.tags,
                expires: entry.expires,
                meta: entry.meta,
            });
            if (recomputed !== entry.hash) {
                mismatched.push({ kind: entry.kind, id: entry.id, scope: entry.scope, fileHash: entry.hash, contentHash: recomputed });
            }
        }
        return { checked, mismatched };
    }
}
async function listJsonFiles(dir) {
    try {
        const items = await fsp.readdir(dir, { withFileTypes: true });
        return items.filter((i) => i.isFile() && i.name.endsWith('.json')).map((i) => path.join(dir, i.name)).sort();
    }
    catch {
        return [];
    }
}
async function appendAudit(file, fields) {
    const line = JSON.stringify({ ts: nowIso(), ...fields }) + '\n';
    await ensureDir(path.dirname(file));
    await fsp.appendFile(file, line, 'utf8');
}
