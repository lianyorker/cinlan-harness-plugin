/**
 * @cinlan/knowledge-sync 浏览器半包（手写 __ModuleLoader__ 形态，不经 tsdown）。
 * 宿主的 client-modules 把 exports["./client"] 即本文件按 /plugins/<id>/client.js
 * 发给浏览器并注册成 cordis 插件；apply 里向 settings.section 槽位注册
 * “记忆与技能同步”配置页，读写走 ctx.configForms.get('cinlan-knowledge-sync')
 * → 持久化进 profile cordis.patch.yml 的 override 行并热更服务运行时。
 * 模块表 seed 提供 react / react-dom / cordis / dsh-client-*；样式注入
 * <style data-plugin-css>，由模块系统随 fiber 卸载回收。
 */
window.__ModuleLoader__.load({
  id: '@cinlan/knowledge-sync',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    // ---------- locale ----------
    const NS = 'settings.cinlan-knowledge-sync'
    const en = {
      nav: 'Memory & Skills Sync',
      title: 'Memory & Skills Sync',
      intro: 'Share memory files and skills with other nodes through an approvable central hub. Changes apply live and persist to the profile patch.',
      loading: 'Loading sync configuration…',
      unavailable: 'The cinlan-knowledge-sync service is not exposing a settings namespace yet. It appears once the plugin is enabled and running.',
      save: 'Save changes', saving: 'Saving…', reset: 'Discard changes',
      saved: 'Saved.', saveFailed: 'Save rejected — values were reloaded from the profile.',
      dirty: 'Unsaved changes',
      groupHub: 'Hub connection', groupNode: 'Node', groupSync: 'Sync', groupOneshot: 'One-shot runner (advanced)', groupLog: 'Logging',
      nodeId: 'Node ID', nodeIdHelp: 'Unique node name registered at the hub.',
      nodeToken: 'Node token', nodeTokenHelp: 'Write-only. Leave empty to keep the current token.',
      activeProfile: 'Active hub profile', activeProfileHelp: 'Which profile under hub.profiles the node connects with.',
      profile: 'Edit profile', addProfile: 'Add profile', removeProfile: 'Remove profile',
      protocol: 'Protocol', host: 'Host', port: 'Port', basePath: 'Base path', timeoutMs: 'Timeout (ms)',
      profileToken: 'Profile token', profileTokenHelp: 'Write-only. Falls back to the node token when empty.',
      profileAdminToken: 'Admin token', profileAdminTokenHelp: 'Write-only. Unlocks the Memory Hub panel (approve / browse).',
      tlsTitle: 'TLS (https only)', rejectUnauthorized: 'Verify server certificate', caFile: 'CA file (optional)',
      auto: 'Auto sync', autoHelp: 'Push, read approvals and pull on an interval.',
      syncOnStart: 'Sync on start', syncOnStartHelp: 'Run one cycle when the service starts.',
      intervalSec: 'Interval (s)', memoryDir: 'Memory directory', memoryDirHelp: 'Absolute path; *.md with frontmatter id/expiry/tags.',
      skillRoots: 'Skill roots', skillRootsHelp: 'One absolute path per line; each child folder is one skill.',
      stateDirName: 'State folder', stateDirNameHelp: 'Plugin-private folder under the memory directory holding sync state and conflict copies. Usually keep the default.',
      syncScope: 'Write scope', syncScopeHelp: 'Namespace for this node\'s pushes: empty = global, proj:<name>, or proj:<name>:mod:<name>. The hub token must grant write access.',
      syncReadScopes: 'Read scopes', syncReadScopesHelp: 'Comma-separated scopes this node may pull/search. Empty = write scope plus its ancestors.',
      errScope: 'Invalid scope. Use empty (global), proj:<name> or proj:<name>:mod:<name> — lowercase letters, digits, - and _.',
      oneshotEnabled: 'Enable one-shot mode', oneshotCommands: 'Commands', oneshotCommandsHelp: 'One CLI command per line; results are written then the process exits.',
      oneshotResultFile: 'Result file', logLevel: 'Log level', logDir: 'Log dir', logDirHelp: 'Empty keeps stateDir/logs.',
      errHost: 'Host is required', errPort: 'Port must be 1-65535', errInterval: 'Interval must be a positive number',
      errMemory: 'Memory directory is required', errActiveMissing: 'Active profile must exist in the profile list',
      secretSet: 'leave empty to keep current', profileNameTaken: 'Profile name already exists',
      removeBlocked: 'Cannot remove the active profile', hubProfiles: 'Profiles',
      groupHubHelp: 'The central hub this node pushes to and pulls from.',
      groupNodeHelp: 'How this node identifies itself to the hub.',
      endpoint: 'Endpoint', hubSummaryNone: 'Not configured', nodeNone: 'Not set',
      edit: 'Edit', editHub: 'Edit hub profiles', editNode: 'Edit node', profilePick: 'Profile',
      syncInterval: 'Sync interval', syncIntervalHelp: 'How often to run a full push / approve / pull cycle.',
      unit_sec: 'seconds', unit_min: 'minutes', unit_hour: 'hours',
      browse: 'Browse\u2026', addSkillRoot: 'Add folder', remove: 'Remove',
      pickFailed: 'Could not open the system folder chooser \u2014 type the path instead.',
      advanced: 'Advanced', advancedHelp: 'One-shot runner and logging. Most setups leave these as-is.',
      show: 'Show', hide: 'Hide', done: 'Done', noProfiles: 'No profile yet \u2014 add one.',
    }
    const zh = {
      nav: '记忆与技能同步',
      title: '记忆与技能同步',
      intro: '通过可审批的中心 hub 与其他节点共享记忆文件和 skills。改动实时生效并写回 profile 补丁。',
      loading: '正在读取同步配置…',
      unavailable: 'cinlan-knowledge-sync 尚未开放 settings 命名空间。插件启用并运行后才会出现。',
      save: '保存更改', saving: '保存中…', reset: '放弃更改',
      saved: '已保存。', saveFailed: '保存被拒绝 —— 已从 profile 重新加载。',
      dirty: '有未保存的更改',
      groupHub: 'Hub 连接', groupNode: '节点', groupSync: '同步', groupOneshot: '一次性运行（高级）', groupLog: '日志',
      nodeId: '节点 ID', nodeIdHelp: '注册到 hub 的唯一节点名。',
      nodeToken: '节点令牌', nodeTokenHelp: '只写。留空则保留当前令牌。',
      activeProfile: '生效 Hub 配置', activeProfileHelp: 'hub.profiles 中当前使用的连接配置。',
      profile: '编辑配置', addProfile: '新增配置', removeProfile: '删除配置',
      protocol: '协议', host: '地址', port: '端口', basePath: 'Base path', timeoutMs: '超时 (ms)',
      profileToken: '配置令牌', profileTokenHelp: '只写。留空回落到节点令牌。',
      profileAdminToken: '管理员令牌', profileAdminTokenHelp: '只写。填了才解锁「记忆库管理」面板（审批 / 总库浏览）。',
      tlsTitle: 'TLS（仅 https）', rejectUnauthorized: '校验服务端证书', caFile: 'CA 文件（可选）',
      auto: '自动同步', autoHelp: '按周期推送、回读审批、拉取。',
      syncOnStart: '启动即同步', syncOnStartHelp: '服务启动时先跑一轮。',
      intervalSec: '周期（秒）', memoryDir: '记忆目录', memoryDirHelp: '绝对路径；*.md，frontmatter 带 id/expiry/tags。',
      skillRoots: 'Skill 根目录', skillRootsHelp: '每行一个绝对路径；其下每个子目录是一个 skill。',
      stateDirName: '状态目录', stateDirNameHelp: '插件私有目录（位于记忆目录下），存放同步状态与冲突副本，一般保持默认即可。',
      syncScope: '写入作用域', syncScopeHelp: '本节点推送归属的命名空间：留空=全局，proj:<名> 或 proj:<名>:mod:<名>；需 hub 令牌授此 scope。',
      syncReadScopes: '读取作用域', syncReadScopesHelp: '逗号分隔的可读 scope 列表；留空自动取写 scope 及其上级层（""+proj+mod）。',
      errScope: '作用域格式非法。应为空（全局）、proj:<名> 或 proj:<名>:mod:<名>——小写字母/数字/-/_。',
      oneshotEnabled: '启用一次性模式', oneshotCommands: '指令列表', oneshotCommandsHelp: '每行一条 CLI 指令；写完结果文件后进程退出。',
      oneshotResultFile: '结果文件', logLevel: '日志级别', logDir: '日志目录', logDirHelp: '留空使用 stateDir/logs。',
      errHost: 'Host 必填', errPort: '端口必须是 1-65535', errInterval: '周期必须是正数',
      errMemory: '记忆目录必填', errActiveMissing: '生效配置必须存在于配置列表',
      secretSet: '留空则保持不变', profileNameTaken: '配置名已存在',
      removeBlocked: '不能删除当前生效的配置', hubProfiles: '连接配置',
      groupHubHelp: '本节点推送 / 拉取所连接的中心 hub。',
      groupNodeHelp: '本节点向 hub 表明身份的方式。',
      endpoint: '连接地址', hubSummaryNone: '未配置', nodeNone: '未设置',
      edit: '编辑', editHub: '编辑 Hub 配置', editNode: '编辑节点', profilePick: '配置',
      syncInterval: '同步周期', syncIntervalHelp: '每隔多久跑一轮完整的推送 / 审批 / 拉取。',
      unit_sec: '秒', unit_min: '分钟', unit_hour: '小时',
      browse: '浏览\u2026', addSkillRoot: '添加目录', remove: '移除',
      pickFailed: '无法打开系统文件夹选择器，请手动输入路径。',
      advanced: '高级设置', advancedHelp: '一次性运行与日志，一般保持默认即可。',
      show: '展开', hide: '收起', done: '完成', noProfiles: '还没有配置，请先新增一个。',
    }

    // ---------- panel i18n ----------
    const PANEL_NS = 'panel.cinlan-knowledge-sync'
    const enPanel = {
      nav: 'Memory Hub', title: 'Memory Hub',
      tabPending: 'Pending', tabLibrary: 'Library', tabRejected: 'Rejected',
      refresh: 'Refresh', loading: 'Loading\u2026',
      emptyPending: 'Queue is clear \u2014 nothing awaiting approval.',
      emptyLibrary: 'The published library is empty.',
      emptyRejected: 'No rejected pushes.',
      emptyDetail: 'Select an item on the left.',
      searchPh: 'Filter by id / title / tag\u2026',
      filterAll: 'All kinds', filterMemory: 'Memories', filterSkill: 'Skills',
      approve: 'Approve', reject: 'Reject', reasonPh: 'Reason (required to reject)\u2026',
      acting: 'Working\u2026', decideOk: 'Done.', decideFail: 'Action failed',
      untitled: '(untitled)',
      metaNode: 'Node', metaTime: 'Received', metaUpdated: 'Updated',
      metaVersion: 'Version', metaSeq: 'Seq', metaTags: 'Tags', metaExpires: 'Expires',
      metaScope: 'Scope', scopeAll: 'All scopes', scopeGlobal: 'global',
      metaForce: 'Force push', metaRejectedReason: 'Rejection reason',
      cleanupFlagged: 'Flagged for cleanup',
      filesTitle: 'Files', contentTitle: 'Content',
      errGeneric: 'Request failed',
      errTokenMissing: 'Admin token is not configured \u2014 set hub.profiles.*.adminToken in the sync settings, then reopen this panel.',
    }
    const zhPanel = {
      nav: '记忆库管理', title: '记忆库管理',
      tabPending: '待审批', tabLibrary: '总库', tabRejected: '已拒绝',
      refresh: '刷新', loading: '加载中\u2026',
      emptyPending: '队列已清空 \u2014 没有待审批的推送。',
      emptyLibrary: '总库还没有已发布的内容。',
      emptyRejected: '没有被拒绝的推送。',
      emptyDetail: '在左侧选择一条查看详情。',
      searchPh: '按 id / 标题 / 标签过滤\u2026',
      filterAll: '全部类型', filterMemory: '记忆', filterSkill: '技能',
      approve: '通过', reject: '拒绝', reasonPh: '拒绝理由（拒绝时必填）\u2026',
      acting: '处理中\u2026', decideOk: '已完成。', decideFail: '操作失败',
      untitled: '（无标题）',
      metaNode: '来源节点', metaTime: '推送时间', metaUpdated: '更新时间',
      metaVersion: '版本', metaSeq: '序号', metaTags: '标签', metaExpires: '过期',
      metaScope: '作用域', scopeAll: '全部作用域', scopeGlobal: '全局',
      metaForce: '强制推送', metaRejectedReason: '拒绝理由',
      cleanupFlagged: '已标记待清理',
      filesTitle: '文件', contentTitle: '内容',
      errGeneric: '请求失败',
      errTokenMissing: '未配置管理员令牌 \u2014 在「记忆与技能同步」设置的 Hub 配置里填 adminToken 后重开面板。',
    }

    // ---------- styles (宿主 --dsw-alias-* 变量) ----------
    const css = `
.dss-form{display:flex;flex-direction:column;gap:26px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:13px;padding-bottom:4px}
.dss-intro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dss-group{display:flex;flex-direction:column;gap:14px}
.dss-ghd{display:flex;flex-direction:column;gap:3px}
.dss-group h3{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em}
.dss-gsub{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dss-divider{height:1px;border:0;margin:2px 0;background:var(--dsw-alias-border-l2)}
.dss-row{display:grid;grid-template-columns:168px 1fr;gap:6px 20px;align-items:start}
.dss-label{font-size:13px;line-height:34px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dss-cell{display:flex;flex-direction:column;gap:5px;min-width:0}
.dss-help{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dss-input,.dss-textarea{box-sizing:border-box;width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 11px;outline:none;min-height:34px;transition:border-color .15s,box-shadow .15s}
.dss-textarea{resize:vertical;min-height:72px;line-height:1.5}
.dss-input:focus,.dss-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dss-input::placeholder,.dss-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dss-input.num{width:120px;text-align:right;font-variant-numeric:tabular-nums}
.dss-dd{position:relative;min-width:0}
.dss-dd-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:34px;font:inherit;font-size:13px;text-align:left;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 10px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dss-dd-btn:hover{border-color:var(--dsw-alias-label-tertiary)}
.dss-dd-btn.open{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dss-dd-btn:disabled{opacity:.5;cursor:default}
.dss-dd-val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dss-dd-val.ph{color:var(--dsw-alias-label-tertiary)}
.dss-dd-caret{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none}
.dss-dd-menu{position:absolute;z-index:50;top:calc(100% + 4px);left:0;right:0;margin:0;padding:4px;list-style:none;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.2);max-height:260px;overflow:auto}
.dss-dd-opt{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;line-height:1.3}
.dss-dd-opt:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.dss-dd-opt.sel{color:var(--dsw-alias-brand-primary);font-weight:600}
.dss-dd-opt.sel::after{content:'✓';margin-left:auto;font-size:12px}
.dss-switch{position:relative;width:38px;height:22px;border-radius:999px;border:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);cursor:pointer;padding:0;transition:background .18s;flex:none}
.dss-switch.on{background:var(--dsw-alias-brand-primary)}
.dss-switch:disabled{opacity:.5;cursor:default}
.dss-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .18s}
.dss-switch.on .dss-switch-knob{transform:translateX(16px)}
.dss-switchrow{display:flex;align-items:center;min-height:34px}
.dss-inline{display:flex;align-items:center;gap:8px}
.dss-inline .dss-dd{flex:1}
.dss-btn{font:inherit;font-size:13px;line-height:1;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 14px;height:34px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:border-color .15s,background .15s}
.dss-btn:hover{border-color:var(--dsw-alias-label-tertiary)}
.dss-btn:disabled{opacity:.5;cursor:default}
.dss-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dss-btn-primary:hover{border-color:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.dss-btn-ghost{background:transparent}
.dss-iconbtn{width:34px;height:34px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1;flex:none;transition:border-color .15s,color .15s}
.dss-iconbtn:hover{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}
.dss-linkbtn{border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none}
.dss-pathrow{display:flex;align-items:center;gap:8px}
.dss-pathrow .dss-input{flex:1}
.dss-pathlist{display:flex;flex-direction:column;gap:8px}
.dss-summary{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:34px}
.dss-summary code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dss-tls{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dss-tls h4{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.dss-scrim{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}
.dss-modal{width:100%;max-width:520px;max-height:84vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 20px 64px rgba(0,0,0,.35);overflow:hidden}
.dss-modal-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dss-modal-title{margin:0;font-size:15px;font-weight:600}
.dss-modal-bd{padding:18px;overflow:auto;display:flex;flex-direction:column;gap:16px}
.dss-modal-ft{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:13px 18px;border-top:1px solid var(--dsw-alias-border-l2)}
.dss-foot{display:flex;align-items:center;gap:12px;padding:16px 0 2px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2)}
.dss-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dss-status.err{color:var(--dsw-alias-state-error-primary)}
.dss-status.ok{color:var(--dsw-alias-brand-primary)}
.dss-empty{font-size:13px;color:var(--dsw-alias-label-tertiary);padding:12px 0}

/* ---------- 记忆库管理面板 ---------- */
.dsp-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.dsp-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.dsp-title{margin:0;font-size:14px;font-weight:600;flex:none}
.dsp-tabs{display:flex;align-items:center;gap:4px;flex:1;min-width:0}
.dsp-tab{font:inherit;font-size:12px;line-height:1;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));border-radius:7px;padding:7px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dsp-tab:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dsp-tab.on{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dsp-badge{min-width:18px;height:16px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
.dsp-body{display:flex;flex:1;min-height:0}
.dsp-list{width:280px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l2);min-height:0}
.dsp-listtools{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.dsp-listtools .dss-input{flex:1;min-width:0;min-height:30px;padding:5px 9px;font-size:12px}
.dsp-listtools .dss-dd-btn{min-height:30px;padding:4px 8px;font-size:12px}
.dsp-items{flex:1;overflow:auto;padding:6px}
.dsp-item{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;font:inherit;border:1px solid transparent;background:transparent;border-radius:8px;padding:8px 10px;cursor:pointer;color:var(--dsw-alias-label-primary)}
.dsp-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dsp-item.sel{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.dsp-item-top{display:flex;align-items:center;gap:7px;min-width:0}
.dsp-kind{flex:none;font-size:10px;line-height:1;padding:3px 6px;border-radius:5px;font-weight:600;letter-spacing:.02em}
.dsp-kind.memory{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary)}
.dsp-kind.skill{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dsp-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12px}
.dsp-item-sub{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0}
.dsp-item-sub span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-scope{flex:none;max-width:130px;padding:1px 6px;border-radius:5px;font-size:10px;line-height:14px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font-variant-numeric:tabular-nums}
.dsp-detail{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.dsp-detail-scroll{flex:1;overflow:auto;padding:14px 18px}
.dsp-dtitle{margin:0 0 4px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.dsp-did{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin-bottom:12px}
.dsp-meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 16px;margin-bottom:14px}
.dsp-meta-k{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}
.dsp-meta-v{font-size:12px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.dsp-section-h{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:14px 0 6px}
.dsp-content{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;margin:0}
.dsp-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dsp-file{display:flex;justify-content:space-between;gap:12px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px}
.dsp-file span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-file span:last-child{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}
.dsp-warn{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:12px}
.dsp-foot{flex:none;display:flex;align-items:center;gap:10px;padding:10px 18px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsp-foot .dss-input{flex:1;min-height:32px;font-size:12px}
.dsp-center{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}
.dsp-err{color:var(--dsw-alias-state-error-primary)}
`

    // ---------- draft helpers ----------
    const seedDraft = (value) => ({
      nodeId: value?.node?.id ?? '',
      nodeToken: '',
      activeProfile: value?.hub?.activeProfile ?? 'intranet',
      profiles: Object.fromEntries(Object.entries(value?.hub?.profiles ?? {}).map(([k, p]) => [k, {
        protocol: p?.protocol ?? 'http', host: p?.host ?? '', port: p?.port ?? '',
        basePath: p?.basePath ?? '', timeoutMs: p?.timeoutMs ?? 8000, token: '', adminToken: '',
        rejectUnauthorized: p?.tls?.rejectUnauthorized ?? true, caFile: p?.tls?.caFile ?? '',
      }])),
      auto: value?.sync?.auto ?? true,
      intervalSec: value?.sync?.intervalSec ?? 300,
      syncOnStart: value?.sync?.syncOnStart ?? true,
      memoryDir: value?.sync?.memoryDir ?? '',
      skillRoots: (value?.sync?.skillRoots ?? []).slice(),
      stateDirName: value?.sync?.stateDirName ?? '.cinlan-knowledge-sync',
      scope: value?.sync?.scope ?? '',
      readScopesText: (value?.sync?.readScopes ?? []).join(', '),
      oneshotEnabled: value?.oneshot?.enabled ?? false,
      oneshotCommandsText: (value?.oneshot?.commands ?? []).join('\n'),
      oneshotResultFile: value?.oneshot?.resultFile ?? '',
      logLevel: value?.log?.level ?? 'info',
      logDir: value?.log?.dir ?? '',
    })

    const lines = (text) => text.split('\n').map(s => s.trim()).filter(Boolean)

    const validate = (d, t) => {
      const errs = []
      const prof = d.profiles[d.activeProfile]
      if (!prof) errs.push(t('errActiveMissing'))
      if (prof && !prof.host.trim()) errs.push(t('errHost'))
      if (prof && prof.port !== '' && (!Number.isInteger(Number(prof.port)) || Number(prof.port) < 1 || Number(prof.port) > 65535)) errs.push(t('errPort'))
      if (!Number.isFinite(Number(d.intervalSec)) || Number(d.intervalSec) <= 0) errs.push(t('errInterval'))
      if (!d.memoryDir.trim()) errs.push(t('errMemory'))
      const scopeOk = (s) => s === '' || ((() => { const p = s.split(':'); const seg = /^[a-z0-9][a-z0-9_-]*$/; return (p.length === 2 || p.length === 4) && p[0] === 'proj' && seg.test(p[1]) && (p.length === 2 || (p[2] === 'mod' && seg.test(p[3]))) })())
      if (!scopeOk(d.scope.trim())) errs.push(t('errScope'))
      for (const s of d.readScopesText.split(/[,\n]/).map(x => x.trim()).filter(Boolean)) {
        if (!scopeOk(s)) { errs.push(t('errScope')); break }
      }
      return errs
    }

    const buildOps = (d, existing) => {
      const ops = []
      const set = (path, value) => ops.push({ op: 'set', path, value })
      const unset = (path) => ops.push({ op: 'unset', path })
      const old = existing?.hub?.profiles ?? {}
      set(['node', 'id'], d.nodeId)
      if (d.nodeToken) set(['node', 'token'], d.nodeToken)
      set(['hub', 'activeProfile'], d.activeProfile)
      for (const name of Object.keys(old)) if (!(name in d.profiles)) unset(['hub', 'profiles', name])
      for (const [name, p] of Object.entries(d.profiles)) {
        const body = { protocol: p.protocol, host: p.host.trim(), basePath: p.basePath, timeoutMs: Number(p.timeoutMs) || 8000 }
        if (p.port !== '') body.port = Number(p.port)
        body.tls = { rejectUnauthorized: !!p.rejectUnauthorized }
        if (p.caFile) body.tls.caFile = p.caFile
        if (p.token) body.token = p.token
        if (p.adminToken) body.adminToken = p.adminToken
        if (!(name in old)) { set(['hub', 'profiles', name], body); continue }
        set(['hub', 'profiles', name, 'protocol'], body.protocol)
        set(['hub', 'profiles', name, 'host'], body.host)
        set(['hub', 'profiles', name, 'basePath'], body.basePath)
        set(['hub', 'profiles', name, 'timeoutMs'], body.timeoutMs)
        if (p.port === '') unset(['hub', 'profiles', name, 'port']); else set(['hub', 'profiles', name, 'port'], body.port)
        set(['hub', 'profiles', name, 'tls'], body.tls)
        if (p.token) set(['hub', 'profiles', name, 'token'], p.token)
        if (p.adminToken) set(['hub', 'profiles', name, 'adminToken'], p.adminToken)
      }
      set(['sync', 'auto'], !!d.auto)
      set(['sync', 'intervalSec'], Number(d.intervalSec))
      set(['sync', 'syncOnStart'], !!d.syncOnStart)
      set(['sync', 'memoryDir'], d.memoryDir.trim())
      set(['sync', 'skillRoots'], d.skillRoots.map(s => s.trim()).filter(Boolean))
      set(['sync', 'stateDirName'], d.stateDirName.trim() || '.cinlan-knowledge-sync')
      set(['sync', 'scope'], d.scope.trim())
      set(['sync', 'readScopes'], d.readScopesText.split(/[,\n]/).map(x => x.trim()).filter(Boolean))
      set(['oneshot'], { enabled: !!d.oneshotEnabled, commands: lines(d.oneshotCommandsText), resultFile: d.oneshotResultFile.trim() })
      set(['log'], { level: d.logLevel, dir: d.logDir.trim() })
      return ops
    }

    // ---------- small controls ----------
    const Field = ({ label, help, children }) =>
      h('div', { className: 'dss-row' },
        h('label', { className: 'dss-label' }, label),
        h('div', { className: 'dss-cell' }, children, help ? h('div', { className: 'dss-help' }, help) : null))

    const Text = ({ value, onChange, type = 'text', placeholder = '', readOnly = false }) =>
      h('input', { className: 'dss-input', type, value, placeholder, readOnly, onChange: e => onChange(e.target.value) })

    const Num = ({ value, onChange, placeholder = '', className = 'dss-input' }) =>
      h('input', { className, type: 'number', value, placeholder, onChange: e => onChange(e.target.value) })

    const Area = ({ value, onChange, rows = 3, placeholder = '' }) =>
      h('textarea', { className: 'dss-textarea', rows, value, placeholder, onChange: e => onChange(e.target.value) })

    // 自定义下拉：替换原生 select，贴合主题、跟随 i18n label。
    function Dropdown({ value, onChange, options, placeholder, disabled }) {
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
      }, [open])
      const cur = options.find(o => o.v === value)
      return h('div', { className: 'dss-dd', ref }, [
        h('button', { key: 'b', type: 'button', disabled, className: 'dss-dd-btn' + (open ? ' open' : ''), onClick: () => setOpen(v => !v) }, [
          h('span', { key: 'v', className: 'dss-dd-val' + (cur ? '' : ' ph') }, cur ? cur.label : (placeholder || '')),
          h('span', { key: 'c', className: 'dss-dd-caret', 'aria-hidden': 'true' }, '\u25be'),
        ]),
        open ? h('ul', { key: 'm', className: 'dss-dd-menu', role: 'listbox' },
          options.map(o => h('li', {
            key: o.v, role: 'option', 'aria-selected': o.v === value ? 'true' : 'false',
            className: 'dss-dd-opt' + (o.v === value ? ' sel' : ''),
            onClick: () => { onChange(o.v); setOpen(false) },
          }, o.label))) : null,
      ])
    }

    const Switch = ({ checked, onChange, disabled }) =>
      h('div', { className: 'dss-switchrow' },
        h('button', {
          type: 'button', role: 'switch', disabled, 'aria-checked': checked ? 'true' : 'false',
          className: 'dss-switch' + (checked ? ' on' : ''), onClick: () => onChange(!checked),
        }, h('span', { className: 'dss-switch-knob' })))

    // 弹框：portal 到 body，Esc / 点遮罩关闭。
    function Modal({ title, onClose, children, footer }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return ReactDOM.createPortal(
        h('div', { className: 'dss-scrim', onMouseDown: e => { if (e.target === e.currentTarget) onClose() } },
          h('div', { className: 'dss-modal', role: 'dialog', 'aria-modal': 'true' }, [
            h('div', { key: 'hd', className: 'dss-modal-hd' }, [
              h('h3', { key: 't', className: 'dss-modal-title' }, title),
              h('button', { key: 'x', type: 'button', className: 'dss-iconbtn', 'aria-label': title, onClick: onClose }, '\u2715'),
            ]),
            h('div', { key: 'bd', className: 'dss-modal-bd' }, children),
            footer ? h('div', { key: 'ft', className: 'dss-modal-ft' }, footer) : null,
          ])),
        document.body)
    }

    const PathInput = ({ t, value, onChange, pick, placeholder, onPickError }) =>
      h('div', { className: 'dss-pathrow' }, [
        h('input', { key: 'i', className: 'dss-input', value, placeholder, onChange: e => onChange(e.target.value) }),
        pick ? h('button', { key: 'b', type: 'button', className: 'dss-btn dss-btn-ghost', onClick: async () => { try { const p = await pick(); if (p) onChange(p) } catch (_) { onPickError && onPickError() } } }, t('browse')) : null,
      ])

    function PathList({ t, items, onChange, pick, onPickError, placeholder }) {
      const setAt = (i, v) => { const next = items.slice(); next[i] = v; onChange(next) }
      const del = (i) => { const next = items.slice(); next.splice(i, 1); onChange(next) }
      const add = async () => {
        if (!pick) { onChange(items.concat([''])); return }
        try { const p = await pick(); onChange(items.concat([p || ''])) } catch (_) { onPickError && onPickError() }
      }
      return h('div', { className: 'dss-pathlist' }, [
        ...items.map((it, i) => h('div', { key: 'r' + i, className: 'dss-pathrow' }, [
          h('input', { key: 'i', className: 'dss-input', value: it, placeholder, onChange: e => setAt(i, e.target.value) }),
          pick ? h('button', { key: 'b', type: 'button', className: 'dss-btn dss-btn-ghost', onClick: async () => { try { const p = await pick(); if (p) setAt(i, p) } catch (_) { onPickError && onPickError() } } }, t('browse')) : null,
          h('button', { key: 'd', type: 'button', className: 'dss-iconbtn', 'aria-label': t('remove'), onClick: () => del(i) }, '\u2715'),
        ])),
        h('button', { key: 'add', type: 'button', className: 'dss-btn dss-btn-ghost', onClick: add }, '\uff0b ' + t('addSkillRoot')),
      ])
    }

    // 时间组件：内部按秒存储，展示用 秒/分钟/小时 单位切换。
    const DUR_UNITS = [{ v: 'sec', k: 1 }, { v: 'min', k: 60 }, { v: 'hour', k: 3600 }]
    const autoUnit = (s) => {
      const n = Number(s) || 0
      if (n >= 3600 && n % 3600 === 0) return 'hour'
      if (n >= 60 && n % 60 === 0) return 'min'
      return 'sec'
    }
    function Duration({ t, seconds, onChange }) {
      const [unit, setUnit] = useState(() => autoUnit(seconds))
      const k = (DUR_UNITS.find(u => u.v === unit) || DUR_UNITS[0]).k
      const shown = Math.round((Number(seconds) || 0) / k * 100) / 100
      return h('div', { className: 'dss-inline' }, [
        h('input', {
          key: 'n', className: 'dss-input num', type: 'number', min: 1, value: shown,
          onChange: e => onChange(Math.max(1, Math.round((Number(e.target.value) || 0) * k))),
        }),
        h('div', { key: 'u', style: { width: 124, flex: 'none' } },
          h(Dropdown, { value: unit, onChange: setUnit, options: DUR_UNITS.map(u => ({ v: u.v, label: t('unit_' + u.v) })) })),
      ])
    }

    // ---------- profile editor（在弹框里用） ----------
    function ProfileEditor({ t, p, onChange }) {
      const set = (k, v) => onChange({ ...p, [k]: v })
      return h('div', { className: 'dss-group', style: { gap: 12 } }, [
        h(Field, { key: 'proto', label: t('protocol') },
          h(Dropdown, { value: p.protocol, onChange: v => set('protocol', v), options: [{ v: 'http', label: 'http' }, { v: 'https', label: 'https' }] })),
        h(Field, { key: 'host', label: t('host') },
          h(Text, { value: p.host, onChange: v => set('host', v), placeholder: '10.0.0.5 / hub.example.com' })),
        h(Field, { key: 'port', label: t('port') },
          h(Num, { value: p.port, onChange: v => set('port', v), className: 'dss-input num', placeholder: p.protocol === 'https' ? '443' : '80' })),
        h(Field, { key: 'base', label: t('basePath') },
          h(Text, { value: p.basePath, onChange: v => set('basePath', v), placeholder: '/' })),
        h(Field, { key: 'tm', label: t('timeoutMs') },
          h(Num, { value: p.timeoutMs, onChange: v => set('timeoutMs', v), className: 'dss-input num' })),
        h(Field, { key: 'tok', label: t('profileToken'), help: t('profileTokenHelp') },
          h(Text, { value: p.token, onChange: v => set('token', v), type: 'password', placeholder: t('secretSet') })),
        h(Field, { key: 'atok', label: t('profileAdminToken'), help: t('profileAdminTokenHelp') },
          h(Text, { value: p.adminToken, onChange: v => set('adminToken', v), type: 'password', placeholder: t('secretSet') })),
        p.protocol === 'https' ? h('div', { key: 'tls', className: 'dss-tls' }, [
          h('h4', { key: 'h' }, t('tlsTitle')),
          h(Field, { key: 'v', label: t('rejectUnauthorized') },
            h(Switch, { checked: p.rejectUnauthorized, onChange: v => set('rejectUnauthorized', v) })),
          h(Field, { key: 'ca', label: t('caFile') },
            h(Text, { value: p.caFile, onChange: v => set('caFile', v), placeholder: 'D:\\certs\\ca.pem' })),
        ]) : null,
      ])
    }

    // ---------- the settings section ----------
    function knowledgeSyncSettings({ t, useForm, save, reset, pick }) {
      const snap = useForm(v => v)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [modal, setModal] = useState(null)
      const [editName, setEditName] = useState('')
      const [showAdv, setShowAdv] = useState(false)

      // 外部 revision 变化且没有本地未保存改动 → 重灌草稿
      useEffect(() => {
        if (snap.status === 'ready' && draft === null) {
          const seed = seedDraft(snap.value)
          setDraft(seed)
          setEditName(seed.activeProfile)
        }
      }, [snap.status, snap.revision, draft])

      if (snap.status === 'loading') return h('p', { className: 'dss-empty' }, t('loading'))
      if (snap.status === 'unavailable' || !snap.writable) return h('p', { className: 'dss-empty' }, t('unavailable'))
      if (draft === null) return h('p', { className: 'dss-empty' }, t('loading'))

      const setD = (k, v) => { setDraft({ ...draft, [k]: v }); setNotice(null) }
      const names = Object.keys(draft.profiles)
      const curEdit = names.includes(editName) ? editName : (names[0] ?? '')
      const errors = validate(draft, t)
      const canPick = typeof pick === 'function'
      const pickErr = () => setNotice({ kind: 'err', text: t('pickFailed') })
      const active = draft.profiles[draft.activeProfile]
      const endpoint = active
        ? active.protocol + '://' + (active.host || '\u2014') + (active.port ? ':' + active.port : '')
        : t('hubSummaryNone')

      const onSave = async () => {
        if (errors.length || busy) return
        setBusy(true); setNotice(null)
        const ok = await save(buildOps(draft, snap.value), snap.revision)
        setBusy(false); setDraft(null)
        setNotice({ kind: ok ? 'ok' : 'err', text: ok ? t('saved') : t('saveFailed') })
      }
      const onReset = () => { setDraft(null); setNotice(null); reset() }

      const addProfile = () => {
        let i = 1; while (draft.profiles['profile' + i]) i++
        const name = 'profile' + i
        setDraft({ ...draft, profiles: { ...draft.profiles, [name]: { protocol: 'http', host: '', port: '', basePath: '', timeoutMs: 8000, token: '', rejectUnauthorized: true, caFile: '' } } })
        setEditName(name); setNotice(null)
      }
      const removeProfile = () => {
        if (curEdit === draft.activeProfile) { setNotice({ kind: 'err', text: t('removeBlocked') }); return }
        const next = { ...draft.profiles }; delete next[curEdit]
        setDraft({ ...draft, profiles: next }); setEditName(draft.activeProfile); setNotice(null)
      }
      const setProfile = (pp) => { setDraft({ ...draft, profiles: { ...draft.profiles, [curEdit]: pp } }); setNotice(null) }

      const groupHead = (title, sub) => h('div', { className: 'dss-ghd' }, [
        h('h3', { key: 'h' }, title), sub ? h('p', { key: 's', className: 'dss-gsub' }, sub) : null,
      ])

      return h('div', { className: 'dss-form' }, [
        h('p', { key: 'intro', className: 'dss-intro' }, t('intro')),

        h('div', { key: 'hub', className: 'dss-group', 'data-settings-anchor': 'dss-hub' }, [
          groupHead(t('groupHub'), t('groupHubHelp')),
          h(Field, { key: 'act', label: t('activeProfile'), help: t('activeProfileHelp') },
            h('div', { className: 'dss-inline' }, [
              h(Dropdown, { key: 'dd', value: draft.activeProfile, onChange: v => setD('activeProfile', v), options: names.map(n => ({ v: n, label: n })) }),
              h('button', { key: 'cfg', type: 'button', className: 'dss-iconbtn', title: t('editHub'), 'aria-label': t('editHub'), onClick: () => { setEditName(draft.activeProfile); setModal('hub') } }, '\u2699'),
            ])),
          h(Field, { key: 'ep', label: t('endpoint') },
            h('span', { className: 'dss-summary' }, h('code', {}, endpoint))),
        ]),

        h('div', { key: 'node', className: 'dss-group', 'data-settings-anchor': 'dss-node' }, [
          groupHead(t('groupNode'), t('groupNodeHelp')),
          h(Field, { key: 'id', label: t('nodeId') },
            h('div', { className: 'dss-inline' }, [
              h('span', { key: 's', className: 'dss-summary', style: { flex: 1, minWidth: 0 } }, h('code', {}, draft.nodeId || t('nodeNone'))),
              h('button', { key: 'e', type: 'button', className: 'dss-btn dss-btn-ghost', onClick: () => setModal('node') }, t('edit')),
            ])),
        ]),

        h('div', { key: 'sync', className: 'dss-group', 'data-settings-anchor': 'dss-sync' }, [
          groupHead(t('groupSync')),
          h(Field, { key: 'auto', label: t('auto'), help: t('autoHelp') }, h(Switch, { checked: draft.auto, onChange: v => setD('auto', v) })),
          h(Field, { key: 'sos', label: t('syncOnStart'), help: t('syncOnStartHelp') }, h(Switch, { checked: draft.syncOnStart, onChange: v => setD('syncOnStart', v) })),
          h(Field, { key: 'int', label: t('syncInterval'), help: t('syncIntervalHelp') },
            h(Duration, { t, seconds: draft.intervalSec, onChange: v => setD('intervalSec', v) })),
          h(Field, { key: 'mem', label: t('memoryDir'), help: t('memoryDirHelp') },
            h(PathInput, { t, value: draft.memoryDir, onChange: v => setD('memoryDir', v), pick: canPick ? pick : null, onPickError: pickErr, placeholder: 'C:\\Users\\me\\.dsh\\cinlan-knowledge-sync\\memory' })),
          h(Field, { key: 'sk', label: t('skillRoots'), help: t('skillRootsHelp') },
            h(PathList, { t, items: draft.skillRoots, onChange: v => setD('skillRoots', v), pick: canPick ? pick : null, onPickError: pickErr, placeholder: 'C:\\Users\\me\\.dsh\\skills' })),
          h(Field, { key: 'sdn', label: t('stateDirName'), help: t('stateDirNameHelp') },
            h(Text, { value: draft.stateDirName, onChange: v => setD('stateDirName', v), placeholder: '.cinlan-knowledge-sync' })),
          h(Field, { key: 'scp', label: t('syncScope'), help: t('syncScopeHelp') },
            h(Text, { value: draft.scope, onChange: v => setD('scope', v), placeholder: 'proj:my-project 或留空（全局）' })),
          h(Field, { key: 'rsc', label: t('syncReadScopes'), help: t('syncReadScopesHelp') },
            h(Text, { value: draft.readScopesText, onChange: v => setD('readScopesText', v), placeholder: ', proj:cinlan, proj:cinlan:mod:web' })),
        ]),

        h('div', { key: 'adv', className: 'dss-group', 'data-settings-anchor': 'dss-adv' }, [
          h('div', { key: 'hd', className: 'dss-inline', style: { justifyContent: 'space-between', alignItems: 'flex-start' } }, [
            groupHead(t('advanced'), t('advancedHelp')),
            h('button', { key: 'tgl', type: 'button', className: 'dss-linkbtn', onClick: () => setShowAdv(v => !v) }, showAdv ? t('hide') : t('show')),
          ]),
          showAdv ? h('div', { key: 'body', className: 'dss-group' }, [
            h(Field, { key: 'os', label: t('oneshotEnabled') }, h(Switch, { checked: draft.oneshotEnabled, onChange: v => setD('oneshotEnabled', v) })),
            draft.oneshotEnabled ? h(Field, { key: 'cmd', label: t('oneshotCommands'), help: t('oneshotCommandsHelp') },
              h(Area, { value: draft.oneshotCommandsText, onChange: v => setD('oneshotCommandsText', v), rows: 3 })) : null,
            draft.oneshotEnabled ? h(Field, { key: 'res', label: t('oneshotResultFile') },
              h(Text, { value: draft.oneshotResultFile, onChange: v => setD('oneshotResultFile', v) })) : null,
            h(Field, { key: 'lvl', label: t('logLevel') },
              h(Dropdown, { value: draft.logLevel, onChange: v => setD('logLevel', v), options: ['debug', 'info', 'warn', 'error'].map(v => ({ v, label: v })) })),
            h(Field, { key: 'dir', label: t('logDir'), help: t('logDirHelp') },
              h(Text, { value: draft.logDir, onChange: v => setD('logDir', v) })),
          ]) : null,
        ]),

        h('div', { key: 'foot', className: 'dss-foot' }, [
          h('button', { key: 'save', className: 'dss-btn dss-btn-primary', type: 'button', disabled: busy || errors.length > 0, onClick: onSave }, busy ? t('saving') : t('save')),
          h('button', { key: 'reset', className: 'dss-btn', type: 'button', disabled: busy, onClick: onReset }, t('reset')),
          errors.length ? h('span', { key: 'errs', className: 'dss-status err' }, errors.join('；')) :
            notice ? h('span', { key: 'note', className: 'dss-status ' + notice.kind }, notice.text) :
              h('span', { key: 'hint', className: 'dss-status' }, t('dirty')),
        ]),

        modal === 'hub' ? h(Modal, {
          key: 'm-hub', title: t('editHub'), onClose: () => setModal(null),
          footer: [h('button', { key: 'd', type: 'button', className: 'dss-btn dss-btn-primary', onClick: () => setModal(null) }, t('done'))],
        }, [
          h(Field, { key: 'pick', label: t('profilePick') },
            h('div', { className: 'dss-inline' }, [
              h(Dropdown, { key: 'dd', value: curEdit, onChange: setEditName, options: names.map(n => ({ v: n, label: n })) }),
              h('button', { key: 'add', type: 'button', className: 'dss-btn dss-btn-ghost', onClick: addProfile }, '\uff0b ' + t('addProfile')),
              names.length > 1 ? h('button', { key: 'del', type: 'button', className: 'dss-iconbtn', title: t('removeProfile'), 'aria-label': t('removeProfile'), onClick: removeProfile }, '\u2715') : null,
            ])),
          h('hr', { key: 'hr', className: 'dss-divider' }),
          curEdit ? h(ProfileEditor, { key: 'ed-' + curEdit, t, p: draft.profiles[curEdit], onChange: setProfile }) : h('p', { className: 'dss-empty' }, t('noProfiles')),
        ]) : null,

        modal === 'node' ? h(Modal, {
          key: 'm-node', title: t('editNode'), onClose: () => setModal(null),
          footer: [h('button', { key: 'd', type: 'button', className: 'dss-btn dss-btn-primary', onClick: () => setModal(null) }, t('done'))],
        }, [
          h(Field, { key: 'id', label: t('nodeId'), help: t('nodeIdHelp') },
            h(Text, { value: draft.nodeId, onChange: v => setD('nodeId', v) })),
          h(Field, { key: 'tok', label: t('nodeToken'), help: t('nodeTokenHelp') },
            h(Text, { value: draft.nodeToken, onChange: v => setD('nodeToken', v), type: 'password', placeholder: t('secretSet') })),
        ]) : null,
      ])
    }

    // ---------- panel: 记忆库管理 ----------
    const relTime = (iso) => {
      const t = Date.parse(iso || '')
      if (Number.isNaN(t)) return '\u2014'
      const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
      if (s < 60) return s + 's'
      if (s < 3600) return Math.floor(s / 60) + 'm'
      if (s < 86400) return Math.floor(s / 3600) + 'h'
      return Math.floor(s / 86400) + 'd'
    }

    function MemoryPanelIcon(props) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', ...props }, [
        h('path', { key: 'a', d: 'M8 1.8 14 4.8 8 7.8 2 4.8 8 1.8Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M2 8l6 3 6-3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'c', d: 'M2 11.2l6 3 6-3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ])
    }

    // 同 id 可跨 scope 并存：非队列项用 scope|kind:id 消歧
    const itemKey = (it) => it.queueId || ((it.scope || '') + '|' + it.kind + ':' + it.id)
    const itemTitle = (it, t) => (it.payload?.title || it.title || it.id || t('untitled'))
    const itemNode = (it) => it.node || it.sourceNode || ''
    const itemTime = (it) => it.receivedAt || it.updatedAt || ''
    const isTokenMissing = (err) => String(err).includes('adminToken') || String(err).includes('admin-token-missing')

    function clhMemoryPanel({ t, api }) {
      const [tab, setTab] = useState('pending')
      const [items, setItems] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [sel, setSel] = useState(null)
      const [detail, setDetail] = useState(null)
      const [reason, setReason] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [q, setQ] = useState('')
      const [kindFilter, setKindFilter] = useState('')
      const [scopeFilter, setScopeFilter] = useState('*')

      const load = async () => {
        setLoading(true); setError(null)
        try {
          let list = []
          if (tab === 'pending') { const r = await api.call('adminPending'); list = r?.pending ?? [] }
          else if (tab === 'rejected') { const r = await api.call('adminRejected'); list = r?.rejected ?? [] }
          else { const r = await api.call('adminEntries', { kinds: kindFilter, q: q.trim() }); list = r?.entries ?? [] }
          setItems(list)
          setSel(prev => list.some(it => itemKey(it) === prev) ? prev : null)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setItems([])
        }
        setLoading(false)
      }

      useEffect(() => { void load() }, [tab, kindFilter])

      const cur = items.find(it => itemKey(it) === sel) || null

      // 总库 tab 的详情要再拉一次正文；pending/rejected 的 payload 已带全文
      useEffect(() => {
        if (tab !== 'library' || !cur) { setDetail(null); return undefined }
        let dead = false
        api.call('adminEntry', { kind: cur.kind, id: cur.id, scope: cur.scope ?? '' })
          .then(e => { if (!dead) setDetail(e || null) })
          .catch(() => { if (!dead) setDetail(null) })
        return () => { dead = true }
      }, [sel, tab])

      const decide = async (action) => {
        if (!cur || !cur.queueId || busy) return
        if (action === 'reject' && !reason.trim()) return
        setBusy(true); setNotice(null)
        try {
          await api.call('adminDecide', { queueId: cur.queueId, action, reason: reason.trim() })
          setReason(''); setSel(null)
          await load()
          setNotice({ kind: 'ok', text: t('decideOk') })
        } catch (err) {
          setNotice({ kind: 'err', text: t('decideFail') + ': ' + (err instanceof Error ? err.message : String(err)) })
        }
        setBusy(false)
      }

      const pendingCount = tab === 'pending' ? items.length : null
      const tabs = [['pending', t('tabPending')], ['library', t('tabLibrary')], ['rejected', t('tabRejected')]]
      const emptyText = tab === 'pending' ? t('emptyPending') : tab === 'library' ? t('emptyLibrary') : t('emptyRejected')
      // 作用域过滤：选项由已加载数据推导；'*'=全部，''=仅全局
      const scopeSeen = [...new Set(items.map(it => it.scope || ''))]
      const visibleItems = (tab === 'library' && scopeFilter !== '*') ? items.filter(it => (it.scope || '') === scopeFilter) : items

      const metaCell = (k, v) => v ? h('div', { key: k }, [
        h('div', { key: 'k', className: 'dsp-meta-k' }, k),
        h('div', { key: 'v', className: 'dsp-meta-v' }, String(v)),
      ]) : null

      const renderDetail = () => {
        if (!cur) return h('div', { className: 'dsp-center' }, t('emptyDetail'))
        const p = cur.payload || detail || cur
        const files = Array.isArray(p.files) ? p.files : []
        const rejectedReason = tab === 'rejected' ? cur.reason : null
        const flagged = cur.cleanupFlag
        return h(React.Fragment, null, [
          h('div', { key: 'sc', className: 'dsp-detail-scroll' }, [
            flagged ? h('div', { key: 'flag', className: 'dsp-warn' }, t('cleanupFlagged') + (flagged.reason ? ': ' + flagged.reason : '')) : null,
            h('h2', { key: 'ti', className: 'dsp-dtitle' }, itemTitle(cur, t)),
            h('div', { key: 'id', className: 'dsp-did' }, cur.kind + ' / ' + cur.id),
            h('div', { key: 'meta', className: 'dsp-meta' }, [
              metaCell(t('metaScope'), cur.scope || t('scopeGlobal')),
              metaCell(t('metaNode'), itemNode(cur)),
              metaCell(t('metaTime'), itemTime(cur) ? itemTime(cur) + ' (' + relTime(itemTime(cur)) + ')' : ''),
              metaCell(t('metaVersion'), cur.version !== undefined ? 'v' + cur.version : ''),
              metaCell(t('metaSeq'), cur.seq !== undefined ? cur.seq : ''),
              metaCell(t('metaTags'), (p.tags || cur.tags || []).join(', ')),
              metaCell(t('metaExpires'), p.expires || cur.expires || ''),
              cur.payload?.force ? metaCell(t('metaForce'), 'yes') : null,
              rejectedReason ? metaCell(t('metaRejectedReason'), rejectedReason) : null,
            ]),
            p.description ? h('div', { key: 'dh' }, [
              h('div', { key: 'h', className: 'dsp-section-h' }, t('contentTitle')),
              h('pre', { key: 'c', className: 'dsp-content' }, p.description),
            ]) : null,
            p.content ? h('div', { key: 'ch' }, [
              h('div', { key: 'h', className: 'dsp-section-h' }, t('contentTitle')),
              h('pre', { key: 'c', className: 'dsp-content' }, p.content),
            ]) : null,
            files.length > 0 ? h('div', { key: 'fh' }, [
              h('div', { key: 'h', className: 'dsp-section-h' }, t('filesTitle') + ' (' + files.length + ')'),
              h('ul', { key: 'l', className: 'dsp-files' }, files.map((f, i) =>
                h('li', { key: i, className: 'dsp-file' }, [
                  h('span', { key: 'p' }, f.path),
                  h('span', { key: 's' }, String((f.content || '').length) + ' B'),
                ]))),
            ]) : null,
          ]),
          tab === 'pending' ? h('div', { key: 'ft', className: 'dsp-foot' }, [
            h('input', {
              key: 'r', className: 'dss-input', value: reason, placeholder: t('reasonPh'),
              onChange: e => setReason(e.target.value),
            }),
            h('button', { key: 'a', type: 'button', className: 'dss-btn dss-btn-primary', disabled: busy, onClick: () => decide('approve') }, busy ? t('acting') : t('approve')),
            h('button', { key: 'j', type: 'button', className: 'dss-btn', disabled: busy || !reason.trim(), onClick: () => decide('reject') }, t('reject')),
            notice ? h('span', { key: 'n', className: 'dss-status ' + notice.kind }, notice.text) : null,
          ]) : (notice ? h('div', { key: 'ft', className: 'dsp-foot' }, h('span', { className: 'dss-status ' + notice.kind }, notice.text)) : null),
        ])
      }

      return h('div', { className: 'dsp-root' }, [
        h('div', { key: 'hd', className: 'dsp-head' }, [
          h('h1', { key: 't', className: 'dsp-title' }, t('title')),
          h('div', { key: 'tabs', className: 'dsp-tabs' }, tabs.map(([k, label]) =>
            h('button', {
              key: k, type: 'button', className: 'dsp-tab' + (tab === k ? ' on' : ''),
              onClick: () => { setTab(k); setSel(null); setNotice(null) },
            }, [label, k === 'pending' && pendingCount !== null && pendingCount > 0 ? h('span', { key: 'b', className: 'dsp-badge' }, pendingCount) : null]))),
          h('button', { key: 'rf', type: 'button', className: 'dss-btn dss-btn-ghost', onClick: () => void load() }, t('refresh')),
        ]),
        h('div', { key: 'bd', className: 'dsp-body' }, [
          h('div', { key: 'ls', className: 'dsp-list' }, [
            tab === 'library' ? h('div', { key: 'lt', className: 'dsp-listtools' }, [
              h('input', {
                key: 'q', className: 'dss-input', value: q, placeholder: t('searchPh'),
                onChange: e => setQ(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter') void load() },
              }),
              h('div', { key: 'k', style: { width: 108, flex: 'none' } },
                h(Dropdown, {
                  value: kindFilter, onChange: v => setKindFilter(v),
                  options: [{ v: '', label: t('filterAll') }, { v: 'memory', label: t('filterMemory') }, { v: 'skill', label: t('filterSkill') }],
                })),
              h('div', { key: 's', style: { width: 140, flex: 'none' } },
                h(Dropdown, {
                  value: scopeFilter, onChange: v => setScopeFilter(v),
                  options: [{ v: '*', label: t('scopeAll') }, ...scopeSeen.map(s => ({ v: s, label: s || t('scopeGlobal') }))],
                })),
            ]) : null,
            h('div', { key: 'is', className: 'dsp-items' },
              loading ? h('div', { className: 'dsp-center' }, t('loading'))
                : error ? h('div', { className: 'dsp-center dsp-err' }, isTokenMissing(error) ? t('errTokenMissing') : error)
                  : visibleItems.length === 0 ? h('div', { className: 'dsp-center' }, emptyText)
                    : visibleItems.map(it => h('button', {
                      key: itemKey(it), type: 'button',
                      className: 'dsp-item' + (sel === itemKey(it) ? ' sel' : ''),
                      onClick: () => { setSel(itemKey(it)); setNotice(null) },
                    }, [
                      h('div', { key: 'tp', className: 'dsp-item-top' }, [
                        h('span', { key: 'k', className: 'dsp-kind ' + it.kind }, it.kind === 'skill' ? 'SKILL' : 'MEM'),
                        h('span', { key: 't', className: 'dsp-item-title', title: itemTitle(it, t) }, itemTitle(it, t)),
                      ]),
                      h('div', { key: 'sb', className: 'dsp-item-sub' }, [
                        it.scope ? h('span', { key: 's', className: 'dsp-scope', title: it.scope }, it.scope) : null,
                        h('span', { key: 'n' }, itemNode(it)),
                        h('span', { key: 't' }, relTime(itemTime(it))),
                        tab === 'rejected' && it.reason ? h('span', { key: 'r', title: it.reason }, it.reason.slice(0, 24)) : null,
                      ]),
                    ]))),
          ]),
          h('div', { key: 'dt', className: 'dsp-detail' }, renderDetail()),
        ]),
      ])
    }

    // ---------- plugin entry ----------
    // 注意：settingsMetadata 不能进 inject——Desktop 0.2.2-rc.1 启动图里
    // root ctx.get('settingsMetadata') 为 undefined（服务未注册/已改名），
    // inject 声明它会让本 entry 永远 pending 并拖垮整个 web boot。
    // slots/locale/configForms 经崩溃日志审计确认在 root 可用。
    // remote / remote.directoryPicker 与 ui-workspace（Desktop 侧边栏工作区选择器
    // 同款）一致，root 已注册——用于“浏览…”调起宿主原生文件夹选择器。
    // connection：Client 底层 RPC 通道（api-gateway.client 的 inject 同款），
    // 面板用它直连 /api 上 knowledgeSync/* 端点（gateway SRC 认领，owner 限定）。
    exports.inject = ['slots', 'locale', 'configForms', 'remote', 'remote.directoryPicker', 'connection']
    exports.apply = function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const t2 = ctx.locale.bind(PANEL_NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'cinlan-knowledge-sync: dictionaries')
      ctx.effect(() => ctx.locale.register(PANEL_NS, { en: enPanel, zh: zhPanel }), 'cinlan-knowledge-sync: panel dictionaries')

      const form = ctx.configForms.get('cinlan-knowledge-sync')
      const save = (ops, expectedRevision) => form.mutate(ops, expectedRevision)
      const reset = () => { /* draft 层重灌；表单值以镜像为准，无需 Host 侧动作 */ }
      // 复用宿主原生目录选择器（ui-workspace 同款 remote.directoryPicker）。
      // pick() 返回 { ok, value }：value 为所选绝对路径或 null（用户取消）。
      const pick = async () => {
        const picker = ctx.remote && ctx.remote.directoryPicker
        if (!picker || typeof picker.pick !== 'function') return null
        const r = await picker.pick()
        if (r && r.ok === false) throw new Error((r.error && r.error.message) || 'directory picker failed')
        if (r && typeof r === 'object' && 'ok' in r) return r.value
        return r == null ? null : r
      }

      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', '@cinlan/knowledge-sync')
      style.textContent = css
      document.head.appendChild(style)

      // 两条 rc.1 实测红线：
      // 1) slots.inject 回调必须用普通函数返回 disposer——rc.1 不迭代 function*。
      // 2) 动态插件 ctx 对未 inject 的服务访问直接 rejectGuard 抛错，没有
      //    "读到 undefined"这种好事——settingsMetadata 在 rc.1 不存在且不在
      //    inject 里，任何 ctx.settingsMetadata 触碰都会在回调里炸掉注册。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section', id: 'cinlan-knowledge-sync', order: 30,
          label: () => t('nav'), locale: NS,
          inject: () => ({ hooks: { form }, save, reset, pick }),
        }, knowledgeSyncSettings))

      // ---------- 侧边栏「记忆库管理」面板 ----------
      // 走 gateway /api 直连 host 侧 knowledgeSync/* Remote 方法；
      // 不注册 client 端 namespace（admin 端点不给 typert 目录/模型工具暴露）。
      const callApi = async (method, args) => {
        const r = await ctx.connection.rpc.call(
          '/api', 'knowledgeSync/' + method, { args: args || {} }, new AbortController().signal)
        if (!r || !r.ok) {
          const err = r && r.error ? r.error : null
          throw new Error((err && err.message) || 'Remote call failed: ' + method)
        }
        return r.value
      }
      const api = { call: callApi }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({
          name: 'sidebar.panellist', id: 'knowledge-memory', order: 20,
          label: () => t2('nav'), locale: PANEL_NS,
        }, MemoryPanelIcon))

      ctx.slots.inject('main', () =>
        ctx.slots.register({
          name: 'main', key: 'knowledge-memory', locale: PANEL_NS,
          inject: () => ({ api }),
        }, clhMemoryPanel))
    }
    return module.exports
  },
})
