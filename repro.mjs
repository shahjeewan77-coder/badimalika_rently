// Reproduce: order created by driver A, locked+dispatched by driver B, then
// does driver B's ping appear on the owner's live map?
const BASE = "http://127.0.0.1:3001";

const jars = {};
function jarFor(who) {
  if (!jars[who]) jars[who] = {};
  return jars[who];
}

async function call(who, path, input) {
  const jar = jarFor(who);
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}/trpc/${path}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ "0": { json: input ?? null } }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const item = Array.isArray(body) ? body[0] : body;
  if (item?.error) {
    return { __error: item.error?.json?.data?.code ?? item.error?.data?.code, message: item.error?.json?.data?.message ?? item.error?.message ?? JSON.stringify(item.error) };
  }
  return item?.result?.data?.json ?? item?.result?.data ?? null;
}

function log(label, value) {
  console.log(`\n### ${label}`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

(async () => {
  log("login owner", await call("owner", "auth.login", { email: "owner@sharma.com", password: "Rent@2026New" }));

  const me = await call("owner", "auth.me");
  log("owner me", me);

  const drivers = await call("owner", "drivers.list");
  log("drivers.list", drivers);

  const vehicles = await call("owner", "vehicles.list");
  log("vehicles.list", vehicles);

  const customers = await call("owner", "customers.list");
  log("customers.list", customers);

  const equipment = await call("owner", "equipment.list");
  log("equipment.list", equipment);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
