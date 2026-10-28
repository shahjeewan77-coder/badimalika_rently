#!/bin/bash
B=agent-browser

echo "=== DELETE REFUSAL: Ram Bahadur (locked to on_transit order) ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Remove Ram Bahadur from the roster');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({tail:document.body.innerText.slice(-560)})" 2>&1 | head -3
