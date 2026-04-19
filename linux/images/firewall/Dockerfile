FROM alpine:3.19
RUN apk add --no-cache iptables ip6tables
COPY rules.sh /firewall/rules.sh
RUN chmod +x /firewall/rules.sh
