#!/bin/bash
B=agent-browser
BASE=http://localhost:3000

echo "=== 1. LOGIN AS OWNER ==="
$B open "$BASE/login" >/dev/null 2>&1
sleep 3
$B eval "fetch('/trpc/auth.login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{email:'owner@sharma.com',password:'Rent@2026New'}})}).then(r=>r.text())" 2>&1 | head -3
sleep 2
$B eval "fetch('/trpc/auth.me?batch=1&input=%7B%7D').then(r=>r.json()).then(d=>JSON.stringify(d))" 2>&1 | head -5

echo ""
echo "=== 2. OPEN VEHICLES PAGE ==="
$B open "$BASE/vehicles" >/dev/null 2>&1
sleep 4
$B eval "JSON.stringify({url:location.pathname,h1:document.querySelector('h1')?.textContent,hasVehicles:/Vehicles/.test(document.body.innerText),hasDrivers:/Drivers/.test(document.body.innerText),rows:document.querySelectorAll('tbody tr').length})" 2>&1 | head -5

echo ""
echo "=== 3. ADD VEHICLE ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Add vehicle/i.test(x.textContent));if(b){b.click();return 'clicked add'}return 'no add button: '+[...document.querySelectorAll('button')].map(x=>x.textContent.trim()).slice(0,12).join('|')})()" 2>&1 | head -3
sleep 2
$B eval "JSON.stringify({inputs:[...document.querySelectorAll('input')].map(i=>({id:i.id,ph:i.placeholder,val:i.value})),buttons:[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,15)})" 2>&1 | head -5
