#!/usr/bin/env node
// 把 agents/<host>/ 的 host.json 与 templates/* 打成一份 JSON，供 /guide 渲染（panel-design.md §7 PD-3 A）。
// 片段与 ck setup 同源：这里只搬运文件内容，不改写。
//
//   node scripts/build-hosts.mjs            写 public/hosts.json
//   node scripts/build-hosts.mjs --stdout   打到 stdout，不落盘
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(here, "..", "..", "..", "agents");
const OUT = join(here, "..", "public", "hosts.json");

function readHost(dir) {
  const declaration = JSON.parse(readFileSync(join(AGENTS, dir, "host.json"), "utf8"));
  const tplDir = join(AGENTS, dir, "templates");
  const templates = readdirSync(tplDir)
    .filter((f) => statSync(join(tplDir, f)).isFile())
    .sort()
    .map((file) => ({ file, content: readFileSync(join(tplDir, file), "utf8").replaceAll("\r\n", "\n") }));
  return { name: declaration.name, title: declaration.title, declaration, templates };
}

const hosts = readdirSync(AGENTS)
  .filter((d) => statSync(join(AGENTS, d)).isDirectory())
  .sort()
  .map(readHost);

const json = `${JSON.stringify({ hosts }, null, 2)}\n`;

if (process.argv.includes("--stdout")) {
  process.stdout.write(json);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  process.stderr.write(`hosts.json: ${hosts.map((h) => h.name).join(", ")}\n`);
}
