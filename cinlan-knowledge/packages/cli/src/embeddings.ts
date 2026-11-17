import type { ResolvedConfig } from "./config.js";
import { callEnvelope } from "./prepare.js";
import type { EmbedFn } from "@cinlan/knowledge-mcp";

/**
 * `ck embeddings sync`（O-9 通道 A 外置 worker，vector-search.md §4.3）：
 * 拉 embedding/pending 差集 → 逐条取正文 → 调 openai-compatible 端点算向量 →
 * embedding/put 写回。hub 零 LLM；模型端点与额度都在本机/本团队自己手里。
 *
 * 逐条顺序处理（与 import 同款节奏）；单条失败记录后继续，退出码由汇总决定。
 */

/** 送进模型的文本：标题 + 摘要 + 正文，截断到 6000 字符（阶段一整条资产，不分块）。 */
const EMBED_TEXT_MAX = 6000;
/** 条目之间的固定间隔（与 import 的限速口径一致）。 */
const ITEM_INTERVAL_MS = 100;

export interface EmbeddingsSyncOptions {
  config: ResolvedConfig;
  /** openai-compatible 的 base URL（worker 会 POST `${url}/embeddings`）。 */
  url: string;
  model: string;
  apiKey?: string;
  team?: string;
  /** 单轮条数上限（embedding/pending 的 limit，1..200）。 */
  limit?: number;
  dryRun?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 进度输出（测试注入用；默认无输出——stdout 只留汇总 JSON）。 */
  log?: (message: string) => void;
}

export interface EmbeddingsSyncReport {
  ok: boolean;
  total: number;
  embedded: number;
  failed: number;
  failures: { asset_id: string; reason: string }[];
}

interface PendingItem {
  asset_id: string;
  version: number;
  title: string;
}

/** 调 openai-compatible 的 `/embeddings`，把一段文本转成向量。 */
async function embedText(
  options: { url: string; model: string; apiKey?: string; fetchImpl?: typeof fetch },
  text: string,
): Promise<number[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${options.url.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: options.model, input: [text] }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`embeddings endpoint ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  const parsed = JSON.parse(bodyText) as { data?: { embedding?: unknown }[] };
  const vec = parsed.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0 || !vec.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error("embeddings endpoint returned no usable vector");
  }
  return vec as number[];
}

/**
 * `ck mcp` 的查询向量注入（O-9 通道 A）：环境里配了 `CK_EMBED_URL` + `CK_EMBED_MODEL`
 * 才生效（`CK_EMBED_KEY` 可选）；没配返回 undefined——MCP 面走纯 FTS。
 * 返回的 EmbedFn 失败时抛错，由 searchTool 捕获降级。
 */
export function makeEmbedder(env: NodeJS.ProcessEnv = process.env): EmbedFn | undefined {
  const url = env.CK_EMBED_URL;
  const model = env.CK_EMBED_MODEL;
  if (url === undefined || url === "" || model === undefined || model === "") return undefined;
  const apiKey = env.CK_EMBED_KEY;
  return async (text: string): Promise<number[]> => embedText({ url, model, ...(apiKey !== undefined ? { apiKey } : {}) }, text);
}

export async function runEmbeddingsSync(options: EmbeddingsSyncOptions): Promise<EmbeddingsSyncReport> {
  const log = options.log ?? (() => {});
  const hub = { hub: options.config.hub!, key: options.config.key!, timeoutMs: options.timeoutMs };
  const pending = await callEnvelope({
    ...hub,
    action: "embedding/pending",
    body: { limit: options.limit ?? 50, ...(options.team !== undefined ? { team: options.team } : {}) },
  });
  const items = (pending["items"] ?? []) as PendingItem[];
  const report: EmbeddingsSyncReport = { ok: true, total: items.length, embedded: 0, failed: 0, failures: [] };

  for (const item of items) {
    try {
      // 正文从 hub 取现行版本；取不到（权限/状态刚变）记失败继续
      const detail = await callEnvelope({ ...hub, action: "asset/get", body: { asset_id: item.asset_id } });
      const asset = detail["asset"] as { title: string; summary?: string } | undefined;
      const version = detail["version"] as { content: string } | undefined;
      if (asset === undefined || version === undefined) throw new Error("asset/get returned no content");
      const text = `${asset.title}\n${asset.summary ?? ""}\n${version.content}`.slice(0, EMBED_TEXT_MAX);
      log(`embed ${item.asset_id} (${text.length} chars)`);
      if (options.dryRun === true) {
        report.embedded += 1;
        continue;
      }
      const vector = await embedText({ url: options.url, model: options.model, ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}), fetchImpl: options.fetchImpl }, text);
      await callEnvelope({
        ...hub,
        action: "embedding/put",
        body: { asset_id: item.asset_id, version: item.version, model: options.model, vectors: [vector] },
      });
      report.embedded += 1;
    } catch (err) {
      report.failed += 1;
      report.failures.push({ asset_id: item.asset_id, reason: (err as Error).message.slice(0, 200) });
    }
    await new Promise((r) => setTimeout(r, ITEM_INTERVAL_MS));
  }
  report.ok = report.failed === 0;
  return report;
}
