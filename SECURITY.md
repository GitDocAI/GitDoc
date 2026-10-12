# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. Include what you found, how to reproduce it and what it affects.

You will get an acknowledgement, and we will keep you informed until it is
fixed. We credit reporters who want it.

## What is in scope

The server and the admin panel in this repository: authentication of readers
(password, OpenID Connect, IAM), the publish API, the operator API, session
handling, and anything that exposes private documentation or secrets.

## Good to know when deploying

- The admin panel (port 8081) is meant for the machine or a private network
  only. Do not publish it to the internet.
- Set `TRUST_PROXY=true` only when the server is reachable exclusively through
  your proxy or CDN.
- Anything you send to an AI provider (`AI_URL`) leaves your server: for
  private documentation, use a provider you host.
