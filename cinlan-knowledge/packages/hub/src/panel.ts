import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/** panel 是静态 SPA：只有 `vite build` 的产物，没有服务端渲染。 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * User Key 存在 sessionStorage 里，页面被注入脚本就等于丢 key：脚本与连接只许同源，
 * 不许被别的页面嵌入。`style-src` 留 `unsafe-inline` 是组件库要写行内样式。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function sendFile(res: ServerResponse, file: string, cacheControl: string, head: boolean): Promise<void> {
  const info = await stat(file);
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    ...(ext === ".html" ? { "content-security-policy": CSP, "referrer-policy": "no-referrer" } : {}),
  });
  if (head) {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/**
 * `/panel/<rest>`：`rest` 是 URL 里还没解码的那一段。
 * 回 `sent` 表示响应已写出；`not_built` / `not_found` 由调用方回统一信封。
 * 没有扩展名的路径是前端路由，回 index.html；带扩展名却不存在的是缺文件，回 404。
 */
export async function servePanel(
  panelDir: string | undefined,
  rest: string,
  res: ServerResponse,
  head: boolean,
): Promise<"sent" | "not_built" | "not_found"> {
  if (panelDir === undefined) return "not_built";
  const root = resolve(panelDir);
  const index = join(root, "index.html");
  if (!(await isFile(index))) return "not_built";

  let rel: string;
  try {
    rel = decodeURIComponent(rest);
  } catch {
    return "not_found";
  }
  if (rel.includes("\0")) return "not_found";

  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return "not_found";

  if (target !== root && (await isFile(target))) {
    // 只有 assets/ 下的文件名带内容 hash，才能让浏览器长期缓存
    const hashed = target.startsWith(join(root, "assets") + sep);
    await sendFile(res, target, hashed ? "public, max-age=31536000, immutable" : "no-cache", head);
    return "sent";
  }
  if (extname(rel) !== "") return "not_found";
  await sendFile(res, index, "no-cache", head);
  return "sent";
}
