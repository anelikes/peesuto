# Releasing

A release is a tag `vX.Y.Z` on `main`. `.github/workflows/release.yml` builds
the macOS (Apple silicon) DMG from it and opens a draft GitHub Release; you
check the draft and publish it. Nothing is published automatically.

## Cutting a release

1. `main` is green in CI, and `engine.json` points at the engine you want to
   ship: the release bundles the engine subset, so the pin is part of it.
2. Bump the version in the four places that carry one, to the same value:
   - `package.json` — `version`
   - `app/package.json` — `version`
   - `app/src-tauri/tauri.conf.json` — `version` (this one names the DMG)
   - `app/src-tauri/Cargo.toml` — `version`; then run any cargo command that
     resolves (`cargo check` in `app/src-tauri`) so `Cargo.lock` records it,
     and commit the lockfile too.
3. In `CHANGELOG.md`, rename `Unreleased` to `vX.Y.Z — YYYY-MM-DD` and open a
   new empty `Unreleased` above it.
4. Commit: `chore(release): vX.Y.Z`.
5. Tag and push both:

   ```bash
   git tag -a vX.Y.Z -m "Pocket Paste vX.Y.Z"
   git push origin main vX.Y.Z
   ```

6. Watch *Actions → release*. The Rust build takes a while the first time;
   later runs reuse the cargo cache. A run that fails at the `engine token
   present` step means the `ENGINE_TOKEN` secret is missing (below).
7. Open *Releases*. The draft "Pocket Paste vX.Y.Z" carries the DMG (and,
   once the updater is enabled, `.app.tar.gz`, its `.sig` and `latest.json`).
   Install the DMG on a machine or a fresh user account that has never run
   the app, walk through onboarding, paste once with each action.
8. Paste the relevant part of `CHANGELOG.md` into the release notes and
   press *Publish release*. The updater (once enabled) sees a release only
   after it is published.
9. Homebrew: in `anelikes/homebrew-tap`, update `Casks/pocket-paste.rb` from
   the skeleton in `docs/homebrew/pocket-paste.rb` with the new version and
   `shasum -a 256 <the DMG>`.

A run started by hand (*Actions → release → Run workflow*) builds the same
way from any branch but creates no release; the DMG is under the run's
*Artifacts*. Use it to check a build before tagging.

### Unsigned builds

Until the Apple secrets are in place the DMG is ad-hoc signed and not
notarized. Gatekeeper refuses it on first launch; users open it once with
right-click → *Open*, or on macOS 15 via *System Settings → Privacy &
Security → Open Anyway*, or with

```bash
xattr -dr com.apple.quarantine "/Applications/Pocket Paste.app"
```

Say so in the release notes of every unsigned release.

## One-time setup

Everything here is per repository and done once. Add secrets under
*Settings → Secrets and variables → Actions → New repository secret*, or with
`gh secret set NAME < file`.

### Engine access (needed today)

`engine.json` pins a private repository until the engine's branch stack is
merged into the public pocket-motion. Create a fine-grained personal access
token with *Contents: read* on that repository and store it as
`ENGINE_TOKEN`. CI already uses the same secret. Once the pin moves to a
public tag, delete the token; the workflow will still expect the secret until
the `engine token present` step is removed.

### Code signing (Developer ID)

Needs a paid Apple Developer Program membership.

1. Create a *Developer ID Application* certificate: Xcode → *Settings →
   Accounts → Manage Certificates → + → Developer ID Application*, or at
   developer.apple.com → *Certificates, Identifiers & Profiles*.
2. Export it from Keychain Access as a `.p12` with a password
   (select the certificate together with its private key → *Export 2 items*).
3. Encode and add the secrets:

   ```bash
   base64 -i DeveloperID.p12 | tr -d '\n' | gh secret set APPLE_CERTIFICATE
   gh secret set APPLE_CERTIFICATE_PASSWORD        # the .p12 password
   security find-identity -v -p codesigning        # copy the "Developer ID Application: … (TEAMID)" line
   gh secret set APPLE_SIGNING_IDENTITY
   ```

### Notarization

1. An app-specific password for the Apple ID that holds the certificate:
   account.apple.com → *Sign-In and Security → App-Specific Passwords*.
2. The team id: developer.apple.com/account → *Membership details*.
3. Secrets: `APPLE_ID` (the Apple ID email), `APPLE_PASSWORD` (the
   app-specific password), `APPLE_TEAM_ID`.

With these six secrets present the next tagged run signs, notarizes and
staples the DMG; no workflow change is needed.

### Updater key pair

The Tauri updater verifies each update against a public key baked into the
app. Generate the pair once and keep the private key somewhere safe: losing
it means installed apps can never verify another update, and it cannot be
rotated without shipping a new app by hand.

```bash
cd app
bunx tauri signer generate -w ~/.tauri/pocket-paste.key
```

The command prints the public key and writes the private key to the path
given (choose a password when asked, or leave it empty).

- Put the **public** key into `app/src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`, set `plugins.updater.endpoints` to
  `https://github.com/anelikes/pocket-paste/releases/latest/download/latest.json`,
  and `bundle.createUpdaterArtifacts` to `true`. The public key is committed;
  it is not a secret.
- Store the **private** key's contents as `TAURI_SIGNING_PRIVATE_KEY`
  (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/pocket-paste.key`) and
  its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; leave that secret
  unset if the key has no password. Never commit the private key.

From then on every release needs both secrets; the build fails without them.

## Homebrew cask

`docs/homebrew/pocket-paste.rb` is the skeleton for `anelikes/homebrew-tap`
(`Casks/pocket-paste.rb` in that repository). Per release, update `version`
and `sha256`. The asset name in the `url` comes from `productName` and
`version` in `tauri.conf.json` (Tauri names the DMG
`<productName>_<version>_aarch64.dmg`, and GitHub replaces spaces in asset
names with dots), so copy it from the release page the first time. Users
install with

```bash
brew tap anelikes/tap
brew install --cask pocket-paste
```
