# scripts/deploy/

Bootstrap and one-shot scripts for setting up the mappy-hour deployment
infrastructure (Tailscale ACL, mitch host, GitHub Actions secrets).

## `mitch-bootstrap.ps1`

End-to-end bootstrap for a fresh Windows 10/11 host into a working
mappy-hour deployment target. Re-runnable (idempotent), survives the
mid-bootstrap reboot via a state file.

### Pre-requisites on the target host

- Windows 10 22H2+ or Windows 11
- An admin Windows user (e.g. `devops`) — used to **run** the script
- A second user (e.g. `kiosque`) configured for auto-login — Docker
  runs in this user's WSL2 session so it persists across SSH
  disconnects. Auto-login can be configured later, but the user must
  exist before the script starts. See §3 of `docs/deploy.md` for the
  reasoning.
- Internet access (the script downloads WSL kernel, Ubuntu, Git, gh CLI)

### What the operator does on a machine with a browser (one-time)

1. Create a Tailscale **OAuth client** at
   <https://login.tailscale.com/admin/settings/oauth> with:
   - Scopes: **Devices > Core (Write)** AND **Auth Keys (Write)** — both required
   - Tags: `tag:ci`
   Save the client ID and secret.

2. (Optional, for automation of step 12 in the script) Create a Tailscale
   **API access token** at <https://login.tailscale.com/admin/settings/keys>.
   Revoke immediately after the script completes.

3. (Optional, for automation of step 13) Create a GitHub **Personal
   Access Token** with `repo` scope. Revoke after the script completes.

### Standalone download (no repo on the target yet)

```powershell
iwr https://raw.githubusercontent.com/salfab/mappy-hour/master/scripts/deploy/mitch-bootstrap.ps1 -OutFile bootstrap.ps1
.\bootstrap.ps1 `
  -TailscaleOAuthClientId   <client-id> `
  -TailscaleOAuthSecret     <client-secret> `
  -TailscaleApiToken        <api-token>      `# optional
  -GitHubPat                <ghp-...>        `# optional
  -SshPublicKey             "ssh-ed25519 AAAA... github-actions-deploy"
```

Any parameter you omit will be prompted interactively. Re-run after the
mid-bootstrap reboot with the same args — state is in
`C:\ProgramData\MappyHour\bootstrap-state.json`.

### Phases (idempotent, skipped when already done)

1. **WSL2 + VirtualMachinePlatform features** (reboot triggered here)
2. **Git + repo clone** to `C:\srv\mappy-hour`
3. **WSL kernel update + Ubuntu install** (web-download, avoids the Microsoft Store)
4. **`/etc/wsl.conf`** with `systemd=true` + root default user
5. **Docker Engine** installed in WSL via `install-docker.sh`
6. **`C:\Users\$KiosqueUser\.wslconfig`** with `vmIdleTimeout=-1`
7. **`Mappy-WSL-Keepalive`** scheduled task (kiosque @ logon, `wsl ... sleep infinity`)
8. **`sshd_config`** — adds `$KiosqueUser` to `AllowUsers`, backup + `sshd -t` validation
9. **CI deploy SSH key** appended to `administrators_authorized_keys`
10. **`.env`** with `MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight`
11. **Atlas data directory** created (empty — seed separately)
12. **Tailscale ACL** patched via API (`scripts/deploy/setup-tailscale-ci-acl.sh`)
13. **GitHub Actions secrets** pushed via `gh secret set`
14. **Smoke test** — `docker compose pull && up -d` + `curl 127.0.0.1:3000/api/datasets`

### Still manual after the script

- `tailscale up` on mitch (interactive on first run)
- `tailscale serve --bg --https=443 http://localhost:3000` + `tailscale funnel 443 on`
- Seed the atlas data into `C:\mappy-data\cache\sunlight`
- Configure auto-login for `kiosque` (Windows Settings or
  [Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon))
- `MITCH_SSH_KEY` GHA secret — must be set with the **private** half of
  the CI deploy key, easiest via the GitHub web UI

## `setup-tailscale-ci-acl.sh`

Idempotent shell script that patches a Tailscale ACL via the Admin API
to add `tag:ci` under `tagOwners`. Used in phase 12 of the bootstrap,
also runnable standalone if you already have a working host and just
need to update the ACL.

```bash
TS_API_TOKEN=tskey-api-... ./setup-tailscale-ci-acl.sh [tailnet]
```
