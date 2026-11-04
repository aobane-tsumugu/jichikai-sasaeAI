// 試験だけで使う束縛（vitest.config.ts が入れる）と、Worker 本体の export の型
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
