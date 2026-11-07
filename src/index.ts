// Workers の入口。束 1 の持ち物。他の束は触らず、自分の置き場の index.ts に Bundle を export する。
// 経路と Cron の差し込み口の約束は src/core/bundle.ts。
import { createApp, runScheduled } from "./core/app";
import type { Bundle } from "./core/bundle";
import type { Env } from "./env";

import { ai } from "./ai";
import { answers } from "./answers";
import { archive } from "./archive";
import { check } from "./check";
import { close } from "./close";
import { draft } from "./draft";
import { intake } from "./intake";
import { know } from "./know";
import { line } from "./line";
import { map } from "./map";
import { printPages } from "./print/pages";
import { project } from "./project";
import { publish } from "./publish";
import { settings } from "./settings";
import { space } from "./space";
import { wardPages } from "./ward";

/** 経路の先に当たる順。名前は Cron の失敗の記録に出る。 */
export const bundles: Record<string, Bundle> = {
  settings,
  intake,
  know,
  ai,
  project,
  map,
  draft,
  check,
  publish,
  wardPages,
  printPages,
  answers,
  space,
  line,
  close,
  archive,
};

const app = createApp(Object.values(bundles));

export default {
  fetch: app.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runScheduled(bundles, event, env, ctx);
      const { runBackupCron } = await import("./archive/backup");
      await runBackupCron(event, env);
    })());
  },
} satisfies ExportedHandler<Env>;
