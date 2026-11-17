import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createAgent, createTeam, createUser, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import { createAsset, findAssetRow, toAsset } from "../src/asset.js";
import {
  ACCESSIBLE_SQL,
  accessibleParams,
  canManage,
  canRead,
  requireManage,
  requireRead,
  type Principal,
} from "../src/access.js";

/**
 * T1 权限矩阵（docs/sop.md）：调用者关系 × 可见性 × 状态 × 读 / 管，全枚举。
 * 期望值取自 data-model §3：矩阵表给 active / deprecated 下的每一格，状态规则叠在上面——
 * draft 仅 Owner 可读，archived 仅管理者可读。
 * 每一格同时断言 canRead / canManage、对外错误码，以及 ACCESSIBLE_SQL 与 canRead 一致。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-access-"));
}

function cleanup(dir: string): void {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") return;
    }
  }
}

const VISIBILITIES = ["private", "team", "restricted", "agent"] as const;
const STATUSES = ["draft", "active", "deprecated", "archived"] as const;
type Visibility = (typeof VISIBILITIES)[number];
type Status = (typeof STATUSES)[number];

/** 一格：第一位 r = 可读，第二位 m = 可管。 */
type Cell = "rm" | "r-" | "-m" | "--";

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  team: ReturnType<typeof createTeam>;
  owner: User;
  admin: User;
  member: User;
  outsider: User;
  sa: User;
  memberAgent: string;
  outsiderAgent: string;
}

function fixture(dir: string): Fixture {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  // 建团队的人自动成为该团队 Admin，所以建队用 root，另起一个不在任何团队里的 System Admin
  const root = createUser(db, { name: "root", display_name: "Root", is_system_admin: true });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const owner = createUser(db, { name: "owner", display_name: "Owner" });
  const admin = createUser(db, { name: "admin", display_name: "Admin" });
  const member = createUser(db, { name: "member", display_name: "Member" });
  const outsider = createUser(db, { name: "out", display_name: "Out" });
  const team = createTeam(db, root, { name: "demo", title: "Demo" });
  addMember(db, root, team, owner);
  addMember(db, root, team, admin, "admin");
  addMember(db, root, team, member);
  // 团队外的人在别的团队是 Admin：角色只看资产所属团队
  const other = createTeam(db, root, { name: "other", title: "Other" });
  addMember(db, root, other, outsider, "admin");
  const memberAgent = createAgent(db, member, team, { name: "m-agent", host: "dsh" }).id;
  const outsiderAgent = createAgent(db, outsider, other, { name: "o-agent", host: "dsh" }).id;
  return { db, team, owner, admin, member, outsider, sa, memberAgent, outsiderAgent };
}

interface AclRow {
  subject_type: "user" | "role" | "agent";
  subject_id: string;
  permission: "read" | "manage";
}

interface Caller {
  name: string;
  principal: (f: Fixture) => Principal;
  /** restricted 资产上的 acl 行。其它可见性没有 acl：离开 restricted 即清空（asset/set-visibility）。 */
  acl?: (f: Fixture) => AclRow;
  /** 资产绑在这个 Agent 上（agent_asset）。 */
  bound?: (f: Fixture) => string;
  /** active / deprecated 下四档可见性各一格。 */
  expect: Record<Visibility, Cell>;
}

const user = (pick: (f: Fixture) => User) => (f: Fixture): Principal => ({ user: { id: pick(f).id } });
const withAgent = (pick: (f: Fixture) => User, agent: (f: Fixture) => string) => (f: Fixture): Principal => ({
  user: { id: pick(f).id },
  agent: { id: agent(f), owner_user_id: pick(f).id },
});

/**
 * 期望值即 data-model §3 矩阵表（含 O-14② 的 canManage ⇒ canRead）。
 * - Admin 对 restricted / agent：能管即能读 → `rm`（无需 ACL；之前实现少了这条兜底）。
 * - 团队外的人对 agent：规则只看 agent_asset，绑定行还在就可读，故是 `r-`。
 */
const CALLERS: Caller[] = [
  { name: "owner", principal: user((f) => f.owner), expect: { private: "rm", team: "rm", restricted: "rm", agent: "rm" } },
  { name: "admin", principal: user((f) => f.admin), expect: { private: "--", team: "rm", restricted: "rm", agent: "rm" } },
  {
    name: "admin + acl user:read",
    principal: user((f) => f.admin),
    acl: (f) => ({ subject_type: "user", subject_id: f.admin.id, permission: "read" }),
    expect: { private: "--", team: "rm", restricted: "rm", agent: "rm" },
  },
  { name: "member", principal: user((f) => f.member), expect: { private: "--", team: "r-", restricted: "--", agent: "--" } },
  {
    name: "member + acl user:read",
    principal: user((f) => f.member),
    acl: (f) => ({ subject_type: "user", subject_id: f.member.id, permission: "read" }),
    expect: { private: "--", team: "r-", restricted: "r-", agent: "--" },
  },
  {
    name: "member + acl user:manage",
    principal: user((f) => f.member),
    acl: (f) => ({ subject_type: "user", subject_id: f.member.id, permission: "manage" }),
    expect: { private: "--", team: "r-", restricted: "rm", agent: "--" },
  },
  {
    name: "member + acl role:member read",
    principal: user((f) => f.member),
    acl: () => ({ subject_type: "role", subject_id: "member", permission: "read" }),
    expect: { private: "--", team: "r-", restricted: "r-", agent: "--" },
  },
  {
    name: "member + acl role:admin read（角色不符）",
    principal: user((f) => f.member),
    acl: () => ({ subject_type: "role", subject_id: "admin", permission: "read" }),
    expect: { private: "--", team: "r-", restricted: "--", agent: "--" },
  },
  {
    name: "member 的 Agent + acl agent:read",
    principal: withAgent((f) => f.member, (f) => f.memberAgent),
    acl: (f) => ({ subject_type: "agent", subject_id: f.memberAgent, permission: "read" }),
    expect: { private: "--", team: "r-", restricted: "r-", agent: "--" },
  },
  {
    name: "member 本人（不带 Agent）+ acl agent:read",
    principal: user((f) => f.member),
    acl: (f) => ({ subject_type: "agent", subject_id: f.memberAgent, permission: "read" }),
    expect: { private: "--", team: "r-", restricted: "--", agent: "--" },
  },
  {
    name: "member 的 Agent，未绑定",
    principal: withAgent((f) => f.member, (f) => f.memberAgent),
    expect: { private: "--", team: "r-", restricted: "--", agent: "--" },
  },
  {
    name: "member 的 Agent，已绑定",
    principal: withAgent((f) => f.member, (f) => f.memberAgent),
    bound: (f) => f.memberAgent,
    expect: { private: "--", team: "r-", restricted: "--", agent: "r-" },
  },
  {
    name: "member 本人（不带 Agent），其 Agent 已绑定",
    principal: user((f) => f.member),
    bound: (f) => f.memberAgent,
    expect: { private: "--", team: "r-", restricted: "--", agent: "--" },
  },
  { name: "outsider", principal: user((f) => f.outsider), expect: { private: "--", team: "--", restricted: "--", agent: "--" } },
  {
    name: "outsider + acl user:read",
    principal: user((f) => f.outsider),
    acl: (f) => ({ subject_type: "user", subject_id: f.outsider.id, permission: "read" }),
    expect: { private: "--", team: "--", restricted: "r-", agent: "--" },
  },
  {
    name: "outsider + acl user:manage",
    principal: user((f) => f.outsider),
    acl: (f) => ({ subject_type: "user", subject_id: f.outsider.id, permission: "manage" }),
    expect: { private: "--", team: "--", restricted: "rm", agent: "--" },
  },
  {
    name: "outsider + acl role:admin read（别的团队的角色不算）",
    principal: user((f) => f.outsider),
    acl: () => ({ subject_type: "role", subject_id: "admin", permission: "read" }),
    expect: { private: "--", team: "--", restricted: "--", agent: "--" },
  },
  {
    name: "outsider 的 Agent + acl agent:read",
    principal: withAgent((f) => f.outsider, (f) => f.outsiderAgent),
    acl: (f) => ({ subject_type: "agent", subject_id: f.outsiderAgent, permission: "read" }),
    expect: { private: "--", team: "--", restricted: "r-", agent: "--" },
  },
  {
    name: "outsider 的 Agent，已绑定",
    principal: withAgent((f) => f.outsider, (f) => f.outsiderAgent),
    bound: (f) => f.outsiderAgent,
    // 规则≠表：agent 表上是 --
    expect: { private: "--", team: "--", restricted: "--", agent: "r-" },
  },
  // System Admin 的治理兜底（元数据 + 强制归档）不经 canRead / canManage：正文一格都读不到
  { name: "system admin（非成员）", principal: user((f) => f.sa), expect: { private: "--", team: "--", restricted: "--", agent: "--" } },
];

/** 状态规则叠到矩阵格上：draft 仅 Owner 可读；archived 仅管理者可读；管理权不随状态变。 */
function expected(cell: Cell, status: Status, isOwner: boolean): { read: boolean; manage: boolean } {
  const manage = cell[1] === "m";
  if (status === "draft") return { read: isOwner, manage };
  if (status === "archived") return { read: manage, manage };
  return { read: cell[0] === "r", manage };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    return (err as DomainError).code;
  }
}

test("T1: permission matrix — caller × visibility × status × read/manage, canRead and ACCESSIBLE_SQL agree", () => {
  const dir = tempDir();
  try {
    const f = fixture(dir);
    const { db } = f;
    const listable = db.prepare(`SELECT COUNT(*) AS n FROM asset a WHERE a.id = :id AND ${ACCESSIBLE_SQL}`);
    const now = new Date().toISOString();
    let cells = 0;

    for (const caller of CALLERS) {
      const principal = caller.principal(f);
      for (const visibility of VISIBILITIES) {
        for (const status of STATUSES) {
          const where = `${caller.name} / ${visibility} / ${status}`;
          // 每格一条新资产：Owner 新建（private + active），再直接落到目标可见性与状态
          const created = createAsset(db, { user: { id: f.owner.id } }, f.team.id, {
            type: "memory",
            title: where,
            content: "c",
          }).asset;
          db.prepare("UPDATE asset SET visibility = ?, status = ? WHERE id = ?").run(visibility, status, created.id);
          if (caller.acl && visibility === "restricted") {
            const row = caller.acl(f);
            db.prepare(
              "INSERT INTO acl (asset_id, subject_type, subject_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(created.id, row.subject_type, row.subject_id, row.permission, f.owner.id, now);
          }
          if (caller.bound) {
            db.prepare("INSERT INTO agent_asset (agent_id, asset_id, bound_by, created_at) VALUES (?, ?, ?, ?)").run(
              caller.bound(f),
              created.id,
              f.owner.id,
              now,
            );
          }
          const asset = toAsset(findAssetRow(db, created.id)!);
          const want = expected(caller.expect[visibility], status, principal.user.id === f.owner.id);

          assert.equal(canRead(db, principal, asset), want.read, `canRead: ${where}`);
          assert.equal(canManage(db, principal, asset), want.manage, `canManage: ${where}`);
          const listed = (listable.get({ ...accessibleParams(principal), id: asset.id }) as { n: number }).n === 1;
          assert.equal(listed, want.read, `ACCESSIBLE_SQL: ${where}`);
          // 对外：看不见即 NOT_FOUND；看得见但不够格才 FORBIDDEN
          assert.equal(codeOf(() => requireRead(db, principal, asset)), want.read ? null : "NOT_FOUND", `requireRead: ${where}`);
          assert.equal(
            codeOf(() => requireManage(db, principal, asset)),
            !want.read ? "NOT_FOUND" : want.manage ? null : "FORBIDDEN",
            `requireManage: ${where}`,
          );
          cells++;
        }
      }
    }
    assert.equal(cells, CALLERS.length * VISIBILITIES.length * STATUSES.length);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
