/* osos-push: push notifications for the OSOS institute portal, running on Cloudflare Workers (free plan).
   - POST /notify {kind, id}: the portal says "this record changed". The worker checks the caller's Firebase
     login, re-reads the record with its own service-account key, decides who should hear about it, and keeps
     a pushLog so the same thing is never sent twice. The caller cannot choose the text or the recipients.
   - Two daily schedules: 09:00 installment reminders + tomorrow's calendar, 20:00 trainers who did not take attendance.
   Secrets: SA_JSON = the Firebase service-account key (JSON). Vars: PROJECT_ID. */

const TZ = "Asia/Riyadh";
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const todayStr = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {timeZone: TZ}).format(d);
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dayName = s => { const [y, m, d] = s.split("-").map(Number); return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const idOf = t => t.replace(/[^\w:-]/g, "_").slice(0, 1400);   // same as the portal's pushId()
const CHUNK = 40;          // messages per worker invocation (free plan: 50 outside requests each)
const DIRECT = 20;         // small sends go out from the first invocation itself
const CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS"};
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {"content-type": "application/json", ...CORS}});

/* ---------- base64url + Google auth ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = s => b64u(new TextEncoder().encode(s));
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
let ACCESS = null;   // {token, exp} kept while this worker instance lives
async function accessToken(env){
  if (ACCESS && ACCESS.exp > Date.now() + 60000) return ACCESS.token;
  const sa = JSON.parse(env.SA_JSON), now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const body = b64uStr(JSON.stringify({iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/identitytoolkit", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600}));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + body + "." + b64u(sig)});
  const j = await r.json(); if (!j.access_token) throw new Error("service account login failed: " + JSON.stringify(j));
  ACCESS = {token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000};
  return ACCESS.token;
}

/* Firebase login check: the caller sends its ID token; we verify Google's signature, project and expiry */
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let KEYS = null;   // Google's public keys, kept for an hour while this worker instance lives
async function jwks(){
  if (KEYS && KEYS.exp > Date.now()) return KEYS.keys;
  const j = await (await fetch(JWKS_URL)).json();
  KEYS = {keys: j.keys || [], exp: Date.now() + 3600000}; return KEYS.keys;
}
const verifyUser = (req, env) => verifyToken((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), env);
async function verifyToken(t, env){
  const [h, p, s] = String(t || "").split(".");
  if (!s) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(unb64u(h))), pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
    const jwk = (await jwks()).find(k => k.kid === head.kid); if (!jwk || head.alg !== "RS256") return null;
    const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p)))) return null;
    const now = Date.now() / 1000, P = env.PROJECT_ID;
    if (pay.aud !== P || pay.iss !== "https://securetoken.google.com/" + P || !pay.sub || pay.exp < now || pay.iat > now + 300) return null;
    return pay;
  } catch { return null; }
}

/* ---------- Firestore REST ---------- */
function dv(v){
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return fields(v.mapValue.fields);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dv);
  return null;
}
const fields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dv(v)]));
const ev = x => typeof x === "string" ? {stringValue: x} : typeof x === "number" ? (Number.isInteger(x) ? {integerValue: String(x)} : {doubleValue: x}) : typeof x === "boolean" ? {booleanValue: x} : Array.isArray(x) ? {arrayValue: {values: x.map(ev)}} : x && typeof x === "object" ? {mapValue: {fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ev(v)]))}} : {nullValue: null};
function FS(env){
  const base = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents`;
  const call = async (url, init = {}) => fetch(url, {...init, headers: {authorization: "Bearer " + await accessToken(env), "content-type": "application/json"}});
  return {
    async get(path){ const r = await call(`${base}/${path}`); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + path + " " + r.status); return fields((await r.json()).fields); },
    async set(path, obj){ const r = await call(`${base}/${path}`, {method: "PATCH", body: JSON.stringify({fields: ev(obj).mapValue.fields})}); if (!r.ok) throw new Error("set " + path + " " + r.status); },
    async del(path){ await call(`${base}/${path}`, {method: "DELETE"}); },
    async patch(path, obj){   // changes only the given fields, keeps the rest of the document
      const q = new URLSearchParams(); Object.keys(obj).forEach(k => q.append("updateMask.fieldPaths", k));
      const r = await call(`${base}/${path}?${q}`, {method: "PATCH", body: JSON.stringify({fields: ev(obj).mapValue.fields})}); if (!r.ok) throw new Error("patch " + path + " " + r.status);
    },
    async list(coll, mask){
      const out = []; let page = "";
      do {
        const q = new URLSearchParams({pageSize: "300"}); (mask || []).forEach(m => q.append("mask.fieldPaths", m)); if (page) q.set("pageToken", page);
        const j = await (await call(`${base}/${coll}?${q}`)).json();
        (j.documents || []).forEach(d => out.push({id: d.name.split("/").pop(), ...fields(d.fields)})); page = j.nextPageToken || "";
      } while (page);
      return out;
    },
    async where(coll, field, op, value){
      const r = await call(`${base}:runQuery`, {method: "POST", body: JSON.stringify({structuredQuery: {from: [{collectionId: coll}], where: {fieldFilter: {field: {fieldPath: field}, op, value: ev(value)}}}})});
      return (await r.json()).filter(x => x.document).map(x => ({id: x.document.name.split("/").pop(), ...fields(x.document.fields)}));
    },
    async many(paths){
      if (!paths.length) return {};
      const pre = `projects/${env.PROJECT_ID}/databases/(default)/documents/`;
      const r = await call(`${base}:batchGet`, {method: "POST", body: JSON.stringify({documents: paths.map(p => pre + p)})});
      const out = {}; (await r.json()).forEach(x => { if (x.found) out[x.found.name.slice(pre.length)] = fields(x.found.fields); }); return out;
    }
  };
}

/* ---------- recipients and sending ---------- */
async function tokensWhere(fs, field, value){
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 30) out.push(...await fs.where("pushTokens", field, "IN", value.slice(i, i + 30)));
    return out;
  }
  return fs.where("pushTokens", field, "EQUAL", value);
}
let SITE = null;
async function portalUrl(fs){
  if (SITE && SITE.exp > Date.now()) return SITE.url;
  let url = ""; try { url = ((await fs.get("public/site")) || {}).portalUrl || ""; } catch {}
  SITE = {url, exp: Date.now() + 600000}; return url;
}
const msgs = (docs, title, body, link) => [...new Set(docs.map(d => d.token).filter(Boolean))].map(token => ({token, title, body, link}));

/* send one batch from this invocation; tokens the browser has dropped are removed */
async function sendBatch(env, list, access){
  let sent = 0, deletes = 0;
  const url = `https://fcm.googleapis.com/v1/projects/${env.PROJECT_ID}/messages:send`;
  for (const m of list) {
    const r = await fetch(url, {method: "POST", headers: {authorization: "Bearer " + access, "content-type": "application/json"},
      body: JSON.stringify({message: {token: m.token, data: {title: m.title, body: m.body, link: m.link || ""}, webpush: {headers: {Urgency: "high", TTL: "86400"}}}})});
    if (r.ok) { sent++; continue; }
    const t = await r.text();
    if ((r.status === 404 || /UNREGISTERED|registration token/i.test(t)) && deletes < 8) {
      deletes++;
      await fetch(`https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents/pushTokens/${encodeURIComponent(idOf(m.token))}`, {method: "DELETE", headers: {authorization: "Bearer " + access}}).catch(() => {});
    }
  }
  return sent;
}
/* small sends go out directly; bigger ones are split across fresh invocations of this same worker */
async function deliver(env, list){
  if (!list.length) return 0;
  const access = await accessToken(env);
  if (list.length <= DIRECT || !env.SELF) return sendBatch(env, list.slice(0, env.SELF ? DIRECT : 30), access);
  const sa = JSON.parse(env.SA_JSON), parts = [];
  for (let i = 0; i < list.length; i += CHUNK) parts.push(list.slice(i, i + CHUNK));
  const res = await Promise.all(parts.map(p => env.SELF.fetch("https://self/batch", {method: "POST", headers: {"x-key": sa.private_key_id, "content-type": "application/json"}, body: JSON.stringify({access, list: p})}).then(r => r.json()).then(j => j.sent || 0).catch(() => 0)));
  return res.reduce((a, b) => a + b, 0);
}

/* ---------- events (mirror the old Cloud Functions) ---------- */
async function onEvent(env, kind, id, user){
  const fs = FS(env), link = await portalUrl(fs);
  const logPath = `pushLog/${kind}_${id}`, log = (await fs.get(logPath)) || {keys: []}, seen = new Set(log.keys || []);
  const remember = async keys => { keys.forEach(k => seen.add(k)); await fs.set(logPath, {keys: [...seen].slice(-200), at: new Date().toISOString()}); };
  const once = async (key, fn) => { if (seen.has(key)) return 0; await remember([key]); return fn(); };

  if (kind === "test") {
    return deliver(env, msgs(await tokensWhere(fs, "email", user.email || "-"), "إشعار تجريبي", "الإشعارات شغّالة ✓", link));
  }
  if (kind === "att") {
    const a = await fs.get("att/" + id); if (!a || a.date < addDays(todayStr(), -2)) return 0;
    const absent = Object.entries(a.rec || {}).filter(([, r]) => r && r.st === "a").map(([k]) => k).filter(k => !seen.has(k));
    if (!absent.length) return 0;
    await remember(absent);
    const g = await fs.get("groups/" + a.groupId); if (!g) return 0;
    const nums = (g.students || []).filter(s => absent.includes(s.id) && s.sid).map(s => s.sid); if (!nums.length) return 0;
    return deliver(env, msgs(await tokensWhere(fs, "num", nums), "تسجيل غياب", `سُجّل غيابك في ${a.course || "المحاضرة"} بتاريخ ${a.date}. إذا عندك عذر ارفعه من البوابة.`, link));
  }
  if (kind === "warning") {
    const w = await fs.get("warnings/" + id); if (!w || !w.num) return 0;
    return once("sent", async () => deliver(env, msgs(await tokensWhere(fs, "num", w.num), w.levelName || "إنذار غياب", `${w.levelName || "إنذار"} في ${w.course}: نسبة غيابك ${w.absPct}%. راجع الشؤون الأكاديمية.`, link)));
  }
  if (kind === "grade") {
    const rs = (await fs.where("results", "groupId", "EQUAL", id)).filter(r => r.num && !seen.has(r.num)); if (!rs.length) return 0;
    await remember(rs.map(r => r.num));
    return deliver(env, msgs(await tokensWhere(fs, "num", rs.map(r => r.num)), "اعتُمدت درجتك", `اعتُمدت درجتك في ${rs[0].course}. تقدر تشوفها في البوابة.`, link));
  }
  if (kind === "excuse") {
    const x = await fs.get("excuses/" + id); if (!x || !x.num) return 0;
    if (x.status === "pending") return once("pending", async () => deliver(env, msgs(await tokensWhere(fs, "email", "acadmic@osostl.local"), "عذر غياب جديد", `${x.name || x.num} · ${x.course} بتاريخ ${x.date}`, link)));
    if (!["accepted", "rejected"].includes(x.status)) return 0;
    return once(x.status, async () => deliver(env, msgs(await tokensWhere(fs, "num", x.num), x.status === "accepted" ? "انقبل عذرك" : "انرفض عذرك", `عذر غياب ${x.course} بتاريخ ${x.date}: ${x.status === "accepted" ? "مقبول" : "مرفوض"}${x.note ? " · " + x.note : ""}`, link)));
  }
  if (kind === "cert") {
    const c = await fs.get("certs/" + id); if (!c || !c.num || c.revoked) return 0;
    return once("sent", async () => deliver(env, msgs(await tokensWhere(fs, "num", c.num), "صدرت لك شهادة", `شهادة حضور: ${c.course}. تقدر تطبعها من البوابة.`, link + `?verify=${c.code || id}`)));
  }
  if (kind === "ann") {
    const items = ((await fs.get("ann/" + id)) || {}).items || [];
    let fresh = items.filter(x => x && x.text && !seen.has(x.text.slice(0, 300)));
    if (!(log.keys || []).length && fresh.length > 1) { await remember(fresh.slice(0, -1).map(x => x.text.slice(0, 300))); fresh = fresh.slice(-1); }   // first run: only the newest
    if (!fresh.length) return 0;
    await remember(fresh.map(x => x.text.slice(0, 300)));
    let docs = await fs.list("pushTokens", ["token", "role"]);
    if (id !== "all") docs = docs.filter(d => d.role === (id === "students" ? "student" : "trainer"));
    let n = 0; for (const x of fresh) n += await deliver(env, msgs(docs, "إعلان من المعهد", x.text, link));
    return n;
  }
  if (kind === "sign") {
    const r = await fs.get("signReqs/" + id); if (!r) return 0;
    if (r.status === "pending") return once("pending", async () => deliver(env, msgs(await tokensWhere(fs, "role", "admin"), "طلب توقيع جديد", `${r.title} · بانتظار توقيعك`, link)));
    if (["signed", "rejected"].includes(r.status)) return once(r.status, async () => deliver(env, msgs(await tokensWhere(fs, "email", r.byEmail || "-"), r.status === "signed" ? "توقّع مستندك" : "انرفض طلب التوقيع", r.status === "signed" ? `${r.title} · موقّع ومختوم وجاهز للتنزيل` : `${r.title}${r.reason ? " · " + r.reason : ""}`, link)));
    return 0;
  }
  if (kind === "gradesub") {
    const g = await fs.get("grades/" + id); if (!g || g.status !== "submitted") return 0;
    return once("sub:" + (g.submittedAt || ""), async () => deliver(env, msgs(await tokensWhere(fs, "email", "acadmic@osostl.local"), "درجات بانتظار الاعتماد", `${g.course || "مقرر"}: رفع المدرب الدرجات للاعتماد.`, link)));
  }
  if (kind === "memo") {
    const m = await fs.get("memos/" + id); if (!m || !["admin", "academic", "finance"].includes(m.to)) return 0;
    const NAMES = {admin: "الإدارة", academic: "الشؤون الأكاديمية", finance: "المالية"};
    return once("sent", async () => deliver(env, msgs(await tokensWhere(fs, "role", m.to), "رسالة من " + (NAMES[m.from] || "الإدارة"), (m.text || "").slice(0, 140), link)));
  }
  if (kind === "live") {
    const l = await fs.get("live/" + id); if (!l || !l.on) return 0;
    return once("at:" + l.mode + ":" + (l.at || ""), async () => {
      const g = await fs.get("groups/" + id); if (!g) return 0;
      const nums = (g.memberNums || []).filter(Boolean); if (!nums.length) return 0;
      return deliver(env, msgs(await tokensWhere(fs, "num", nums), "بدأت المحاضرة", `${g.course || "المحاضرة"}: ${l.mode === "teams" ? "على Teams" : "في قاعة المعهد"}. ادخل من البوابة.`, link));
    });
  }
  if (kind === "acad") {
    const r = await fs.get("acReqs/" + id); if (!r) return 0;
    if (r.status === "new") return once("new", async () => deliver(env, msgs(await tokensWhere(fs, "email", "acadmic@osostl.local"), "طلب جديد من طالب", `${r.name || r.num} · ${r.cat || "استفسار"}: ${(r.text || "").slice(0, 80)}`, link)));
    if (r.status === "done") return once("done", async () => deliver(env, msgs(await tokensWhere(fs, "num", r.num), "رد الشؤون الأكاديمية", r.reply ? r.reply.slice(0, 140) : "تم الرد على طلبك. شوفه في «طلبات الأكاديمية».", link)));
    return 0;
  }
  if (kind === "fin") {
    const a = await fs.get("finReqs/" + id); if (!a) return 0;
    const who = a.name || a.num, to = async (field, v, title, body) => deliver(env, msgs(await tokensWhere(fs, field, v), title, body, link));
    return once(a.status, async () => {
      if (a.status === "new") return to("email", "finance@osostl.local", a.type === "inquiry" ? "استفسار مالي جديد" : "طلب فاتورة نهائية", a.type === "inquiry" ? `${who}: ${(a.text || "").slice(0, 80)}` : `${who} يطلب فاتورته النهائية.`);
      if (a.status === "fin_signed") return to("email", "admin@osostl.local", "فاتورة بانتظار الختم", `فاتورة ${who} موقّعة من المالية وتنتظر الختم.`);
      if (a.status === "stamped") return to("email", "finance@osostl.local", "فاتورة مختومة", `فاتورة ${who} انختمت وتنتظر اعتمادك.`);
      if (a.status === "approved") return to("num", a.num, "فاتورتك جاهزة", "فاتورتك النهائية معتمدة. تلقاها في «طلبات المالية».");
      if (a.status === "rejected") return to("num", a.num, "طلب الفاتورة", "طلبك للفاتورة النهائية انرفض. شوف السبب في «طلبات المالية».");
      return 0;
    });
  }
  return 0;
}

/* ---------- staff accounts: emergency stop / new code (general administration only) ----------
   Uses the Firebase Auth admin API with the service account. After any change, public/staffLock[role] is set
   to now, and the security rules refuse every session of that role that signed in before it. */
const STAFF = {admin: "admin@osostl.local", academic: "acadmic@osostl.local", finance: "finance@osostl.local", auditor: "audit@osostl.local"};
async function idt(env, op, body){
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.PROJECT_ID}/accounts:${op}`, {method: "POST", headers: {authorization: "Bearer " + await accessToken(env), "content-type": "application/json"}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(op + " " + r.status + " " + JSON.stringify(j).slice(0, 300)); return j;
}
const newCode = () => [...crypto.getRandomValues(new Uint32Array(8))].map((x, i) => i === 0 ? 1 + x % 9 : x % 10).join("");
async function staffSecurity(req, env){
  const user = await verifyUser(req, env);
  if (!user || user.email !== STAFF.admin) return json({error: "not allowed"}, 403);
  const fs = FS(env), locks = (await fs.get("public/staffLock")) || {};
  if ((locks.admin || 0) >= (user.auth_time || 0)) return json({error: "not allowed"}, 403);
  let b; try { b = await req.json(); } catch { return json({error: "bad body"}, 400); }
  const action = String(b.action || ""), role = String(b.role || ""), now = Math.floor(Date.now() / 1000);
  if (action !== "status" && now - (user.auth_time || 0) > 900) return json({error: "reauth"}, 401);   // changes need the code typed in the last 15 minutes
  const lookup = async email => ((await idt(env, "lookup", {email: [email]})).users || [])[0] || null;
  const lock = async roles => fs.patch("public/staffLock", Object.fromEntries(roles.map(r => [r, now])));
  if (action === "status") {
    const out = {};
    for (const [r, email] of Object.entries(STAFF)) {
      const u = await lookup(email);
      out[r] = u ? {exists: true, disabled: !!u.disabled, lastLogin: Number(u.lastLoginAt || 0) || null, lockedAt: locks[r] || null} : {exists: false};
    }
    return json({ok: true, roles: out});
  }
  if (action === "lockall") {
    const res = {};
    for (const r of ["academic", "finance", "auditor"]) {
      const u = await lookup(STAFF[r]); if (!u) continue;
      await idt(env, "update", {localId: u.localId, disableUser: true, validSince: String(now)}); res[r] = "stopped";
    }
    const a = await lookup(STAFF.admin), code = newCode();
    await idt(env, "update", {localId: a.localId, password: code, validSince: String(now)});
    await lock(["admin", "academic", "finance", "auditor"]);
    return json({ok: true, code, res});
  }
  if (!STAFF[role] || !["newcode", "disable", "enable"].includes(action)) return json({error: "bad request"}, 400);
  if (role === "admin" && action === "disable") return json({error: "cannot stop own account"}, 400);
  const u = await lookup(STAFF[role]); if (!u) return json({error: "no account"}, 404);
  if (action === "newcode") {
    const code = newCode();
    await idt(env, "update", {localId: u.localId, password: code, validSince: String(now)});
    await lock([role]);
    return json({ok: true, code});
  }
  if (action === "disable") { await idt(env, "update", {localId: u.localId, disableUser: true, validSince: String(now)}); await lock([role]); return json({ok: true}); }
  await idt(env, "update", {localId: u.localId, disableUser: false});
  return json({ok: true});
}

/* ---------- virtual classroom passes ----------
   The meet server only lets in people holding a pass signed with MEET_SECRET (shared with its prosody).
   Trainer of the group and the administration get moderator passes; a student of the group gets one only
   while the lecture is live in the institute's room. */
async function signHS(payload, secret){
  const h = b64uStr(JSON.stringify({alg: "HS256", typ: "JWT"})), p = b64uStr(JSON.stringify(payload));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return h + "." + p + "." + b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(h + "." + p)));
}
/* who the caller is for a course group: "admin" (administration / academic affairs), "trainer" (its own trainer), "student" (a member), or null */
async function groupRole(fs, user, g){
  const email = user.email || "", local = email.split("@")[0].split(".")[0];
  if (email === "admin@osostl.local" || email === "acadmic@osostl.local") return {role: "admin", email};
  if (/^t-/.test(local)) {
    if (!g || g.trainerId !== local) return null;
    const t = await fs.get("trainers/" + local); return t && t.uid === user.sub && !t.disabled ? {role: "trainer", t, local} : null;
  }
  const m = local.match(/^st-(\d+)$/); if (!m || !g || !(g.memberNums || []).includes(m[1])) return null;
  const st = await fs.get("students/" + m[1]); return st && st.uid === user.sub && !st.disabled ? {role: "student", st, num: m[1]} : null;
}
/* recordings live on the meet server; each upload/view/delete carries a short ticket signed with MEET_SECRET */
async function recTicket(obj, secret){
  const body = b64uStr(JSON.stringify(obj));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("");
  return body + "." + sig;
}
const RID = /^\d{8}-[A-Za-z0-9]{6,20}$/;
async function recPass(req, env){
  const user = await verifyUser(req, env); if (!user) return json({error: "login required"}, 401);
  if (!env.MEET_SECRET) return json({error: "not configured"}, 503);
  let b; try { b = await req.json(); } catch { return json({error: "bad body"}, 400); }
  const op = String(b.op || ""), gid = String(b.gid || ""), rid = String(b.rid || ""), fs = FS(env);
  const base = `https://${env.MEET_DOMAIN || "meet.osustl.com"}/rec`, exp = Math.floor(Date.now() / 1000) + 3 * 3600;
  if (op === "stats") {
    const who = await groupRole(fs, user, null); if (!who || who.role !== "admin") return json({error: "not allowed"}, 403);
    return json({url: `${base}/stats?t=${await recTicket({op, exp}, env.MEET_SECRET)}`});
  }
  if (!["up", "get", "del"].includes(op) || !/^[\w-]{1,80}$/.test(gid) || (op !== "up" && !RID.test(rid))) return json({error: "bad request"}, 400);
  const g = await fs.get("groups/" + gid); if (!g) return json({error: "no group"}, 404);
  const who = await groupRole(fs, user, g); if (!who) return json({error: "not allowed"}, 403);
  if (op !== "get" && who.role === "student") return json({error: "not allowed"}, 403);
  if (op === "up") {
    const day = new Intl.DateTimeFormat("en-CA", {timeZone: TZ}).format(new Date()).replace(/-/g, "");
    const newRid = day + "-" + [...crypto.getRandomValues(new Uint8Array(6))].map(x => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
    return json({rid: newRid, url: `${base}/up?t=${await recTicket({op, gid, rid: newRid, exp, max: 4 * 1024 ** 3}, env.MEET_SECRET)}`});
  }
  return json({url: `${base}/${op}?t=${await recTicket({op, gid, rid, exp}, env.MEET_SECRET)}`});
}
/* after the semester (public/site.recEnd) + 30 days: delete that semester's recordings from the server and the portal, once */
async function purgeRecordings(env){
  if (!env.MEET_SECRET) return 0;
  const fs = FS(env), site = (await fs.get("public/site")) || {}, end = site.recEnd || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || site.recPurged === end || todayStr() < addDays(end, 30)) return 0;
  const t = await recTicket({op: "purge", before: end, exp: Math.floor(Date.now() / 1000) + 600}, env.MEET_SECRET);
  const r = await fetch(`https://${env.MEET_DOMAIN || "meet.osustl.com"}/rec/purge?t=${t}`, {method: "POST"});
  if (!r.ok) throw new Error("purge " + r.status);
  for (const g of await fs.list("groups", ["recordings"])) {
    const recs = g.recordings || [], keep = recs.filter(x => !(x && x.rid && x.date <= end));
    if (keep.length !== recs.length) await fs.patch("groups/" + g.id, {recordings: keep});
  }
  await fs.patch("public/site", {recPurged: end});
  return 1;
}
async function meetPass(req, env){
  const user = await verifyUser(req, env); if (!user) return json({error: "login required"}, 401);
  if (!env.MEET_SECRET) return json({error: "not configured"}, 503);
  let b; try { b = await req.json(); } catch { return json({error: "bad body"}, 400); }
  const gid = String(b.gid || ""); if (!/^[\w-]{1,80}$/.test(gid)) return json({error: "bad request"}, 400);
  const fs = FS(env), email = user.email || "", local = email.split("@")[0].split(".")[0];
  const g = await fs.get("groups/" + gid); if (!g) return json({error: "no group"}, 404);
  const no = () => json({error: "not allowed"}, 403);
  let who;
  if (email === "admin@osostl.local" || email === "acadmic@osostl.local") {
    who = {id: "o-" + user.sub.slice(0, 12), name: email.startsWith("admin") ? "الإدارة" : "الشؤون الأكاديمية", moderator: true, observer: true};
  } else if (/^t-/.test(local)) {
    if (g.trainerId !== local) return no();
    const t = await fs.get("trainers/" + local); if (!t || t.uid !== user.sub || t.disabled) return no();
    who = {id: local, name: "المدرب " + (t.name || ""), moderator: true};
  } else {
    const m = local.match(/^st-(\d+)$/); if (!m) return no();
    const num = m[1]; if (!(g.memberNums || []).includes(num)) return no();
    const st = await fs.get("students/" + num); if (!st || st.uid !== user.sub || st.disabled) return no();
    const l = await fs.get("live/" + gid);
    if (!l || !l.on || l.mode !== "osos" || Date.now() - Date.parse(l.at) > 5 * 3600e3) return json({error: "not live"}, 409);
    const e = (g.students || []).find(x => x && x.sid === num);
    who = {id: "s-" + num, name: (e && e.name) || st.name || num, moderator: false};
  }
  const domain = env.MEET_DOMAIN || "meet.osustl.com", room = ("osos-" + gid).toLowerCase().replace(/[^a-z0-9-]/g, ""), now = Math.floor(Date.now() / 1000);
  const jwt = await signHS({aud: "jitsi", iss: "osos", sub: "*", room, nbf: now - 60, exp: now + 6 * 3600,
    context: {user: {id: who.id, name: who.name, moderator: who.moderator}}}, env.MEET_SECRET);
  return json({jwt, room, domain, name: who.name, moderator: who.moderator, observer: !!who.observer});
}

/* ---------- daily schedules ---------- */
async function morning(env){
  const fs = FS(env), link = await portalUrl(fs), t = todayStr(), in3 = addDays(t, 3), tomorrow = addDays(t, 1), sunday = dayName(t) === "الأحد";
  const [accs, pays, toks, sys] = await Promise.all([fs.list("finAccounts", ["installments", "extras"]), fs.list("payments", ["num", "amount", "void"]), fs.list("pushTokens", ["token", "role", "num"]), fs.get("public/system")]);
  const byNum = {}; toks.forEach(d => { if (d.num) (byNum[d.num] = byNum[d.num] || []).push(d); });
  const paidBy = {}; pays.forEach(p => { if (!p.void) paidBy[p.num] = (paidBy[p.num] || 0) + Number(p.amount || 0); });
  const out = [];
  for (const acc of accs) {
    const num = acc.id, paid = paidBy[num] || 0; if (!byNum[num]) continue;
    const inst = [...(acc.installments || []), ...(acc.extras || []).map(x => ({due: x.date, amount: x.amount}))].filter(i => i && i.due).sort((x, y) => x.due.localeCompare(y.due));
    let cum = 0, overdue = 0, soon = null;
    for (const i of inst) { cum += Number(i.amount || 0); if (i.due <= t) overdue = Math.max(0, cum - paid); else if (i.due === in3 && cum > paid) soon = i; }
    if (soon) out.push(...msgs(byNum[num], "تذكير بالقسط", `قسطك القادم ${Number(soon.amount).toLocaleString("en-US")} ريال بتاريخ ${soon.due}.`, link));
    else if (overdue > 0.01 && sunday) out.push(...msgs(byNum[num], "مبلغ متأخر", `عليك مبلغ متأخر ${Math.round(overdue).toLocaleString("en-US")} ريال. تواصل مع المالية.`, link));
  }
  const s = sys || {};
  const items = [...(s.holidays || []).filter(h => h.from === tomorrow).map(h => `بكرة: ${h.label || "إجازة"}`), ...(s.events || []).filter(x => x.date === tomorrow).map(x => `بكرة: ${x.label}`)];
  const people = toks.filter(d => ["student", "trainer"].includes(d.role));
  for (const m of items) out.push(...msgs(people, "التقويم التدريبي", m, link));
  return deliver(env, out);
}
async function evening(env){
  const fs = FS(env), link = await portalUrl(fs), t = todayStr(), dn = dayName(t);
  const sys = (await fs.get("public/system")) || {};
  if ((sys.holidays || []).some(h => t >= h.from && t <= (h.to || h.from))) return 0;
  const groups = (await fs.list("groups", ["trainerId", "sessions", "course"])).filter(g => g.trainerId && (g.sessions || []).some(s => s && s.day === dn));
  if (!groups.length) return 0;
  const done = await fs.many(groups.map(g => `att/${g.id}_${t}`));
  const late = groups.filter(g => !done[`att/${g.id}_${t}`]); if (!late.length) return 0;
  const toks = await tokensWhere(fs, "tid", [...new Set(late.map(g => g.trainerId))]);
  const out = []; late.forEach(g => out.push(...msgs(toks.filter(d => d.tid === g.trainerId), "ما انحضّرت المحاضرة", `محاضرة ${g.course} اليوم ما سجّلت حضورها للحين.`, link)));
  return deliver(env, out);
}

const KINDS = ["test", "att", "warning", "grade", "excuse", "cert", "ann", "sign", "fin", "acad", "gradesub", "memo", "live"];
export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {headers: CORS});
    if (req.method === "GET") return new Response("osos-push شغّال ✓", {headers: {"content-type": "text/plain; charset=utf-8", ...CORS}});
    if (url.pathname === "/staff-security" && req.method === "POST") { try { return await staffSecurity(req, env); } catch (e) { console.error(e); return json({error: "failed"}, 500); } }
    if (url.pathname === "/rec-ticket" && req.method === "POST") { try { return await recPass(req, env); } catch (e) { console.error(e); return json({error: "failed"}, 500); } }
    if (url.pathname === "/meet-token" && req.method === "POST") { try { return await meetPass(req, env); } catch (e) { console.error(e); return json({error: "failed"}, 500); } }
    if (url.pathname === "/batch") {   // only from this worker itself (service binding), marked with the key id
      if (req.headers.get("x-key") !== JSON.parse(env.SA_JSON).private_key_id) return json({error: "forbidden"}, 403);
      const {access, list} = await req.json();
      return json({sent: await sendBatch(env, (list || []).slice(0, CHUNK), access)});
    }
    if (url.pathname !== "/notify" || req.method !== "POST") return json({error: "not found"}, 404);
    const user = await verifyUser(req, env); if (!user) return json({error: "login required"}, 401);
    let b; try { b = await req.json(); } catch { return json({error: "bad body"}, 400); }
    const kind = String(b.kind || ""), id = String(b.id || "");
    if (!KINDS.includes(kind) || !/^[\w.:-]{1,200}$/.test(id) || (kind === "ann" && !["all", "trainers", "students"].includes(id))) return json({error: "bad request"}, 400);
    try { return json({ok: true, sent: await onEvent(env, kind, id, user)}); }
    catch (e) { console.error(e); return json({error: "failed"}, 500); }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil((event.cron === "0 6 * * *" ? morning(env) : evening(env)).catch(e => console.error(e)));
    if (event.cron === "0 6 * * *") ctx.waitUntil(purgeRecordings(env).catch(e => console.error(e)));
  }
};
