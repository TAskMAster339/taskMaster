#!/usr/bin/env bash
set -euo pipefail

rpm_path=${1:?Specify the RPM path}
public_key=${2:?Specify the public key output path}
: "${RPM_SIGNING_KEY:?Configure the armored release signing key}"
: "${RPM_SIGNING_FINGERPRINT:?Configure the release signing key fingerprint}"
: "${RPM_SIGNING_PASSPHRASE:?Configure the release signing key passphrase}"

fingerprint=${RPM_SIGNING_FINGERPRINT^^}
if [[ ! $fingerprint =~ ^[0-9A-F]{40}$ ]]; then
    echo "Expected a full OpenPGP v4 fingerprint." >&2
    exit 1
fi

umask 077
work=$(mktemp -d)
export GNUPGHOME="$work/gnupg"
mkdir "$GNUPGHOME" "$work/rpmdb"
trap 'gpgconf --kill gpg-agent; rm -rf -- "$work"' EXIT

printf '%s\n' "$RPM_SIGNING_KEY" | gpg --batch --import
printf '%s\n' "$RPM_SIGNING_PASSPHRASE" > "$work/passphrase"
unset RPM_SIGNING_KEY RPM_SIGNING_PASSPHRASE
gpg --batch --list-secret-keys "$fingerprint" >/dev/null
gpg --batch --armor --export "$fingerprint" > "$work/public.asc"
test -s "$work/public.asc"

rpmsign --resign \
    --define '_openpgp_sign gpg' \
    --define "_openpgp_sign_id $fingerprint!" \
    --define "_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback --passphrase-file $work/passphrase" \
    "$rpm_path"
rpm --dbpath "$work/rpmdb" --import "$work/public.asc"
rpm --dbpath "$work/rpmdb" --define '_pkgverify_level signature' --checksig "$rpm_path"
install -m 0644 "$work/public.asc" "$public_key"
