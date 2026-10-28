#!/bin/bash
B=agent-browser
BASE=http://localhost:3000

echo "=== back to owner, open Audit Trail ==="
$B eval "fetch('/trpc/auth.logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.href='/login')" 2>&1 | head -2
sleep 4
$B eval "fetch('/trpc/auth.login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{email:'owner@sharma.com',password:'Rent@2026New'}})}).then(r=>r.text())" 2>&1 | head -2
sleep 2
$B open "$BASE/audit" >/dev/null 2>&1
sleep 4
$B eval "JSON.stringify({url:location.pathname,h1:document.querySelector('h1')?.textContent,qaEntries:(document.body.innerText.match(/QA Truck Alpha|QA Driver Zeta/g)||[]).length,tail:document.body.innerText.slice(0,900)})" 2>&1 | head -4
