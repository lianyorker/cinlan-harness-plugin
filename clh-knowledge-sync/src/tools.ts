/**
 * @cinlan/clh-knowledge-sync/tools 插件行：向 harness 工具流水线注册四个模型可调用工具。
 * 依赖 ctx.tools（base profile 提供）与 ctx.clhKnowledgeSync（主插件行提供）。
 * 工具把结构化结果渲染为模型可读文本；服务未就绪时给出明确错误，不静默。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EntryKind } from './hub/store.js'
import type { clhKnowledgeSyncService, SyncServiceApi } from './index.js'

export const name = 'clh-knowledge-sync-tools'

export const inject = ['tools']

/** 主插件行未挂载时的明确报错（而不是 undefined 上取方法崩掉）。 */
function svc(ctx: Context): SyncServiceApi {
  const s = ctx.get('clhKnowledgeSync') as clhKnowledgeSyncService | undefined
  if (!s) {
    throw new Error('clh-knowledge-sync 主插件行未挂载（ctx.clhKnowledgeSync 不可用）；请在组合中加入 "@cinlan/clh-knowledge-sync" 行')
  }
  return s as unknown as SyncServiceApi
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description: '在跨实例共享的总记忆库中检索已审批的记忆条目（仅返回已过审批内容）。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词，可多个词' },
        limit: { type: 'number', description: '返回条数上限，默认 20' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: asText(value) }] },
      async execute(args) {
        return asText(await svc(ctx).search(args.query, args.limit))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_push',
      description: '把本地记忆与 skills 手动推送到远程总记忆库（进入待审批队列，过审批后才对其他实例可见）。',
      parameters: {
        force: { type: 'boolean', description: '冲突时强制覆盖远端版本（默认 false：冲突只报错）' },
        kind: { type: 'string', description: '只推某一类：memory 或 skill；默认两者' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: asText(value) }] },
      async execute(args) {
        const kind = args.kind === 'memory' || args.kind === 'skill' ? (args.kind as EntryKind) : undefined
        return asText(await svc(ctx).push(Boolean(args.force), kind))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_sync_status',
      description: '查看同步状态：各推送的审批结果（含拒绝原因）、冲突记录与最近错误。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: asText(value) }] },
      async execute() {
        return asText(await svc(ctx).status())
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'skills_sync',
      description: '与总记忆库同步 skills：push 推送本地 skills（进待审批队列），pull 拉取已审批的共享 skills 到本地技能目录。',
      parameters: {
        direction: { type: 'string', description: 'push | pull | both，默认 both' },
        force: { type: 'boolean', description: '拉取时覆盖本地同名不同内容（默认 false：保留冲突副本）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: asText(value) }] },
      async execute(args) {
        const direction = args.direction ?? 'both'
        const results: Record<string, unknown> = {}
        if (direction === 'push' || direction === 'both') results.push = await svc(ctx).push(Boolean(args.force), 'skill')
        if (direction === 'pull' || direction === 'both') results.pull = await svc(ctx).pull('skill')
        return asText(results)
      },
    }),
  )
}
