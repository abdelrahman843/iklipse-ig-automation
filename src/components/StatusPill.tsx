import type { RunStatus } from "../lib/types";

const RUN_TONE: Record<RunStatus, string> = {
  running: "is-live",
  waiting_input: "",
  waiting_delay: "",
  done: "is-good",
  failed: "is-bad",
  blocked_window: "is-bad",
};

const RUN_TEXT: Record<RunStatus, string> = {
  running: "Running",
  waiting_input: "Waiting for reply",
  waiting_delay: "Waiting",
  done: "Done",
  failed: "Failed",
  blocked_window: "Window closed",
};

export function RunPill({ status }: { status: RunStatus }) {
  return <span className={`pill ${RUN_TONE[status] ?? ""}`}>{RUN_TEXT[status] ?? status}</span>;
}

export function FlowPill({ status }: { status: "draft" | "live" }) {
  return (
    <span className={`pill ${status === "live" ? "is-flowlive" : ""}`}>
      {status === "live" ? "Live" : "Draft"}
    </span>
  );
}
