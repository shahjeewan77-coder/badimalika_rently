#!/bin/bash
B=agent-browser

echo "=== CONFIRM REFUSAL on Truck 1 ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Remove from fleet/.test(x.textContent));if(!b)return 'no confirm btn';b.click();return 'confirmed'})()" 2>&1 | head -2
sleep 4
$B eval "JSON.stringify({err:document.body.innerText.match(/[^\n]*(active trip|cannot|Cannot|refus)[^\n]*/gi)?.slice(0,3),stillListed:/Truck 1\b/.test(document.body.innerText),dialogOpen:/Remove Truck 1 from the fleet/.test(document.body.innerText)})" 2>&1 | head -3

echo ""
echo "=== DELETE SUCCESS: QA Truck Alpha (nothing refers to it) ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Remove QA Truck Alpha');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({title:document.body.innerText.match(/Remove QA Truck Alpha[^\n]*/)?.[0],tail:document.body.innerText.slice(-300)})" 2>&1 | head -3
