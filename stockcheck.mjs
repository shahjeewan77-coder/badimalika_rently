import pg from "pg";
import fs from "node:fs";
const env = fs.readFileSync("/workspace/app/.env", "utf8");
const raw = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: raw, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log("=== equipment ===");
const eq = await c.query(`SELECT id, name, total_qty, on_rent_qty FROM equipment ORDER BY name`);
console.table(eq.rows.map(r => ({ name: r.name, total: Number(r.total_qty), onRent: Number(r.on_rent_qty), avail: Number(r.total_qty) - Number(r.on_rent_qty) })));

console.log("\n=== movements per equipment ===");
const mv = await c.query(`
  SELECT e.name, sm.type, COALESCE(SUM(sm.qty),0) AS qty, COUNT(*) AS n
  FROM stock_movements sm JOIN equipment e ON e.id = sm.equipment_id
  GROUP BY e.name, sm.type ORDER BY e.name, sm.type`);
console.table(mv.rows.map(r => ({ name: r.name, type: r.type, qty: Number(r.qty), n: Number(r.n) })));

console.log("\n=== movement rows (detail) ===");
const rows = await c.query(`
  SELECT sm.id, e.name AS equipment, sm.type, sm.qty, sm.date_ad, sm.date_bs,
         sm.order_id, o.status, o.created_at, o.dispatched_at,
         sm.created_at
  FROM stock_movements sm
  JOIN equipment e ON e.id = sm.equipment_id
  LEFT JOIN orders o ON o.id = sm.order_id
  ORDER BY sm.created_at ASC`);
console.table(rows.rows.map(r => ({
  equipment: r.equipment, type: r.type, qty: Number(r.qty),
  dateAd: r.date_ad, orderStatus: r.status,
  createdAt: r.created_at?.toISOString?.().slice(0,19),
})));

console.log("\n=== orders ===");
const ord = await c.query(`
  SELECT o.id, c.name AS customer, o.status, o.order_date_ad, o.created_at, o.dispatched_at,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) AS items
  FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`);
console.table(ord.rows.map(r => ({ customer: r.customer, status: r.status, date: r.order_date_ad, items: Number(r.items) })));

await c.end();
