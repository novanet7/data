#!/bin/sh
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NODE_OPTIONS="--max-old-space-size=512"

cd /home/container

exec node index.js
