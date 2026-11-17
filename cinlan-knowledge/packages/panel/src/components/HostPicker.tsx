import { Select } from "tdesign-react";
import { hostLabel, KNOWN_HOSTS } from "../lib/format.js";

/** 宿主选择器：与 agents/<host>/host.json 的 slug 一一对应（未收录的原样显示）。 */
export function HostPicker(props: { value: string; onChange(host: string): void; disabled?: boolean }) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      options={KNOWN_HOSTS.map((host) => ({ label: `${hostLabel(host)}（${host}）`, value: host }))}
      onChange={(value) => {
        if (typeof value === "string") props.onChange(value);
      }}
    />
  );
}
