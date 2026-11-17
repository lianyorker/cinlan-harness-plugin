import type { Asset, ImportedAsset, ImportStatus, SkillFile } from "@cinlan/knowledge-sdk";
import type { Principal } from "./access.js";
import { createAsset, LIMITS, prepareUpdate, readVersionRow, reloadAsset, updateAsset, type UpdateAssetInput } from "./asset.js";
import type { Db } from "./db.js";
import { notFound } from "./errors.js";
import { getTeamById, requireTeamRole } from "./meta.js";
import { updatePolicy } from "./review.js";
import { optOneOf, reqSlug, reqString, Validator } from "./validate.js";

/**
 * `asset/import`（api.md §3.3、hosts.md §8、data-model §9，P2）：把本机的一个 skill 登记成
 * 调用者自己的 private 资产。幂等在这里做——客户端不算 hash，只管把目录内容原样送上来。
 */

const IMPORT_PATH_MAX = 1024;
const ON_CONFLICT = ["new_version"] as const;

export interface ImportSkillInput {
  name: string;
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  files?: SkillFile[];
  host: string;
  import_path: string;
  on_conflict?: (typeof ON_CONFLICT)[number];
}

function summarize(db: Db, asset: Asset): ImportedAsset {
  const current = readVersionRow(db, asset.id, asset.current_version);
  if (!current) throw notFound("asset version not found");
  return {
    id: asset.id,
    name: asset.name!,
    title: asset.title,
    version: asset.current_version,
    content_hash: current.content_hash,
    visibility: asset.visibility,
    status: asset.status,
    updated_at: asset.updated_at,
  };
}

/**
 * 匹配键 = 本人在该团队名下的同名 skill（与 asset_name 唯一索引同一组列），归档的也算。
 * 没有 → 新建；有且 content_hash 相同 → unchanged；不同 → conflict，
 * 带 `on_conflict: "new_version"` 才出新版本。
 *
 * 入参是本机目录的整份快照：没给的 summary / tags / files 按空算，而不是沿用库里的值。
 *
 * 出新版本只走直通：按团队审批模式这次修改要过审批时（已共享的资产 + review_mode = all），
 * 这里不代发审批单，同样回 conflict、资产不动——要改请走 `asset/update`。
 */
export function importSkill(
  db: Db,
  principal: Principal,
  team_id: string,
  input: ImportSkillInput,
): { status: ImportStatus; asset: ImportedAsset } {
  requireTeamRole(db, team_id, principal.user.id, "member");
  const v = new Validator();
  const name = reqSlug(v, input, "name");
  const title = reqString(v, input, "title", LIMITS.title);
  const content = reqString(v, input, "content");
  const host = reqSlug(v, input, "host");
  const import_path = reqString(v, input, "import_path", IMPORT_PATH_MAX);
  const on_conflict = optOneOf(v, input, "on_conflict", ON_CONFLICT);
  v.done();

  const found = db
    .prepare("SELECT id FROM asset WHERE team_id = ? AND type = 'skill' AND owner_user_id = ? AND name = ?")
    .get(team_id, principal.user.id, name) as { id: string } | undefined;
  if (!found) {
    const { asset } = createAsset(
      db,
      principal,
      team_id,
      { type: "skill", name, title, content, summary: input.summary, tags: input.tags, files: input.files },
      { origin: "import", host, import_path },
    );
    return { status: "created", asset: summarize(db, asset) };
  }

  const existing = reloadAsset(db, found.id);
  const snapshot: UpdateAssetInput = {
    base_version: existing.current_version,
    title,
    content,
    summary: input.summary ?? "",
    tags: input.tags ?? [],
    files: input.files ?? [],
    change_note: `imported from ${host}`,
  };
  // 校验与"是否相同"都用更新路径的那一套，hash 口径才与写入时一致
  const { changed } = prepareUpdate(db, existing, snapshot);
  if (!changed) return { status: "unchanged", asset: summarize(db, existing) };
  if (on_conflict !== "new_version") return { status: "conflict", asset: summarize(db, existing) };

  const team = getTeamById(db, team_id);
  if (!team) throw notFound("team not found");
  // Owner 恒为管理者；private 恒直通，已共享的看团队审批模式
  if (updatePolicy(team.review_mode, existing.visibility === "private", true) !== "direct") {
    return { status: "conflict", asset: summarize(db, existing) };
  }
  updateAsset(db, principal, existing, snapshot);
  return { status: "updated", asset: summarize(db, reloadAsset(db, existing.id)) };
}
