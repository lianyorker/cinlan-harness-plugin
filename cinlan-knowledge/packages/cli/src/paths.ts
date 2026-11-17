import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `~` / `~/x` / `~\x` 展开到 home；`%VAR%` 展开环境变量（Windows 风格，hermes 的
 * `%LOCALAPPDATA%/hermes`）；变量未定义时保留字面量。其他原样返回。
 */
export function expandHome(path: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const withEnv = path.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => env[name] ?? m);
  if (withEnv === "~") return home;
  if (withEnv.startsWith("~/") || withEnv.startsWith("~\\")) return join(home, withEnv.slice(2));
  return withEnv;
}
