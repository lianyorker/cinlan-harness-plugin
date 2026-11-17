import { useState, type ReactNode } from "react";
import { Button, Input, Tag } from "tdesign-react";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from "tdesign-icons-react";
import { useApp } from "../app/context.js";
import { CopyButton, EmptyState, LoadingState, PageHeader, useAsync } from "../app/ui.js";
import {
  buildGuide,
  CK_ENTRY,
  fillPlaceholders,
  groupGuide,
  type GuideCard,
  type GuideContext,
  type HostBundle,
} from "../lib/guide.js";

/** 接入指南（panel-design.md §5）：Block A 三步接入、B 客户端矩阵、C 我的 key、D 导入、E 排错。 */
export function GuidePage() {
  const app = useApp();
  const [agentName, setAgentName] = useState("cc-ly");
  const [downloadable, setDownloadable] = useState<boolean | null>(null);

  const ctx: GuideContext = {
    hubUrl: location.origin,
    team: app.currentTeam ?? "<team>",
    agentName,
  };

  const state = useAsync(
    async (signal) => {
      const res = await fetch("/panel/hosts.json", { signal });
      if (!res.ok) throw new Error(`hosts.json HTTP ${res.status}`);
      return (await res.json()) as HostBundle;
    },
    [],
  );

  // PD-2：hub 的 /dl/ck.tgz 就绪后才能给下载命令；现在只探测，不做假承诺。
  useState(() => {
    fetch("/dl/ck.tgz", { method: "HEAD" })
      .then((res) => setDownloadable(res.ok))
      .catch(() => setDownloadable(false));
  });

  const cards = state.data ? buildGuide(state.data, ctx) : [];
  const groups = groupGuide(cards);

  return (
    <>
      <PageHeader
        title="接入指南"
        description="把 hub 接到宿主里：装 ck、跑 setup、验证注入。片段与 agents/<host>/templates 同源生成。"
      />

      <div className="ck-guide">
        {/* Block A */}
        <section className="ck-guide-block">
          <h2 className="ck-guide-title">A · 三步接入</h2>
          <div className="ck-steps">
            <Step
              no={1}
              title="装 ck"
              body={
                downloadable === true ? (
                  <>
                    <p>从 hub 下载并解包：</p>
                    <Code
                      text={`curl -fsSL ${ctx.hubUrl}/dl/ck.tgz | tar -xz -C ~/.local/share/ck\n${CK_ENTRY} --version`}
                    />
                  </>
                ) : (
                  <>
                    <p className="ck-muted">
                      打包下载（PD-2）还没上线，先从仓库安装：<code>pnpm -F @cinlan/knowledge-cli build</code>，
                      入口是仓库里的 <code>packages/cli/lib/bin.js</code>。
                    </p>
                  </>
                )}
            />
            <Step
              no={2}
              title="登录"
              body={
                <>
                  <p>key 从 stdin 读，不落命令历史：</p>
                  <Code text={`ck login --hub ${ctx.hubUrl}`} />
                  <p className="ck-muted">
                    key 在下面「C · 我的 key」里建；明文只显示一次。写进 <code>~/.config/cinlan-knowledge/config.json</code>。
                  </p>
                </>
              }
            />
            <Step
              no={3}
              title="配装"
              body={
                <>
                  <p>按宿主跑 setup（会顺手 agent/ensure，套用团队模板）：</p>
                  <Code text={`ck setup --host <host> --agent ${ctx.team}/${agentName}`} />
                  <p className="ck-muted">
                    用 <code>ck doctor --host &lt;host&gt;</code> 验收；下面每张宿主卡里有该宿主的全部片段。
                  </p>
                </>
              }
            />
          </div>
          <label className="ck-field" style={{ maxWidth: 320 }}>
            <span className="ck-field-label">你打算用的 Agent 名</span>
            <Input
              value={agentName}
              onChange={(value) => setAgentName(value.trim())}
              placeholder="cc-ly"
            />
            <span className="ck-field-hint">只影响下面片段里的 {`{{AGENT}}`}；可随时改。</span>
          </label>
        </section>

        {/* Block B */}
        <section className="ck-guide-block">
          <h2 className="ck-guide-title">B · 客户端矩阵</h2>
          {state.loading ? <LoadingState text="取宿主声明…" /> : null}
          {state.error ? <p className="ck-login-error">{state.error.message}（构建产物缺 hosts.json，检查 scripts/build-hosts.mjs）</p> : null}
          {groups.map((group) => (
            <div key={group.group} className="ck-guide-group">
              <h3 className="ck-subtitle">
                {group.label} <span className="ck-muted">· {group.cards.length}</span>
              </h3>
              {group.cards.map((card) => (
                <HostCard key={card.host} card={card} />
              ))}
            </div>
          ))}
        </section>

        {/* Block C */}
        <section className="ck-guide-block">
          <h2 className="ck-guide-title">C · 我的 key</h2>
          <p>
            建 key、看前缀、吊销都在 <a href="/panel/access">访问控制</a> 页。这里只放命令侧约定：
          </p>
          <Code text="ck login --hub <hub 地址>   # 交互输入 key，或 echo <key> | ck login --hub …" />
          <p className="ck-muted">
            key 不写进任何仓库文件；宿主配置里只落 hash 后的会话，不落 key 本身（A1）。A0 会把 key 写进宿主
            MCP 配置，能走 A1 就走 A1。
          </p>
        </section>

        {/* Block D */}
        <section className="ck-guide-block">
          <h2 className="ck-guide-title">D · 从本机导入 skill</h2>
          <p>宿主里已有的 skill 目录可以反向导入成你自己的私有资产：</p>
          <Code text={`ck import --source <host>${app.currentTeam ? ` --team ${app.currentTeam}` : ""}`} />
          <p className="ck-muted">
            <code>--source</code> 取 host.json 的 <code>import_scan</code>；同名同内容跳过，同名不同内容默认记
            conflict，加 <code>--update</code> 出新版本。
          </p>
        </section>

        {/* Block E */}
        <section className="ck-guide-block">
          <h2 className="ck-guide-title">E · 排错</h2>
          <table className="ck-table-plain">
            <tbody>
              <tr>
                <th scope="row">连不上 hub</th>
                <td>
                  <code>ck doctor</code> 看 NETWORK；确认 <code>ck login</code> 写的 hub 地址与浏览器地址一致。
                </td>
              </tr>
              <tr>
                <th scope="row">401 / UNAUTHORIZED</th>
                <td>key 被吊销或用户被禁用；到「访问控制」重建一把。</td>
              </tr>
              <tr>
                <th scope="row">RATE_LIMITED</th>
                <td>按响应里的 Retry-After 等待；批量操作请放慢。</td>
              </tr>
              <tr>
                <th scope="row">会话里没有注入</th>
                <td>
                  <code>ck doctor --host &lt;host&gt;</code> 看 hook/MCP 是否写入；新会话才会触发 SessionStart。
                </td>
              </tr>
              <tr>
                <th scope="row">资产没进配装</th>
                <td>看 Agent 详情页的「预算预览→被跳过」；未生效、无权限、过期都会被跳过。</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

function Step(props: { no: number; title: string; body: ReactNode }) {
  return (
    <div className="ck-step">
      <span className="ck-step-no" aria-hidden="true">
        {props.no}
      </span>
      <div className="ck-step-body">
        <h3 className="ck-subtitle">{props.title}</h3>
        {props.body}
      </div>
    </div>
  );
}

function Code(props: { text: string }) {
  return (
    <div className="ck-code-row">
      <pre className="ck-code">{props.text}</pre>
      <CopyButton text={props.text} label="复制" />
    </div>
  );
}

function HostCard(props: { card: GuideCard }) {
  const [open, setOpen] = useState(props.card.group === "ready" && props.card.host === "claude-code");
  const { card } = props;
  const hasSnippets = card.snippets.length > 0;

  return (
    <div className="ck-host-card">
      <button
        type="button"
        className="ck-host-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {hasSnippets ? open ? <ChevronDownIcon /> : <ChevronRightIcon /> : <CopyIcon />}
        <span className="ck-host-title">{card.title}</span>
        <code className="ck-muted">{card.host}</code>
        <Tag variant="light" theme={card.group === "ready" ? "success" : card.group === "building" ? "warning" : "default"}>
          {card.phase}
        </Tag>
        {!hasSnippets ? <Tag variant="outline">未提供片段</Tag> : null}
      </button>
      {open ? (
        <div className="ck-host-body">
          {card.setupCommand ? <Code text={card.setupCommand} /> : null}
          {card.notes.map((note) => (
            <p key={note} className="ck-muted ck-small">
              {note}
            </p>
          ))}
          {card.snippets.map((snippet) => (
            <div key={snippet.file} className="ck-snippet">
              <div className="ck-snippet-head">
                <strong>{snippet.file}</strong>
                <span className="ck-muted ck-small">{snippet.target}</span>
              </div>
              {snippet.comment ? <pre className="ck-comment">{snippet.comment}</pre> : null}
              <div className="ck-code-row">
                <pre className="ck-code" data-language={snippet.language}>
                  {snippet.content}
                </pre>
                <CopyButton text={snippet.content} label="复制片段" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
