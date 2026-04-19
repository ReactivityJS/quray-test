FROM alpine:3.19
RUN apk add --no-cache openssh
COPY sshd_config /etc/ssh/sshd_config
RUN mkdir -p /var/empty /run/sshd
