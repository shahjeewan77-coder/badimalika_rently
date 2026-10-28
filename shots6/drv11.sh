#!/bin/bash
B=agent-browser

echo "=== confirm Remove from roster ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Remove from roster/.test(x.textContent));if(!b)return 'no confirm';b.click();return 'confirmed'})()" 2>&1 | head -2
sleep 4
$B eval "JSON.stringify({dialogOpen:/Remove QA Driver Zeta/.test(document.body.innerText),row:(()=>{const r=[...document.querySelectorAll('tbody tr')].find(x=>/QA Driver Zeta/.test(x.textContent));return r?r.innerText.replace(/\n/g,' | '):'GONE'})()})" 2>&1 | head -3
