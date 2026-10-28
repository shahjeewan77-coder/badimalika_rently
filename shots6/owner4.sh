#!/bin/bash
B=agent-browser

echo "=== DELETE REFUSAL: Truck 1 (1 order + 1 assignment) ==="
$B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Remove Truck 1');if(!b)return 'not found';b.click();return 'clicked'})()" 2>&1 | head -2
sleep 3
$B eval "JSON.stringify({title:document.body.innerText.match(/Remove Truck 1[^\n]*/)?.[0],counts:document.body.innerText.match(/\d+ order\(s\)|\d+ assignment\(s\)|\d+ audit entr\(ies\)/g),bodyTail:document.body.innerText.slice(-420)})" 2>&1 | head -4
