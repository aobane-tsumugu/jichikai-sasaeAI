// MCP の書き込みを束 3 の本実装へ渡す。試験だけ差し替えられる。
import type { ProjectApi } from "./project-contract";
import { agentApi } from "../project/agent-api";

let current: ProjectApi = agentApi;

export function projectApi(): ProjectApi {
  return current;
}

/** 試験で差し替える。null で束 3 の実装に戻す。 */
export function setProjectApi(api: ProjectApi | null): void {
  current = api ?? agentApi;
}
