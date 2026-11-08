/**
 * 节点本地存储。
 *
 * 记忆来源（可混用）：
 *   - <memoryDir>/*.md        frontmatter 条目（title/tags/expires + 正文）
 *   - <memoryDir>/entries/*.json  结构化条目
 * 共享拉取内容写入 <memoryDir>/shared/<id>.md，绝不覆盖本地条目；
 * 本地与远端同 id 不同内容时，远端副本写入 <stateDir>/conflicts/ 并告警。
 *
 * skills 来源：<skillRoots> 下的 <name>/SKILL.md 目录 bundle 或 <name>.md 平铺文件，
 * 与 harness skill-filesystem 的发现约定一致（kebab-case、一城一层）。
 * 拉取的 skill 写入 skillRoots[0]，带 .clh-knowledge-sync.json 来源标记；
 * 与本地同名不同内容 → 本地副本挪进 <stateDir>/conflicts/skills/ 后再写入远端版本。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { SyncError, atomicWriteFile, contentHash, ensureDir, formatMemoryMarkdown, isTextFile, memoryHashOf, memoryIdFor, nowIso, parseFrontmatter, pathExists, readJson, removePath, validateSkillName, walkFiles, writeJson, } from '../util.js';
export class LocalStore {
    cfg;
    logger;
    constructor(cfg, logger) {
        this.cfg = cfg;
        this.logger = logger;
    }
    // ---------------- 记忆 ----------------
    /** 扫描本地记忆（*.md + entries/*.json，跳过 shared/ 与状态目录）。 */
    async scanMemory() {
        const items = [];
        const root = this.cfg.memoryDir;
        await ensureDir(root);
        const mdFiles = (await walkFiles(root, { maxDepth: 1 })).filter((rel) => rel.endsWith('.md'));
        for (const rel of mdFiles) {
            const file = path.join(root, rel);
            try {
                const text = await fsp.readFile(file, 'utf8');
                const fm = parseFrontmatter(text);
                if (!fm) {
                    this.logger.warn('memory-skipped', `跳过无 frontmatter 的记忆文件: ${rel}`, { file });
                    continue;
                }
                const title = String(fm.data.title ?? path.basename(rel, '.md'));
                const tags = Array.isArray(fm.data.tags) ? fm.data.tags.map(String) : [];
                const expires = typeof fm.data.expires === 'string' ? fm.data.expires : undefined;
                const content = fm.body.trim();
                const stat = await fsp.stat(file);
                items.push({
                    id: memoryIdFor(title, typeof fm.data.id === 'string' ? fm.data.id : undefined),
                    title,
                    content,
                    tags,
                    meta: { file: rel },
                    expires,
                    updatedAt: typeof fm.data.updatedAt === 'string' ? fm.data.updatedAt : stat.mtime.toISOString(),
                    hash: memoryHashOf({ title, content, tags, expires }),
                    sourcePath: file,
                });
            }
            catch (err) {
                this.logger.error('memory-read-error', `读取记忆文件失败: ${rel}`, { error: err.message });
            }
        }
        const entriesDir = path.join(root, 'entries');
        if (await pathExists(entriesDir)) {
            for (const rel of (await walkFiles(entriesDir, { maxDepth: 1 })).filter((r) => r.endsWith('.json'))) {
                try {
                    const raw = await readJson(path.join(entriesDir, rel));
                    const title = String(raw.title ?? path.basename(rel, '.json'));
                    const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
                    const content = String(raw.content ?? '');
                    const expires = typeof raw.expires === 'string' ? raw.expires : undefined;
                    const stat = await fsp.stat(path.join(entriesDir, rel));
                    items.push({
                        id: memoryIdFor(title, typeof raw.id === 'string' ? raw.id : undefined),
                        title,
                        content,
                        tags,
                        meta: { file: `entries/${rel}` },
                        expires,
                        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : stat.mtime.toISOString(),
                        hash: memoryHashOf({ title, content, tags, expires }),
                        sourcePath: path.join(entriesDir, rel),
                    });
                }
                catch (err) {
                    this.logger.error('memory-read-error', `读取结构化记忆失败: ${rel}`, { error: err.message });
                }
            }
        }
        return items;
    }
    async writeSharedMemory(entry) {
        const sharedDir = path.join(this.cfg.memoryDir, 'shared');
        const file = path.join(sharedDir, `${entry.id}.md`);
        await atomicWriteFile(file, formatMemoryMarkdown({
            id: entry.id,
            title: entry.title,
            content: entry.content ?? '',
            tags: entry.tags,
            expires: entry.expires,
            updatedAt: entry.updatedAt,
            hash: entry.hash,
            version: entry.version,
            source: `hub:${entry.sourceNode} v${entry.version}`,
        }));
        return file;
    }
    async removeSharedMemory(id) {
        const file = path.join(this.cfg.memoryDir, 'shared', `${id}.md`);
        if (await pathExists(file)) {
            await removePath(file);
            return true;
        }
        return false;
    }
    async writeConflictMemory(entry) {
        const dir = path.join(this.cfg.stateDir, 'conflicts', 'memory');
        const file = path.join(dir, `${entry.id}-v${entry.version}-${Date.now()}.md`);
        await atomicWriteFile(file, formatMemoryMarkdown({
            id: entry.id,
            title: entry.title,
            content: entry.content ?? '',
            tags: entry.tags,
            updatedAt: entry.updatedAt,
            hash: entry.hash,
            version: entry.version,
            source: `hub-conflict:${entry.sourceNode}`,
        }));
        return file;
    }
    // ---------------- skills ----------------
    async scanSkillRoot(root) {
        const bundles = [];
        let topEntries;
        try {
            topEntries = await fsp.readdir(root, { withFileTypes: true });
        }
        catch {
            return bundles; // 根目录尚不存在 = 空集，正常状态
        }
        for (const item of topEntries) {
            if (item.name.startsWith('.'))
                continue;
            if (item.isDirectory()) {
                const bundleDir = path.join(root, item.name);
                const skillMd = path.join(bundleDir, 'SKILL.md');
                if (!(await pathExists(skillMd)))
                    continue;
                const nameErr = validateSkillName(item.name);
                if (nameErr) {
                    this.logger.warn('skill-skipped', `跳过非法命名 skill 目录: ${item.name}`, { reason: nameErr });
                    continue;
                }
                bundles.push(await this.readBundle(bundleDir, item.name, root));
            }
            else if (item.isFile() && item.name.endsWith('.md')) {
                const name = item.name.slice(0, -3);
                const nameErr = validateSkillName(name);
                if (nameErr) {
                    this.logger.warn('skill-skipped', `跳过非法命名 skill 文件: ${item.name}`, { reason: nameErr });
                    continue;
                }
                const text = await fsp.readFile(path.join(root, item.name), 'utf8');
                const fm = parseFrontmatter(text);
                const files = [{ path: 'SKILL.md', encoding: 'utf8', content: text }];
                bundles.push({
                    name,
                    description: String(fm?.data.description ?? ''),
                    files,
                    hash: contentHash(files),
                    rootDir: root,
                });
            }
        }
        return bundles;
    }
    async scanSkills() {
        const out = [];
        for (const root of this.cfg.skillRoots) {
            out.push(...(await this.scanSkillRoot(root)));
        }
        return out;
    }
    async readBundle(bundleDir, name, rootDir) {
        const rels = await walkFiles(bundleDir, { maxDepth: 8 });
        const files = [];
        for (const rel of rels) {
            const abs = path.join(bundleDir, rel);
            const stat = await fsp.stat(abs);
            if (stat.size > 5 * 1024 * 1024) {
                throw new SyncError('file-too-large', `skill 文件超过 5MB 上限: ${name}/${rel}`);
            }
            if (isTextFile(rel)) {
                files.push({ path: rel, encoding: 'utf8', content: await fsp.readFile(abs, 'utf8') });
            }
            else {
                files.push({ path: rel, encoding: 'base64', content: (await fsp.readFile(abs)).toString('base64') });
            }
        }
        if (!files.some((f) => f.path === 'SKILL.md')) {
            throw new SyncError('invalid-skill', `skill 目录缺少 SKILL.md: ${name}`);
        }
        const skillMd = files.find((f) => f.path === 'SKILL.md');
        const fm = parseFrontmatter(skillMd.content);
        return {
            name,
            description: String(fm?.data.description ?? ''),
            files,
            hash: contentHash(files),
            rootDir,
        };
    }
    /**
     * 把远端 skill bundle 写入指定根目录。
     * 返回 written（新写入/覆盖）/ unchanged（哈希相同）/ conflict-copy（本地冲突副本已保全）。
     */
    async writeSkillBundle(root, entry, opts = {}) {
        const nameErr = validateSkillName(entry.id);
        if (nameErr)
            throw new SyncError('invalid-skill', `远端 skill 名称非法: ${nameErr}`);
        const bundleDir = path.join(root, entry.id);
        const markerFile = path.join(bundleDir, '.clh-knowledge-sync.json');
        let localHash = null;
        if (await pathExists(path.join(bundleDir, 'SKILL.md'))) {
            try {
                localHash = (await readJson(markerFile)).hash ?? null;
            }
            catch {
                localHash = null;
            }
            if (localHash === null) {
                // 无来源标记 → 本地手写 skill；按当前内容计算哈希用于冲突比较
                localHash = (await this.readBundle(bundleDir, entry.id, root)).hash;
            }
            if (localHash === entry.hash) {
                return { status: 'unchanged', dir: bundleDir };
            }
            if (!opts.force) {
                const backupDir = path.join(this.cfg.stateDir, 'conflicts', 'skills', `${entry.id}-local-${Date.now()}`);
                await fsp.mkdir(bundleDir, { recursive: true });
                await this.copyTree(bundleDir, backupDir);
                this.logger.warn('skill-conflict', `本地 skill 与远端版本不同，已备份本地副本后写入远端版本`, {
                    skill: entry.id,
                    localBackup: backupDir,
                    remoteVersion: entry.version,
                });
                await removePath(bundleDir);
                await this.writeBundleDir(bundleDir, entry);
                await writeJson(markerFile, { source: 'clh-knowledge-sync-hub', hash: entry.hash, version: entry.version, pulledAt: nowIso() });
                return { status: 'conflict-copy', localBackup: backupDir, dir: bundleDir };
            }
        }
        await this.writeBundleDir(bundleDir, entry);
        await writeJson(markerFile, { source: 'clh-knowledge-sync-hub', hash: entry.hash, version: entry.version, pulledAt: nowIso() });
        return { status: 'written', dir: bundleDir };
    }
    async writeBundleDir(bundleDir, entry) {
        await removePath(bundleDir);
        await ensureDir(bundleDir);
        for (const f of entry.files ?? []) {
            if (f.path.includes('..'))
                throw new SyncError('unsafe-path', `skill 文件路径含 ..: ${f.path}`);
            const abs = path.join(bundleDir, f.path);
            if (!abs.startsWith(bundleDir))
                throw new SyncError('unsafe-path', `skill 文件路径越界: ${f.path}`);
            await ensureDir(path.dirname(abs));
            await atomicWriteFile(abs, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content);
        }
    }
    /** 删除本插件拉取的 skill（有来源标记才删；本地手写不动，只告警）。 */
    async removeSyncedSkill(root, name) {
        const bundleDir = path.join(root, name);
        const markerFile = path.join(bundleDir, '.clh-knowledge-sync.json');
        if (!(await pathExists(path.join(bundleDir, 'SKILL.md'))))
            return 'not-found';
        if (await pathExists(markerFile)) {
            await removePath(bundleDir);
            return 'removed';
        }
        this.logger.warn('skill-tombstone-kept', `hub 已清理 skill "${name}"，但本地为手写副本，未删除`, { root });
        return 'kept-local';
    }
    async copyTree(src, dest) {
        await ensureDir(dest);
        for (const rel of await walkFiles(src, { maxDepth: 8 })) {
            const from = path.join(src, rel);
            const to = path.join(dest, rel);
            await ensureDir(path.dirname(to));
            await fsp.copyFile(from, to);
        }
    }
}
