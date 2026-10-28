import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (label, sql) => {
  const r = await client.query(sql);
  console.log("\n=== " + label + " ===");
  console.log(JSON.stringify(r.rows, null, 2));
};

await q("orders by status", `select status, count(*) from orders group by status order by 1`);

await q(
  "ALL ORDERS",
  `select o.id, o.status, o.customer_id, o.driver_id, o.vehicle_id, o.locked_by_driver_id,
          o.order_date_ad, o.approved_at, o.dispatched_at,
          (select count(*) from order_items oi where oi.order_id = o.id) as items
   from orders o order by o.created_at`
);

await q("drivers", `select id, name, phone, user_id from drivers order by name`);
await q("vehicles", `select id, name, number from vehicles order by name`);
await q("customers", `select id, name from customers order by name`);
await q("equipment", `select id, name, total_qty, on_rent_qty from equipment order by name`);
await q("invoices", `select id, order_id, invoice_no, total, amount_due from invoices`);
await q("profiles", `select user_id, owner_id, role, display_name, username, phone from profiles`);
await q("users", `select id, email, name, role from users`);

await client.end();
