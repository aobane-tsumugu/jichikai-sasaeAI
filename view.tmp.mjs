import { chromium } from "playwright";
const P = "C:/Users/USER/work/jichikai-codex/print-now";
const id = "4379950e-0293-437e-8b02-58d97555af7a";
const b = await chromium.launch();
const ctx = await b.newContext({ storageState: `${P}/state.json`, viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
for (const path of process.argv.slice(3)) {
  await page.goto(`https://jichikai.aobane-tsumugu.com/demoku/admin${path.replace("{id}", id)}`, { waitUntil: "load" });
  console.log("=== " + path + " " + page.url().slice(-40));
  console.log((await page.locator("main, body").first().innerText()).slice(0, Number(process.argv[2])));
}
await b.close();
