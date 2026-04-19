#!/bin/sh
# Firewall-Regeln setzen (one-shot, danach beendet sich der Container)
set -e

iptables -F
iptables -X
iptables -Z

iptables -P INPUT   DROP
iptables -P FORWARD ACCEPT
iptables -P OUTPUT  ACCEPT

iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p icmp -j ACCEPT

# Weitere Ports auskommentieren/ergänzen:
# iptables -A INPUT -p tcp --dport 2376 -j ACCEPT  # Docker TLS
# iptables -A INPUT -p tcp --dport 2377 -j ACCEPT  # Swarm

echo "Firewall rules applied."
