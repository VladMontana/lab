# Custom SSL Certificates Directory (Optional)
If you are using custom certificates (e.g. Cloudflare Origin CA) instead of Caddy's automatic Let's Encrypt,
place your `cert.pem` and `key.pem` in this directory and reference them in Caddyfile:
`tls /etc/caddy/certs/cert.pem /etc/caddy/certs/key.pem`
