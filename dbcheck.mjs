import pg from "pg";
import fs from "node:fs";
const env=fs.readFileSync("/workspace/app/.env","utf8");
const raw=env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,"");
const url=raw;
const c=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false}});
await c.connect();
const r=await c.query(`SELECT tl.id, d.name AS driver, tl.latitude, tl.longitude, tl.recorded_at, o.status
FROM trip_locations tl LEFT JOIN drivers d ON d.id=tl.driver_id
LEFT JOIN orders o ON o.id=tl.order_id ORDER BY tl.recorded_at DESC LIMIT 6`);
console.log(JSON.stringify(r.rows,null,1));
await c.end();
