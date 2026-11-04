import type { Bundle } from "../core/bundle";
import { CRON } from "../core/cron";
import { sweepReads } from "./pipeline";
import { intakeAdmin } from "./pages";

// 束 2: 入れると列。役員画面の送る（カメラ、ファイル、一行の文）、受付、原本、読み、列の記録、取り下げ。
// 経路の取り決めは src/core/bundle.ts。この置き場の中だけを埋め、src/index.ts と src/env.ts は触らない。
export const intake: Bundle = {
  admin: intakeAdmin,
  // 五分ごと。waitUntil の 30 秒で止められた読みと、放ってある読みを拾い直す
  async scheduled(event, env) {
    if (event.cron === CRON.EVERY_5_MIN) await sweepReads(env);
  },
};
