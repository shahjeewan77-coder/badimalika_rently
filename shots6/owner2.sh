#!/bin/bash
B=agent-browser
BASE=http://localhost:3000

setval() { # $1=index $2=value
  $B eval "(v=>{const el=document.querySelectorAll('input')[$1];const s=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})('$2')" 2>&1 | head -2
}

echo "=== ADD VEHICLE: fill + save ==="
setval 0 "QA Truck Alpha"
setval 1 "QA-ALPHA-001"
setval 2 "Tipper"
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Save');if(b){b.click();return 'saved'}return 'no save'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({dialogOpen:/Add vehicle|Edit vehicle/.test(document.body.innerText),hasNew:/QA Truck Alpha/.test(document.body.innerText),rows:document.querySelectorAll('tbody tr').length})" 2>&1 | head -3

echo ""
echo "=== EDIT VEHICLE: change type ==="
$B eval "(()=>{const rows=[...document.querySelectorAll('tbody tr')];const r=rows.find(x=>/QA Truck Alpha/.test(x.textContent));if(!r)return 'row not found';const b=[...r.querySelectorAll('button')].find(x=>/edit/i.test(x.getAttribute('aria-label')||x.title||''));if(b){b.click();return 'clicked edit'}return 'no edit btn: '+[...r.querySelectorAll('button')].map(x=>x.getAttribute('aria-label')||x.title||x.textContent.trim()).join('|')})()" 2>&1 | head -3
sleep 2
$B eval "JSON.stringify({inputs:[...document.querySelectorAll('input')].map(i=>i.value),title:document.body.innerText.match(/Edit vehicle|Add vehicle/)?.[0]})" 2>&1 | head -3
