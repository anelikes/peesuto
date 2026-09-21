// Local-only proxy: POST {state, questions} → Workers AI typesafe/jev.
// Runs under `wrangler dev`; the AI binding is served remotely with wrangler's own login.
export default {
  async fetch(req: Request, env: { AI: { run: (model: string, input: unknown) => Promise<unknown> } }) {
    if (req.method !== "POST") return new Response("POST {state, questions}", { status: 405 });
    const input = await req.json();
    const t0 = Date.now();
    try {
      const out = await env.AI.run("typesafe/jev", input);
      return Response.json({ ms: Date.now() - t0, ...(out as object) });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  },
};
