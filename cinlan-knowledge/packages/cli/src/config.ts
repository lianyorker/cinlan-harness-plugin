import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 本机状态目录：~/.cinlan-knowledge，可用 CK_HOME 覆盖。 */
export function ckHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CK_HOME && env.CK_HOME !== "" ? env.CK_HOME : join(homedir(), ".cinlan-knowledge");
}

export interface ResolvedConfig {
  hub: string | null;
  key: string | null;
  /** 来源，doctor 用来解释取值顺序 */
  sources: { hub: "env" | "file" | "none"; key: "env" | "file" | "none" };
}

function readTrim(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * 取值顺序：环境变量 CK_HUB_URL / CK_USER_KEY 优先，其次本机文件
 * config.json（{"hub": "…"}）与 key（一行明文）。
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const home = ckHome(env);
  let hub: string | null = env.CK_HUB_URL && env.CK_HUB_URL !== "" ? env.CK_HUB_URL : null;
  let hubSource: ResolvedConfig["sources"]["hub"] = hub ? "env" : "none";
  if (!hub) {
    const file = join(home, "config.json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { hub?: unknown };
        if (typeof parsed.hub === "string" && parsed.hub !== "") {
          hub = parsed.hub;
          hubSource = "file";
        }
      } catch {
        // 坏文件等同没有；doctor 会报
      }
    }
  }

  let key: string | null = env.CK_USER_KEY && env.CK_USER_KEY !== "" ? env.CK_USER_KEY : null;
  let keySource: ResolvedConfig["sources"]["key"] = key ? "env" : "none";
  if (!key) {
    key = readTrim(join(home, "key"));
    if (key) keySource = "file";
  }

  return { hub: hub ? hub.replace(/\/+$/, "") : null, key, sources: { hub: hubSource, key: keySource } };
}
