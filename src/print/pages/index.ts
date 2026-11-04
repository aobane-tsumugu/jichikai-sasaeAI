import { Hono } from "hono";
import type { Bundle } from "../../core/bundle";
import type { AdminEnv } from "../../env";

// 束 4: 印刷用ページの中身（案内、回答票、班長への一枚、当番表と配置図、記入欄）。A4 の版面と QR の部品は src/print/ にある。
// 経路の取り決めは src/core/bundle.ts。
export const printPages: Bundle = {
  admin: new Hono<AdminEnv>(),
};
