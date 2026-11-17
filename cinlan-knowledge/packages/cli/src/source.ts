import { callEnvelope } from "./prepare.js";
import type { SkillSource } from "./skills.js";

/**
 * 物化用的 HTTP 取值（loadout.md §6 步骤 5）：走 `asset/get`。
 * 版本号一律显式带上——`asset/get` 不带 version 时给的是 current_version，
 * 中途发布新版会让 SKILL.md 与附属文件错配。
 */

/** `asset/get` 的 data 形状（core/src/asset.ts getAssetDetail）。 */
interface AssetGetData {
  version?: { content?: unknown };
  files?: { path?: unknown; bytes?: unknown }[];
  file?: { path?: unknown; encoding?: unknown; content?: unknown };
}

export interface HttpSkillSourceOptions {
  hub: string;
  key: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`asset/get: ${message}`);
}

export function httpSkillSource(options: HttpSkillSourceOptions): SkillSource {
  const get = async (body: Record<string, unknown>): Promise<AssetGetData> => {
    return (await callEnvelope({
      hub: options.hub,
      key: options.key,
      action: "asset/get",
      body,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })) as AssetGetData;
  };

  return {
    async read(assetId, version) {
      const data = await get({ asset_id: assetId, version });
      const content = data.version?.content;
      expect(typeof content === "string", `version ${version} of ${assetId} has no content`);
      const files = (data.files ?? []).map((f) => {
        expect(typeof f.path === "string" && typeof f.bytes === "number", `bad file entry in ${assetId} v${version}`);
        return { path: f.path as string, bytes: f.bytes as number };
      });
      return { files, content };
    },

    async readFile(assetId, version, path) {
      const data = await get({ asset_id: assetId, version, path });
      expect(data.file !== undefined, `${assetId} v${version} returned no file for ${path}`);
      const file = data.file;
      expect(file.path === path, `asked for ${path}, hub returned ${String(file.path)}`);
      // hub 的读文件接口固定回 base64；utf8 也收，其他编码直接报，不做猜测解码。
      if (file.encoding === "base64") {
        expect(typeof file.content === "string", `file ${path} has no content`);
        return Buffer.from(file.content, "base64");
      }
      if (file.encoding === "utf8") {
        expect(typeof file.content === "string", `file ${path} has no content`);
        return Buffer.from(file.content, "utf8");
      }
      throw new Error(`asset/get: file ${path} has unsupported encoding ${String(file.encoding)}`);
    },
  };
}
