// Upload throughput benchmark against the preview environment, driving the real HTTP endpoints
// the way web/lib/uploads.tsx does (through the Next.js proxy by default).
//
//   npx tsx test/preview/upload-bench.ts --mb=200 --part-mib=5 --in-flight=1
//
// For numbers that resemble production, run the preview backend against a database with real
// network latency (production talks to a remote Supabase pooler), e.g. via Toxiproxy:
//   docker run -d --name dbase-bench-toxiproxy --network dbase_default -p 8474:8474 -p 54400:54400 \
//     ghcr.io/shopify/toxiproxy:2.9.0
//   (create proxy pg → test-db:5432 on :54400 with a 25 ms latency toxic each way)
//   PREVIEW_DATABASE_URL=postgres://dbase_test:dbase_test@localhost:54400/dbase_preview npm run preview:backend

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k!, v ?? "true"] as const;
  }),
);
const BASE = args.get("base") ?? "http://localhost:3110/api/v1";
const SIZE_MB = Number(args.get("mb") ?? 200);
const PART = Number(args.get("part-mib") ?? 5) * 1024 * 1024;
const IN_FLIGHT = Number(args.get("in-flight") ?? 1);
const RUNS = Number(args.get("runs") ?? 2);

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "preview-user@dbase.test", password: "preview-password" }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

async function json(res: Response) {
  if (!res.ok) throw new Error(`${res.url} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function uploadOnce(cookie: string, data: Buffer, name: string): Promise<{ ms: number; fileId: string }> {
  const totalParts = Math.max(1, Math.ceil(data.length / PART));
  const t0 = performance.now();
  const { uploadSessionId } = await json(
    await fetch(`${BASE}/files`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ targetName: name, totalParts }),
    }),
  );
  let next = 0;
  async function worker() {
    while (next < totalParts) {
      const n = next++;
      await json(
        await fetch(`${BASE}/files/upload-sessions/${uploadSessionId}/parts/${n}`, {
          method: "PUT",
          headers: { cookie, "Content-Type": "application/octet-stream" },
          body: data.subarray(n * PART, (n + 1) * PART),
        }),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, totalParts) }, worker));
  const { file } = await json(
    await fetch(`${BASE}/files/upload-sessions/${uploadSessionId}/complete`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mimeType: "application/octet-stream" }),
    }),
  );
  return { ms: performance.now() - t0, fileId: file.id };
}

const cookie = await login();
const data = Buffer.alloc(SIZE_MB * 1024 * 1024);
for (let i = 0; i < data.length; i += 4093) data[i] = i % 251;

const times: number[] = [];
for (let r = 0; r < RUNS; r++) {
  const { ms, fileId } = await uploadOnce(cookie, data, `bench-${Date.now()}-${r}.bin`);
  times.push(ms);
  // Clean up so repeated runs don't fill the quota: trash, then purge.
  await json(await fetch(`${BASE}/files/${fileId}`, { method: "DELETE", headers: { cookie } }));
  await json(await fetch(`${BASE}/trash/file/${fileId}`, { method: "DELETE", headers: { cookie } }));
}
const best = Math.min(...times);
console.log(
  JSON.stringify({
    sizeMB: SIZE_MB,
    partMiB: PART / 1024 / 1024,
    inFlight: IN_FLIGHT,
    runsMs: times.map((t) => Math.round(t)),
    bestMBps: Number((SIZE_MB / (best / 1000)).toFixed(1)),
  }),
);
