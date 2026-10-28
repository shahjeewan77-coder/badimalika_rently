#!/bin/bash
B=agent-browser

echo "=== click Remove on the LINKED Ram Bahadur (locked to on_transit) ==="
$B eval "(()=>{const rows=[...document.querySelectorAll('tbody tr')].filter(r=>/Ram Bahadur/.test(r.textContent));const linked=rows.find(r=>/Linked/.test(r.textContent));if(!linked)return 'no linked row';const b=[...linked.querySelectorAll('button')].find(x=>/Remove/.test(x.getAttribute('aria-label')||''));if(!b)return 'no remove btn';b.click();return 'clicked linked row'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({tail:document.body.innerText.slice(-620)})" 2>&1 | head -3
