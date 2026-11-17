/**
 * @cinlan/redaction browser half (handwritten __ModuleLoader__ form).
 * Settings section: master toggles + words/rules/allow + live preview.
 * Conversation view tab: per-request redaction records, dynamically
 * registered/unregistered by config (records only when redaction is active).
 */
window.__ModuleLoader__.load({
  id: '@cinlan/redaction',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const NS = 'settings.cinlan-redaction'
    const VIEW_NS = 'view.cinlan-redaction'
    const en = {
      nav: 'Redaction', title: 'Outbound Redaction',
      intro: 'Mask secrets and personal data before requests leave for the model provider. Placeholders are stable and restored in replies.',
      loading: 'Loading configuration…',
      unavailable: 'The redaction plugin is not exposing a settings namespace yet.',
      secrets: 'Mask secrets', secretsHelp: 'API keys, private keys, tokens, passwords.',
      personal: 'Mask personal data', personalHelp: 'Email, phone, ID card, bank card.',
      kinds: 'Personal data kinds',
      kindSsn: 'SSN', kindPassport: 'Passport', kindIban: 'IBAN', kindBirthday: 'Birthday',
      kindMac: 'MAC address', kindSerial: 'Serial number',
      kindHome: 'Home folder user', kindUserhost: 'user@host', kindIp: 'Public IP', kindBucket: 'Cloud bucket',
      words: 'Your words', wordsHelp: 'One per line: codenames, internal hostnames, client names.',
      wordsAnyCase: 'Case-insensitive words', wordsAnyCaseHelp: 'Nightjar masks NIGHTJAR and nightjar too.',
      wordsWhole: 'Whole words only', wordsWholeHelp: 'ABC masks ABC IS but not XABCD; 123456 masks no part of 91234567.',
      rules: 'Custom rules', rulesHelp: 'One per line: KIND prefix=xx or KIND regex=…',
      allow: 'Allow list', allowHelp: 'Whole values allowed through as written, one per line.',
      actions: 'Actions', actionsHelp: 'Per-kind override: mask = replace with placeholder, warn = send and record, block = mask and hold the request.',
      actMask: 'Mask', actWarn: 'Warn', actBlock: 'Block',
      skipProviders: 'Skip providers', skipProvidersHelp: 'Provider ids never redacted, one per line (GenerateOptions.provider).',
      records: 'Keep redaction records', recordsHelp: 'Data source for the Redaction tab next to Trajectory.',
      save: 'Save changes', saving: 'Saving…', reset: 'Discard changes',
      saved: 'Saved.', saveFailed: 'Save rejected — values were reloaded from the profile.',
      dirty: 'Unsaved changes',
      preview: 'Preview', previewPh: 'Paste any text to preview redaction…',
      previewRun: 'Preview', previewReplaced: 'replaced', previewFound: 'values found',
      previewEmpty: 'Paste text above and press Preview.',
      view: 'Redaction',
      recTime: 'Time', recModel: 'Model', recBytes: 'Size', recValues: 'Values', recReplaced: 'Replaced', recTook: 'Took',
      blocked: 'Blocked', warned: 'Sent as written',
      byRule: 'rule', byWord: 'word', byYours: 'custom', byKnown: 'known',
      refresh: 'Refresh', clear: 'Clear session records', empty: 'No redaction records for this session yet.',
      filter: 'Filter', filterAll: 'All',
      errRpc: 'Record service unavailable',
      selectItem: 'Select a record on the left',
      before: 'Before', after: 'After',
      // detail view
      stepReceive: 'Received', stepFind: 'Found {n} values', stepReplace: 'Replaced {n} places',
      stepSend: 'Sent to model',
      sizeBytes: '{size}', tookMs: '{ms} ms',
      stepReceiveSub: '{size}', stepFindSub: '{finders} · {ms} ms',
      stepReplaceSub: 'replaced with placeholders', stepSendSub: '{provider} · {model}',
      reqContent: 'Request content', showChangedOnly: 'only changed parts shown',
      tabOriginal: 'Original', tabMasked: 'What the vendor saw', tabDiff: 'Compare',
      colLocal: 'This machine',
      noChange: 'sections unchanged', collapsed: 'collapsed',
      howMasked: 'How it was masked', valuesN: '{n} values', replacedN: '{n} replacements',
      lookup: 'Found by', position: 'Position',
      expand: 'Expand', collapse: 'Collapse',
      kind_EMAIL: 'Email', kind_PHONE: 'Phone', kind_ID_CARD: 'ID card', kind_BANK_CARD: 'Bank card',
      kind_SSN: 'SSN', kind_PASSPORT: 'Passport', kind_IBAN: 'IBAN', kind_BIRTHDAY: 'Birthday',
      kind_MAC: 'MAC address', kind_SERIAL: 'Serial number', kind_USERNAME: 'Username', kind_HOSTNAME: 'Hostname',
      kind_IP: 'Public IP', kind_BUCKET: 'Cloud bucket', kind_WORD: 'Your word', kind_CUSTOM: 'Custom',
      kind_API_KEY: 'API key', kind_TOKEN: 'Token', kind_SECRET: 'Secret', kind_PASSWORD: 'Password',
      kind_PRIVATE_KEY: 'Private key',
    }
    const zh = {
      nav: '脱敏', title: '出站脱敏',
      intro: '请求发给模型供应商前，把密钥与个人信息替换为稳定占位符；回复中的占位符自动换回原值。',
      loading: '正在读取配置…',
      unavailable: '脱敏插件尚未开放 settings 命名空间。',
      secrets: '脱敏密钥', secretsHelp: 'API key、私钥、token、密码。',
      personal: '脱敏个人信息', personalHelp: '邮箱、手机号、身份证、银行卡。',
      kinds: '个人信息细分',
      kindSsn: 'SSN', kindPassport: '护照', kindIban: 'IBAN', kindBirthday: '生日',
      kindMac: 'MAC 地址', kindSerial: '序列号',
      kindHome: '主目录用户名', kindUserhost: 'user@host', kindIp: '公网 IP', kindBucket: '云存储桶',
      words: '你的词', wordsHelp: '每行一个：项目代号、内部主机名、客户名。',
      wordsAnyCase: '不区分大小写', wordsAnyCaseHelp: 'Nightjar 也会脱敏 NIGHTJAR 和 nightjar。',
      wordsWhole: '仅完整单词匹配', wordsWholeHelp: 'ABC 脱敏 ABC IS 但不脱敏 XABCD；123456 不脱敏 91234567。',
      rules: '自定义规则', rulesHelp: '每行一条：KIND prefix=xx 或 KIND regex=…',
      allow: '允许名单', allowHelp: '整值放行，每行一个。',
      actions: '动作', actionsHelp: '按类别覆盖：mask = 替换占位符，warn = 照发仅记录，block = 脱敏并拦截请求。',
      actMask: '脱敏', actWarn: '提醒', actBlock: '拦截',
      skipProviders: '不脱敏的供应商', skipProvidersHelp: '这些 provider 的请求原样发出，每行一个 id（GenerateOptions.provider）。',
      records: '脱敏记录', recordsHelp: '「脱敏」tab（轨迹旁）的数据源。',
      save: '保存更改', saving: '保存中…', reset: '放弃更改',
      saved: '已保存。', saveFailed: '保存被拒绝 —— 已从 profile 重新加载。',
      dirty: '有未保存的更改',
      preview: '预览', previewPh: '粘贴任意文本预览脱敏效果…',
      previewRun: '预览', previewReplaced: '处替换', previewFound: '个值',
      previewEmpty: '粘贴文本后点击预览。',
      view: '脱敏',
      recTime: '时间', recModel: '模型', recBytes: '大小', recValues: '值', recReplaced: '替换', recTook: '耗时',
      blocked: '已拦截', warned: '已照发',
      byRule: '规则', byWord: '你的词', byYours: '自定义', byKnown: '已知',
      refresh: '刷新', clear: '清空本会话记录', empty: '本会话还没有脱敏记录。',
      filter: '筛选', filterAll: '全部',
      errRpc: '记录服务不可用',
      selectItem: '选择左侧一条记录查看详情',
      before: '变更前', after: '变更后',
      // detail view
      stepReceive: '收到', stepFind: '发现 {n} 个值', stepReplace: '替换 {n} 处',
      stepSend: '发送模型',
      sizeBytes: '{size}', tookMs: '{ms} ms',
      stepReceiveSub: '{size}', stepFindSub: '{finders} · {ms} ms',
      stepReplaceSub: '换成占位符', stepSendSub: '{provider} · {model}',
      reqContent: '请求内容', showChangedOnly: '只显示有改动的部分',
      tabOriginal: '原文', tabMasked: '厂商看到的样子', tabDiff: '对照',
      colLocal: '这台电脑上的',
      noChange: '段没有改动', collapsed: '已折叠',
      howMasked: '怎么遮的', valuesN: '{n} 个值', replacedN: '{n} 处',
      lookup: '查找方式', position: '位置',
      expand: '展开', collapse: '收起',
      kind_EMAIL: '邮箱', kind_PHONE: '手机号', kind_ID_CARD: '身份证', kind_BANK_CARD: '银行卡',
      kind_SSN: 'SSN', kind_PASSPORT: '护照', kind_IBAN: 'IBAN', kind_BIRTHDAY: '生日',
      kind_MAC: 'MAC 地址', kind_SERIAL: '序列号', kind_USERNAME: '用户名', kind_HOSTNAME: '主机名',
      kind_IP: '公网 IP', kind_BUCKET: '云存储桶', kind_WORD: '你的词', kind_CUSTOM: '自定义',
      kind_API_KEY: 'API key', kind_TOKEN: 'Token', kind_SECRET: '密钥', kind_PASSWORD: '密码',
      kind_PRIVATE_KEY: '私钥',
    }

    const css = `
.dsr-form{display:flex;flex-direction:column;gap:24px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:13px;padding-bottom:4px}
.dsr-intro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dsr-group{display:flex;flex-direction:column;gap:12px}
.dsr-row{display:flex;align-items:center;gap:10px;min-height:32px}
.dsr-label{font-size:13px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dsr-help{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsr-switch{position:relative;width:38px;height:22px;border-radius:999px;border:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);cursor:pointer;padding:0;transition:background .18s;flex:none}
.dsr-switch.on{background:var(--dsw-alias-brand-primary)}
.dsr-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .18s}
.dsr-switch.on .dsr-knob{transform:translateX(16px)}
.dsr-textarea{box-sizing:border-box;width:100%;font:inherit;font-size:13px;font-family:var(--dsw-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 11px;outline:none;min-height:64px;resize:vertical;line-height:1.5}
.dsr-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dsr-btn{font:inherit;font-size:13px;line-height:1;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 16px;height:32px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:border-color .15s,background .15s}
.dsr-btn:hover{border-color:var(--dsw-alias-label-tertiary)}
.dsr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsr-btn-primary:hover{border-color:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.dsr-btn:disabled{opacity:.5;cursor:default}
.dsr-foot{display:flex;align-items:center;gap:12px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsr-foot .dsr-status{flex:1}
.dsr-row-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsr-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;overflow:hidden}
.dsr-seg button{font:inherit;font-size:12px;line-height:1;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:6px 12px;cursor:pointer}
.dsr-seg button.on{background:var(--dsw-alias-brand-primary);color:#fff}
.dsr-seg button:not(:last-child){border-right:1px solid var(--dsw-alias-border-l3)}
.dsr-field{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:32px}
.dsr-field .dsr-label{flex:1}
.dsr-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsr-status.ok{color:var(--dsw-alias-brand-primary)}
.dsr-status.err{color:#e5484d}
.dsr-pre{margin:0;padding:10px 12px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary)}
.dsr-hits{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.dsr-hit{display:flex;align-items:center;gap:8px;font-size:12px;font-family:var(--dsw-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dsr-badge{font-size:10px;line-height:1;padding:3px 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.dsr-badge.warn{background:color-mix(in srgb,#e6a700 18%,transparent);color:#e6a700}
.dsr-badge.block{background:color-mix(in srgb,#e5484d 18%,transparent);color:#e5484d}
.dsr-empty{font-size:13px;color:var(--dsw-alias-label-tertiary);padding:12px 0}
/* ---- redaction view (magpie-style) ---- */
.dsr-view{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;background:var(--dsw-alias-bg-layer-0)}
.dsr-view-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;background:var(--dsw-alias-bg-layer-0);position:sticky;top:0;z-index:10}
.dsr-view-title{margin:0;font-size:14px;font-weight:600;flex:none}
.dsr-view-tools{display:flex;align-items:center;gap:8px;margin-left:auto}
.dsr-view-body{flex:1;min-height:0;overflow:hidden;display:flex}
.dsr-list{width:280px;flex:none;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l2);padding:8px;background:var(--dsw-alias-bg-layer-0)}
.dsr-item{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1);transition:border-color .15s}
.dsr-item:hover{border-color:var(--dsw-alias-label-tertiary)}
.dsr-item.sel{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.dsr-item-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsr-item-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsr-detail{flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-0)}
.dsr-detail-inner{flex:1;min-height:0;display:flex;flex-direction:column;padding:16px 16px 0}
.dsr-crumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsr-crumb a{color:var(--dsw-alias-brand-primary);text-decoration:none;cursor:pointer}
.dsr-crumb span{color:var(--dsw-alias-label-tertiary)}
.dsr-flow-wrap{flex:none;padding:12px 0}
.dsr-flow{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 20px;display:flex;flex-direction:column;gap:0}
.dsr-flow-head{display:flex;align-items:center;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:12px}
.dsr-flow-agent{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-flow-model{font-size:12px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));padding:2px 8px;border-radius:999px}
.dsr-flow-steps{display:flex;align-items:flex-start;gap:0;overflow-x:auto}
.dsr-step{flex:1;min-width:120px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;position:relative;padding:0 8px}
.dsr-step:not(:last-child)::after{content:'';position:absolute;top:11px;left:calc(50% + 20px);right:calc(-50% + 20px);height:1px;background:var(--dsw-alias-border-l2)}
.dsr-step-num{width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;flex:none}
.dsr-step-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-step-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
.dsr-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.dsr-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsr-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-panel-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsr-tabs{display:inline-flex;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;overflow:hidden}
.dsr-tabs button{font:inherit;font-size:12px;line-height:1;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:6px 12px;cursor:pointer}
.dsr-tabs button.on{background:var(--dsw-alias-brand-primary);color:#fff}
.dsr-tabs button:not(:last-child){border-right:1px solid var(--dsw-alias-border-l3)}
.dsr-content{padding:0}
.dsr-content.clamped{max-height:220px;overflow:hidden;position:relative}
.dsr-content.clamped::after{content:'';position:absolute;left:0;right:0;bottom:0;height:64px;background:linear-gradient(transparent,var(--dsw-alias-bg-layer-1));pointer-events:none}
.dsr-content-row{display:flex;flex-direction:column;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsr-content-row:last-child{border-bottom:0}
.dsr-crow-head{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsr-crow-head .role{color:var(--dsw-alias-brand-primary);font-weight:600}
.dsr-row-path{font-family:var(--dsw-font-mono,ui-monospace,monospace);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-row-vals{margin-left:auto;flex:none}
.dsr-colheads{display:flex;gap:12px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.dsr-colheads span{flex:1;min-width:0}
.dsr-content-main{flex:1;min-width:0;padding:10px 12px;display:flex;gap:12px}
.dsr-unchanged{margin:10px 12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;overflow:hidden;flex:none}
.dsr-unchanged-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsr-unchanged-head:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06))}
.dsr-unchanged-body{padding:2px 12px 10px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;gap:2px}
.dsr-content-col{flex:1;min-width:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary)}
.dsr-content-col.left{color:var(--dsw-alias-label-secondary)}
.dsr-content-col.right{color:var(--dsw-alias-label-primary)}
.dsr-collapsed{padding:8px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.dsr-collapsed:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06))}
.dsr-hl{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);border-radius:3px;padding:0 2px;cursor:help}
.dsr-pop{position:fixed;z-index:1000;width:280px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:6px;font-size:12px;pointer-events:none}
.dsr-pop-kind{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-pop-map{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-brand-primary);word-break:break-all}
.dsr-pop-meta{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsr-pop-meta span{display:flex;gap:6px}
.dsr-pop-meta b{color:var(--dsw-alias-label-secondary);font-weight:400;min-width:44px}
.dsr-count{font-size:10px;line-height:1;padding:3px 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);flex:none}
.dsr-side{width:300px;flex:none;display:flex;flex-direction:column;gap:0}
.dsr-side-head{padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:space-between}
.dsr-side-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-side-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsr-side-list{flex:1;overflow-y:auto;padding:8px}
.dsr-side-item{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}
.dsr-side-item.sel{border-color:var(--dsw-alias-brand-primary)}
.dsr-side-kind{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-side-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dsr-side-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsr-side-map{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-brand-primary);word-break:break-all}
.dsr-side-meta{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsr-side-meta span{display:flex;gap:6px}
.dsr-side-meta b{color:var(--dsw-alias-label-secondary);font-weight:400;min-width:44px}
.dsr-detail-flex{flex:1;min-height:0;display:flex;gap:16px;padding-bottom:16px}
.dsr-detail-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:16px}
.dsr-detail-main .dsr-panel{flex:1;min-height:0;display:flex;flex-direction:column}
.dsr-detail-main .dsr-content{flex:1;min-height:0;overflow-y:auto}
.dsr-detail-right{width:300px;flex:none;display:flex;flex-direction:column;min-height:0}
.dsr-expandbar{display:flex;justify-content:center;padding:6px 0}
.dsr-expand{font:inherit;font-size:12px;line-height:1;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:5px 14px;cursor:pointer}
.dsr-expand:hover{border-color:var(--dsw-alias-label-tertiary)}
`

    function Switch({ on, onChange }) {
      return h('button', {
        type: 'button', className: 'dsr-switch' + (on ? ' on' : ''),
        role: 'switch', 'aria-checked': String(!!on), onClick: () => onChange(!on),
      }, h('span', { className: 'dsr-knob' }))
    }

    function ToggleRow({ label, help, checked, onChange }) {
      return h('div', { className: 'dsr-field' }, [
        h('div', { key: 'l', style: { flex: 1 } }, [
          h('div', { key: 't', className: 'dsr-label' }, label),
          help ? h('div', { key: 'h', className: 'dsr-help' }, help) : null,
        ]),
        h(Switch, { key: 's', on: checked, onChange }),
      ])
    }

    const parseRules = (text) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
      const m = /^(?:(\w+)\s+)?(?:(prefix|regex)=(.+))$/.exec(line)
      if (!m) return null
      const kind = (m[1] || 'CUSTOM').toUpperCase()
      return m[2] === 'prefix' ? { kind, prefix: m[3] } : { kind, regex: m[3] }
    }).filter(Boolean)
    const rulesText = (rules) => (rules || []).map(r => r.prefix ? `${r.kind} prefix=${r.prefix}` : `${r.kind} regex=${r.regex}`).join('\n')

    // module-level bridge so RedactionView (module scope) can reach the RPC
    let moduleCallApi = null

    // Props contract (ui-slots PropsRuntime): the entry inject()'s `hooks`
    // compartment of HostObservable sources is replaced by synthesized
    // use<Name> selector hooks ({ form } → useForm); `t` comes from the
    // registration's `locale:` declaration; the rest of the inject face
    // passes through as top-level props.
    function RedactionSettings({ t, useForm, save: saveOp, preview }) {
      const snap = useForm(v => v)
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [pText, setPText] = useState('')
      const [pOut, setPOut] = useState(null)

      // seed draft when form is ready
      useEffect(() => {
        if (snap.status === 'ready' && draft === null) setDraft(snap.value || {})
      }, [snap.status, snap.revision, draft])

      if (snap.status === 'loading') return h('p', { className: 'dsr-empty' }, t('loading'))
      if (snap.status === 'unavailable' || !snap.writable) return h('p', { className: 'dsr-empty' }, t('unavailable'))
      if (draft === null) return h('p', { className: 'dsr-empty' }, t('loading'))

      const set = (k, v) => { setDraft({ ...draft, [k]: v }); setNotice(null) }

      const onSave = async () => {
        setBusy(true); setNotice(null)
        try {
          const ok = await saveOp([
            { op: 'set', path: ['secrets'], value: !!draft.secrets },
            { op: 'set', path: ['personal'], value: !!draft.personal },
            { op: 'set', path: ['kinds'], value: draft.kinds || {} },
            { op: 'set', path: ['words'], value: (draft.words || []) },
            { op: 'set', path: ['wordsAnyCase'], value: !!draft.wordsAnyCase },
            { op: 'set', path: ['wordsWhole'], value: !!draft.wordsWhole },
            { op: 'set', path: ['rules'], value: draft.rules || [] },
            { op: 'set', path: ['allow'], value: draft.allow || [] },
            { op: 'set', path: ['actions'], value: draft.actions || {} },
            { op: 'set', path: ['skipProviders'], value: draft.skipProviders || [] },
            { op: 'set', path: ['records'], value: draft.records !== false },
          ], snap.revision)
          setNotice(ok === false ? { kind: 'err', text: t('saveFailed') } : { kind: 'ok', text: t('saved') })
          if (ok !== false) setDraft(null)
        } catch (err) {
          setNotice({ kind: 'err', text: String(err && err.message || err) })
        }
        setBusy(false)
      }

      const onReset = () => { setDraft(null); setNotice(null) }

      const runPreview = async () => {
        try {
          const out = await preview(pText)
          setPOut(out)
        } catch (err) {
          setPOut({ error: String(err && err.message || err) })
        }
      }

      const kinds = draft.kinds || {}
      const actions = draft.actions || {}
      const actionFor = (k) => actions[k] || ''
      const setAction = (k, v) => {
        const next = { ...actions }
        if (v) next[k] = v
        else delete next[k]
        set('actions', next)
      }
      const CAT_LABEL = (k) => ['EMAIL','PHONE','ID_CARD','BANK_CARD'].includes(k) ? k : t('kind' + k[0].toUpperCase() + k.slice(1))
      return h('div', { className: 'dsr-form' }, [
        h('p', { key: 'in', className: 'dsr-intro' }, t('intro')),
        h('div', { key: 's', className: 'dsr-group' }, [
          h(ToggleRow, { key: 'secrets', label: t('secrets'), help: t('secretsHelp'), checked: !!draft.secrets, onChange: v => set('secrets', v) }),
          h(ToggleRow, { key: 'personal', label: t('personal'), help: t('personalHelp'), checked: !!draft.personal, onChange: v => set('personal', v) }),
          draft.personal ? h('div', { key: 'kinds', className: 'dsr-group' },
            ['EMAIL', 'PHONE', 'ID_CARD', 'BANK_CARD', 'ssn', 'passport', 'iban', 'birthday', 'mac', 'serial', 'home', 'userhost', 'ip', 'bucket'].map(k =>
              h('div', { key: k, className: 'dsr-field' }, [
                h('span', { key: 'l', className: 'dsr-label', style: { flex: 1 } }, CAT_LABEL(k)),
                h(Switch, { key: 's', on: kinds[k] !== false, onChange: v => set('kinds', { ...kinds, [k]: v }) }),
              ]))) : null,
        ]),
        h('div', { key: 'words', className: 'dsr-group' }, [
          h('div', { key: 'l', className: 'dsr-label' }, t('words')),
          h('div', { key: 'h', className: 'dsr-help' }, t('wordsHelp')),
          h('textarea', { key: 'ta', className: 'dsr-textarea', rows: 3, value: (draft.words || []).join('\n'),
            onChange: e => set('words', e.target.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) }),
          h(ToggleRow, { key: 'wac', label: t('wordsAnyCase'), help: t('wordsAnyCaseHelp'), checked: !!draft.wordsAnyCase, onChange: v => set('wordsAnyCase', v) }),
          h(ToggleRow, { key: 'ww', label: t('wordsWhole'), help: t('wordsWholeHelp'), checked: !!draft.wordsWhole, onChange: v => set('wordsWhole', v) }),
        ]),
        h('div', { key: 'rules', className: 'dsr-group' }, [
          h('div', { key: 'l', className: 'dsr-label' }, t('rules')),
          h('div', { key: 'h', className: 'dsr-help' }, t('rulesHelp')),
          h('textarea', { key: 'ta', className: 'dsr-textarea', rows: 3, value: rulesText(draft.rules),
            onChange: e => set('rules', parseRules(e.target.value)) }),
        ]),
        h('div', { key: 'allow', className: 'dsr-group' }, [
          h('div', { key: 'l', className: 'dsr-label' }, t('allow')),
          h('div', { key: 'h', className: 'dsr-help' }, t('allowHelp')),
          h('textarea', { key: 'ta', className: 'dsr-textarea', rows: 2, value: (draft.allow || []).join('\n'),
            onChange: e => set('allow', e.target.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) }),
        ]),
        h(ToggleRow, { key: 'records', label: t('records'), help: t('recordsHelp'), checked: draft.records !== false, onChange: v => set('records', v) }),

        h('div', { key: 'actions', className: 'dsr-group' }, [
          h('div', { key: 'l', className: 'dsr-label' }, t('actions')),
          h('div', { key: 'h', className: 'dsr-help' }, t('actionsHelp')),
          ['EMAIL', 'PHONE', 'ID_CARD', 'BANK_CARD', 'SSN', 'PASSPORT', 'IBAN', 'BIRTHDAY', 'MAC', 'SERIAL', 'USERNAME', 'HOSTNAME', 'IP', 'BUCKET', 'WORD', 'CUSTOM'].map(k =>
            h('div', { key: k, className: 'dsr-field' }, [
              h('span', { key: 'l', className: 'dsr-label', style: { flex: 1 } }, k),
              h('div', { key: 'seg', className: 'dsr-seg' }, ['', 'warn', 'block'].map(v =>
                h('button', {
                  key: v, type: 'button',
                  className: actionFor(k) === v ? 'on' : '',
                  onClick: () => setAction(k, v),
                }, v === '' ? t('actMask') : v === 'warn' ? t('actWarn') : t('actBlock')))),
            ])),
        ]),
        h('div', { key: 'skip', className: 'dsr-group' }, [
          h('div', { key: 'l', className: 'dsr-label' }, t('skipProviders')),
          h('div', { key: 'h', className: 'dsr-help' }, t('skipProvidersHelp')),
          h('textarea', { key: 'ta', className: 'dsr-textarea', rows: 2, value: (draft.skipProviders || []).join('\n'),
            onChange: e => set('skipProviders', e.target.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) }),
        ]),

        h('div', { key: 'pv', className: 'dsr-group' }, [
          h('div', { key: 'hd', className: 'dsr-row-head' }, [
            h('span', { key: 'l', className: 'dsr-label' }, t('preview')),
            h('button', { key: 'run', type: 'button', className: 'dsr-btn dsr-btn-primary', disabled: !pText.trim(), onClick: () => void runPreview() }, t('previewRun')),
          ]),
          h('textarea', { key: 'ta', className: 'dsr-textarea', rows: 3, placeholder: t('previewPh'), value: pText, onChange: e => setPText(e.target.value) }),
          pOut ? (pOut.error
            ? h('div', { key: 'err', className: 'dsr-help' }, pOut.error)
            : h('div', { key: 'out', className: 'dsr-group' }, [
              h('pre', { key: 'p', className: 'dsr-pre' }, pOut.text || pText),
              h('div', { key: 'n', className: 'dsr-help' }, `${pOut.values.length} ${t('previewFound')} · ${pOut.replaced} ${t('previewReplaced')}`),
              h('div', { key: 'hits', className: 'dsr-hits' }, (pOut.values || []).map((v, i) =>
                h('div', { key: i, className: 'dsr-hit' }, [
                  h('span', { key: 'p' }, v.placeholder),
                  h('span', { key: 'k', className: 'dsr-badge' }, v.kind),
                  h('span', { key: 'b', className: 'dsr-badge' }, t('by' + v.by[0].toUpperCase() + v.by.slice(1))),
                  h('span', { key: 'l' }, `${v.head || '·'}… ${v.len}`),
                ]))),
            ])) : h('div', { key: 'empty', className: 'dsr-help' }, t('previewEmpty')),
        ]),

        h('div', { key: 'foot', className: 'dsr-foot' }, [
          notice ? h('span', { key: 'n', className: 'dsr-status ' + notice.kind }, notice.text) : h('span', { key: 'd', className: 'dsr-status' }, t('dirty')),
          h('button', { key: 'reset', type: 'button', className: 'dsr-btn', disabled: busy, onClick: onReset }, t('reset')),
          h('button', { key: 'save', type: 'button', className: 'dsr-btn dsr-btn-primary', disabled: busy, onClick: () => void onSave() }, busy ? t('saving') : t('save')),
        ]),
      ])
    }

    const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
    const fmtTime = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
    const fmtDate = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
    }
    const maskVal = (head, len) => {
      const h = head || '·'
      return h + '•'.repeat(Math.max(1, Math.min(len - h.length, 6)))
    }

    // magpie-style detail: breadcrumb + flow steps + content compare + side list
    function RedactionDetail({ rec, t, onBack }) {
      const [contentTab, setContentTab] = useState('diff') // original | masked | diff
      const [expanded, setExpanded] = useState(false)
      const [selVal, setSelVal] = useState(null)

      const finders = [...new Set((rec.values || []).map(v => v.by))]
      const finderNames = finders.map(f => t('by' + f[0].toUpperCase() + f.slice(1))).join(', ')

      const steps = [
        { num: 1, title: t('stepReceive'), sub: t('stepReceiveSub', { size: fmtBytes(rec.bytes) }) },
        { num: 2, title: t('stepFind', { n: rec.values.length }), sub: t('stepFindSub', { finders: finderNames, ms: rec.tookMs }) },
        { num: 3, title: t('stepReplace', { n: rec.replaced }), sub: t('stepReplaceSub') },
        { num: 4, title: t('stepSend'), sub: t('stepSendSub', { provider: rec.provider, model: rec.model }) },
      ]

      // build content rows from values: group by path, collect every placeholder
      // hit at that path so the masked column can highlight them inline.
      const rows = []
      const seenPaths = new Map()
      for (const v of rec.values || []) {
        if (!v.before) continue
        const existing = seenPaths.get(v.path)
        if (existing) {
          existing.count++
          if (v.placeholder) existing.phs.push(v.placeholder)
          continue
        }
        seenPaths.set(v.path, { path: v.path, before: v.before, after: v.after || '', count: 1, phs: v.placeholder ? [v.placeholder] : [] })
        rows.push(seenPaths.get(v.path))
      }

      // role label：优先用记录里带的消息角色（messages[i].role），无则按路径猜
      const segByPath = new Map((rec.segments || []).map(s => [s.path, s]))
      const roleOf = (p) => segByPath.get(p)?.role
        || (p.startsWith('system') ? 'system' : p.startsWith('tools') ? 'tool' : p === 'preview' ? 'preview' : 'message')

      // 未改动段：记录后新增字段，老记录没 segments 就空卡都不画
      const [showUnchanged, setShowUnchanged] = useState(false)
      const unchanged = (rec.segments || []).filter(s => !s.changed)
      const unchangedBytes = unchanged.reduce((a, s) => a + s.bytes, 0)

      // scroll targets reset per record: keep the detail head pinned at top.
      const scrollRefs = useRef({ content: null, side: null })
      useEffect(() => {
        if (scrollRefs.current.content) scrollRefs.current.content.scrollTop = 0
        if (scrollRefs.current.side) scrollRefs.current.side.scrollTop = 0
        setSelVal(null)
        setExpanded(false)
      }, [rec.id])

      // inline-highlight every stored placeholder inside masked text; hovering a
      // mark reports (placeholder, element) up so the detail can float a card.
      const Highlight = ({ text, marks, onPh }) => {
        if (typeof text !== 'string' || !marks || marks.length === 0) return text
        const uniq = [...new Set(marks)].filter(Boolean).sort((a, b) => b.length - a.length)
        if (uniq.length === 0) return text
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const parts = text.split(new RegExp('(' + uniq.map(esc).join('|') + ')', 'g'))
        return parts.map((p, i) => uniq.includes(p)
          ? h('mark', { key: i, className: 'dsr-hl', onMouseEnter: (e) => onPh && onPh(p, e.currentTarget), onMouseLeave: () => onPh && onPh(null) }, p)
          : p)
      }

      const [pop, setPop] = useState(null) // { x, y, v }
      const showPop = (ph, el) => {
        if (ph === null) { setPop(null); return }
        const v = (rec.values || []).find(x => x.placeholder === ph)
        if (!v) return
        const r = el.getBoundingClientRect()
        setPop({ x: Math.max(8, Math.min(r.left, window.innerWidth - 300)), y: r.bottom + 6, v })
      }

      const KIND_COLOR = (k) => {
        const map = {
          EMAIL: '#0aa', PHONE: '#0aa', ID_CARD: '#0aa', BANK_CARD: '#0aa',
          SSN: '#0aa', PASSPORT: '#0aa', IBAN: '#0aa', BIRTHDAY: '#0aa',
          MAC: '#0aa', SERIAL: '#0aa', USERNAME: '#0aa', HOSTNAME: '#0aa',
          IP: '#0aa', BUCKET: '#0aa', WORD: '#7c3aed', CUSTOM: '#7c3aed',
          API_KEY: '#e5484d', TOKEN: '#e5484d', SECRET: '#e5484d', PASSWORD: '#e5484d',
          PRIVATE_KEY: '#e5484d',
        }
        return map[k] || '#0aa'
      }

      const kindLabel = (k) => {
        const key = 'kind_' + k
        const label = t(key)
        return label === key ? k : label
      }

      return h('div', { className: 'dsr-detail-inner' }, [
        // breadcrumb
        h('div', { key: 'crumb', className: 'dsr-crumb' }, [
          h('a', { key: 'b', onClick: onBack }, '‹ ' + t('view')),
          h('span', { key: 'sep' }, '/'),
          h('span', { key: 't' }, fmtDate(rec.time) + ' ' + fmtTime(rec.time)),
        ]),

        // flow card (fixed above the content area)
        h('div', { key: 'flowwrap', className: 'dsr-flow-wrap' },
          h('div', { className: 'dsr-flow' }, [
          h('div', { key: 'head', className: 'dsr-flow-head' }, [
            h('span', { key: 'provider', className: 'dsr-flow-agent' }, rec.provider),
            h('span', { key: 'model', className: 'dsr-flow-model' }, rec.model),
          ]),
          h('div', { key: 'steps', className: 'dsr-flow-steps' },
            steps.map(s =>
              h('div', { key: s.num, className: 'dsr-step' }, [
                h('div', { key: 'n', className: 'dsr-step-num' }, s.num),
                h('div', { key: 't', className: 'dsr-step-title' }, s.title),
                h('div', { key: 's', className: 'dsr-step-sub' }, s.sub),
              ]))),
          ])),

        // main + side
        h('div', { key: 'body', className: 'dsr-detail-flex' }, [
          // request content
          h('div', { key: 'main', className: 'dsr-detail-main' }, [
            h('div', { key: 'panel', className: 'dsr-panel' }, [
              h('div', { key: 'ph', className: 'dsr-panel-head' }, [
                h('div', { key: 'l' }, [
                  h('span', { key: 't', className: 'dsr-panel-title' }, t('reqContent')),
                  h('span', { key: 's', className: 'dsr-panel-sub', style: { marginLeft: 8 } }, t('showChangedOnly')),
                ]),
                h('div', { key: 'tabs', className: 'dsr-tabs' },
                  [['original', t('tabOriginal')], ['masked', t('tabMasked')], ['diff', t('tabDiff')]].map(([k, label]) =>
                    h('button', { key: k, type: 'button', className: contentTab === k ? 'on' : '', onClick: () => setContentTab(k) }, label))),
              ]),
              h('div', { key: 'content', ref: (el) => { scrollRefs.current.content = el }, className: 'dsr-content' + (expanded ? '' : ' clamped') },
                rows.length === 0 && unchanged.length === 0
                  ? h('div', { className: 'dsr-empty', style: { padding: 16 } }, t('empty'))
                  : [
                    // 双栏列头：本机原文 / 厂商看到的
                    contentTab === 'diff' && rows.length > 0 ? h('div', { key: 'colheads', className: 'dsr-colheads' }, [
                      h('span', { key: 'l' }, t('colLocal')),
                      h('span', { key: 'r' }, t('tabMasked')),
                    ]) : null,
                    // 未改动段折叠卡
                    unchanged.length > 0 ? h('div', { key: 'un', className: 'dsr-unchanged' }, [
                      h('div', { key: 'h', className: 'dsr-unchanged-head', onClick: () => setShowUnchanged(v => !v) }, [
                        h('span', { key: 't' }, (showUnchanged ? '⌄ ' : '› ') + unchanged.length + ' ' + t('noChange')),
                        h('span', { key: 'b' }, fmtBytes(unchangedBytes)),
                      ]),
                      showUnchanged ? h('div', { key: 'b', className: 'dsr-unchanged-body' },
                        unchanged.map(s => h('div', { key: s.path }, (s.role ? s.role + ' ' : '') + s.path))) : null,
                    ]) : null,
                    // 改动字段卡
                    ...rows.map(r =>
                      h('div', { key: r.path, className: 'dsr-content-row' }, [
                        h('div', { key: 'hd', className: 'dsr-crow-head' }, [
                          h('span', { key: 'role', className: 'role' }, roleOf(r.path)),
                          h('span', { key: 'path', className: 'dsr-row-path' }, r.path),
                          h('span', { key: 'vals', className: 'dsr-row-vals' }, t('valuesN', { n: r.count })),
                        ]),
                        h('div', { key: 'main', className: 'dsr-content-main' },
                          contentTab === 'original' ? h('div', { className: 'dsr-content-col left' }, r.before) :
                          contentTab === 'masked' ? h('div', { className: 'dsr-content-col right' }, h(Highlight, { text: r.after, marks: r.phs, onPh: showPop })) :
                          [
                            h('div', { key: 'l', className: 'dsr-content-col left' }, r.before),
                            h('div', { key: 'r', className: 'dsr-content-col right' }, h(Highlight, { text: r.after, marks: r.phs, onPh: showPop })),
                          ]),
                      ])),
                  ]),
              rows.length > 0 ? h('div', { key: 'exp', className: 'dsr-expandbar' },
                h('button', { type: 'button', className: 'dsr-expand', onClick: () => setExpanded(v => !v) },
                  expanded ? t('collapse') : t('expand'))) : null,
            ]),
          ]),

          // side: how masked
          h('div', { key: 'side', className: 'dsr-detail-right' }, [
            h('div', { key: 'panel', className: 'dsr-panel', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, [
              h('div', { key: 'ph', className: 'dsr-side-head' }, [
                h('span', { key: 't', className: 'dsr-side-title' }, t('howMasked')),
                h('span', { key: 's', className: 'dsr-side-sub' }, t('valuesN', { n: rec.values.length }) + ' · ' + t('replacedN', { n: rec.replaced })),
              ]),
              h('div', { key: 'list', ref: (el) => { scrollRefs.current.side = el }, className: 'dsr-side-list' },
                (rec.values || []).map((v, i) =>
                  h('div', {
                    key: i,
                    className: 'dsr-side-item' + (selVal === i ? ' sel' : ''),
                    onClick: () => setSelVal(selVal === i ? null : i),
                  }, [
                    h('div', { key: 'kind', className: 'dsr-side-kind' }, [
                      h('span', { key: 'dot', className: 'dsr-side-dot', style: { background: KIND_COLOR(v.kind) } }),
                      h('span', { key: 'k' }, kindLabel(v.kind)),
                      h('span', { key: 'c', className: 'dsr-side-count' }, '×' + v.n),
                    ]),
                    h('div', { key: 'map', className: 'dsr-side-map' },
                      maskVal(v.head, v.len) + ' → ' + v.placeholder),
                    h('div', { key: 'meta', className: 'dsr-side-meta' }, [
                      h('span', { key: 'by' }, [h('b', { key: 'b' }, t('lookup')), h('span', { key: 'v' }, t('by' + v.by[0].toUpperCase() + v.by.slice(1)))]),
                      h('span', { key: 'path' }, [h('b', { key: 'b' }, t('position')), h('span', { key: 'v' }, v.path)]),
                    ]),
                  ]))),
            ]),
          ]),
        ]),

        // placeholder hover card (record只存 head+len，原值不落盘)
        pop ? h('div', { key: 'pop', className: 'dsr-pop', style: { left: pop.x + 'px', top: pop.y + 'px' } }, [
          h('div', { key: 'k', className: 'dsr-pop-kind' }, [
            h('span', { key: 'd', className: 'dsr-side-dot', style: { background: KIND_COLOR(pop.v.kind) } }),
            h('span', { key: 'n' }, kindLabel(pop.v.kind)),
            h('span', { key: 'c', className: 'dsr-side-count' }, '×' + pop.v.n),
          ]),
          h('div', { key: 'm', className: 'dsr-pop-map' }, maskVal(pop.v.head, pop.v.len) + ' → ' + pop.v.placeholder),
          h('div', { key: 'meta', className: 'dsr-pop-meta' }, [
            h('span', { key: 'by' }, [h('b', { key: 'b' }, t('lookup')), h('span', { key: 'v' }, t('by' + pop.v.by[0].toUpperCase() + pop.v.by.slice(1)))]),
            h('span', { key: 'path' }, [h('b', { key: 'b' }, t('position')), h('span', { key: 'v' }, pop.v.path)]),
          ]),
        ]) : null,
      ])
    }

    // Same props contract: `t` from locale declaration; session-scoped standard
    // props carry sessionId; inject-face members arrive as top-level props.
    function RedactionView({ t, sessionId }) {
      const api = { call: moduleCallApi }
      const [items, setItems] = useState(null)
      const [err, setErr] = useState(null)
      const [byFinder, setByFinder] = useState('')
      const [selected, setSelected] = useState(null)
      const load = async () => {
        try {
          const list = await api.call('list', { sessionId: sessionId || '' })
          setItems(list || [])
          setErr(null)
        } catch (e) {
          setErr(String(e && e.message || e))
        }
      }
      useEffect(() => { void load() }, [sessionId])
      useEffect(() => {
        const timer = setInterval(() => { void load() }, 1500)
        return () => clearInterval(timer)
      }, [sessionId])

      const clear = async () => {
        await api.call('clear', { sessionId: sessionId || '' })
        setSelected(null)
        void load()
      }

      const finders = [...new Set((items || []).flatMap(r => (r.values || []).map(v => v.by)))]
      const visible = (items || []).map(r => byFinder ? { ...r, values: (r.values || []).filter(v => v.by === byFinder) } : r)
        .filter(r => (r.values || []).length > 0 || !byFinder)

      // keep selected record in sync with latest data
      const selectedRec = selected ? (items || []).find(r => r.id === selected.id) || selected : null

      return h('div', { className: 'dsr-view' }, [
        h('div', { key: 'hd', className: 'dsr-view-head' }, [
          h('h1', { key: 't', className: 'dsr-view-title' }, t('view')),
          h('div', { key: 'tools', className: 'dsr-view-tools' }, [
            finders.length > 0 ? h('select', {
              key: 'f', className: 'dsr-sel', value: byFinder,
              onChange: e => setByFinder(e.target.value),
            }, [h('option', { key: '', value: '' }, t('filterAll')), ...finders.map(f => h('option', { key: f, value: f }, t('by' + f[0].toUpperCase() + f.slice(1))))]) : null,
            h('button', { key: 'r', type: 'button', className: 'dsr-btn', onClick: () => void load() }, t('refresh')),
            h('button', { key: 'c', type: 'button', className: 'dsr-btn', onClick: () => void clear() }, t('clear')),
          ]),
        ]),
        h('div', { key: 'bd', className: 'dsr-view-body' },
          err ? h('div', { className: 'dsr-empty' }, t('errRpc') + ': ' + err)
            : items === null ? h('div', { className: 'dsr-empty' }, '…')
              : visible.length === 0 ? h('div', { className: 'dsr-empty' }, t('empty'))
                : [
                  // left list
                  h('div', { key: 'list', className: 'dsr-list' }, visible.map(rec =>
                    h('div', {
                      key: rec.id,
                      className: 'dsr-item' + (selectedRec?.id === rec.id ? ' sel' : ''),
                      onClick: () => setSelected(rec),
                    }, [
                      h('div', { key: 'h', className: 'dsr-item-head' }, [
                        h('span', { key: 'tm' }, fmtTime(rec.time)),
                        h('span', { key: 'm' }, rec.model),
                        h('span', { key: 'v' }, rec.values.length + ' ' + t('recValues')),
                      ]),
                      h('div', { key: 's', className: 'dsr-item-sub' }, rec.replaced + ' ' + t('recReplaced') + ' · ' + rec.tookMs + 'ms'),
                    ]))),
                  // right detail
                  h('div', { key: 'det', className: 'dsr-detail' },
                    selectedRec === null
                      ? h('div', { className: 'dsr-empty' }, t('selectItem'))
                      : h(RedactionDetail, { rec: selectedRec, t, onBack: () => setSelected(null) })),
                ]),
      ])
    }

    // Dual-runtime red lines (verified on Desktop 0.2.2-rc.1): only shared
    // services in inject; slots.inject callbacks are plain functions returning
    // disposers; never touch settingsMetadata.
    exports.inject = ['slots', 'locale', 'configForms', 'connection']
    exports.apply = function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const tv = ctx.locale.bind(VIEW_NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'cinlan-redaction: dict')
      ctx.effect(() => ctx.locale.register(VIEW_NS, { en, zh }), 'cinlan-redaction: view dict')

      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', '@cinlan/redaction')
      style.textContent = css
      document.head.appendChild(style)

      const form = ctx.configForms.get('cinlan-redaction')
      const callApi = async (method, args) => {
        const r = await ctx.connection.rpc.call('/api', 'redaction/' + method, { args: args || {} }, new AbortController().signal)
        if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || 'Remote call failed: ' + method)
        return r.value
      }
      moduleCallApi = callApi
      const preview = async (text) => callApi('preview', { text })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section', id: 'cinlan-redaction', order: 32,
          label: () => t('nav'), locale: NS,
          inject: () => ({
            // hooks compartment = HostObservable sources only; the framework
            // synthesizes useForm from `form`. Functions ride as plain props.
            hooks: { form },
            save: (ops, rev) => form.mutate(ops, rev),
            preview,
          }),
        }, RedactionSettings))

      // Conversation tab: always mounted; shows empty state when no records.
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view', id: 'cinlan-redaction', order: 15,
          label: () => tv('view'), locale: VIEW_NS,
          inject: () => ({}),
        }, RedactionView))
    }
    return module.exports
  },
})
