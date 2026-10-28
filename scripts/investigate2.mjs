import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (label, sql) => {
  const r = await client.query(sql);
  console.log("\n=== " + label + " ===");
  console.log(JSON.stringify(r.rows, null, 2));
};

await q("db identity", `select current_database(), current_user, inet_server_addr()::text, version()`);
await q("ALL order rows (raw)", `select id, status, driver_id, vehicle_id, locked_by_driver_id, order_date_ad, approved_at, dispatched_at, created_at from orders order by created_at`);
await q("order_items", `select oi.id, oi.order_id, e.name as equip, oi.basis, oi.rate, oi.actual_qty, oi.billed_qty, oi.units, oi.line_amount, oi.created_at from order_items oi join equipment e on e.id=oi.equipment_id order by oi.created_at`);
await q("stock movements", `select sm.id, e.name as equip, sm.order_id, sm.type, sm.qty, sm.date_ad from stock_movements sm join equipment e on e.id=sm.equipment_id order by sm.created_at`);
await q("assignments", `select va.id, d.name as driver, v.name as vehicle, va.date_ad, va.date_bs from vehicle_assignments va join drivers d on d.id=va.driver_id join vehicles v on v.id=va.vehicle_id order by va.date_ad`);
await q("duplicate drivers by phone", `select phone, count(*), array_agg(id) from drivers group by phone having count(*) > 1`);
await q("any on_transit anywhere", `select id,status from orders where status='on_transit'`);

await client.end();
