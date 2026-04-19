#!/bin/sh
nerdctl stop $(nerdctl ps -q) 2>/dev/null || true
