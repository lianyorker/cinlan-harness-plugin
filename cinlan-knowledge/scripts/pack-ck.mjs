#!/usr/bin/env node
// §5.7（acceptance-report，2026-11-14 拍板 A）/ decisions D-19：产出自包含的 `ck` 安装包。
//
//   node scripts/pack-ck.mjs [--out <dir>]        # 缺省 <仓库>/dist
//
// 产物固定叫 ck.tgz：拷到 hub 的 <dataDir>/dl/ck.tgz，成员按 install.md §5 装：
//   npm i -g http://<hub-host>:8424/dl/ck.tgz
//
// 自包含的做法（不引打包器）：
//   1. cli 的 stage（lib/ + agents/ + package.json）里只声明 registry 依赖
//      （来自 workspace 依赖闭包的非 workspace 依赖，即 zod 与 @modelcontextprotocol/server），
//      `npm install` 让 npm 解析 registry 侧（含传递依赖）；
//   2. workspace 依赖（@cinlan/knowledge-sdk / knowledge-mcp）手工拷进 stage/node_modules——
//      Node 的模块解析只认目录结构不查 registry，tarball 内嵌套 file: 的做法 npm 不支持；
//   3. node_modules 里实际装上的全部包登记 bundledDependencies，`npm pack` 把 node_modules
//      一并打进 tarball。安装机不需要 pnpm、不需要仓库，只要 Node ≥ 20。
//
// 前置：先 `pnpm -r build`（本脚本不构建，只打包）；npm 需要能访问 registry。

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * cli 的 workspace 依赖闭包（手动维护，按运行时 import 链）：cli → sdk、mcp；
 * mcp 运行时只 type-import core，core 不进 ck 的包（hub 侧自己在 workspace 里构建）。
 */
const WORKSPACE_DEPS = [
  { name: "@cinlan/knowledge-sdk", dir: "sdk" },
  { name: "@cinlan/knowledge-mcp", dir: "mcp" },
];

function fail(message) {
  process.stderr.write(`pack-ck: ${message}\n`);
  process.exit(1);
}

function npm(args, cwd) {
  const run = spawnSync("npm", args, { cwd, encoding: "utf8", shell: true });
  if (run.status !== 0) fail(`npm ${args.join(" ")} (in ${cwd}) failed:\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
}

const outFlag = process.argv.indexOf("--out");
const outDir = outFlag >= 0 ? resolve(process.argv[outFlag + 1] ?? "") : join(repo, "dist");

for (const dep of WORKSPACE_DEPS) {
  if (!existsSync(join(repo, "packages", dep.dir, "lib"))) fail(`packages/${dep.dir} has no lib/: run \`pnpm -r build\` first`);
}
if (!existsSync(join(repo, "packages", "cli", "lib"))) fail("packages/cli has no lib/: run `pnpm -r build` first");
if (!existsSync(join(repo, "packages", "cli", "agents"))) fail("packages/cli has no agents/: run `pnpm -r build` first");

const cliPkg = JSON.parse(readFileSync(join(repo, "packages", "cli", "package.json"), "utf8"));

const stage = mkdtempSync(join(tmpdir(), "ck-pack-"));
try {
  cpSync(join(repo, "packages", "cli", "lib"), join(stage, "lib"), { recursive: true });
  cpSync(join(repo, "packages", "cli", "agents"), join(stage, "agents"), { recursive: true });

  // 1. registry 依赖：workspace 闭包里所有非 workspace 依赖（zod、@modelcontextprotocol/server），
  //    由 npm 解析进 node_modules（含传递依赖）。
  const registryDeps = {};
  for (const dep of WORKSPACE_DEPS) {
    const pkg = JSON.parse(readFileSync(join(repo, "packages", dep.dir, "package.json"), "utf8"));
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (String(spec).startsWith("workspace:")) continue;
      if (registryDeps[name] !== undefined && registryDeps[name] !== spec) {
        fail(`conflicting registry dependency versions for ${name} across workspace deps`);
      }
      registryDeps[name] = spec;
    }
  }
  // cli 自己的依赖都是 workspace 包；stage 的 package.json 只声明 registry 侧
  //（devDependencies 不进安装包：typescript 那 3MB 与运行时无关）
  const staged = { ...cliPkg, dependencies: registryDeps };
  delete staged.scripts;
  delete staged.devDependencies;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  if (Object.keys(registryDeps).length > 0) npm(["install", "--no-audit", "--no-fund", "--loglevel=error"], stage);

  // 2. workspace 依赖手工进 node_modules：package.json 里的 workspace 引用删掉
  //（Node 解析只认目录；声明留给 npm 的部分已经不需要）。
  for (const dep of WORKSPACE_DEPS) {
    const dir = join(repo, "packages", dep.dir);
    const target = join(stage, "node_modules", ...dep.name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(dir, "lib"), join(target, "lib"), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const nested = { ...pkg };
    if (nested.dependencies !== undefined) {
      nested.dependencies = Object.fromEntries(
        Object.entries(nested.dependencies).filter(([, spec]) => !String(spec).startsWith("workspace:")),
      );
      if (Object.keys(nested.dependencies).length === 0) delete nested.dependencies;
    }
    delete nested.scripts;
    delete nested.devDependencies;
    writeFileSync(join(target, "package.json"), `${JSON.stringify(nested, null, 2)}\n`);
  }

  // 3. node_modules 里实际装上的全部包登记 bundledDependencies → npm pack 全打进 tarball
  const nm = join(stage, "node_modules");
  const bundled = [];
  for (const entry of readdirSync(nm, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(join(nm, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) bundled.push(`${entry.name}/${scoped.name}`);
      }
    } else {
      bundled.push(entry.name);
    }
  }
  if (bundled.length === 0) fail("node_modules is empty; nothing to bundle");
  // bundle 时把 workspace 依赖也按实版本写进 dependencies：npm pack 只打包「dependencies 声明过
  // 且列在 bundledDependencies」的包，手工放进 node_modules 却未声明的会被当 extraneous 丢弃。
  // 写的是已打进 node_modules 的版本号，且列在 bundledDependencies 里 → 安装机不会向 registry 查。
  const declaredDeps = { ...registryDeps };
  for (const dep of WORKSPACE_DEPS) {
    const pkg = JSON.parse(readFileSync(join(repo, "packages", dep.dir, "package.json"), "utf8"));
    declaredDeps[dep.name] = pkg.version;
  }
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify({ ...staged, dependencies: declaredDeps, bundledDependencies: bundled.sort() }, null, 2)}\n`,
  );

  // 4. pack → out/ck.tgz
  npm(["pack", "--silent", "--pack-destination", stage], stage);
  const packed = join(stage, `${cliPkg.name.replace(/^@/, "").replace(/\//g, "-")}-${cliPkg.version}.tgz`);
  if (!existsSync(packed)) fail(`npm pack produced no tarball (expected ${packed})`);
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, "ck.tgz");
  rmSync(dest, { force: true });
  renameSync(packed, dest);

  const bytes = statSync(dest).size;
  const sha256 = createHash("sha256").update(readFileSync(dest)).digest("hex");
  process.stdout.write(
    [
      `ck ${cliPkg.version} → ${dest}`,
      `  size    ${bytes} bytes`,
      `  sha256  ${sha256}`,
      `  bundled ${bundled.length} package(s): ${bundled.join(", ")}`,
      `  install: 拷到 hub 的 <dataDir>/dl/ck.tgz，成员执行 npm i -g http://<hub-host>:8424/dl/ck.tgz`,
      "",
    ].join("\n"),
  );
} finally {
  if (process.env.CK_PACK_KEEP === "1") process.stderr.write(`pack-ck: stage kept at ${stage}\n`);
  else rmSync(stage, { recursive: true, force: true });
}
