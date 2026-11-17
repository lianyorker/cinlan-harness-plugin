import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ckHome } from "./config.js";

/**
 * 本机日志（loadout.md §6）：`~/.cinlan-knowledge/logs/ck.log`，一行一个 JSON。
 * - 只写事件名与状态，不写 key、不写正文；
 * - 写失败打到 stderr：stdout 是 MCP / hook 的协议通道，任何时候都不能混入日志。
 */

export function logEvent(event: string, fields: Record<string, unknown> = {}, home: string = ckHome()): void {
  const dir = join(home, "logs");
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "ck.log"), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
  } catch (err) {
    process.stderr.write(`ck: log write failed: ${(err as Error).message}\n`);
  }
}
