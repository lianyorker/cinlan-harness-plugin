/**
 * PII / secrets 规则预检（deep-memory.md §3.5，2026-11-16 拍板落地）。
 * 形状正则匹配，零 LLM、零新依赖；命中**警告不拦截**——裁决权留在人审（B.3 自查清单 / 审批队列）。
 * 规则的选择：只收「出现即几乎必然是凭据 / 敏感」的形状，避免误报泛滥（电话号码、身份证不收——
 * 形状歧义太大，真需要的团队在共享审批里人审）。
 */

export interface PiiHit {
  kind: string;
}

interface Rule {
  kind: string;
  regex: RegExp;
}

const RULES: Rule[] = [
  { kind: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  // 排除 sk-ant- 前缀（Anthropic 的形状优先命中上一条）
  { kind: "openai_key", regex: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  // Bearer 后 ≥40 字符的随机串才计；20–39 的可能是占位符（如 "Bearer your-token-here"）
  { kind: "bearer_token", regex: /Bearer\s+[A-Za-z0-9-._]{40,}/ },
  // 私网 IP：排除本机回环与全零
  { kind: "private_ip", regex: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/ },
  { kind: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

/** 扫描一段文本，返回命中的 kind 列表（去重；不记正文——正文留在人审的视野里）。 */
export function scanPii(text: string): PiiHit[] {
  const kinds = new Set<string>();
  for (const rule of RULES) {
    if (rule.regex.test(text)) kinds.add(rule.kind);
  }
  return [...kinds].sort().map((kind) => ({ kind }));
}

/** 资产正文 = 标题 + 摘要 + 正文一起扫（共享审批读的是整个文档）。 */
export function scanAssetPii(input: { title: string; summary?: string; content: string }): PiiHit[] {
  return scanPii(`${input.title}\n${input.summary ?? ""}\n${input.content}`);
}
