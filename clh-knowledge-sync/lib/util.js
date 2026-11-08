/**
 * clh-knowledge-sync 共享工具：哈希、id 生成、frontmatter 解析、原子文件写入。
 * 节点端与 hub 端共用；不依赖任何 harness 运行时，保证 CLI 也能独立运行。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
export const nowIso = () => new Date().toISOString();
export function sha256Hex(input) {
    return createHash('sha256').update(input, 'utf8').digest('hex');
}
/** 确定性 JSON 序列化：键递归排序，保证同内容同哈希。 */
export function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
/** 对任意结构化内容做稳定哈希（内容寻址的基础）。 */
export function contentHash(value) {
    return sha256Hex(stableStringify(value));
}
export function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
/**
 * 记忆条目的逻辑 id：由标题 slug 决定，与内容无关——
 * 同名条目在两节点间天然同 id，内容不同即产生可检测的同步冲突。
 */
export function slugify(title) {
    const slug = title
        .toLowerCase()
        .trim()
        .replace(/[^\p{Script=Han}a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
    return slug || 'untitled';
}
export const MEMORY_ID_PREFIX = 'mem-';
export function memoryIdFor(title, explicitId) {
    if (explicitId && /^mem-[a-z0-9\u4e00-\u9fff-]{1,80}$/.test(explicitId))
        return explicitId;
    return MEMORY_ID_PREFIX + slugify(title);
}
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** harness 的 skill-filesystem 要求 kebab-case 名称；错误名称在推送前就被拦下并报错。 */
export function validateSkillName(name) {
    if (!SKILL_NAME_RE.test(name))
        return `skill 名称必须是 kebab-case（小写字母数字与 -），收到 "${name}"`;
    if (name.length > 80)
        return `skill 名称过长（>80）：${name}`;
    return null;
}
/** 解析 `--- ... ---` frontmatter（行式 key: value，支持 [a, b] 数组），无 frontmatter 返回 null。 */
export function parseFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m)
        return null;
    const data = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (!kv)
            continue;
        const key = kv[1];
        const raw = kv[2].trim();
        if (raw.startsWith('[') && raw.endsWith(']')) {
            data[key] = raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        }
        else {
            data[key] = raw.replace(/^['"]|['"]$/g, '');
        }
    }
    return { data, body: text.slice(m[0].length) };
}
/** 把本地 md/JSON 条目折算成统一的哈希输入（标题+正文+标签+过期，不含文件路径）。 */
export function memoryHashOf(e) {
    return contentHash({
        title: e.title,
        content: e.content,
        tags: e.tags ?? [],
        expires: e.expires ?? null,
    });
}
export function formatMemoryMarkdown(e) {
    const lines = ['---'];
    lines.push(`id: ${e.id}`);
    lines.push(`title: ${e.title}`);
    if (e.tags.length)
        lines.push(`tags: [${e.tags.join(', ')}]`);
    if (e.expires)
        lines.push(`expires: ${e.expires}`);
    lines.push(`updatedAt: ${e.updatedAt}`);
    if (e.hash)
        lines.push(`syncHash: ${e.hash}`);
    if (e.version)
        lines.push(`version: ${e.version}`);
    if (e.source)
        lines.push(`source: ${e.source}`);
    lines.push('---', '');
    lines.push(e.content.endsWith('\n') ? e.content : `${e.content}\n`);
    return lines.join('\n');
}
export async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}
/** 原子写：同目录临时文件 + rename，避免读到半截文件。 */
export async function atomicWriteFile(file, data) {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${randomUUID().slice(0, 6)}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
}
export async function writeJson(file, value) {
    await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function readJson(file) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    }
    catch (err) {
        throw new SyncError('io-error', `读取 JSON 失败: ${file}: ${err.message}`);
    }
}
export async function pathExists(p) {
    try {
        await fsp.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
/** 受限删除：拒绝空串/根路径/结尾斜杠，防误删。 */
export async function removePath(p) {
    const resolved = path.resolve(p);
    const root = path.parse(resolved).root;
    if (!resolved || resolved === root || resolved.endsWith(path.sep)) {
        throw new SyncError('unsafe-path', `拒绝删除可疑路径: "${p}"`);
    }
    await fsp.rm(resolved, { recursive: true, force: true });
}
const SKIP_DIRS = new Set(['node_modules', '.git']);
/** 递归列出相对路径文件；默认深度 6、跳过 node_modules/.git 与 . 开头目录。 */
export async function walkFiles(dir, opts = {}) {
    const maxDepth = opts.maxDepth ?? 6;
    const out = [];
    const visit = async (cur, rel, depth) => {
        if (depth > maxDepth)
            return;
        let items;
        try {
            items = await fsp.readdir(cur, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const item of items) {
            if (item.name.startsWith('.') && !(opts.includeDotDirs && depth === 0))
                continue;
            if (SKIP_DIRS.has(item.name))
                continue;
            const relPath = rel ? `${rel}/${item.name}` : item.name;
            if (item.isDirectory()) {
                await visit(path.join(cur, item.name), relPath, depth + 1);
            }
            else if (item.isFile()) {
                out.push(relPath);
            }
        }
    };
    await visit(dir, '', 0);
    return out.sort();
}
const TEXT_EXTS = new Set([
    '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.ts', '.js', '.mjs', '.cjs',
    '.py', '.sh', '.ps1', '.css', '.html', '.xml', '.csv', '.toml', '.ini', '.svg',
]);
export function isTextFile(name) {
    return TEXT_EXTS.has(path.extname(name).toLowerCase()) || !path.extname(name);
}
export class SyncError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = 'SyncError';
    }
}
