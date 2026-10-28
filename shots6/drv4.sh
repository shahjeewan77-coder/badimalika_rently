#!/bin/bash
B=agent-browser

echo "=== save driver edit (phone -> 9800088888) ==="
$B eval "(v=>{const el=document.querySelectorAll('input')[1];const s=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})('9800088888')" 2>&1 | head -2
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save changes/.test(x.textContent));if(b){b.click();return 'saved'}return 'no save'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({dialogOpen:/Edit QA Driver Zeta/.test(document.body.innerText),row:(()=>{const r=[...document.querySelectorAll('tbody tr')].find(x=>/QA Driver Zeta/.test(x.textContent));return r?r.innerText.replace(/\n/g,' | '):'missing'})()})" 2>&1 | head -3

echo ""
echo "=== DELETE REFUSAL: Ram Bahadur (locked to on_transit order) ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Remove Ram Bahadur from the roster');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({tail:document.body.innerText.slice(-500)})" 2>&1 | head -3
