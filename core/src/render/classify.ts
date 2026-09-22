/**
 * The rule-based kind classifier: what the `rules` decider answers the kind
 * question with, and the stand-in scripts/corpus.ts always used. Written
 * against the 100-sample corpus (91% there, see baselines/laya.md), so it
 * knows the shapes in it — fenced or braced code, stack traces, logs, list
 * markers, attributed quotes, one-line figures — and calls everything else
 * plain. Never a network call, never a millisecond.
 */
import type { Kind } from "../dsl.ts";
import { LIST_MARKER } from "./compose.ts";

const CODE_LINE = /^\s*(?:import|export|const|let|var|function|class|def|fn|pub|struct|impl|SELECT|FROM|WHERE|package|func|if|for|while|return|else|try|except|async|await|@media|\{|\}|\[|\]|#include|<\/?[a-z]|\$ |curl |docker |git |kubectl )/i;
const LOG_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\d{1,3}(?:\.\d{1,3}){3} |\[\d{2}\/\w{3}\/\d{4}|\w{3} +\d{1,2} \d{2}:\d{2}:\d{2} |\{"ts"|\{"time"|[A-Z][a-z]+ +[A-Z][A-Za-z]+ +\d+ )/;
const UNIT_NUMBER = /\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:[%％万亿倍]|[xXkKM](?![A-Za-z0-9]))/;
const ATTRIBUTED = /(?:\n\s*|[”"」』’]\s*|[。．.!?！？…]\s*)(?:——|—|--|-)\s*[^\n—]{1,40}$/;

export function classify(text: string): Kind {
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
