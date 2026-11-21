#!/bin/bash
# OSOS classroom, step 2: link the room to the portal.
# After this, nobody can join without a pass from the portal: the trainer and the administration
# enter as moderators, students only while their lecture is running. Run as root: bash meet-link.sh
set -e
DOMAIN="meet.osustl.com"
PCFG="/etc/prosody/conf.avail/$DOMAIN.cfg.lua"
MCFG="/etc/jitsi/meet/$DOMAIN-config.js"
JCFG="/etc/jitsi/jicofo/jicofo.conf"
NCFG="/etc/nginx/sites-available/$DOMAIN.conf"
PLUG="/usr/share/jitsi-meet/prosody-plugins"
SECRET_FILE="/root/osos-meet-secret"
say(){ echo; echo "=== $* ==="; }
[ "$(id -u)" = 0 ] || { echo "Run this as root."; exit 1; }
for f in "$PCFG" "$MCFG" "$JCFG" "$NCFG"; do [ -f "$f" ] || { echo "Missing $f: run meet-setup.sh first."; exit 1; }; done

say "1/6 Backup of the current settings"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/osos-backup
cp -a "$PCFG" "$MCFG" "$JCFG" "$NCFG" /root/osos-backup/ && echo "saved in /root/osos-backup"

say "2/6 Shared key with the portal"
[ -s "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
SECRET=$(cat "$SECRET_FILE")

say "3/6 Pass (token) login"
echo "jitsi-meet-tokens jitsi-meet-tokens/appid string osos" | debconf-set-selections
echo "jitsi-meet-tokens jitsi-meet-tokens/appsecret password $SECRET" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y jitsi-meet-tokens lua-cjson lua-basexx || true
python3 - "$PCFG" "$DOMAIN" "$SECRET" <<'PY'
import re, sys
p, dom, sec = sys.argv[1:4]
s = open(p).read()
s = re.sub(r'^[ \t]*(app_id|app_secret|allow_empty_token)\s*=.*\n', '', s, flags=re.M)
def block(head):
    m = re.search(head, s)
    if not m: sys.exit("block not found: " + head)
    st = m.end(); n = re.search(r'^(VirtualHost|Component)\s', s[st:], re.M)
    return st, st + (n.start() if n else len(s) - st)
# main domain: token login only
st, en = block(r'VirtualHost\s+"%s"' % re.escape(dom))
b = s[st:en]
auth = 'authentication = "token"\n    app_id = "osos"\n    app_secret = "%s"\n    allow_empty_token = false' % sec
b, n = re.subn(r'authentication\s*=\s*"[^"]*"', auth, b, count=1)
if not n: b = '\n    ' + auth + b
s = s[:st] + b + s[en:]
# the old guest entrance (if any) also needs a pass now
g = re.search(r'VirtualHost\s+"guest\.%s"' % re.escape(dom), s)
if g:
    st, en = block(r'VirtualHost\s+"guest\.%s"' % re.escape(dom))
    s = s[:st] + re.sub(r'authentication\s*=\s*"[^"]*"', auth, s[st:en], count=1) + s[en:]
# rooms: the pass must name the room, and moderators come from the pass
st, en = block(r'Component\s+"conference\.%s"\s+"muc"' % re.escape(dom))
b = s[st:en]
b = re.sub(r'[ \t]*--\s*"token_verification";?[ \t]*\n', '', b)
add = ''.join('\n        "%s";' % m for m in ("token_verification", "osos_moderation") if '"%s"' % m not in b)
if add: b = re.sub(r'modules_enabled\s*=\s*\{', lambda m: m.group(0) + add, b, count=1)
s = s[:st] + b + s[en:]
open(p, 'w').write(s)
print("prosody settings updated")
PY

say "4/6 Moderators come from the pass"
cat > "$PLUG/mod_osos_moderation.lua" <<'LUA'
-- OSOS: whoever the portal's pass marks as moderator (the course trainer, the administration) becomes
-- a room moderator as soon as they join; everyone else stays a normal participant.
module:hook("muc-occupant-joined", function (event)
    local session, occupant, room = event.origin, event.occupant, event.room;
    if not (session and occupant and room) then return; end
    local user = session.jitsi_meet_context_user;
    if user and (user.moderator == true or user.moderator == "true") then
        room:set_affiliation(true, occupant.bare_jid, "owner");
    end
end, -2);
LUA
# jicofo: no login of its own, and nobody becomes moderator just by being first
sed -i '/^jicofo.authentication {/,/^}/d' "$JCFG"
grep -q "enable-auto-owner" "$JCFG" || echo 'jicofo.conference.enable-auto-owner = false' >> "$JCFG"
# web: no guest entrance any more; trainers may record on their own device
sed -i "/config.hosts.anonymousdomain/d" "$MCFG"
grep -q "config.localRecording" "$MCFG" || cat >> "$MCFG" <<'EOF'
config.localRecording = { disable: false, notifyAllParticipants: true };
config.disableDeepLinking = true;
EOF

say "5/6 Load counter for the automatic switch to Teams"
python3 - "$NCFG" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
if "/osos-load" not in s:
    blk = '''    # OSOS: how many people are in the rooms now (the portal switches new lectures to Teams when it is full)
    location = /osos-load {
        proxy_pass http://127.0.0.1:8080/colibri/stats;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Cache-Control "no-store" always;
    }
'''
    m = re.search(r'^[ \t]*location\s*=\s*/external_api\.js', s, re.M)
    if m: s = s[:m.start()] + blk + s[m.start():]; print("load counter added")
    else: print("load counter skipped (place not found)")
    open(p, 'w').write(s)
PY
nginx -t

say "6/6 Restarting"
systemctl restart prosody jicofo jitsi-videobridge2 nginx
sleep 6
for s in prosody jicofo jitsi-videobridge2 nginx; do printf "%-20s %s\n" "$s" "$(systemctl is-active $s)"; done
echo
echo "Recent prosody errors (empty is good):"
grep -iE "error|cannot|failed" /var/log/prosody/prosody.log 2>/dev/null | tail -n 5 || true
echo
echo "Load counter: $(curl -s -m 3 https://$DOMAIN/osos-load | head -c 120)"
echo
echo "DONE. Now copy this key into Cloudflare (MEET_SECRET):"
echo
echo "    $SECRET"
echo
