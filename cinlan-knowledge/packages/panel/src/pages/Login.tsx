import { useState } from "react";
import { Button, Input } from "tdesign-react";
import { ServerIcon } from "tdesign-icons-react";
import { useApp } from "../app/context.js";
import { toApiError } from "../app/ui.js";
import { describeErrorCode } from "../lib/errors.js";

/** 登录：hub 地址只读展示，User Key 从表单输入 → `auth/verify`（panel-design.md §4.1）。 */
export function LoginPage() {
  const app = useApp();
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; text: string; detail: string } | null>(null);

  const submit = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setError({ code: "UNAUTHORIZED", text: "请输入 User Key", detail: "" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await app.login(trimmed);
    } catch (cause) {
      const api = toApiError(cause);
      setError({ code: api.code, text: describeErrorCode(api.code), detail: api.detail });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ck-login">
      <div className="ck-login-card">
        <div className="ck-login-logo" aria-hidden="true">
          <ServerIcon size="22px" />
        </div>
        <h1 className="ck-login-title">Cinlan Knowledge</h1>
        <p className="ck-login-sub">团队记忆中枢 · 用 User Key 登录</p>

        <label className="ck-field">
          <span className="ck-field-label">hub 地址</span>
          <Input value={location.origin} readonly />
          <span className="ck-field-hint">与面板同源，只读。</span>
        </label>

        <label className="ck-field">
          <span className="ck-field-label">User Key</span>
          <Input
            type={visible ? "text" : "password"}
            value={key}
            onChange={(value) => setKey(value)}
            placeholder="ck_…"
            autocomplete="off"
            onEnter={() => void submit()}
            suffix={
              <Button variant="text" size="small" onClick={() => setVisible((s) => !s)}>
                {visible ? "隐藏" : "显示"}
              </Button>
            }
          />
          <span className="ck-field-hint">key 只保存在本标签页的 sessionStorage，关掉即失效。</span>
        </label>

        {app.authNotice && !error ? (
          <p className="ck-login-error" role="status">
            {app.authNotice}
          </p>
        ) : null}
        {error ? (
          <p className="ck-login-error" role="alert">
            {error.text}
            {error.detail ? `（${error.detail}）` : ""}
          </p>
        ) : null}

        <Button theme="primary" size="large" block loading={busy} onClick={() => void submit()}>
          登录
        </Button>
        <p className="ck-login-foot">
          没有 key？请团队管理员在「访问控制」页为你新建；key 只在创建时显示一次。
        </p>
      </div>
    </div>
  );
}
