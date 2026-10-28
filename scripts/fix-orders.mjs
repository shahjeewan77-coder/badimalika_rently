import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const show = async (label) => {
  const r = await client.query(
    "select id,status,driver_id,vehicle_id,locked_by_driver_id,dispatched_at from orders order by created_at",
  );
  console.log("\n=== " + label + " ===");
  console.log(JSON.stringify(r.rows, null, 2));
};

await show("BEFORE");

// 1) Himalaya Builders (fcb853d7...) — a genuine approved order that was left in
//    a half-locked state. Put it back to a clean, dispatchable approved order.
await client.query(
  `update orders set status='approved', locked_by_driver_id=null, dispatched_at=null where id='fcb853d7-90f0-4188-bb23-b7e39f78231d'`,
);

// 2) Everest Construction (aba7c46f...) — a DUPLICATE of the Himalaya order
//    (identical 20-pillar line and Rs 22,500 total) that was left straddling two
//    states: marked "returned" while carrying an unpaid sales invoice with no
//    matching stock movement ever recorded for its own line. Delete it; the
//    order_items + invoice + stock movements cascade away with it.
await client.query(`delete from orders where id='aba7c46f-5613-46ee-a0ed-42c6f8d5877d'`);

await show("AFTER");
console.log(
  "\nremaining invoices:",
  JSON.stringify((await client.query("select invoice_no,total,amount_due from invoices")).rows),
);
console.log(
  "equipment on_rent:",
  JSON.stringify(
    (await client.query("select name,total_qty,on_rent_qty from equipment where on_rent_qty>0")).rows,
  ),
);

await client.end();
