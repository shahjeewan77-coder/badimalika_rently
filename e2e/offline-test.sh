#!/usr/bin/env bash
# End-to-end offline test driver.
set -u
AB="bash /workspace/.skills/browser-automation/scripts/ab"
BASE="http://localhost:3000"

step() { echo; echo "──── $* ────"; }
js()   { $AB eval "$1" 2>&1 | tail -1; }

step "1. open + log in as owner"
$AB close --all >/dev/null 2>&1
$AB open "$BASE/login" >/dev/null 2>&1
sleep 3
$AB fill "#identifier" "owner@sharma.com" >/dev/null 2>&1
$AB fill "#password" "Rent@2026New" >/dev/null 2>&1
$AB click "button[type=submit]" >/dev/null 2>&1
sleep 5
echo "url: $($AB get url 2>&1 | tail -1)"
js "document.body.innerText.slice(0,220)"

step "2. confirm online state + pending count on the banner"
js "document.querySelector('body').innerText.split('\n').filter(l=>/Online|Offline|pending sync|Waiting/.test(l)).join(' | ')"

step "3. GO OFFLINE"
$AB set offline on 2>&1 | tail -1
sleep 2
js "navigator.onLine"

step "4. navigate to the new-order form while offline (SPA nav, no reload)"
$AB open "$BASE/orders/new" >/dev/null 2>&1
sleep 4
js "document.body.innerText.slice(0,200)"

step "5. leave the page and come back — a hard reload with no network"
$AB reload >/dev/null 2>&1
sleep 4
echo "url after offline reload: $($AB get url 2>&1 | tail -1)"
js "document.body.innerText.slice(0,200)"
