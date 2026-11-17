import type {
  Agent,
  Asset,
  AssetType,
  Review,
  SkillFile,
  User,
  Verification,
} from "@cinlan/knowledge-sdk";
import { join } from "node:path";
import * as core from "@cinlan/knowledge-core";
import type { Db, Principal, UpdateAssetInput } from "@cinlan/knowledge-core";

/**
 * 动作注册表（api.md §3）。
 * 每个 handler 只做三件事：校验入参形状 → 调 core → 把结果装成 sdk 契约的形状。
 * 权限判定一律在 core 里，这里绝不自作主张放行。
 *
 * 写动作统一经 `write()`：先执行、后审计，detail 只记元数据（writeAudit 会拦下正文与 key）。
 */

export interface ActionContext {
  db: Db;
  /** 认证后的完整 User；角色判定（SA）需要它 */
  user: User;
  /** 传给 core 的主体；带 x-ck-agent-id 时含 agent */
  principal: Principal;
  request_id: string;
  server_version: string;
  /** hub 的数据目录；只有 `system/backup` 用它定落点 */
  data_dir: string;
}

export type ActionHandler = (ctx: ActionContext, body: Record<string, unknown>) => unknown;

const handlers = new Map<string, ActionHandler>();

export function register(action: string, handler: ActionHandler): void {
  if (handlers.has(action)) throw new Error(`duplicate action handler: ${action}`);
  handlers.set(action, handler);
}

export function getHandler(action: string): ActionHandler | undefined {
  return handlers.get(action);
}

export function implementedActions(): string[] {
  return [...handlers.keys()].sort();
}

// ---------------------------------------------------------------------------
// 入参取值：只做"形状对不对"，业务校验留给 core
// ---------------------------------------------------------------------------

function reqString(body: Record<string, unknown>, field: string): string {
  const raw = body[field];
  if (typeof raw !== "string" || raw === "") {
    throw core.invalid("invalid argument", [`${field} is required`]);
  }
  return raw;
}

function optString(body: Record<string, unknown>, field: string): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw core.invalid("invalid argument", [`${field} must be a string`]);
  return raw;
}

function optBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") throw core.invalid("invalid argument", [`${field} must be a boolean`]);
  return raw;
}

function optNumber(body: Record<string, unknown>, field: string): number | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw core.invalid("invalid argument", [`${field} must be a number`]);
  }
  return raw;
}

function optFiles(body: Record<string, unknown>): SkillFile[] | undefined {
  const raw = body["files"];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw core.invalid("invalid argument", ["files must be an array"]);
  return raw as SkillFile[];
}

/** 当前调用者对应的资产（不可见即 NOT_FOUND，由 core 给出）。 */
function assetOf(ctx: ActionContext, body: Record<string, unknown>): Asset {
  return core.getAsset(ctx.db, ctx.principal, reqString(body, "asset_id"));
}

function agentOf(ctx: ActionContext, body: Record<string, unknown>): Agent {
  const id = reqString(body, "agent_id");
  const agent = core.getAgent(ctx.db, id);
  if (!agent) throw core.notFound("agent not found");
  return agent;
}

function self(ctx: ActionContext): Principal {
  return { user: { id: ctx.user.id } };
}

// ---------------------------------------------------------------------------
// 写动作的审计包装
// ---------------------------------------------------------------------------

interface Audited<T> {
  data: T;
  target?: { type: string; id: string };
  detail?: Record<string, unknown>;
}

type WriteHandler = (ctx: ActionContext, body: Record<string, unknown>) => Audited<unknown>;

/**
 * 审计与业务变更同事务：core 里的 withTx 用 SAVEPOINT 嵌套，
 * 因此这里多包一层不会拆散内层的原子性，而审计失败会连同变更一起回滚。
 */
function write(action: string, handler: WriteHandler): void {
  register(action, (ctx, body) => {
    return core.withTx(ctx.db, () => {
      const out = handler(ctx, body);
      core.writeAudit(ctx.db, {
        action,
        request_id: ctx.request_id,
        actor_user_id: ctx.user.id,
        actor_agent_id: ctx.principal.agent?.id ?? null,
        target_type: out.target?.type ?? null,
        target_id: out.target?.id ?? null,
        detail: out.detail ?? {},
      });
      return out.data;
    });
  });
}

// ---------------------------------------------------------------------------
// 3.1 身份与团队
// ---------------------------------------------------------------------------

register("auth/verify", (ctx): Verification => ({
  user: ctx.user,
  is_system_admin: ctx.user.is_system_admin,
  teams: core.teamsOfUser(ctx.db, ctx.user.id),
  server_version: ctx.server_version,
}));

write("user/create", (ctx, body) => {
  core.requireSystemAdmin(ctx.user);
  const user = core.createUser(ctx.db, {
    name: reqString(body, "name"),
    display_name: reqString(body, "display_name"),
    is_system_admin: optBoolean(body, "is_system_admin"),
  });
  return { data: { user }, target: { type: "user", id: user.id }, detail: { is_system_admin: user.is_system_admin } };
});

write("user/create-with-key", (ctx, body) => {
  core.requireSystemAdmin(ctx.user);
  const expires_at = core.optIso(new core.Validator(), body, "expires_at") ?? null;
  return core.withTx(ctx.db, () => {
    const user = core.createUser(ctx.db, {
      name: reqString(body, "name"),
      display_name: reqString(body, "display_name"),
      is_system_admin: optBoolean(body, "is_system_admin"),
    });
    const issued = core.createUserKeyFor(ctx.db, ctx.user, user, reqString(body, "key_name"), expires_at);
    return {
      data: { user, key: { id: issued.id, prefix: issued.prefix, key: issued.key } },
      target: { type: "user", id: user.id },
      detail: { is_system_admin: user.is_system_admin, key_id: issued.id },
    };
  });
});

register("user/get", (ctx, body) => {
  core.requireSystemAdmin(ctx.user);
  return { user: core.resolveUserRef(ctx.db, body) };
});

register("user/list", (ctx, body) => {
  core.requireSystemAdmin(ctx.user);
  return core.listUsers(ctx.db, body);
});

write("user/disable", (ctx, body) => {
  core.requireSystemAdmin(ctx.user);
  const target = core.resolveUserRef(ctx.db, body);
  const disabled = optBoolean(body, "disabled");
  if (disabled === undefined) throw core.invalid("invalid argument", ["disabled is required"]);
  const user = core.setUserDisabled(ctx.db, ctx.user, target, disabled);
  return {
    data: { user },
    target: { type: "user", id: target.id },
    detail: { status: { from: target.status, to: user.status } },
  };
});

write("user-key/create", (ctx, body) => {
  const target = selfOrResolved(ctx, body);
  const issued = core.createUserKeyFor(
    ctx.db,
    ctx.user,
    target,
    reqString(body, "name"),
    core.optIso(new core.Validator(), body, "expires_at") ?? null,
  );
  return {
    data: { key: { id: issued.id, name: issued.name, prefix: issued.prefix, key: issued.key, expires_at: issued.expires_at } },
    target: { type: "user-key", id: issued.id },
    // 明文 key 不进审计
    detail: { user_id: target.id, key_name: issued.name, prefix: issued.prefix },
  };
});

register("user-key/list", (ctx, body) => {
  return { keys: core.listUserKeys(ctx.db, ctx.user, selfOrResolved(ctx, body)) };
});

write("user-key/revoke", (ctx, body) => {
  const target = selfOrResolved(ctx, body);
  const key_id = reqString(body, "key_id");
  core.revokeUserKey(ctx.db, ctx.user, target, key_id);
  return { data: { revoked: true as const }, target: { type: "user-key", id: key_id }, detail: { user_id: target.id } };
});

write("team/create", (ctx, body) => {
  const team = core.createTeam(ctx.db, ctx.user, {
    name: reqString(body, "name"),
    title: reqString(body, "title"),
    description: optString(body, "description"),
  });
  return { data: { team }, target: { type: "team", id: team.id } };
});

register("team/get", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  // 团队外的人不可见；SA 例外
  if (!ctx.user.is_system_admin) core.requireTeamRole(ctx.db, team.id, ctx.user.id, "member");
  return { team };
});

register("team/list", (ctx, body) => {
  return core.listTeams(ctx.db, ctx.user, body);
});

write("team/update", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const next = core.updateTeam(ctx.db, ctx.user, team, {
    title: optString(body, "title"),
    description: optString(body, "description"),
    review_mode: core.optOneOf(new core.Validator(), body, "review_mode", ["off", "share", "all"] as const),
    allow_self_approve: optBoolean(body, "allow_self_approve"),
  });
  return {
    data: { team: next },
    target: { type: "team", id: team.id },
    detail: {
      review_mode: { from: team.review_mode, to: next.review_mode },
      allow_self_approve: { from: team.allow_self_approve, to: next.allow_self_approve },
    },
  };
});

write("team/delete", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  core.deleteTeam(ctx.db, ctx.user, team);
  return { data: { deleted: true as const }, target: { type: "team", id: team.id }, detail: { name: team.name } };
});

write("team-member/add", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const target = requireUserRef(ctx, body);
  const role = core.optOneOf(new core.Validator(), body, "role", ["admin", "member"] as const) ?? "member";
  const member = core.addMember(ctx.db, ctx.user, team, target, role);
  return {
    data: { member },
    target: { type: "team", id: team.id },
    detail: { user_id: target.id, role: member.role },
  };
});

write("team-member/remove", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const target = requireUserRef(ctx, body);
  core.removeMember(ctx.db, ctx.user, team, target);
  return { data: { removed: true as const }, target: { type: "team", id: team.id }, detail: { user_id: target.id } };
});

write("team-member/set-role", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const target = requireUserRef(ctx, body);
  const role = core.optOneOf(new core.Validator(), body, "role", ["admin", "member"] as const);
  if (role === undefined) throw core.invalid("invalid argument", ["role is required"]);
  const member = core.setMemberRole(ctx.db, ctx.user, team, target, role);
  return {
    data: { member },
    target: { type: "team", id: team.id },
    detail: { user_id: target.id, role: { to: member.role } },
  };
});

register("team-member/list", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  return { members: core.listMembers(ctx.db, ctx.user, team) };
});

// ---------------------------------------------------------------------------
// 3.2 Agent
// ---------------------------------------------------------------------------

write("agent/ensure", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const out = core.ensureAgent(ctx.db, ctx.user, team, {
    name: reqString(body, "name"),
    host: reqString(body, "host"),
    description: optString(body, "description"),
  });
  return {
    data: out,
    target: { type: "agent", id: out.agent.id },
    detail: { created: out.created, template_applied: out.template_applied, host: out.agent.host },
  };
});

write("agent/create", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const agent = core.createAgent(ctx.db, ctx.user, team, {
    name: reqString(body, "name"),
    host: reqString(body, "host"),
    description: optString(body, "description"),
    is_template: optBoolean(body, "is_template"),
  });
  return { data: { agent }, target: { type: "agent", id: agent.id }, detail: { is_template: agent.is_template } };
});

register("agent/get", (ctx, body) => {
  const agent = agentOf(ctx, body);
  core.requireAgentAccess(ctx.db, ctx.user, agent);
  return { agent };
});

write("agent/update", (ctx, body) => {
  const agent = agentOf(ctx, body);
  const next = core.updateAgent(ctx.db, ctx.user, agent, {
    description: optString(body, "description"),
    host: optString(body, "host"),
    is_template: optBoolean(body, "is_template"),
  });
  return {
    data: { agent: next },
    target: { type: "agent", id: agent.id },
    detail: { host: { from: agent.host, to: next.host }, is_template: { from: agent.is_template, to: next.is_template } },
  };
});

write("agent/archive", (ctx, body) => {
  const agent = agentOf(ctx, body);
  const next = core.archiveAgent(ctx.db, ctx.user, agent);
  return {
    data: { agent: next },
    target: { type: "agent", id: agent.id },
    detail: { status: { from: agent.status, to: next.status } },
  };
});

register("agent/list", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  // owner / owner_user_id 二选一；core 只认 owner_user_id
  const hasOwner = body["owner_user_id"] !== undefined || body["owner"] !== undefined;
  const patch: Record<string, unknown> = { ...body };
  if (hasOwner) patch["owner_user_id"] = requireUserRef(ctx, body).id;
  return core.listAgents(ctx.db, ctx.user, team, patch);
});

write("agent/set-default-template", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const agent = agentOf(ctx, body);
  const next = core.setDefaultTemplate(ctx.db, ctx.user, team, agent);
  return {
    data: { team: next },
    target: { type: "team", id: team.id },
    detail: { template_agent_id: { from: team.template_agent_id, to: agent.id } },
  };
});

register("agent/get-default-template", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  return { agent: core.getDefaultTemplate(ctx.db, ctx.user, team) };
});

// ---------------------------------------------------------------------------
// 3.3 资产
// ---------------------------------------------------------------------------

write("asset/create", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const input: core.CreateAssetInput = {
    type: reqString(body, "type") as AssetType,
    name: optString(body, "name"),
    title: reqString(body, "title"),
    content: reqString(body, "content"),
    summary: optString(body, "summary"),
    tags: Array.isArray(body["tags"]) ? (body["tags"] as string[]) : undefined,
    layer: optString(body, "layer") as core.CreateAssetInput["layer"],
    files: optFiles(body),
  };
  const out = core.createAsset(ctx.db, ctx.principal, team.id, input);
  // PII / secrets 预检（deep-memory.md §3.5）：私有资产也扫——泄漏在共享前就该被发现
  const pii = core.scanAssetPii({ title: out.asset.title, summary: out.asset.summary, content: out.version.content });
  return {
    data: {
      asset: {
        id: out.asset.id,
        version: out.version.version,
        visibility: out.asset.visibility,
        status: out.asset.status,
        content_hash: out.version.content_hash,
      },
      ...(pii.length > 0 ? { warnings: { pii } } : {}),
    },
    target: { type: "asset", id: out.asset.id },
    detail: {
      type: out.asset.type,
      visibility: out.asset.visibility,
      version: out.version.version,
      ...(pii.length > 0 ? { pii_kinds: pii.map((p) => p.kind) } : {}),
    },
  };
});

register("asset/get", (ctx, body) => {
  const det = core.getAssetDetail(
    ctx.db,
    ctx.principal,
    reqString(body, "asset_id"),
    optNumber(body, "version"),
    optString(body, "path"),
  );
  // 运行面读取：带 agent 身份时记一次 opened，记账失败不影响读取
  if (ctx.principal.agent !== undefined) {
    try {
      core.recordOpened(ctx.db, ctx.principal.agent.id, det.asset.id);
    } catch (err) {
      process.stderr.write(`${JSON.stringify({ level: "warn", action: "asset/get", error: (err as Error).message })}\n`);
    }
  }
  return det;
});

write("asset/update", (ctx, body) => {
  const asset = assetOf(ctx, body);
  const input: UpdateAssetInput = {
    base_version: reqNumber(body, "base_version"),
    content: optString(body, "content"),
    title: optString(body, "title"),
    summary: optString(body, "summary"),
    tags: Array.isArray(body["tags"]) ? (body["tags"] as string[]) : undefined,
    files: optFiles(body),
    change_note: optString(body, "change_note"),
  };
  const out = core.updateThroughGate(ctx.db, ctx.principal, asset, input);
  const data = out.applied
    ? out.result
    : { status: "pending_review" as const, review_id: out.review!.id, proposed_version: out.result.version };
  return {
    data,
    target: { type: "asset", id: asset.id },
    detail: {
      version: out.applied ? { to: out.result.version } : { proposed: out.result.version },
      review_id: out.review?.id ?? null,
    },
  };
});

/** 版本回滚（deep-memory.md §5 #1）：读历史版本 → 直接落新版本（绕过 updateAsset 的无变化短路）。
 *  回滚 = 「现行版本回退到历史版本」，与 update 语义一致但强制产生新版本（即使内容相同，也要留痕）。
 *  直通时绕过 updateThroughGate 的无变化短路：直接 appendVersion + commitVersion。 */
write("asset/rollback", (ctx, body) => {
  const asset = assetOf(ctx, body);
  const targetVersion = reqNumber(body, "version");
  const detail = core.getAssetDetail(ctx.db, ctx.principal, asset.id, targetVersion);
  if (detail.version.state !== "committed") {
    throw core.invalid("invalid argument", [`version ${targetVersion} is not a committed version (state: ${detail.version.state})`]);
  }
  // 回滚带现行版本的文件（不清空 skill 附属文件）
  const files = ctx.db
    .prepare("SELECT path, bytes, sha256, data FROM asset_file WHERE asset_id = ? AND version = ? ORDER BY path")
    .all(asset.id, asset.current_version) as unknown as { path: string; bytes: number; sha256: string; data: Uint8Array }[];
  const filesInput = files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, data: Buffer.from(f.data) }));
  const result = core.withTx(ctx.db, () => {
    const { version } = core.appendVersion(ctx.db, asset, "committed", asset.current_version, ctx.user.id, {
      title: detail.version.title,
      summary: detail.version.summary,
      content: detail.version.content,
      tags: asset.tags,
      layer: asset.layer,
      expires_at: asset.expires_at,
      files: filesInput,
    }, `rollback to v${targetVersion}`);
    core.commitVersion(ctx.db, asset, version.version, {
      title: detail.version.title,
      summary: detail.version.summary,
      tags: asset.tags,
      layer: asset.layer,
      expires_at: asset.expires_at,
    });
    return { changed: true, version: version.version };
  });
  return {
    data: { status: "applied" as const, asset: { id: asset.id, version: result.version, visibility: asset.visibility, status: asset.status } },
    target: { type: "asset", id: asset.id },
    detail: { from: asset.current_version, to: targetVersion, applied: true },
  };
});

register("asset/list", (ctx, body) => core.listAssets(ctx.db, ctx.principal, body));

register("asset/search", (ctx, body) => core.searchAssets(ctx.db, ctx.principal, body));

register("asset/history", (ctx, body) => {
  return { versions: core.getHistory(ctx.db, ctx.principal, reqString(body, "asset_id")) };
});

write("asset/set-visibility", (ctx, body) => {
  const asset = assetOf(ctx, body);
  const plan = core.planVisibility(ctx.db, ctx.principal, asset, body);
  // PII / secrets 预检：提升可见性时扫当前正文（deep-memory.md §3.5）
  let pii: core.PiiHit[] = [];
  if (plan.elevates) {
    try {
      const detail = core.getAssetDetail(ctx.db, ctx.principal, asset.id);
      pii = core.scanAssetPii({ title: detail.asset.title, summary: detail.asset.summary, content: detail.version.content });
    } catch {
      // 预检失败不拦共享（getAssetDetail 在极少数并发下可能拒读）；扫描只是警告
    }
  }
  const out = core.setVisibilityThroughGate(ctx.db, ctx.principal, asset, plan.plan, plan.elevates, optString(body, "note") ?? "");
  const data: Record<string, unknown> = out.applied
    ? { status: "applied" as const }
    : { status: "pending_review" as const, review_id: out.review!.id };
  if (pii.length > 0) data["warnings"] = { pii };
  return {
    data,
    target: { type: "asset", id: asset.id },
    detail: {
      visibility: { from: asset.visibility, to: plan.plan.visibility },
      acl: plan.plan.acl.length,
      review_id: out.review?.id ?? null,
      ...(pii.length > 0 ? { pii_kinds: pii.map((p) => p.kind) } : {}),
    },
  };
});

write("asset/set-status", (ctx, body) => {
  const asset = assetOf(ctx, body);
  const action = core.optOneOf(new core.Validator(), body, "action", ["activate", "deprecate", "archive", "restore"] as const);
  if (action === undefined) throw core.invalid("invalid argument", ["action is required"]);
  const out = core.setStatusThroughGate(ctx.db, ctx.principal, asset, action, optString(body, "note") ?? "");
  const data = out.applied ? { asset: out.result } : { status: "pending_review" as const, review_id: out.review!.id };
  return {
    data,
    target: { type: "asset", id: asset.id },
    detail: { status: { from: asset.status, to: out.result.status }, review_id: out.review?.id ?? null },
  };
});

write("asset/purge", (ctx, body) => {
  const asset = assetOf(ctx, body);
  core.purgeAsset(ctx.db, ctx.principal, asset);
  return {
    data: { deleted: true as const },
    target: { type: "asset", id: asset.id },
    detail: { type: asset.type, status: asset.status },
  };
});

// P2：`ck import` 逐个 skill 调一次；unchanged / conflict 也留审计（import_path 是本机路径，不进 detail）
write("asset/import", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const host = reqString(body, "host");
  const out = core.importSkill(ctx.db, ctx.principal, team.id, {
    name: reqString(body, "name"),
    title: reqString(body, "title"),
    content: reqString(body, "content"),
    summary: optString(body, "summary"),
    tags: Array.isArray(body["tags"]) ? (body["tags"] as string[]) : undefined,
    files: optFiles(body),
    host,
    import_path: reqString(body, "import_path"),
    on_conflict: optString(body, "on_conflict") as core.ImportSkillInput["on_conflict"],
  });
  return {
    data: out,
    target: { type: "asset", id: out.asset.id },
    detail: { status: out.status, host, version: out.asset.version },
  };
});

write("acl/grant", (ctx, body) => {
  const asset = assetOf(ctx, body);
  const entry = {
    subject_type: reqString(body, "subject_type") as core.AclEntry["subject_type"],
    subject_id: reqString(body, "subject_id"),
    permission: reqString(body, "permission") as core.AclEntry["permission"],
  };
  const acl = core.grantAcl(ctx.db, ctx.principal, asset, entry);
  return {
    data: { acl },
    target: { type: "asset", id: asset.id },
    detail: { subject_type: entry.subject_type, subject_id: entry.subject_id, permission: entry.permission },
  };
});

write("acl/revoke", (ctx, body) => {
  const asset = assetOf(ctx, body);
  const entry = {
    subject_type: reqString(body, "subject_type") as core.AclEntry["subject_type"],
    subject_id: reqString(body, "subject_id"),
  };
  core.revokeAcl(ctx.db, ctx.principal, asset, entry);
  return {
    data: { revoked: true as const },
    target: { type: "asset", id: asset.id },
    detail: { subject_type: entry.subject_type, subject_id: entry.subject_id },
  };
});

register("acl/list", (ctx, body) => {
  return { acl: core.listAcl(ctx.db, ctx.principal, assetOf(ctx, body)) };
});

register("acl/check", (ctx, body) => {
  return core.checkAcl(
    ctx.db,
    ctx.principal,
    reqString(body, "asset_id"),
    optString(body, "agent_id"),
  );
});

// ---------------------------------------------------------------------------
// 3.4 配装
// ---------------------------------------------------------------------------

register("loadout/get", (ctx, body) => {
  return { bindings: core.listBindings(ctx.db, ctx.principal, reqString(body, "agent_id")) };
});

write("loadout/set", (ctx, body) => {
  const bindings = core.setBindings(ctx.db, ctx.principal, body);
  return {
    data: { bindings },
    target: { type: "agent", id: reqString(body, "agent_id") },
    detail: { bindings: bindings.map((b) => b.asset_id) },
  };
});

write("loadout/bind", (ctx, body) => {
  const binding = core.bindAsset(ctx.db, ctx.principal, body);
  return {
    data: { binding },
    target: { type: "agent", id: reqString(body, "agent_id") },
    detail: { asset_id: binding.asset_id, priority: binding.priority, injection_mode: binding.injection_mode },
  };
});

write("loadout/unbind", (ctx, body) => {
  const agent_id = reqString(body, "agent_id");
  const asset_id = reqString(body, "asset_id");
  core.unbindAsset(ctx.db, ctx.principal, body);
  return {
    data: { unbound: true as const },
    target: { type: "agent", id: agent_id },
    detail: { asset_id },
  };
});

register("loadout/resolve", (ctx, body) => core.resolveLoadout(ctx.db, ctx.principal, body));

// 模板下发是显式动作，留审计（architecture.md §4、D-06）
write("loadout/sync-template", (ctx, body) => {
  const out = core.syncTemplate(ctx.db, ctx.principal, body);
  return {
    data: out,
    target: { type: "agent", id: reqString(body, "agent_id") },
    detail: {
      mode: body["mode"] ?? null,
      applied: out.applied,
      removed: out.removed,
      template_agent_id: out.template_agent_id,
    },
  };
});

// ---------------------------------------------------------------------------
// 3.5 审批、用量
// ---------------------------------------------------------------------------

register("review/list", (ctx, body) => core.listReviews(ctx.db, ctx.principal, body));

register("review/get", (ctx, body) => {
  const det = core.getReview(ctx.db, ctx.principal, reqString(body, "review_id"));
  return {
    review: {
      id: det.id,
      team_id: det.team_id,
      asset_id: det.asset_id,
      kind: det.kind,
      status: det.status,
      requester_user_id: det.requester_user_id,
      note: det.note,
      reviewer_user_id: det.reviewer_user_id,
      reason: det.reason,
      created_at: det.created_at,
      decided_at: det.decided_at,
    } satisfies Review,
    base: det.current === null ? null : { version: det.current.version, title: det.current.title, content: det.current.content },
    proposed:
      det.proposed === null
        ? null
        : { version: det.proposed.version, title: det.proposed.title, content: det.proposed.content },
  };
});

write("review/decide", (ctx, body) => {
  const review = core.decideReview(ctx.db, ctx.principal, body);
  return {
    data: { review },
    target: { type: "review", id: review.id },
    detail: { status: review.status, decision: body["decision"] ?? null, asset_id: review.asset_id },
  };
});

write("review/withdraw", (ctx, body) => {
  const review = core.withdrawReview(ctx.db, ctx.principal, reqString(body, "review_id"));
  return {
    data: { review },
    target: { type: "review", id: review.id },
    detail: { status: review.status, asset_id: review.asset_id },
  };
});

// 用量是记账而不是变更：逐条事件已经落在 usage_daily，不再写审计（data-model §7）
register("usage/report", (ctx, body) => core.reportUsage(ctx.db, ctx.principal, body));

// 只读汇总：TA 看本团队，SA 看全部
register("usage/summary", (ctx, body) => core.usageSummary(ctx.db, ctx.user, body));

// 审计只读：TA 的边界按目标反查团队（audit 表没有 team 列）
register("audit/list", (ctx, body) => core.listAudit(ctx.db, ctx.user, body));

// system/*：仅 SA（判定在 core）。统计与复算只读，不写审计
register("system/stats", (ctx) => core.systemStats(ctx.db, ctx.user));
register("system/integrity", (ctx) => core.checkIntegrity(ctx.db, ctx.user));

// VACUUM 不能在事务里跑，所以不经 write()：先出备份，再单独记一条审计。
// 落点固定在 <dataDir>/backups/，请求体里不收路径。
register("system/backup", (ctx) => {
  const backup = core.createBackup(ctx.db, ctx.user, join(ctx.data_dir, "backups"));
  core.writeAudit(ctx.db, {
    action: "system/backup",
    request_id: ctx.request_id,
    actor_user_id: ctx.user.id,
    actor_agent_id: ctx.principal.agent?.id ?? null,
    target_type: null,
    target_id: null,
    detail: { name: backup.file, size: backup.bytes },
  });
  return { backup };
});

// ---------------------------------------------------------------------------
// P3：向量检索（O-9，通道 A 外置 worker——模型在宿主侧调，hub 只存结果）
// ---------------------------------------------------------------------------

write("embedding/put", (ctx, body) => {
  const asset = assetOf(ctx, body);
  core.requireManage(ctx.db, ctx.principal, asset);
  const rawVectors = body["vectors"];
  if (
    !Array.isArray(rawVectors) ||
    rawVectors.length === 0 ||
    !rawVectors.every((vec) => Array.isArray(vec) && vec.every((x) => typeof x === "number" && Number.isFinite(x)))
  ) {
    throw core.invalid("invalid argument", ["vectors must be a non-empty array of finite-number arrays"]);
  }
  const version = optNumber(body, "version");
  const written = core.putEmbeddings(ctx.db, {
    asset_id: asset.id,
    ...(version !== undefined ? { version } : { version: asset.current_version }),
    model: reqString(body, "model"),
    vectors: rawVectors as number[][],
  });
  return {
    data: { written },
    target: { type: "asset", id: asset.id },
    detail: { model: reqString(body, "model"), vectors: written, version: version ?? asset.current_version },
  };
});

register("embedding/pending", (ctx, body) => core.pendingEmbeddings(ctx.db, ctx.principal, body));

// ---------------------------------------------------------------------------
// P3：自动沉淀（O-7，通道 A' 客户端抽取——候选直落私有草稿）+ 草稿采纳
// ---------------------------------------------------------------------------

write("session/report", (ctx, body) => {
  const team = core.resolveTeam(ctx.db, body);
  const candidates = body["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw core.invalid("invalid argument", ["candidates must be a non-empty array"]);
  }
  if (candidates.length > 5) {
    throw core.invalid("invalid argument", ["at most 5 candidates per report"]);
  }
  const sessionId = optString(body, "session_id");

  // v2 evidence trail（deep-memory.md §2 observations）：同标题的草稿不再重复创建，
  // 合并进已有草稿——累积 session_ids 与 proof_count（信念强度）。
  const existingDrafts = core.listAssets(ctx.db, ctx.principal, {
    team_id: team.id,
    status: "draft",
    limit: 100,
  }).items;
  const byTitle = new Map(existingDrafts.filter((a) => a.type === "memory").map((a) => [a.title, a]));

  const drafts = candidates.map((raw) => {
    const input = raw as Record<string, unknown>;
    const title = input["title"] as string;

    // evidence trail：重复标题 → 合并进已有草稿（更新 source 的 session_ids / proof_count）
    const existing = byTitle.get(title);
    if (existing !== undefined && existing.owner_user_id === ctx.user.id) {
      const source = existing.source as { origin?: string; session_id?: string; session_ids?: string[]; proof_count?: number };
      const sessions = source.session_ids ?? (source.session_id ? [source.session_id] : []);
      const proof = (source.proof_count ?? sessions.length) + 1;
      const newSessions = sessionId !== undefined && !sessions.includes(sessionId) ? [...sessions, sessionId] : sessions;
      ctx.db
        .prepare("UPDATE asset SET source = ?, updated_at = ? WHERE id = ?")
        .run(
          JSON.stringify({
            ...source,
            origin: "capture",
            session_id: newSessions[0] ?? source.session_id,
            session_ids: newSessions,
            proof_count: proof,
          }),
          new Date().toISOString(),
          existing.id,
        );
      return {
        id: existing.id,
        title: existing.title,
        visibility: existing.visibility,
        status: existing.status,
        proof_count: proof,
        ...(newSessions.length > 0 ? { session_ids: newSessions } : {}),
      } as { id: string; title: string; visibility: string; status: string; proof_count?: number; session_ids?: string[]; warnings?: { pii: core.PiiHit[] } };
    }

    const out = core.createAsset(
      ctx.db,
      ctx.principal,
      team.id,
      {
        type: input["type"] as AssetType,
        ...(input["name"] !== undefined ? { name: optString(input, "name") } : {}),
        title,
        content: input["content"] as string,
        ...(input["summary"] !== undefined ? { summary: optString(input, "summary") } : {}),
        ...(input["tags"] !== undefined ? { tags: input["tags"] as string[] } : {}),
        ...(input["layer"] !== undefined ? { layer: optString(input, "layer") as core.CreateAssetInput["layer"] } : {}),
        status: "draft",
      },
      {
        origin: "capture",
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        ...(sessionId !== undefined ? { session_ids: [sessionId], proof_count: 1 } : {}),
      },
    );
    // PII 预检（deep-memory.md §3.5）：草稿逐条扫，命中警告不拦截（私人草稿，人审前还有时间改）
    const pii = core.scanAssetPii({ title: out.asset.title, summary: out.asset.summary, content: out.version.content });
    return {
      id: out.asset.id,
      title: out.asset.title,
      visibility: out.asset.visibility,
      status: out.asset.status,
      ...(sessionId !== undefined ? { proof_count: 1, session_ids: [sessionId] } : {}),
      ...(pii.length > 0 ? { warnings: { pii } } : {}),
    };
  });
  const allKinds = [...new Set(drafts.flatMap((d) => ((d as { warnings?: { pii: core.PiiHit[] } }).warnings?.pii ?? []).map((p) => p.kind)))];
  return {
    data: { drafts },
    target: { type: "asset", id: drafts[0]!.id },
    detail: {
      team: team.id,
      count: drafts.length,
      session_id: sessionId ?? null,
      ...(allKinds.length > 0 ? { pii_kinds: allKinds } : {}),
    },
  };
});

write("inbox/adopt", (ctx, body) => {
  const out = core.adoptDraft(ctx.db, ctx.principal, body);
  return {
    data: {
      asset_id: out.asset.id,
      status: out.asset.status,
      visibility: out.asset.visibility,
      review_id: out.review?.id ?? null,
    },
    target: { type: "asset", id: out.asset.id },
    detail: { status: { to: out.asset.status }, visibility: out.asset.visibility, review_id: out.review?.id ?? null },
  };
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * user-key 系列动作的目标：不给 user_id / user 就是本人。
 * 给了一个就按它解析（SA 可代管；本人以外由 core 的 assertSelfOrAdmin 拦）。
 */
function selfOrResolved(ctx: ActionContext, body: Record<string, unknown>): User {
  if (body["user_id"] === undefined && body["user"] === undefined) return ctx.user;
  return core.resolveUserRef(ctx.db, body);
}

function requireUserRef(ctx: ActionContext, body: Record<string, unknown>): User {
  if (body["user_id"] === undefined && body["user"] === undefined) {
    throw core.invalid("invalid argument", ["user_id or user is required"]);
  }
  return core.resolveUserRef(ctx.db, body);
}

function reqNumber(body: Record<string, unknown>, field: string): number {
  const n = optNumber(body, field);
  if (n === undefined) throw core.invalid("invalid argument", [`${field} is required`]);
  return n;
}
