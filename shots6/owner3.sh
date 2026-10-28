#!/bin/bash
B=agent-browser

echo "=== EDIT: change type to Crane, save ==="
$B eval "(v=>{const el=document.querySelectorAll('input')[2];const s=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})('Crane')" 2>&1 | head -2
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save changes/.test(x.textContent));if(b){b.click();return 'saved'}return 'no save btn'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({dialogStillOpen:/Edit QA Truck Alpha/.test(document.body.innerText),rowText:(()=>{const r=[...document.querySelectorAll('tbody tr')].find(x=>/QA Truck Alpha/.test(x.textContent));return r?r.innerText.replace(/\n/g,' | '):'row missing'})()})" 2>&1 | head -3

echo ""
echo "=== DELETE REFUSAL: Truck 1 (has 1 order + 1 assignment) ==="
$B eval "(()=>{const r=[...document.querySelectorAll('tbody tr')].find(x=>/Truck 1\b/.test(x.textContent)&&/BA 1 KHA 1234/.test(x.textContent));if(!r)return 'row not found';const b=[...r.querySelectorAll('button')].find(x=>/delete|remove/i.test(x.getAttribute('aria-label')||x.title||''));if(b){b.click();return 'clicked delete'}return 'no delete btn: '+[...r.querySelectorAll('button')].map(x=>x.getAttribute('aria-label')||x.title||x.textContent.trim()).join('|')})()" 2>&1 | head -3
sleep 3
$B eval "JSON.stringify({dialog:document.body.innerText.match(/Remove[^\n]*|Delete[^\n]*/g)?.slice(0,4),counts:document.body.innerText.match(/\d+ order\(s\)|\d+ assignment\(s\)|\d+ audit entr\(ies\)/g)})" 2>&1 | head -3
