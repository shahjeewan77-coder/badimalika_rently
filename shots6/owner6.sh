#!/bin/bash
B=agent-browser

echo "=== close any open dialog ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Cancel');if(b){b.click();return 'cancelled'}return 'no dialog'})()" 2>&1 | head -2
sleep 2

echo "=== reopen Remove QA Truck Alpha (should show NO stale error) ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Remove QA Truck Alpha');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({tail:document.body.innerText.slice(-400)})" 2>&1 | head -3
