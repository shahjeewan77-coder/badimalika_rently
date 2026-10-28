#!/bin/bash
set -x
B=agent-browser
$B open http://localhost:3000/login > /tmp/o1.txt 2>&1
sleep 3
$B snapshot -i -c > /tmp/snap_login.txt 2>&1
cat /tmp/snap_login.txt
