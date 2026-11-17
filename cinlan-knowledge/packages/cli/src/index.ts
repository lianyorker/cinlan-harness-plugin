export { ckHome, resolveConfig, type ResolvedConfig } from "./config.js";
export { rpc, RpcError, type RpcOptions } from "./rpc.js";
export { logEvent } from "./log.js";
export { expandHome } from "./paths.js";
export { hostConfig, knownHosts, type HostConfig } from "./hosts.js";
export { VERSION } from "./version.js";
export {
  PrepareError,
  callEnvelope,
  contextOf,
  dropCache,
  loadoutCachePath,
  makeKnowledgeRpc,
  parseAgent,
  prepare,
  type AgentSpec,
  type PrepareOptions,
  type PreparedLoadout,
} from "./prepare.js";
export {
  MARKER_FILE,
  materializeSkills,
  type MaterializeOptions,
  type MaterializeResult,
  type SkillSource,
} from "./skills.js";
export { httpSkillSource, type HttpSkillSourceOptions } from "./source.js";
export { SYNC_TIMEOUT_MS, runSkillsSync, syncSkills, type SkillsSyncOptions, type SyncOptions } from "./sync.js";
export { runHook, type HookOptions, type HookOutput } from "./hook.js";
export { INJECTED_DEDUPE_MS, createCliSession, type CliSession, type McpSessionOptions } from "./mcp.js";
export { runDoctor, type DoctorOptions } from "./doctor.js";
export {
  applyPlan,
  hookEntry,
  mcpEntry,
  planSetup,
  renderYamlBlock,
  type FileChange,
  type SetupOptions,
  type SetupPlan,
} from "./setup.js";
