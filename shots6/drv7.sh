#!/bin/bash
B=agent-browser

echo "=== cancel current dialog ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Cancel');if(b){b.click();return 'cancelled'}return 'none'})()" 2>&1 | head -2
sleep 2

echo "=== find the Ram Bahadur row that has history (locked driver) ==="
$B eval "JSON.stringify([...document.querySelectorAll('tbody tr')].filter(r=>/Ram Bahadur/.test(r.textContent)).map(r=>({text:r.innerText.replace(/\n/g,' | '),del:[...r.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(Boolean)})))" 2>&1 | head -4
