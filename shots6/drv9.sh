#!/bin/bash
B=agent-browser

echo "=== CONFIRM refusal on locked driver ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Remove from roster/.test(x.textContent));if(!b)return 'no confirm';b.click();return 'confirmed'})()" 2>&1 | head -2
sleep 4
$B eval "JSON.stringify({err:document.body.innerText.match(/[^\n]*(locked an order|active trip|Only the driver)[^\n]*/gi)?.slice(0,3),stillListed:[...document.querySelectorAll('tbody tr')].filter(r=>/Ram Bahadur/.test(r.textContent)).length})" 2>&1 | head -3
