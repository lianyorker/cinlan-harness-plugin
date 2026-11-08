/**
 * 同步引擎：把本地记忆/skills 与远程总库对齐。
 *
 * - pushCycle：扫描本地 → 与 sync-state 对比 → 新增/变化条目推送到 hub（hub 侧进待审批队列）。
 * - statusCycle：回读各推送的审批结果；被拒条目记录原因并不再重推（内容变了才会再推）。
 * - pullCycle：拉取已发布条目与 tombstone；memory 写入 shared/，skill 写入第一个 skill 根目录；
 *   冲突（同 id 不同内容）一律保全副本 + WARN 日志，绝不静默覆盖。
 * - auto：intervalSec 定时循环，循环内 push→status→pull；每一步失败都记 ERROR 与 lastError。
 */
import path from 'node:path';
import { SyncError, ensureDir, nowIso, readJson, writeJson } from '../util.js';
const STATE_FILE = 'sync-state.json';
const MAX_CONFLICTS = 200;
export class SyncEngine {
    cfg;
    client;
    local;
    logger;
    state = { version: 1, cursor: 0, pushed: {}, conflicts: [] };
    timer = null;
    running = false;
    constructor(cfg, client, local, logger) {
        this.cfg = cfg;
        this.client = client;
        this.local = local;
        this.logger = logger;
    }
    async loadState() {
        try {
            const raw = await readJson(path.join(this.cfg.stateDir, STATE_FILE));
            this.state = {
                version: 1,
                cursor: raw.cursor ?? 0,
                pushed: raw.pushed ?? {},
                conflicts: raw.conflicts ?? [],
                lastError: raw.lastError,
                lastSyncAt: raw.lastSyncAt,
                lastPullAt: raw.lastPullAt,
            };
            this.logger.debug('state-loaded', '同步状态已加载', { cursor: this.state.cursor, pushed: Object.keys(this.state.pushed).length });
        }
        catch {
            this.logger.info('state-init', '无历史同步状态，从零开始');
        }
    }
    async saveState() {
        if (this.state.conflicts.length > MAX_CONFLICTS) {
            this.state.conflicts = this.state.conflicts.slice(-MAX_CONFLICTS);
        }
        await writeJson(path.join(this.cfg.stateDir, STATE_FILE), this.state);
    }
    stateSnapshot() {
        return { ...this.state, hub: this.client.describe(), node: this.cfg.nodeId };
    }
    recordError(operation, err) {
        const syncErr = err instanceof SyncError ? err : new SyncError('internal', err.message ?? String(err));
        this.state.lastError = { at: nowIso(), code: syncErr.code, message: syncErr.message, operation };
        this.logger.error('sync-error', `${operation} 失败: [${syncErr.code}] ${syncErr.message}`, {
            code: syncErr.code,
            hub: this.client.describe(),
        });
        return;
    }
    // ---------------- 推送 ----------------
    async pushCycle(force = false, kindFilter) {
        const op = 'push';
        try {
            const [memories, skills] = await Promise.all([
                this.local.scanMemory(),
                this.local.scanSkills(),
            ]);
            const items = [];
            if (!kindFilter || kindFilter === 'memory') {
                for (const m of memories) {
                    const rec = this.state.pushed[m.id];
                    const unchanged = rec && rec.hash === m.hash && rec.status !== 'invalid';
                    if (unchanged)
                        continue;
                    items.push({
                        kind: 'memory',
                        payload: {
                            kind: 'memory',
                            id: m.id,
                            title: m.title,
                            content: m.content,
                            tags: m.tags,
                            meta: m.meta,
                            expires: m.expires,
                            hash: m.hash,
                            updatedAt: m.updatedAt,
                            baseVersion: rec?.status === 'approved' ? rec.seq : rec?.seq,
                            force,
                        },
                    });
                }
            }
            if (!kindFilter || kindFilter === 'skill') {
                for (const s of skills) {
                    const id = `skill-${s.name}`;
                    const rec = this.state.pushed[id];
                    if (rec && rec.hash === s.hash && rec.status !== 'invalid')
                        continue;
                    items.push({
                        kind: 'skill',
                        payload: {
                            kind: 'skill',
                            id: s.name,
                            title: s.name,
                            description: s.description,
                            files: s.files,
                            tags: [],
                            meta: { root: s.rootDir },
                            hash: s.hash,
                            updatedAt: nowIso(),
                            baseVersion: rec?.status === 'approved' ? rec.seq : rec?.seq,
                            force,
                        },
                    });
                }
            }
            if (items.length === 0) {
                this.logger.info('push-idle', '本地无新增/变化条目，跳过推送');
                await this.saveState();
                return { operation: op, ok: true, counts: { pushed: 0 } };
            }
            const response = await this.client.request('POST', '/api/v1/push', {
                body: { items: items.map((i) => i.payload) },
            });
            let errors = 0;
            for (const r of response.results) {
                const stateId = r.kind === 'skill' ? `skill-${r.id}` : r.id;
                if (r.status === 'queued') {
                    this.state.pushed[stateId] = { kind: r.kind, hash: items.find((i) => (i.kind === 'skill' ? `skill-${i.payload.id}` : i.payload.id) === stateId)?.payload.hash, queueId: r.queueId, status: 'pending', at: nowIso() };
                }
                else if (r.status === 'duplicate') {
                    this.state.pushed[stateId] = { kind: r.kind, hash: this.hashOf(items, stateId), status: 'published-duplicate', version: r.serverVersion, at: nowIso() };
                    this.logger.info('push-duplicate', `条目已在总库且内容一致: ${r.id}`, { id: r.id, serverVersion: r.serverVersion });
                }
                else if (r.status === 'conflict') {
                    // 冲突是已检测、已记日志、已保全副本的正常业务结果，不算指令失败
                    this.state.pushed[stateId] = { kind: r.kind, hash: this.hashOf(items, stateId), status: 'conflict', reason: r.message, version: r.serverVersion, at: nowIso() };
                    this.state.conflicts.push({ ts: nowIso(), direction: 'push', kind: r.kind, id: r.id, detail: r.message ?? 'version conflict' });
                    this.logger.warn('push-conflict', `同步冲突（推送被拒）: ${r.id}: ${r.message}`, {
                        id: r.id, serverVersion: r.serverVersion, hint: '先 pull 合并，或将内容更新后重推；确认覆盖可用 push --force',
                    });
                }
                else {
                    errors++;
                    this.state.pushed[stateId] = { kind: r.kind, hash: this.hashOf(items, stateId), status: 'invalid', reason: r.message, at: nowIso() };
                    this.logger.error('push-invalid', `推送条目被校验拒绝: ${r.id}: ${r.message}`, { id: r.id });
                }
            }
            this.state.lastSyncAt = nowIso();
            this.state.lastError = undefined;
            await this.saveState();
            const queued = response.results.filter((r) => r.status === 'queued').length;
            this.logger.info('push-done', `推送完成: ${queued} 进待审批队列`, {
                queued, duplicate: response.results.filter((r) => r.status === 'duplicate').length,
                conflict: response.results.filter((r) => r.status === 'conflict').length,
                invalid: response.results.filter((r) => r.status === 'invalid').length,
            });
            return { operation: op, ok: errors === 0, counts: { pushed: queued, total: response.results.length, errors }, details: response.results };
        }
        catch (err) {
            this.recordError(op, err);
            await this.saveState();
            const syncErr = err instanceof SyncError ? err : new SyncError('internal', err.message);
            return { operation: op, ok: false, counts: {}, errors: [{ code: syncErr.code, message: syncErr.message }] };
        }
    }
    hashOf(items, stateId) {
        const found = items.find((i) => (i.kind === 'skill' ? `skill-${i.payload.id}` : i.payload.id) === stateId);
        return found?.payload.hash ?? '';
    }
    // ---------------- 审批状态回读 ----------------
    async statusCycle() {
        const op = 'status';
        try {
            const pendingIds = Object.entries(this.state.pushed)
                .filter(([, rec]) => rec.status === 'pending' && rec.queueId)
                .map(([, rec]) => rec.queueId);
            if (pendingIds.length === 0) {
                return { operation: op, ok: true, counts: { checked: 0 } };
            }
            const resp = await this.client.request('GET', '/api/v1/push-status', {
                query: { ids: pendingIds.join(',') },
            });
            let approved = 0;
            let rejected = 0;
            for (const st of resp.statuses) {
                const queueId = st.queueId;
                const entryId = Object.entries(this.state.pushed).find(([, rec]) => rec.queueId === queueId)?.[0];
                if (!entryId)
                    continue;
                const rec = this.state.pushed[entryId];
                if (st.status === 'approved') {
                    rec.status = 'approved';
                    rec.version = st.version;
                    rec.seq = st.seq;
                    approved++;
                    this.logger.info('approval-approved', `推送已过审批并发布: ${entryId} v${rec.version}`, { id: entryId, seq: rec.seq });
                }
                else if (st.status === 'rejected') {
                    rec.status = 'rejected';
                    rec.reason = st.reason;
                    rejected++;
                    this.logger.warn('approval-rejected', `推送被管理员拒绝（未进入总库）: ${entryId}: ${st.reason}`, { id: entryId });
                }
            }
            await this.saveState();
            return { operation: op, ok: true, counts: { checked: pendingIds.length, approved, rejected }, statuses: resp.statuses };
        }
        catch (err) {
            this.recordError(op, err);
            const syncErr = err instanceof SyncError ? err : new SyncError('internal', err.message);
            return { operation: op, ok: false, counts: {}, errors: [{ code: syncErr.code, message: syncErr.message }] };
        }
    }
    // ---------------- 拉取 ----------------
    async pullCycle(kindFilter) {
        const op = 'pull';
        try {
            const kinds = kindFilter ? [kindFilter] : ['memory', 'skill'];
            const resp = await this.client.request('GET', '/api/v1/pull', { query: { sinceSeq: String(this.state.cursor), kinds: kinds.join(',') } });
            const details = [];
            let written = 0;
            let conflicts = 0;
            let removed = 0;
            for (const entry of resp.entries) {
                if (entry.kind === 'memory') {
                    const local = await this.findLocalMemory(entry.id);
                    if (local && local.hash !== entry.hash) {
                        const file = await this.local.writeConflictMemory(entry);
                        conflicts++;
                        this.state.conflicts.push({
                            ts: nowIso(), direction: 'pull', kind: 'memory', id: entry.id,
                            detail: `本地内容与总库 v${entry.version} 不同；远端副本已存到 ${file}`,
                        });
                        this.logger.warn('pull-conflict', `拉取冲突: ${entry.id} 本地与远端内容不同，远端副本存于 ${file}`, {
                            id: entry.id, remoteVersion: entry.version, localFile: local.sourcePath,
                        });
                        details.push({ id: entry.id, kind: 'memory', status: 'conflict-copy', file });
                        continue;
                    }
                    if (local && local.hash === entry.hash) {
                        details.push({ id: entry.id, kind: 'memory', status: 'unchanged' });
                        continue;
                    }
                    const file = await this.local.writeSharedMemory(entry);
                    written++;
                    this.logger.info('pull-memory', `写入共享记忆: ${entry.id} (v${entry.version}, 来自 ${entry.sourceNode})`, { file, version: entry.version });
                    details.push({ id: entry.id, kind: 'memory', status: 'written', file });
                }
                else if (entry.kind === 'skill') {
                    const root = this.cfg.skillRoots[0];
                    if (!root) {
                        this.logger.warn('pull-skill-skipped', `收到远端 skill "${entry.id}"，但 sync.skillRoots 为空，未落地`, { skill: entry.id });
                        details.push({ id: entry.id, kind: 'skill', status: 'skipped-no-root' });
                        continue;
                    }
                    const r = await this.local.writeSkillBundle(root, entry);
                    if (r.status === 'written')
                        written++;
                    if (r.status === 'conflict-copy')
                        conflicts++;
                    this.logger.info('pull-skill', `skill "${entry.id}": ${r.status}`, { dir: r.dir, localBackup: r.localBackup });
                    details.push({ id: entry.id, kind: 'skill', status: r.status, dir: r.dir, localBackup: r.localBackup });
                }
            }
            for (const tomb of resp.tombstones) {
                if (tomb.kind === 'memory') {
                    const removedFile = await this.local.removeSharedMemory(tomb.id);
                    if (removedFile)
                        removed++;
                    this.logger.info('pull-tombstone', `总库已清理记忆 "${tomb.id}"，本地共享副本${removedFile ? '已删除' : '不存在'}`, { reason: tomb.reason });
                    details.push({ id: tomb.id, kind: 'memory', status: removedFile ? 'removed' : 'absent', reason: tomb.reason });
                }
                else {
                    const root = this.cfg.skillRoots[0];
                    if (root) {
                        const r = await this.local.removeSyncedSkill(root, tomb.id);
                        if (r === 'removed')
                            removed++;
                        this.logger.info('pull-tombstone', `总库已清理 skill "${tomb.id}"，本地处理: ${r}`, { reason: tomb.reason });
                        details.push({ id: tomb.id, kind: 'skill', status: r, reason: tomb.reason });
                    }
                }
            }
            this.state.cursor = resp.cursor;
            this.state.lastPullAt = nowIso();
            this.state.lastError = undefined;
            await this.saveState();
            return { operation: op, ok: true, counts: { entries: resp.entries.length, written, conflicts, removed, tombstones: resp.tombstones.length }, details };
        }
        catch (err) {
            this.recordError(op, err);
            const syncErr = err instanceof SyncError ? err : new SyncError('internal', err.message);
            return { operation: op, ok: false, counts: {}, errors: [{ code: syncErr.code, message: syncErr.message }] };
        }
    }
    async findLocalMemory(id) {
        const all = await this.local.scanMemory();
        return all.find((m) => m.id === id) ?? null;
    }
    // ---------------- 检索 / 探测 ----------------
    async search(query, limit = 20) {
        const resp = await this.client.request('GET', '/api/v1/search', {
            query: { q: query, limit: String(limit) },
        });
        return resp;
    }
    async doctor() {
        try {
            const health = await this.client.health();
            return { ok: true, hub: this.client.describe(), detail: health };
        }
        catch (err) {
            const syncErr = err instanceof SyncError ? err : new SyncError('internal', err.message);
            return { ok: false, hub: this.client.describe(), error: { code: syncErr.code, message: syncErr.message } };
        }
    }
    // ---------------- 自动同步 ----------------
    startAuto() {
        if (this.timer)
            return;
        const intervalMs = Math.max(5, this.cfg.intervalSec) * 1000;
        this.timer = setInterval(() => void this.runCycle(), intervalMs);
        // 常驻模式：这个 interval 就是进程的保活句柄，不 unref；
        // oneshot 模式不走 startAuto，fiber 卸载时 stopAuto 会清掉它。
        this.logger.info('auto-on', `自动同步已启动（每 ${this.cfg.intervalSec}s 一轮）`);
    }
    stopAuto() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.logger.info('auto-off', '自动同步已停止');
        }
    }
    async runCycle() {
        if (this.running)
            return;
        this.running = true;
        try {
            await this.pushCycle();
            await this.statusCycle();
            await this.pullCycle();
        }
        finally {
            this.running = false;
        }
    }
    // ---------------- oneshot（无界面环境下跑指定指令并落结果文件） ----------------
    async oneshot(commands, resultFile) {
        const results = [];
        let allOk = true;
        for (const raw of commands) {
            const [cmd, ...rest] = raw.trim().split(/\s+/);
            try {
                let data;
                switch (cmd) {
                    case 'doctor': {
                        const r = await this.doctor();
                        data = r;
                        if (!r.ok)
                            allOk = false;
                        break;
                    }
                    case 'push': {
                        const force = rest.includes('--force');
                        const kind = rest.includes('--skills') ? 'skill' : rest.includes('--memory') ? 'memory' : undefined;
                        const r = await this.pushCycle(force, kind);
                        data = r;
                        if (!r.ok)
                            allOk = false;
                        break;
                    }
                    case 'status': {
                        const r = await this.statusCycle();
                        data = { ...r, state: this.stateSnapshot() };
                        if (!r.ok)
                            allOk = false;
                        break;
                    }
                    case 'pull': {
                        const r = await this.pullCycle();
                        data = r;
                        if (!r.ok)
                            allOk = false;
                        break;
                    }
                    case 'skills-pull': {
                        const r = await this.pullCycle('skill');
                        data = r;
                        if (!r.ok)
                            allOk = false;
                        break;
                    }
                    case 'search': {
                        const query = rest.join(' ');
                        if (!query)
                            throw new SyncError('bad-request', 'search 需要关键词');
                        data = await this.search(query);
                        break;
                    }
                    case 'sleep': {
                        await new Promise((r) => setTimeout(r, Number.parseInt(rest[0] ?? '1000', 10)));
                        data = { sleptMs: rest[0] ?? '1000' };
                        break;
                    }
                    default:
                        throw new SyncError('bad-request', `oneshot 未知指令: ${cmd}`);
                }
                results.push({ command: raw, ok: true, data });
            }
            catch (err) {
                allOk = false;
                const syncErr = err instanceof SyncError ? err : new SyncError('internal', err.message);
                this.recordError(`oneshot:${raw}`, err);
                results.push({ command: raw, ok: false, error: { code: syncErr.code, message: syncErr.message } });
            }
        }
        if (resultFile) {
            await ensureDir(path.dirname(resultFile));
            await writeJson(resultFile, { node: this.cfg.nodeId, ok: allOk, at: nowIso(), results });
        }
        return { ok: allOk, results };
    }
}
