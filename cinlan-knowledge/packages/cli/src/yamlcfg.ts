/**
 * hermes `config.yaml` 一类"嵌套键"宿主配置的结构化合并（hosts.md §4.6）。
 * 行级手术、不解析 YAML：顶层键列 0，直子键取段内最小缩进；条目以"相对缩进归一化后
 * 逐行等价"判幂等，同名不同内容报冲突，绝不覆盖他人条目——与 JSON/TOML 路径同一套语义。
 */

export type YamlMerge =
  | { status: "changed" | "unchanged"; text: string }
  | { status: "conflict"; detail: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

const topKeyRe = (key: string): RegExp => new RegExp(`^${escapeRegExp(key)}\\s*:`);
const childKeyRe = (indent: number, key: string): RegExp =>
  new RegExp(`^ {${indent}}${escapeRegExp(key)}\\s*:`);

function topKeyIndex(lines: string[], key: string): number {
  const re = topKeyRe(key);
  return lines.findIndex((line) => re.test(line));
}

/**
 * key 行 `start`（缩进 I）的块范围 [start+1, end)：首个不空、非注释且缩进 ≤ I 的行为界。
 * 例外：`- ` 列表项允许与 key 同缩进（`key:\n- a` 里 dash 仍是 key 的值）；
 * `---` / `...` 文档标记恒为界。
 */
function blockEnd(lines: string[], start: number): number {
  const indent = indentOf(lines[start]!);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trimStart();
    if (t === "" || t.startsWith("#")) continue;
    if (indentOf(line) <= indent) {
      if (indentOf(line) === indent && t.startsWith("-") && t !== "---" && t !== "...") continue;
      return i;
    }
  }
  return lines.length;
}

/** 段内第一条内容行；空段返回 null。 */
function firstChild(lines: string[], start: number, end: number): string | null {
  for (let i = start + 1; i < end; i++) {
    const t = lines[i]!.trimStart();
    if (t === "" || t.startsWith("#")) continue;
    return lines[i]!;
  }
  return null;
}

/** `key:` 行冒号后的内联值（裸值才剥注释，引号包裹的原样保留）。 */
function inlineValue(line: string): string {
  const colon = line.indexOf(":");
  let rest = line.slice(colon + 1).trim();
  if (!rest.startsWith("'") && !rest.startsWith('"')) {
    const hash = rest.indexOf("#");
    if (hash >= 0) rest = rest.slice(0, hash).trim();
  }
  return rest;
}

/** 可安全改写成块形式的内联值：空串、null、空容器。 */
const EMPTY_INLINE = new Set(["", "~", "null", "Null", "NULL", "{}", "[]"]);

function isEmptyInline(value: string): boolean {
  return EMPTY_INLINE.has(value);
}

/** 块尾插入点：跳过尾随空行与注释（注释约定属于下一段）；下界 `min`（含）。 */
function insertAt(lines: string[], end: number, min: number): number {
  let i = end;
  while (i > min && (lines[i - 1]!.trim() === "" || lines[i - 1]!.trimStart().startsWith("#"))) i--;
  return i;
}

/** 行组归一化：以首行缩进为基准剥离相对缩进、去行尾空白、丢空行与注释行。 */
function normalizeBlock(block: string[]): string[] {
  if (block.length === 0) return [];
  const base = indentOf(block[0]!);
  return block
    .map((line) => (indentOf(line) >= base ? line.slice(base) : line.trimStart()).trimEnd())
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function conflictDetail(key: string, existing: string[], wanted: string[]): YamlMerge {
  return {
    status: "conflict",
    detail: [
      `${key} exists with different content:`,
      "  current:",
      ...existing.map((l) => `    ${l}`),
      "  wanted:",
      ...wanted.map((l) => `    ${l}`),
    ].join("\n"),
  };
}

/** 在 `lines` 的 [start, end) 里找缩进恰为 `indent` 的 `child:` 行。 */
function findChild(lines: string[], start: number, end: number, indent: number, child: string): number {
  const re = childKeyRe(indent, child);
  for (let i = start; i < end; i++) if (re.test(lines[i]!)) return i;
  return -1;
}

type TopSection = { lines: string[]; topIdx: number; end: number; childIndent: number };

/** 顶层段定位与形状校验：找 `top:`、拒绝非空内联值与列表段。top 缺失时 topIdx=-1。 */
function topSection(text: string, top: string): TopSection | { conflict: string } {
  const lines = text === "" ? [] : text.split("\n");
  const topIdx = topKeyIndex(lines, top);
  if (topIdx < 0) return { lines, topIdx, end: -1, childIndent: 2 };
  const inline = inlineValue(lines[topIdx]!);
  if (!isEmptyInline(inline)) {
    return { conflict: `${top}: has an inline value that can't be merged:\n  ${lines[topIdx]!.trim()}` };
  }
  const end = blockEnd(lines, topIdx);
  const first = firstChild(lines, topIdx, end);
  if (first !== null && first.trimStart().startsWith("-")) {
    return { conflict: `${top}: is a list, expected a mapping` };
  }
  return { lines, topIdx, end, childIndent: first === null ? 2 : indentOf(first) };
}

/**
 * `top:` 段下并入直子映射 `child:`（如 `mcp_servers:` 下的 `ck:`）。
 * `entry` 是相对缩进的条目行：首行 `child:`，子行已含缩进。写入时整体右移 `childIndent`。
 * - top 段不存在 → 文件尾追加 `top:` + entry
 * - child 不存在 → 段尾插入；`child: {}` 空容器 → 整块换成 entry
 * - child 已存在且归一化等价 → unchanged；不同 → conflict
 */
export function mergeYamlMapEntry(text: string, top: string, child: string, entry: string[]): YamlMerge {
  const section = topSection(text, top);
  if ("conflict" in section) return { status: "conflict", detail: section.conflict };
  const { lines, topIdx } = section;

  if (topIdx < 0) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    out.push(`${top}:`, ...entry.map((l) => "  " + l));
    return { status: "changed", text: out.join("\n") };
  }

  const { end, childIndent } = section;
  const cIdx = findChild(lines, topIdx + 1, end, childIndent, child);
  const rendered = entry.map((l) => " ".repeat(childIndent) + l);

  if (cIdx < 0) {
    const at = insertAt(lines, end, topIdx + 1);
    const out = [...lines];
    out[topIdx] = `${top}:`; // `top: {}` 一类内联空容器改回块头
    out.splice(at, 0, ...rendered);
    return { status: "changed", text: out.join("\n") };
  }

  const cEnd = blockEnd(lines, cIdx);
  const cInline = inlineValue(lines[cIdx]!);
  if (cInline !== "" && isEmptyInline(cInline)) {
    const out = [...lines];
    out.splice(cIdx, cEnd - cIdx, ...rendered);
    return { status: "changed", text: out.join("\n") };
  }
  const existing = lines.slice(cIdx, cEnd);
  if (sameLines(normalizeBlock(existing), normalizeBlock(rendered))) return { status: "unchanged", text };
  return conflictDetail(`${top}.${child}`, existing, rendered);
}

/**
 * `top:` 段下的 `child:` 列表里并入一条 `item`（如 `hooks:` → `pre_llm_call:` → `- command:`）。
 * `item` 首行 `- ...`（相对缩进 0），后续行已含相对缩进；`marker` 子串认出自己的条目。
 * - child 不存在 → `top:` 段尾补 `child:` + item；空段 / `[]` → 补 item
 * - 已有 marker 条目：归一化等价 → unchanged；不同 → conflict
 * - child 是映射或非空内联值 → conflict
 */
export function mergeYamlListEntry(text: string, top: string, child: string, item: string[], marker: string): YamlMerge {
  const section = topSection(text, top);
  if ("conflict" in section) return { status: "conflict", detail: section.conflict };
  const { lines, topIdx } = section;

  if (topIdx < 0) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    out.push(`${top}:`, `  ${child}:`, ...item.map((l) => "    " + l));
    return { status: "changed", text: out.join("\n") };
  }

  const { end, childIndent } = section;
  const cIdx = findChild(lines, topIdx + 1, end, childIndent, child);
  const itemPad = " ".repeat(childIndent + 2);

  if (cIdx < 0) {
    const at = insertAt(lines, end, topIdx + 1);
    const out = [...lines];
    out[topIdx] = `${top}:`;
    out.splice(at, 0, `${" ".repeat(childIndent)}${child}:`, ...item.map((l) => itemPad + l));
    return { status: "changed", text: out.join("\n") };
  }

  const cInline = inlineValue(lines[cIdx]!);
  if (cInline !== "" && !isEmptyInline(cInline)) {
    return {
      status: "conflict",
      detail: `${top}.${child}: has an inline value that can't be merged:\n  ${lines[cIdx]!.trim()}`,
    };
  }
  const cEnd = blockEnd(lines, cIdx);
  const first = firstChild(lines, cIdx, cEnd);

  // `child:` 空段，或 `child: []`/`child: ~` 内联空：改回裸键头后铺条目
  if (first === null || cInline !== "") {
    const out = [...lines];
    out[cIdx] = `${" ".repeat(childIndent)}${child}:`;
    out.splice(cIdx + 1, 0, ...item.map((l) => itemPad + l));
    return { status: "changed", text: out.join("\n") };
  }

  if (!first.trimStart().startsWith("-")) {
    return { status: "conflict", detail: `${top}.${child}: is a mapping, expected a list` };
  }
  const itemIndent = indentOf(first);
  const dashRe = new RegExp(`^ {${itemIndent}}-`);
  const items: Array<{ start: number; end: number }> = [];
  for (let i = cIdx + 1; i < cEnd; i++) {
    if (dashRe.test(lines[i]!)) {
      if (items.length > 0) items[items.length - 1]!.end = i;
      items.push({ start: i, end: cEnd });
    }
  }
  for (const it of items) {
    const slice = lines.slice(it.start, it.end);
    if (slice.some((l) => l.includes(marker))) {
      if (sameLines(normalizeBlock(slice), normalizeBlock(item))) return { status: "unchanged", text };
      return conflictDetail(`${top}.${child}`, slice, item.map((l) => itemPad + l));
    }
  }
  const at = insertAt(lines, cEnd, cIdx + 1);
  const pad = " ".repeat(itemIndent);
  const out = [...lines];
  out.splice(at, 0, ...item.map((l) => pad + l));
  return { status: "changed", text: out.join("\n") };
}

/** doctor 用：`top:` 段下 `child:` 直子块的行切片（含 child 行）；找不到或形状不对返回 null。 */
export function yamlChildBlock(text: string, top: string, child: string): string[] | null {
  const lines = text.split("\n");
  const topIdx = topKeyIndex(lines, top);
  if (topIdx < 0) return null;
  const end = blockEnd(lines, topIdx);
  const first = firstChild(lines, topIdx, end);
  if (first === null || first.trimStart().startsWith("-")) return null;
  const idx = findChild(lines, topIdx + 1, end, indentOf(first), child);
  if (idx < 0) return null;
  return lines.slice(idx, blockEnd(lines, idx));
}
