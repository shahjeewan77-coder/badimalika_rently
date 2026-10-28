#!/bin/bash
B=agent-browser

setval() {
  $B eval "(v=>{const el=document.querySelectorAll('input')[$1];const s=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})('$2')" 2>&1 | head -2
}

echo "=== fill driver: name / phone / licence ==="
setval 0 "QA Driver Zeta"
setval 1 "9800099999"
setval 2 "LIC-QA-999"
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Save');if(b){b.click();return 'saved'}return 'no save'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({dialogOpen:/Add driver/.test(document.body.innerText),hasNew:/QA Driver Zeta/.test(document.body.innerText),rows:document.querySelectorAll('tbody tr').length})" 2>&1 | head -3
