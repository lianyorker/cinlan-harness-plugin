import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupTo,
  closeDatabase,
  countUsers,
  createUser,
  createUserKey,
  ensureVec0,
  openDatabase,
} from "@cinlan/knowledge-core";
import { createHubServer, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";

/** 发布目录与仓库同构（install.md §3）：panel 的构建产物在兄弟包 `packages/panel/dist`。 */
const PANEL_DIR = fileURLToPath(new URL("../../panel/dist", import.meta.url));

const USAGE = `usage:
  cinlan-knowledge bootstrap --config <file> [--name <slug>] [--display-name <text>]
  cinlan-knowledge serve --config <file>
  cinlan-knowledge backup --config <file> --out <file>`;

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function mustConfig(argv: string[]) {
  const file = flag(argv, "--config");
  if (!file) die(USAGE);
  const { config, problems } = loadConfig(file);
  if (!config) die(`config invalid:\n  - ${problems.join("\n  - ")}`);
  return config;
}

async function bootstrap(argv: string[]): Promise<void> {
  const config = mustConfig(argv);
  const name = flag(argv, "--name") ?? "admin";
  const displayName = flag(argv, "--display-name") ?? name;

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, "dl"), { recursive: true });
  const db = openDatabase({ file: join(config.dataDir, "knowledge.db") });
  try {
    if (countUsers(db) > 0) die(`already bootstrapped: ${config.dataDir} has users`);
    const user = createUser(db, { name, display_name: displayName, is_system_admin: true });
    const key = createUserKey(db, user.id, "bootstrap");
    process.stdout.write(
      JSON.stringify(
        {
          user: { id: user.id, name: user.name, is_system_admin: user.is_system_admin },
          key: key.key,
          dataDir: config.dataDir,
          note: "key is shown once; store it outside the repo",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    closeDatabase(db);
  }
}

async function serve(argv: string[]): Promise<void> {
  const config = mustConfig(argv);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase({ file: join(config.dataDir, "knowledge.db") });
  // O-9：配置了 embedding 才建 vec0 索引；扩展加载失败时纯 FTS 降级启动（openDatabase 已尽力加载）
  if (config.embedding !== undefined && !ensureVec0(db, config.embedding.dims)) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        msg: "sqlite-vec unavailable; vector search disabled, hub runs pure-FTS",
        dims: config.embedding.dims,
      }) + "\n",
    );
  }
  // P5（optimization-analysis §1.4）：配置了 backup.every 才开自动备份
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  if (config.backup !== undefined) {
    const hours = Number(config.backup.every.slice(0, -1));
    backupTimer = setInterval(() => {
      try {
        const name = `knowledge-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
        backupTo(db, join(config.dataDir, "backups", name));
        process.stderr.write(JSON.stringify({ level: "info", msg: "backup written", file: name }) + "\n");
      } catch (err) {
        process.stderr.write(JSON.stringify({ level: "error", msg: "backup failed", error: (err as Error).message }) + "\n");
      }
    }, hours * 3600_000);
  }
  const server = createHubServer({ db, config, panelDir: PANEL_DIR });
  if (!existsSync(join(PANEL_DIR, "index.html"))) {
    process.stderr.write(
      JSON.stringify({ level: "warn", msg: "panel is not built; /panel/ returns 404", panelDir: PANEL_DIR, fix: "pnpm -F @cinlan/knowledge-panel build" }) + "\n",
    );
  }
  server.listen(config.listen.port, config.listen.host, () => {
    process.stdout.write(
      JSON.stringify({
        level: "info",
        msg: "hub listening",
        host: config.listen.host,
        port: config.listen.port,
        version: SERVER_VERSION,
      }) + "\n",
    );
  });
  server.on("error", (err) => {
    process.stderr.write(JSON.stringify({ level: "error", msg: "listen failed", error: err.message }) + "\n");
    closeDatabase(db);
    process.exit(1);
  });
  const shutdown = () => {
    if (backupTimer !== null) clearInterval(backupTimer);
    server.close(() => {
      closeDatabase(db);
      process.exit(0);
    });
    // 强制退出兜底：10 秒内未完成优雅关闭就结束进程
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function backup(argv: string[]): Promise<void> {
  const config = mustConfig(argv);
  const out = flag(argv, "--out");
  if (!out) die("backup requires --out <file>");
  if (existsSync(out)) die(`refusing to overwrite existing file: ${out}`);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase({ file: join(config.dataDir, "knowledge.db") });
  try {
    backupTo(db, out);
    process.stdout.write(JSON.stringify({ backed_up: out }) + "\n");
  } finally {
    closeDatabase(db);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "bootstrap") await bootstrap(rest);
else if (command === "serve") await serve(rest);
else if (command === "backup") await backup(rest);
else die(USAGE);
