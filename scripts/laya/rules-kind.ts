// The rule-based kind classifier from scripts/corpus.ts, scored against the
// corpus slugs the same way eval-cards.ts scores a decider: the yardstick a
// model has to beat. (Copied rather than imported: corpus.ts runs on import.)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIST_MARKER } from "../../core/src/render/compose.ts";
type Kind = string;
const CODE_LINE = /^\s*(?:import|export|const|let|var|function|class|def|fn|pub|struct|impl|SELECT|FROM|WHERE|package|func|if|for|while|return|else|try|except|async|await|@media|\{|\}|\[|\]|#include|<\/?[a-z]|\$ |curl |docker |git |kubectl )/i;
const LOG_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\d{1,3}(?:\.\d{1,3}){3} |\[\d{2}\/\w{3}\/\d{4}|\w{3} +\d{1,2} \d{2}:\d{2}:\d{2} |\{"ts"|\{"time"|[A-Z][a-z]+ +[A-Z][A-Za-z]+ +\d+ )/;
const UNIT_NUMBER = /\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:[%％万亿倍]|[xXkKM](?![A-Za-z0-9]))/;
const ATTRIBUTED = /(?:\n\s*|[”"」』’]\s*|[。．.!?！？…]\s*)(?:——|—|--|-)\s*[^\n—]{1,40}$/;

function classify(text: string): Kind {
  const t = text.trim();
  const lines = t.split("\n").filter((l) => l.trim());
  const chars = [...t].length;
  if (/^https?:\/\/\S+$/.test(t)) return "plain";
  if (/^```/m.test(t) || /^\s+at .+:\d+:\d+\)?$/m.test(t) || /^Traceback \(most recent call last\)/m.test(t)) return "code";
  if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(t)) return "code";
  const symbols = (t.match(/[;{}()=<>[\]|\\$]/g) ?? []).length / Math.max(1, chars);
  const codeLines = lines.filter((l) => CODE_LINE.test(l)).length;
  const logLines = lines.filter((l) => LOG_LINE.test(l)).length;
  if (symbols > 0.06 || codeLines >= 2 || (lines.length === 1 && codeLines === 1 && symbols > 0.03) || logLines >= 2) return "code";
  if (lines.length >= 3 && lines.filter((l) => LIST_MARKER.test(l) && l.replace(LIST_MARKER, "") !== l).length >= 3) return "list";
  if (ATTRIBUTED.test(t) || /^[“「『][\s\S]*[”」』]$/.test(t)) return "quote";
  if (chars <= 120 && lines.length === 1 && UNIT_NUMBER.test(t)) return "stat";
  return "plain";
}
const dir = join(import.meta.dir, "../../core/fixtures/corpus");
const expectedKind = (f: string): string | null => {
  const m = /^\d+-([a-z]+)-/.exec(f); const g = m?.[1] ?? "";
  return ({ chat: "plain", para: "plain", url: "plain", code: "code", log: "plain", list: "list", quote: "quote", stat: "stat", date: "event", poem: "plain", tweet: "plain", email: "plain", address: "plain", markdown: "plain" } as Record<string, string>)[g] ?? null;
};
let right = 0, total = 0; const conf = new Map<string, number>();
for (const f of readdirSync(dir).filter((x) => x.endsWith(".txt")).sort()) {
  const exp = expectedKind(f); if (!exp) continue;
  const got = classify(readFileSync(join(dir, f), "utf8"));
  const e = exp === "event" ? "plain" : exp; // rules have no event kind
  total++; if (got === e) right++; conf.set(`${e}→${got}`, (conf.get(`${e}→${got}`) ?? 0) + 1);
}
console.log(`rules kind accuracy vs slug (event counted as plain): ${right}/${total} (${Math.round(100 * right / total)}%)`);
console.log([...conf.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
