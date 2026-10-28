#!/bin/bash
B=agent-browser
BASE=http://localhost:3000

echo "=== LOGOUT then LOGIN AS DRIVER ==="
$B eval "fetch('/trpc/auth.logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.href='/login')" 2>&1 | head -2
sleep 4
$B eval "fetch('/trpc/auth.login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{email:'ram@sharma.com',password:'Rent@2026'}})}).then(r=>r.text())" 2>&1 | head -3
sleep 2
$B eval "fetch('/trpc/auth.me?batch=1&input=%7B%7D').then(r=>r.json()).then(d=>JSON.stringify(d))" 2>&1 | head -3

echo ""
echo "=== DRIVER: open /vehicles (should redirect away) ==="
$B open "$BASE/vehicles" >/dev/null 2>&1
sleep 4
$B eval "JSON.stringify({url:location.pathname,h1:document.querySelector('h1')?.textContent,hasAddVehicle:/Add vehicle/.test(document.body.innerText),hasAddDriver:/Add driver/.test(document.body.innerText),hasEdit:/Edit /.test(document.body.innerText),hasRemove:/Remove /.test(document.body.innerText),nav:[...document.querySelectorAll('aside a,nav a')].map(a=>a.textContent.trim()).filter(Boolean)})" 2>&1 | head -4
