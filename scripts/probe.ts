#!/usr/bin/env bun
/**
 * Ask Jev the paste questions for six sample texts and print, one line per
 * text, what came back and the DSL it becomes. The questions go through the
 * provider the environment selects (PASTE_PROVIDER, PASTE_PROXY_URL,
 * PASTE_TOKEN; see core/src/provider/index.ts), by default the dev proxy:
 *
 *   cd proxy && npx wrangler dev --port 8787    # in another terminal
 *   bun run probe
 *
 * A text whose ask fails prints an ERR line and the run goes on; the exit
 * status is 1 when any text failed. This never starts the proxy itself.
 */
import { createProvider, DEV_PROXY_URL, ProviderError, providerFromEnv } from "../core/src/provider/index.ts";
import { answersToDsl, buildRequest, fallbackDsl, type Answers } from "../core/src/questions.ts";

const TEXTS = [
  "“过早的优化是万恶之源。” —— Donald Knuth",
  "本季度活跃用户增长了 37%，是过去三年最快的一次。",
  "1. 先量，再改\n2. 一次只改一个变量\n3. 把结果写进 baseline\n4. 让 CI 在另一台机器上复现",
  "const digest = await trace(comp, { frames: 60 });\nif (digest !== baseline) {\n  throw new Error(\"frame moved: \" + digest);\n}",
  "确定性不是靠 lint 扫出来的，是把能动像素的每一个输入都写进声明里，然后在另一台机器上把同一张图算出来。",
  "周四下午 3 点，会议室 B，带上上季度的报表。",
];
const ASPECT = "chat";

function configure() {
  try { return providerFromEnv(); } catch (e) {
    console.error(`probe: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
const cfg = configure();
const provider = createProvider(cfg);
console.log(`provider: ${provider.name}${cfg.kind === "proxy" ? ` at ${cfg.url}` : ""}`);

const num = (v: unknown): string => (typeof v === "number" ? v.toFixed(2) : JSON.stringify(v));
const label = (t: string): string => JSON.stringify([...t].length > 40 ? [...t].slice(0, 40).join("") + "…" : t);
const ms = (t0: number): string => `${String(Math.round(performance.now() - t0)).padStart(5)} ms`;

let failed = 0;
for (const text of TEXTS) {
  const { body, words } = buildRequest(text);
  const t0 = performance.now();
  let answers: Answers | null;
  try {
    answers = await provider.ask(body);
  } catch (e) {
    failed++;
    const why = e instanceof ProviderError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    const hint = e instanceof ProviderError && e.code === "network" && cfg.kind === "proxy" && cfg.url === DEV_PROXY_URL
      ? "  (is the dev proxy running? `cd proxy && npx wrangler dev --port 8787`)" : "";
    console.log(`[${ms(t0)}] ${label(text)}  ERR ${why}${hint}`);
    continue;
  }
  const took = ms(t0);
  if (answers === null) {
    const d = fallbackDsl(text, ASPECT);
    console.log(`[${took}] ${label(text)}  no decision (provider ${provider.name}); fallback kind=${d.kind}  layout=${d.layout}  scale=${d.scale}`);
    continue;
  }
  const { dsl, kindP } = answersToDsl(text, answers, ASPECT);
  const kind = dsl.kind === answers.kind.choice ? dsl.kind : `${answers.kind.choice}→${dsl.kind}`;
  const emphasis = dsl.emphasis >= 0 ? words[dsl.emphasis] ?? `w${dsl.emphasis}` : "-";
  console.log(
    `[${took}] ${label(text)}  kind=${kind} (${kindP.toFixed(2)})  layout=${dsl.layout}  palette=${dsl.palette}` +
    `  scale=${num(answers.scale.score)}→${dsl.scale}  tone=${num(answers.tone.score)}→${dsl.tone}` +
    `  animate=${num(answers.animate.noul)}→${dsl.animate ? "yes" : "no"}  emphasis=${emphasis}`,
  );
}
process.exit(failed > 0 ? 1 : 0);
