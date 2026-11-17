// e2e 自举脚本：与 vendor/cordis/bin.js 同一加载链，但先挂一个 console exporter，
// 让 cordis 内部 logger（默认只写内存 buffer）的报错在终端可见——用于断言
// 坏配置在真实 loader 下的报错内容。
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
ctx.logger.exporter({
  export: (message) => {
    try {
      console.log('[cordis-log]', typeof message === 'string' ? message : JSON.stringify(message))
    } catch { /* 序列化失败不掩盖主流程 */ }
  },
})
await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
// 留时间让挂载错误（异步 fiber）落进 exporter
setTimeout(() => process.exit(0), 4000)
