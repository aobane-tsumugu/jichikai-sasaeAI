// Anthropic のクライアントの作り方の差し替え口。既定は署名鍵から作る本物。試験が偽物に替える。
import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { createAnthropic } from "./anthropic";

type Factory = (env: Env) => Anthropic;

let factory: Factory | null = null;

export function getClient(env: Env): Anthropic {
  return (factory ?? ((e: Env) => createAnthropic(e, { maxRetries: 2 })))(env);
}

export function setClientFactory(next: Factory | null): void {
  factory = next;
}
