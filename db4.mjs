import pg from "pg";
import fs from "node:fs";
const env=fs.readFileSync("/workspace/app/.env","utf8");
const url=env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,"");
const c=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false}});
await c.connect();
const r=await c.query(`SELECT d.name, tl.latitude, tl.longitude, tl.recorded_at, o.status
FROM trip_locations tl JOIN drivers d ON d.id=tl.driver_id
JOIN orders o ON o.id=tl.order_id
WHERE d.name LIKE 'Bikash%' ORDER BY tl.recorded_at DESC LIMIT 5`);
console.log("LAST 5 MOVES:", JSON.stringify(r.rows,null,1));
const h=await c.query(`SELECT count(*)::int n, min(tl.latitude) mn, max(tl.latitude) mx FROM trip_locations tl
JOIN drivers d ON d.id=tl.driver_id WHERE d.name LIKE 'Bikash%'`);
console.log("ROUTE POINTS:", h.rows[0]);
await c.end();
