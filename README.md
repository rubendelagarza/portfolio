# Ruben de la Garza — Interactive Portfolio

An interactive portfolio for a Senior Technical Consultant. Instead of describing skills, it lets visitors **do the work**: sixteen hands-on labs with simulated terminals, admin consoles, a ticketing tool and a browser.

**Live site:** _add your GitHub Pages URL here after the first deploy_

## Hands-on labs

Each lab drops the visitor into a broken or empty environment with 4–8 objectives. The objectives tick off automatically when the simulated environment reaches the right *state*, so any valid approach passes.

### Microsoft & Identity

| Lab | Title | Interface | Skills |
|---|---|---|---|
| 01 | Harden a new client's Microsoft 365 tenant | PowerShell (EXO + Teams) | Teams meeting/guest/federation policy, transport rules, shared mailboxes, permissions, archiving |
| 02 | Onboard a SaaS app with SAML SSO and MFA | Mock identity admin console | SAML metadata, claims, AADSTS errors, app assignment, Conditional Access (report-only → on), break-glass |
| 03 | Active Directory onboarding, offboarding and cleanup | PowerShell (ActiveDirectory module) | Naming standards and collisions, group copying, lockout vs reset, leaver process, stale accounts, nested privileged groups |

### ITSM & Support

| Lab | Title | Interface | Skills |
|---|---|---|---|
| 04 | ITSM ticket simulator (modeled on ServiceNow) | Incident form, strictly guided, Easy (pickers, "Why?" links, templates, free hints) or Standard (free text) | Impact × urgency, short descriptions, work notes vs customer comments, escalation handoffs, resolution notes, KB/problem/change links |
| 05 | Fix a remote user's VPN access | Windows command prompt | ipconfig, nslookup vs ping, DNS cache, route masks, persistent routes, netsh |

### Cloud: Google Cloud & Azure

| Lab | Title | Interface | Skills |
|---|---|---|---|
| 06 | Repair a broken VPC peering | gcloud | Two-sided peering, firewall priority and evaluation order, Connectivity Tests, least privilege |
| 07 | Migrate a zone to Cloud DNS and enable DNSSEC | gcloud · dig · registrar panel | Zone-file errors, CAA, pre-cutover verification, delegation, DS/KSK chain of trust |
| 08 | Connect on-prem with HA VPN and BGP | gcloud · topology · on-prem view | HA VPN 99.99% design, IKEv2/PSK, Cloud Router ASN, link-local /30s, custom advertisements, MED, failover |
| 09 | Global load balancer, Cloud CDN and Cloud NAT | gcloud | Health checks, GFE probe ranges, backend services, URL maps, managed certs, CDN cache modes, NAT port sizing |
| 10 | Azure VNet, NSG and a Linux VM | Azure CLI | Azure Policy (locations, tags), VNets/subnets, NSG priority and default rules, subnet vs NIC NSG, SSH keys, IP flow verify |

### Infrastructure & Web

| Lab | Title | Interface | Skills |
|---|---|---|---|
| 11 | Set up DNS for email | DNS dashboard · M365 admin · mail tester | MX, single SPF record, DKIM (M365 + third-party sender), DMARC rollout, autodiscover, TLS-RPT |
| 12 | Migrate Outlook accounts to Microsoft 365 | PowerShell (EXO) · M365 admin center · user's PC (Mail profiles, AutoConfiguration, registry, Outlook) | Licensing + usage location, IMAP migration endpoint and batch, CSV errors, retrying failed users, completing after the MX cutover, Autodiscover overrides, PST to online archive, shared mailbox auto-mapping |
| 13 | Deploy a web app on a Linux server (Part 1/3) | bash on Ubuntu · browser | apt, ufw without lockout, systemd unit + system user, nginx reverse proxy, port conflicts |
| 14 | HTTPS with a Cloudflare origin certificate (Part 2/3) | bash · Cloudflare dashboard · browser | Proxied DNS, SSL modes, Origin CA cert + key permissions, redirect loops, 52x errors, origin lockdown |
| 15 | SQLite and Sign in with Google (Part 3/3) | bash · Google Cloud console · browser | sqlite3, file/dir ownership, OAuth consent screen + client, redirect URIs, root-only env file, Python script fix, `.backup` |

### AI & Automation

| Lab | Title | Interface | Skills |
|---|---|---|---|
| 16 | Local LLM + Telegram renewal bot | bash on Ubuntu · Telegram (BotFather + bot chat) | Ollama install and sizing, Qwen3.5 4B, keeping the model API private, PEP 668 and venvs, service user and secrets, Telegram Bot API (getUpdates), debugging LLM glue code, systemd, scheduler time zones |

**Lab features**

- **Randomized environments:** each lab has 3 variants (different fault, tenant or config), so a repeat visit isn't a copy-paste.
- **Realistic errors:** commands validate parameters and fail the way the real tools do (PowerShell, gcloud, az, bash, nginx, sqlite3, OAuth, Cloudflare).
- **Hint ladder:** three hints per objective (nudge → concept → near-answer), each costing points.
- **Check my work:** state-based feedback on every open objective.
- **Watch solution:** an autoplay walkthrough with narration, for visitors who don't have 10 minutes.
- **Debrief:** on completion, explains why each step matters.
- **Progress:** completion and best score are saved in the visitor's browser and shown on the landing page.
- **Mobile:** a tappable command palette under every terminal.

## Repository structure

```
.
├── index.html               Landing page (four tracks, progress badges)
├── about.html               CV, with links from each role to the matching labs
├── contact.html             Contact details
├── assets/
│   ├── style.css            Shared design system
│   ├── lab.css              Lab styles (terminal, objectives, consoles, editor, browser)
│   ├── lab.js               Lab engine: terminal + parser, objectives, hints, scoring, autoplay
│   ├── gcp-common.js        Google Cloud helpers (firewall rules + evaluation)
│   └── linux-sim.js         Linux server simulation (filesystem, users, systemd, ufw, nginx, sqlite3, editor, browser)
└── apps/
    ├── m365-hardening-lab/  01      ├── gcp-diagnostics/     06      ├── email-dns-lab/          11
    ├── sso-mfa-lab/         02      ├── cloud-dns-lab/       07      ├── outlook-migration-lab/  12
    ├── ad-lab/              03      ├── hybrid-vpn-lab/      08      ├── linux-web-lab/          13
    ├── itsm-ticket-lab/     04      ├── gcp-lb-cdn-lab/      09      ├── cloudflare-ssl-lab/     14
    └── vpn-troubleshooter/  05      └── azure-vnet-lab/      10      ├── sqlite-oauth-lab/       15
                                                                     └── local-llm-bot-lab/      16
```

No build step, no backend, no npm, and no external dependencies: every page works offline from the files in this repo.

## How the lab engine works

`assets/lab.js` exposes `Lab({...})`. A lab supplies:

- `createState(variant)`: the starting environment for one of N randomized variants
- `commands(lab)`: a registry of simulated commands with typed parameters (`string`, `int`, `bool`, `enum`, `enumlist`, `list`, `multi`, `switch`, `secure`); the engine handles parsing, PowerShell vs GNU flag styles, PowerShell pipelines and variables, `;` chaining, help, tab completion and realistic error messages per tool
- `objectives`: `check(state)` functions returning `true` or a feedback message, plus three hints each (`optional: true` for bonus objectives; `sequential: true` for guided labs)
- `solution(state)`: the steps the **Watch solution** autoplay types or clicks, with narration
- `debrief`: the "why it matters" notes shown on completion
- optional `render(state)` / `onReset(state)` to drive a mock console, and `terminal: null` for GUI-only labs

`assets/linux-sim.js` (`LinuxSim`) adds a shared Ubuntu server model for Labs 13–16: a virtual filesystem with owners and modes, `sudo`, `apt`, `systemctl`/`journalctl` (custom units, `daemon-reload`, `EnvironmentFile`), `ufw` (with lockout detection), `ss`, `curl`, an `nginx` config parser with real `nginx -t` errors, a small `sqlite3` SQL engine, a `nano` editor panel and a browser panel.

The checker runs in the browser, so a determined visitor could read the answers in the page source. That's fine for a portfolio, since this isn't a certification.

## Running locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying to GitHub Pages

1. Create a public repo named `rubendelagarza.github.io` (or any name).
2. Push these files to `main`.
3. In the repo, go to **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
4. After about a minute the site is live at `https://rubendelagarza.github.io/` (or `https://rubendelagarza.github.io/<repo>/`).

## Notes

- All data is fabricated: tenants, users, IPs, keys, certificates, secrets and vendors are fictional. Admin consoles (ServiceNow-, Cloudflare-, Google Cloud- and Azure-style) are simplified simulations in the portfolio's own design, not copies of vendor UIs.
- Place `CV_Ruben.pdf` in `/assets/` so the "Download CV" link on the contact page works.

## Contact

- Email: ruben_delag@hotmail.com
- LinkedIn: <https://www.linkedin.com/in/rubendelagarza>
