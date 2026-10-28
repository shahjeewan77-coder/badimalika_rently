#!/bin/bash
B=agent-browser

echo "=== cancel, then delete QA Driver Zeta (nothing refers to them) ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Cancel');if(b){b.click();return 'cancelled'}return 'none'})()" 2>&1 | head -2
sleep 2
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Remove QA Driver Zeta from the roster');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({tail:document.body.innerText.slice(-330)})" 2>&1 | head -3
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Delete permanently/.test(x.textContent));if(!b)return 'no confirm';b.click();return 'confirmed'})()" 2>&1 | head -2
sleep 4
$B eval "JSON.stringify({stillListed:/QA Driver Zeta/.test(document.body.innerText),rows:document.querySelectorAll('tbody tr').length})" 2>&1 | head -3
