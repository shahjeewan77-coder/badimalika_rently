#!/bin/bash
B=agent-browser

echo "=== ADD DRIVER ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Add driver/i.test(x.textContent));if(!b)return 'no btn';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 2
$B eval "JSON.stringify({inputs:[...document.querySelectorAll('input')].map(i=>({ph:i.placeholder,val:i.value})),title:[...document.querySelectorAll('h2,h3')].map(h=>h.textContent.trim())})" 2>&1 | head -3
