#!/bin/bash
# OSOS institute virtual classroom: installs Jitsi Meet on a fresh Ubuntu 24.04 server.
# Run as root:  bash meet-setup.sh
# Nothing secret is stored in this file: the email and the trainer password are typed in when it runs.
set -e
DOMAIN="meet.osustl.com"
GUEST="guest.$DOMAIN"

say(){ echo; echo "=== $* ==="; }

[ "$(id -u)" = 0 ] || { echo "Run this as root."; exit 1; }
grep -q 'VERSION_ID="24.04"' /etc/os-release || echo "Warning: this was tested for Ubuntu 24.04."

say "1/7 Checks"
IP=$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DNS=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
echo "Server IP: $IP   |   $DOMAIN points to: ${DNS:-nothing}"
if [ "$IP" != "$DNS" ]; then
  echo "STOP: $DOMAIN must point to $IP in Cloudflare (type A, DNS only, grey cloud). Fix it, wait 5 minutes, run again."
  exit 1
fi
read -rp "Your email (for the free HTTPS certificate): " EMAIL
while true; do
  read -rsp "Choose a password for the trainers' room login (8+ characters): " TPASS; echo
  read -rsp "Type it again: " TPASS2; echo
  [ "$TPASS" = "$TPASS2" ] && [ ${#TPASS} -ge 8 ] && break
  echo "Passwords do not match or too short, try again."
done

say "2/7 Server name and firewall"
hostnamectl set-hostname "$DOMAIN"
grep -q "$DOMAIN" /etc/hosts || echo "$IP $DOMAIN meet" >> /etc/hosts
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y curl gnupg2 apt-transport-https ufw unattended-upgrades
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 10000/udp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw --force enable
# security updates install themselves every day
dpkg-reconfigure -f noninteractive unattended-upgrades

say "3/7 Jitsi repository"
curl -fsSL https://download.jitsi.org/jitsi-key.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/jitsi-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/jitsi-keyring.gpg] https://download.jitsi.org stable/" > /etc/apt/sources.list.d/jitsi-stable.list
curl -fsSL https://prosody.im/files/prosody-debian-packages.key | gpg --dearmor --yes -o /usr/share/keyrings/prosody-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/prosody-keyring.gpg] http://packages.prosody.im/debian $(. /etc/os-release; echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/prosody.list
apt-get update -y

# Prosody 13 (from prosody.im) refuses to run on Lua 5.1: make Lua 5.4 the system interpreter first
DEBIAN_FRONTEND=noninteractive apt-get install -y lua5.4
update-alternatives --install /usr/bin/lua lua-interpreter /usr/bin/lua5.4 140 || true
update-alternatives --set lua-interpreter /usr/bin/lua5.4 || true

say "4/7 Installing Jitsi Meet (a few minutes)"
echo "jitsi-videobridge2 jitsi-videobridge/jvb-hostname string $DOMAIN" | debconf-set-selections
echo "jitsi-meet-prosody jitsi-videobridge/jvb-hostname string $DOMAIN" | debconf-set-selections
echo "jitsi-meet-web-config jitsi-meet/cert-choice select Let's Encrypt certificates" | debconf-set-selections
echo "jitsi-meet-web-config jitsi-meet/email string $EMAIL" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y jitsi-meet

say "5/7 HTTPS certificate"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "$EMAIL" | /usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh "$EMAIL" || true
fi
[ -d "/etc/letsencrypt/live/$DOMAIN" ] && echo "Certificate OK" || echo "WARNING: no certificate yet. Send a photo of this screen."

say "6/7 Only trainers can open a room; students join as guests"
PCFG="/etc/prosody/conf.avail/$DOMAIN.cfg.lua"
# main domain: login required (trainers)
sed -i '0,/authentication = "\(jitsi-\)\?anonymous"/s//authentication = "internal_hashed"/' "$PCFG"
grep -q "VirtualHost \"$GUEST\"" "$PCFG" || cat >> "$PCFG" <<EOF

VirtualHost "$GUEST"
    authentication = "anonymous"
    c2s_require_encryption = false
EOF
MCFG="/etc/jitsi/meet/$DOMAIN-config.js"
grep -q "OSOS settings" "$MCFG" || cat >> "$MCFG" <<EOF

// ---- OSOS settings ----
config.hosts.anonymousdomain = '$GUEST';
config.defaultLanguage = 'ar';
config.disableThirdPartyRequests = true;
config.prejoinConfig = { enabled: true };
// everyone joins with camera and microphone off; the trainer allows them
config.startWithAudioMuted = true;
config.startWithVideoMuted = true;
config.startAudioMuted = 1;
config.startVideoMuted = 1;
// save bandwidth so 100 students run smoothly
config.channelLastN = 6;
config.resolution = 720;
config.constraints = { video: { height: { ideal: 720, max: 720, min: 180 } } };
config.disableSimulcast = false;
config.enableLayerSuspension = true;
// recordings and live streams are not used here
config.fileRecordingsEnabled = false;
config.liveStreamingEnabled = false;
EOF
JCFG="/etc/jitsi/jicofo/jicofo.conf"
grep -q "authentication" "$JCFG" || cat >> "$JCFG" <<EOF

jicofo.authentication {
  enabled = true
  type = XMPP
  login-url = "$DOMAIN"
}
EOF
prosodyctl register trainer "$DOMAIN" "$TPASS"
unset TPASS TPASS2

say "7/7 Restarting"
systemctl restart prosody jicofo jitsi-videobridge2 nginx
sleep 5
for s in prosody jicofo jitsi-videobridge2 nginx; do printf "%-20s %s\n" "$s" "$(systemctl is-active $s)"; done

echo
echo "DONE. Open https://$DOMAIN"
echo "To start a lecture: open a room, press 'I am the host', user: trainer  + the password you chose."
echo "Students join without a login and wait until the trainer is in."
