import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./app/context.js";
import { App } from "./app/App.js";
// React 19 去掉了 ReactDOM.render，TDesign 的 Message / Dialog 插件调用要靠这个适配器挂 createRoot。
import "tdesign-react/es/_util/react-19-adapter";
import "tdesign-react/es/style/index.css";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root is missing from index.html");

createRoot(rootEl).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
