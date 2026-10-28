#!/bin/bash
B=agent-browser

echo "=== CONFIRM delete QA Truck Alpha ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Remove from fleet/.test(x.textContent));if(!b)return 'no confirm';b.click();return 'confirmed'})()" 2>&1 | head -2
sleep 4
$B eval "JSON.stringify({dialogOpen:/Remove QA Truck Alpha from the fleet/.test(document.body.innerText),stillListed:/QA Truck Alpha/.test(document.body.innerText),rows:document.querySelectorAll('tbody tr').length,msg:document.body.innerText.match(/[^\n]*(retired|Removed|deleted|Deleted)[^\n]*/gi)?.slice(0,3)})" 2>&1 | head -3
