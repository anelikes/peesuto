// Ask Jev the paste questions for a few clipboard texts through the local proxy.
const TEXTS = [
  "“过早的优化是万恶之源。” —— Donald Knuth",
  "本季度活跃用户增长了 37%，是过去三年最快的一次。",
  "1. 先量，再改\n2. 一次只改一个变量\n3. 把结果写进 baseline\n4. 让 CI 在另一台机器上复现",
  "const digest = await trace(comp, { frames: 60 });\nif (digest !== baseline) {\n  throw new Error(\"frame moved: \" + digest);\n}",
  "确定性不是靠 lint 扫出来的，是把能动像素的每一个输入都写进声明里，然后在另一台机器上把同一张图算出来。",
  "周四下午 3 点，会议室 B，带上上季度的报表。",
];
const seg = (t: string) => [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(t)].map((s) => s.segment).filter((w) => /[\p{L}\p{N}]/u.test(w));
for (const text of TEXTS) {
  const words = seg(text).slice(0, 200);
  const wordCriteria = Object.fromEntries(words.map((w, i) => [`w${i}`, w]));
  wordCriteria["none"] = "no single word deserves emphasis";
  const body = {
    state: { clipboard: text },
    questions: {
      kind: { type: "choice", instructions: "What kind of text is on the clipboard?", criteria: {
        quote: "a quotation or aphorism, often with an attribution", code: "source code, a shell command or a log line",
        stat: "a sentence whose point is one number", list: "several items or numbered steps",
        event: "a time, a place, an appointment", plain: "ordinary prose that fits none of the above" } },
      layout: { type: "choice", instructions: "Which layout suits it as a card?", criteria: {
        center: "one short thought, centred", left: "a left-aligned stack, good for several lines", split: "an accent rule on the left and text beside it" } },
      palette: { type: "choice", instructions: "Which palette suits the content's mood?", criteria: {
        ink: "neutral dark, technical", paper: "warm light, literary", cyan: "cool dark, business or data", amber: "warm dark, emphatic" } },
      scale: { type: "score", instructions: "How large should the type be, given how much text there is?", criteria: ["small: many lines", "medium", "large: a few lines", "huge: a few words"] },
      tone: { type: "score", instructions: "How emphatic should the entrance animation be?", criteria: ["none: static or informational", "gentle", "emphatic", "dramatic"] },
      animate: { type: "noul", instructions: "Does the content read in a sequence that motion would reveal (steps, a count, typing)?", criteria: { true: "yes, it has an intrinsic order", false: "no, it is one static thought" } },
      emphasis: { type: "choice", instructions: "Which single word carries the point and should be coloured?", criteria: wordCriteria },
    },
  };
  const t0 = performance.now();
  const r = await fetch("http://localhost:8787/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw: any = await r.json(); const j: any = raw.result ? { ms: raw.ms, ...raw.result } : raw;
  const ms = Math.round(performance.now() - t0);
  if (j.error || !j.answers) { console.log("ERR", r.status, JSON.stringify(j).slice(0, 600)); continue; }
  const a = j.answers;
  const pick = (q: any) => q.choice ?? q.score?.toFixed?.(2) ?? q.noul?.toFixed?.(2) ?? JSON.stringify(q);
  const emph = a.emphasis?.choice; const emphWord = emph && emph !== "none" ? words[Number(emph.slice(1))] : "-";
  console.log(`\n[${ms} ms client / ${j.ms} ms worker, model ${j.model}, in ${j.usage?.input_tokens} tok] ${JSON.stringify(text.slice(0, 40))}`);
  console.log(`  kind=${pick(a.kind)} (${(a.kind.probabilities?.[a.kind.choice] ?? 0).toFixed(2)})  layout=${pick(a.layout)}  palette=${pick(a.palette)}  scale=${pick(a.scale)}  tone=${pick(a.tone)}  animate=${pick(a.animate)}  emphasis=${emphWord}`);
}
