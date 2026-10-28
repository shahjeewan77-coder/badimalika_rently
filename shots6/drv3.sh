#!/bin/bash
B=agent-browser

echo "=== EDIT DRIVER: change phone ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Edit QA Driver Zeta');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({title:[...document.querySelectorAll('h2,h3')].map(h=>h.textContent.trim()),inputs:[...document.querySelectorAll('input')].map(i=>i.value)})" 2>&1 | head -3
