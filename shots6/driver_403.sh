#!/bin/bash
B=agent-browser

echo "=== DRIVER calls the write procedures directly (expect 403) ==="
$B eval "fetch('/trpc/vehicles.create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{name:'Hack',number:'HACK-1'}})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}))" 2>&1 | head -3
$B eval "fetch('/trpc/vehicles.update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{id:'00000000-0000-0000-0000-000000000000',name:'Hack'}})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}))" 2>&1 | head -3
$B eval "fetch('/trpc/vehicles.remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{id:'00000000-0000-0000-0000-000000000000'}})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}))" 2>&1 | head -3
$B eval "fetch('/trpc/drivers.create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{name:'Hack'}})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}))" 2>&1 | head -3
$B eval "fetch('/trpc/drivers.update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{id:'00000000-0000-0000-0000-000000000000',name:'Hack'}})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}))" 2>&1 | head -3
$B eval "fetch('/trpc/drivers.remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{id:'00000000-0000-0000-0000-000000000000'}})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}))" 2>&1 | head -3
