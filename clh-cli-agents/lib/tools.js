import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'clh-cli-agents-tools';
export const inject = ['tools'];
/** 主插件行未挂载时的明确报错（而不是 undefined 上取方法崩掉）。 */
function svc(ctx) {
    const s = ctx.get('clhCliAgents');
    if (!s) {
        throw new Error('clh-cli-agents 主插件行未挂载（ctx.clhCliAgents 不可用）；请在组合中加入 "@cinlan/clh-cli-agents" 行');
    }
    return s;
}
/** RunResult → 模型可读文本：状态行 + 截断的 stdout/stderr（超长时明确标注）。 */
export function renderRunResult(r) {
    const lines = [];
    const status = [
        `agent: ${r.agent}`,
        `ok: ${r.ok}`,
        `exitCode: ${r.exitCode}`,
        r.timedOut ? '(超时被终止)' : '',
        `durationMs: ${r.durationMs}`,
    ].filter(Boolean).join('  ');
    lines.push(status);
    if (r.error)
        lines.push(`error: ${r.error}`);
    const stdout = r.stdout.trim();
    if (stdout) {
        lines.push('--- stdout ---');
        if (stdout.length > 4000) {
            lines.push(stdout.slice(0, 4000) + `\n…(截断，全长 ${stdout.length} 字符${r.truncated ? '；进程输出超过采集上限' : ''})`);
        }
        else {
            lines.push(stdout);
        }
    }
    const stderr = r.stderr.trim();
    if (stderr) {
        lines.push('--- stderr ---');
        lines.push(stderr.length > 1000 ? stderr.slice(0, 1000) + '…(截断)' : stderr);
    }
    if (!stdout && !stderr)
        lines.push('（agent 无输出）');
    return lines.join('\n');
}
function asText(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'cli_agents_list',
        description: '列出已配置的外部 CLI agent（orca 式目录）及其探测状态（是否安装、版本行）。',
        parameters: {
            refresh: { type: 'boolean', description: 'true 时重新探测（默认读启动时的缓存）' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: asText(value) }] },
        async execute(args) {
            const service = svc(ctx);
            const detects = await service.detectAll(Boolean(args.refresh));
            const agents = service.list();
            const rows = agents.map((a) => {
                const d = detects.find((x) => x.agent === a.id);
                const state = d ? (d.installed ? `就绪${d.version ? `（${d.version}）` : ''}` : `不在位：${d.error ?? '未知原因'}`) : '未探测';
                return `- ${a.id}${a.description ? `（${a.description}）` : ''}  command: ${a.command}  注入: ${a.promptInjectionMode}  ${state}`;
            });
            return rows.length > 0 ? `已配置 ${rows.length} 个外部 CLI agent：\n${rows.join('\n')}` : '未配置任何外部 CLI agent（agents 为空）';
        },
    }));
    ctx.tools.register(defineTool({
        name: 'cli_agent_run',
        description: '把一个一次性任务派发给指定的外部 CLI agent（headless 运行并等待完成），返回其输出。'
            + ' 可用 agent 先用 cli_agents_list 查询。',
        parameters: {
            agent: { type: 'string', required: true, description: 'agent id（cli_agents_list 里列出的）' },
            prompt: { type: 'string', required: true, description: '派发给 agent 的任务/提示词' },
            timeoutMs: { type: 'number', description: '覆盖配置的超时（毫秒）' },
            cwd: { type: 'string', description: '覆盖配置的工作目录' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: asText(value) }] },
        async execute(args) {
            const result = await svc(ctx).run(String(args.agent), String(args.prompt), {
                timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            });
            return renderRunResult(result);
        },
    }));
}
