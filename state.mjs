import pg from "pg";
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
const e = await c.query(`select on_rent_qty from equipment where id='05114120-8a14-4cc5-bf4e-276a602fe46f'`);
const r = await c.query(`select count(*)::int n from stock_movements where reversal_of_id is not null`);
const a = await c.query(`select count(*)::int n from audit_log where summary like 'Undid%'`);
console.log(JSON.stringify({on_rent_after_double_undo:e.rows[0].on_rent_qty, reversal_rows:r.rows[0].n, undo_audit_entries:a.rows[0].n}));
await c.end();
