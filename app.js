import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, query, where, onSnapshot, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

/* ---------- constants ---------- */
const DOMAIN = "osostl.local";                       // login emails are internal, never mailed
const ROLE_EMAIL = {admin: "admin@" + DOMAIN, academic: "acadmic@" + DOMAIN};
const ROLES = {admin: "الإدارة", academic: "مسؤول الشؤون الأكاديمية"};
const STATUS = {p: "حاضر", l: "متأخر", a: "غائب", e: "مستأذن"};
const GENDER = {m: "طالب", f: "طالبة"};
const TZ = "Asia/Riyadh";

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const today = () => new Date().toLocaleDateString("en-CA", {timeZone: TZ});
const nowHM = () => new Date().toLocaleTimeString("en-GB", {timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false});
const fmtTime = hm => { if (!hm) return "—"; let [h, m] = hm.split(":").map(Number); const s = h < 12 ? "ص" : "م"; h = h % 12 || 12; return `${h}:${String(m).padStart(2,"0")} ${s}`; };
const fmtDate = d => { try { return new Date(d + "T12:00:00").toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", {weekday: "long", day: "numeric", month: "long"}); } catch { return d; } };
const uid = () => Math.random().toString(36).slice(2, 9);
const newCode = () => String(Math.floor(100000 + Math.random() * 900000));
const clone = o => JSON.parse(JSON.stringify(o));
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2800); }

/* ---------- firebase ---------- */
const configured = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).includes("PASTE");
let app, auth, db;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  setPersistence(auth, browserLocalPersistence).catch(() => {});
}
const ref = path => doc(db, ...path.split("/"));

/* per-document write queue: latest data wins, one write in flight per path */
const Q = {};
function saveDoc(path, data){
  const q = Q[path] || (Q[path] = {busy: false, next: null});
  q.next = clone(data);
  if (q.busy) return;
  (async () => {
    q.busy = true;
    while (q.next) {
      const d = q.next; q.next = null;
      try { await setDoc(ref(path), d); }
      catch (e) { handleWriteErr(e); q.next = null; }
    }
    q.busy = false;
  })();
}
const pending = path => { const q = Q[path]; return !!(q && (q.busy || q.next)); };
function handleWriteErr(e){
  console.error(e);
  if (e && e.code === "permission-denied") toast("ما عندك صلاحية تحفظ هذا التعديل");
  else toast("تعذّر الحفظ، تأكد من الاتصال وحاول مرة ثانية");
}

/* ---------- state ---------- */
const S = {
  authUser: null, adminRole: null, me: null, authReady: false,
  pub: null, trainers: {}, groups: {}, secrets: {},
  loaded: {trainers: false, groups: false},
  view: "home", subs: [],
  tGroup: null, tDate: today(), tTab: "roll",
  att: null, attPath: null, unsubAtt: null, groupAtt: [], unsubGroupAtt: null,
  aTab: "dash", aDash: [], unsubDash: null, aReportGroup: null, aReport: [], unsubReport: null,
};

/* ---------- boot ---------- */
if (!configured) {
  $("#app").innerHTML = `<div class="notice err">البوابة تحتاج إعدادات Firebase. افتح الملف <b>config.js</b> والصق فيه إعدادات مشروعك، مثل ما هو مشروح في ملف README.</div>`;
} else {
  onSnapshot(ref("public/trainers"), snap => { S.pub = snap.exists() ? snap.data() : {list: {}}; if (!S.authUser) render(); }, () => { S.pub = {list: {}}; render(); });
  onAuthStateChanged(auth, user => {
    stopAll();
    S.authUser = user; S.adminRole = null; S.me = null; S.authReady = true;
    if (!user) { S.view = S.view === "trainer" || S.view === "admin" ? "home" : S.view; render(); return; }
    const role = Object.keys(ROLE_EMAIL).find(k => ROLE_EMAIL[k] === user.email);
    if (role) { S.adminRole = role; S.view = "admin"; }
    else { S.view = "trainer"; }
    startData();
    render();
  });
}

function startData(){
  S.loaded = {trainers: false, groups: false};
  S.subs.push(onSnapshot(collection(db, "trainers"), snap => {
    S.trainers = {}; snap.docs.forEach(d => S.trainers[d.id] = {id: d.id, ...d.data()});
    if (!S.adminRole) {
      const t = Object.values(S.trainers).find(t => t.uid === S.authUser.uid);
      S.me = t ? t.id : null;
    }
    S.loaded.trainers = true; afterData();
  }, err => fail(err)));
  S.subs.push(onSnapshot(collection(db, "groups"), snap => {
    S.groups = {}; snap.docs.forEach(d => S.groups[d.id] = {id: d.id, ...d.data()});
    S.loaded.groups = true; afterData();
  }, err => fail(err)));
  if (S.adminRole) {
    S.subs.push(onSnapshot(collection(db, "secrets"), snap => { S.secrets = {}; snap.docs.forEach(d => S.secrets[d.id] = d.data().code); if (S.view === "admin") render(); }, () => {}));
  }
}
function fail(err){ console.error(err); $("#app").innerHTML = `<div class="notice err">تعذّر تحميل البيانات. ${err && err.code === "permission-denied" ? "حسابك ما عنده صلاحية." : "تأكد من الاتصال وحدّث الصفحة."}</div>`; }
function stopAll(){ S.subs.forEach(u => u()); S.subs = []; stopAtt(); stopAdminSubs(); S.trainers = {}; S.groups = {}; S.secrets = {}; }

function afterData(){
  if (S.view === "trainer" && S.tGroup && !S.groups[S.tGroup]) { S.tGroup = null; stopAtt(); }
  if (S.view === "admin" && $("#modal").classList.contains("on") && S._modalGroup) renderModalStudents();
  if (!(S.view === "trainer" && editingInList())) render();
}
function editingInList(){ const a = document.activeElement; return a && a.closest && a.closest("#roll") && a.tagName === "INPUT"; }

/* ---------- top bar ---------- */
const trainerTitle = t => (t.gender === "f" ? "المدربة " : "المدرب ") + t.name;
function renderTop(){
  const w = $("#topWho");
  if (S.authUser && S.view === "trainer") {
    $("#topSub").textContent = "بوابة المدربين";
    const t = S.trainers[S.me];
    w.innerHTML = `<span>${t ? esc(trainerTitle(t)) : ""}</span><button class="btn ghost sm" id="out">خروج</button>`;
  } else if (S.authUser && S.view === "admin") {
    $("#topSub").textContent = "بوابة الشؤون الأكاديمية";
    w.innerHTML = `<span>${esc(ROLES[S.adminRole] || "")}</span><button class="btn ghost sm" id="out">خروج</button>`;
  } else if (S.view === "trainerLogin" || S.view === "adminLogin") {
    $("#topSub").textContent = S.view === "trainerLogin" ? "بوابة المدربين" : "بوابة الشؤون الأكاديمية";
    w.innerHTML = `<button class="btn ghost sm" id="homeBtn">الرئيسية</button>`;
  } else { $("#topSub").textContent = "بوابة الحضور والانصراف"; w.innerHTML = ""; }
  if ($("#out")) $("#out").onclick = () => { S.view = "home"; signOut(auth); };
  if ($("#homeBtn")) $("#homeBtn").onclick = () => go("home");
}
function go(v){ S.view = v; render(); window.scrollTo(0, 0); }

/* ---------- render root ---------- */
function render(){
  if (!configured) return;
  renderTop();
  const app = $("#app");
  if (!S.authReady) { app.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري التحميل…</p></div>`; return; }
  if (!S.authUser) {
    if (S.view === "trainerLogin") return renderTrainerLogin(app);
    if (S.view === "adminLogin") return renderAdminLogin(app);
    return renderHome(app);
  }
  if (!S.loaded.groups || !S.loaded.trainers) { app.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري تحميل البيانات…</p></div>`; return; }
  if (S.view === "admin") return renderAdmin(app);
  return renderTrainer(app);
}

/* ---------- home & logins ---------- */
function renderHome(app){
  app.innerHTML = `
  <div class="card"><h2>اختر البوابة</h2><p class="muted" style="margin:0">اليوم ${esc(fmtDate(today()))}</p></div>
  <div class="portals">
    <button class="portal t" id="goT"><b>بوابة المدربين</b><span class="muted">ادخل باسمك ورمزك الخاص، وحضّر طلابك وسجّل وقت الحضور والانصراف.</span></button>
    <button class="portal" id="goA"><b>بوابة الشؤون الأكاديمية</b><span class="muted">إضافة المدربين ورموزهم، توزيع الطلاب على المقررات، ومتابعة تقارير الحضور.</span></button>
  </div>`;
  $("#goT").onclick = () => go("trainerLogin");
  $("#goA").onclick = () => go("adminLogin");
}
function loginErr(e){
  const c = e && e.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-login")) return "الرمز غير صحيح.";
  if (c.includes("too-many-requests")) return "محاولات كثيرة، انتظر شوي وحاول مرة ثانية.";
  if (c.includes("network")) return "ما فيه اتصال بالإنترنت.";
  return "تعذّر الدخول. حاول مرة ثانية.";
}
function renderTrainerLogin(app){
  const list = Object.entries((S.pub && S.pub.list) || {}).map(([id, t]) => ({id, ...t})).sort((a,b) => a.name.localeCompare(b.name, "ar"));
  app.innerHTML = `
  <div class="card" style="max-width:460px;width:100%;justify-self:center">
    <h2>دخول المدربين</h2>
    <form id="lf" class="list" autocomplete="off">
      <label class="f" for="lt">الاسم
        <select id="lt" required><option value="">اختر اسمك</option>${list.map(t => `<option value="${esc(t.id)}">${esc(trainerTitle(t))}</option>`).join("")}</select>
      </label>
      <label class="f" for="lc">الرمز الخاص
        <input type="password" id="lc" inputmode="numeric" required placeholder="الرمز اللي عطتك إياه الإدارة">
      </label>
      <div id="lerr"></div>
      <button class="btn pri" type="submit" id="lb">دخول</button>
    </form>
  </div>`;
  $("#lf").onsubmit = async e => {
    e.preventDefault();
    const t = S.pub.list[$("#lt").value]; if (!t) return;
    $("#lb").disabled = true;
    try { S.view = "trainer"; await signInWithEmailAndPassword(auth, t.email, $("#lc").value.trim()); }
    catch (err) { S.view = "trainerLogin"; $("#lerr").innerHTML = `<div class="notice err">${loginErr(err)}</div>`; $("#lb").disabled = false; }
  };
}
function renderAdminLogin(app){
  app.innerHTML = `
  <div class="card" style="max-width:460px;width:100%;justify-self:center">
    <h2>دخول الشؤون الأكاديمية</h2>
    <form id="alf" class="list" autocomplete="off">
      <label class="f" for="ar">الصفة<select id="ar">${Object.entries(ROLES).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <label class="f" for="ac">الرمز<input type="password" id="ac" inputmode="numeric" required placeholder="رمز الدخول"></label>
      <div id="aerr"></div>
      <button class="btn pri" type="submit" id="ab2">دخول</button>
    </form>
  </div>`;
  $("#alf").onsubmit = async e => {
    e.preventDefault();
    $("#ab2").disabled = true;
    try { S.view = "admin"; await signInWithEmailAndPassword(auth, ROLE_EMAIL[$("#ar").value], $("#ac").value.trim()); }
    catch (err) { S.view = "adminLogin"; $("#aerr").innerHTML = `<div class="notice err">${loginErr(err)}</div>`; $("#ab2").disabled = false; }
  };
}

/* ---------- trainer portal ---------- */
const myGroups = () => Object.values(S.groups).filter(g => g.trainerId === S.me).sort((a,b) => (a.course||"").localeCompare(b.course||"", "ar"));
const countG = (g, gen) => (g.students||[]).filter(s => s.gender === gen).length;
function startAtt(){
  stopAtt();
  if (!S.tGroup) return;
  const path = `att/${S.tGroup}_${S.tDate}`; S.attPath = path; S.att = null;
  S.unsubAtt = onSnapshot(ref(path), snap => {
    if (pending(path)) return;
    S.att = snap.exists() ? snap.data() : null;
    if (!editingInList()) render();
  }, () => toast("تعذّر تحميل التحضير"));
  S.unsubGroupAtt = onSnapshot(query(collection(db, "att"), where("groupId", "==", S.tGroup)), snap => {
    S.groupAtt = snap.docs.map(d => d.data()); if (S.tTab === "hist") render();
  }, () => {});
}
function stopAtt(){ if (S.unsubAtt) S.unsubAtt(); if (S.unsubGroupAtt) S.unsubGroupAtt(); S.unsubAtt = S.unsubGroupAtt = null; S.att = null; S.groupAtt = []; }
function attData(){
  const g = S.groups[S.tGroup];
  return S.att ? clone(S.att) : {groupId: g.id, trainerId: g.trainerId || "", course: g.course, date: S.tDate, rec: {}};
}
function commitAtt(d){ d.trainerId = S.groups[S.tGroup].trainerId || ""; d.updatedAt = new Date().toISOString(); S.att = d; saveDoc(S.attPath, d); }
function setRec(sid, patch){
  const d = attData(); d.rec = d.rec || {};
  const r = Object.assign({}, d.rec[sid] || {}, patch);
  Object.keys(r).forEach(k => { if (r[k] === null || r[k] === "" || r[k] === undefined) delete r[k]; });
  d.rec[sid] = r; commitAtt(d);
}

function renderTrainer(app){
  const t = S.trainers[S.me];
  if (!t) { app.innerHTML = `<div class="notice err">هذا الحساب غير مربوط بمدرب. تواصل مع الشؤون الأكاديمية.</div>`; return; }
  if (!S.tGroup) {
    const gs = myGroups();
    app.innerHTML = `
    <div class="card"><h2>أهلاً ${esc(trainerTitle(t))}</h2><p class="muted" style="margin:0">اختر المقرر اللي تبي تحضّره. أي طالب تضيفه الشؤون الأكاديمية يظهر هنا مباشرة.</p></div>
    ${gs.length ? `<div class="ggrid">${gs.map(g => `
      <button class="groupcard" data-g="${esc(g.id)}">
        <span style="font-weight:700;color:var(--green)">${esc(g.course)}</span>
        <span class="muted">${(g.students||[]).length} متدرب ${g.mode ? "· " + esc(g.mode) : ""}</span>
        <span class="muted">${countG(g,"m")} طالب · ${countG(g,"f")} طالبة</span>
      </button>`).join("")}</div>`
      : `<div class="card empty">ما فيه مقررات مسجلة باسمك حتى الآن. أول ما تضيفك الشؤون الأكاديمية لمقرر بيظهر هنا.</div>`}`;
    app.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { S.tGroup = b.dataset.g; S.tDate = today(); S.tTab = "roll"; startAtt(); render(); });
    return;
  }
  const g = S.groups[S.tGroup];
  if (!S.unsubAtt) startAtt();
  const st = g.students || [];
  const rec = (S.att && S.att.rec) || {};
  const c = {p:0,l:0,a:0,e:0,n:0}; st.forEach(s => { const r = rec[s.id]; if (r && r.st) c[r.st]++; else c.n++; });
  const head = `
  <div class="card">
    <div class="row"><button class="btn sm" id="back">→ المقررات</button><span class="pill">${esc(g.mode || "—")}</span></div>
    <h2 style="margin-top:10px">${esc(g.course)}</h2>
    <div class="row">
      <label class="f" for="d" style="min-width:170px">تاريخ المحاضرة<input type="date" id="d" value="${esc(S.tDate)}" max="${today()}"></label>
      <div class="tabs" style="border:0;padding:0;margin-inline-start:auto">
        <button class="tab ${S.tTab==="roll"?"on":""}" data-tab="roll">التحضير</button>
        <button class="tab ${S.tTab==="hist"?"on":""}" data-tab="hist">سجل الحضور</button>
      </div>
    </div>
  </div>`;
  let body;
  if (S.tTab === "roll") {
    body = `
    <div class="sticky"><div class="card" style="padding:12px">
      <div class="stats">
        <div class="stat"><div class="n">${c.p}</div><div class="l">حاضر</div></div>
        <div class="stat"><div class="n">${c.l}</div><div class="l">متأخر</div></div>
        <div class="stat"><div class="n">${c.a}</div><div class="l">غائب</div></div>
        <div class="stat"><div class="n">${c.e}</div><div class="l">مستأذن</div></div>
        <div class="stat"><div class="n">${c.n}</div><div class="l">لم يُحضّر</div></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn pri sm" id="allP">تحضير الباقي حاضر الآن</button>
        <button class="btn sm" id="allOut">انصراف الحاضرين الآن</button>
        <button class="btn sm" id="allA">الباقي غائب</button>
      </div>
    </div></div>
    <div class="list" id="roll">${st.length ? st.map((s,i) => stuRow(s,i,rec[s.id]||{})).join("") : `<div class="card empty">ما فيه طلاب في هذا المقرر بعد.</div>`}</div>`;
  } else body = `<div class="card"><h2>سجل الحضور</h2>${matrixTable(g, S.groupAtt)}</div>`;
  app.innerHTML = head + body;
  $("#back").onclick = () => { S.tGroup = null; stopAtt(); render(); };
  $("#d").onchange = e => { if (e.target.value) { S.tDate = e.target.value; startAtt(); render(); } };
  app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tTab = b.dataset.tab; render(); });
  if (S.tTab === "roll") bindRoll(st, rec); else bindCopy();
}
function stuRow(s, i, r){
  const stc = r.st || "";
  return `<div class="stu ${stc}" data-s="${esc(s.id)}">
    <span class="num">${i+1}</span>
    <span class="nm">${esc(s.name)} <span class="pill ${s.gender}">${GENDER[s.gender]||""}</span></span>
    <div class="ctl">
      <div class="seg" role="group" aria-label="الحالة">${["p","l","a","e"].map(k => `<button class="${k} ${stc===k?"on":""}" data-st="${k}">${STATUS[k]}</button>`).join("")}</div>
      <div class="times">
        <label for="in-${esc(s.id)}">حضور</label><input type="time" id="in-${esc(s.id)}" data-in value="${esc(r.in||"")}">
        <label for="out-${esc(s.id)}">انصراف</label><input type="time" id="out-${esc(s.id)}" data-out value="${esc(r.out||"")}">
        <button class="btn sm" data-outnow>انصراف الآن</button>
      </div>
    </div>
  </div>`;
}
function bindRoll(st, rec){
  $("#roll").querySelectorAll(".stu").forEach(row => {
    const sid = row.dataset.s, cur = rec[sid] || {};
    row.querySelectorAll("[data-st]").forEach(b => b.onclick = () => {
      const k = b.dataset.st;
      if (cur.st === k) setRec(sid, {st: null});
      else {
        const patch = {st: k};
        if ((k === "p" || k === "l") && !cur.in) patch.in = nowHM();
        if (k === "a") { patch.in = null; patch.out = null; }
        setRec(sid, patch);
      }
      render();
    });
    row.querySelector("[data-in]").onchange = e => { const v = e.target.value; setRec(sid, {in: v || null, st: v && !cur.st ? "p" : cur.st}); render(); };
    row.querySelector("[data-out]").onchange = e => { setRec(sid, {out: e.target.value || null}); render(); };
    row.querySelector("[data-outnow]").onclick = () => { const patch = {out: nowHM()}; if (!cur.st) patch.st = "p"; setRec(sid, patch); render(); };
  });
  const bulk = fn => { const d = attData(); d.rec = d.rec || {}; st.forEach(s => fn(s, d.rec)); commitAtt(d); render(); };
  $("#allP").onclick = () => bulk((s, R) => { if (!R[s.id] || !R[s.id].st) R[s.id] = {st: "p", in: nowHM()}; });
  $("#allOut").onclick = () => bulk((s, R) => { const r = R[s.id]; if (r && (r.st === "p" || r.st === "l") && !r.out) r.out = nowHM(); });
  $("#allA").onclick = () => bulk((s, R) => { if (!R[s.id] || !R[s.id].st) R[s.id] = {st: "a"}; });
}

/* ---------- attendance matrix ---------- */
function matrix(g, docs){
  const sessions = docs.filter(d => d && d.date).sort((a,b) => a.date.localeCompare(b.date));
  const rows = (g.students||[]).map((s,i) => {
    const cells = sessions.map(d => (d.rec && d.rec[s.id]) || {});
    const k = {p:0,l:0,a:0,e:0};
    cells.forEach(r => { if (r.st) k[r.st]++; else k.a++; });
    const rate = sessions.length ? Math.round((k.p + k.l) / sessions.length * 100) : null;
    return {s, i, cells, k, rate};
  });
  return {sessions, rows};
}
function matrixTable(g, docs){
  const {sessions, rows} = matrix(g, docs);
  if (!sessions.length) return `<div class="card empty">ما فيه محاضرات مسجلة لهذا المقرر بعد.</div>`;
  const cell = r => r.st ? `<span class="pill ${r.st}">${STATUS[r.st]}</span>${r.in ? `<div class="muted" style="font-size:11.5px">${fmtTime(r.in)}${r.out ? " ← " + fmtTime(r.out) : ""}</div>` : ""}` : `<span class="muted">—</span>`;
  return `<div class="row" style="justify-content:space-between"><span class="muted">${sessions.length} محاضرة مسجلة · الخانة الفاضية تُحسب غياب</span><button class="btn sm" id="copyT">نسخ الجدول</button></div>
  <div class="tbl"><table id="mt"><thead><tr><th>م</th><th class="nm">الاسم</th><th>الحضور</th><th>غياب</th><th>تأخير</th><th>استئذان</th>${sessions.map(d => `<th>${esc(d.date.slice(5))}</th>`).join("")}</tr></thead>
  <tbody>${rows.map(r => `<tr><td>${r.i+1}</td><td class="nm">${esc(r.s.name)}</td>
    <td><div class="row" style="gap:6px;flex-wrap:nowrap"><b>${r.rate}%</b><span class="bar"><i style="width:${r.rate}%"></i></span></div></td>
    <td>${r.k.a}</td><td>${r.k.l}</td><td>${r.k.e}</td>${r.cells.map(c => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function bindCopy(){
  const b = $("#copyT"); if (!b) return;
  b.onclick = async () => {
    const tsv = [...$("#mt").rows].map(tr => [...tr.cells].map(td => td.innerText.replace(/\s+/g, " ").trim()).join("\t")).join("\n");
    try { await navigator.clipboard.writeText(tsv); toast("انتسخ الجدول، الصقه في Excel"); } catch { toast("المتصفح منع النسخ"); }
  };
}

/* ---------- admin portal ---------- */
function stopAdminSubs(){ if (S.unsubDash) S.unsubDash(); if (S.unsubReport) S.unsubReport(); S.unsubDash = S.unsubReport = null; }
const tName = id => id && S.trainers[id] ? trainerTitle(S.trainers[id]) : "بدون مدرب";
const sortedGroups = () => Object.values(S.groups).sort((a,b) => (a.course||"").localeCompare(b.course||"","ar") || tName(a.trainerId).localeCompare(tName(b.trainerId),"ar"));

function renderAdmin(app){
  const tabs = [["dash","لوحة اليوم"],["groups","المقررات والطلاب"],["trainers","المدربين والرموز"],["report","التقارير"]];
  app.innerHTML = `<div class="card" style="padding:10px 12px"><div class="tabs" style="border:0;padding:0">${tabs.map(([k,v]) => `<button class="tab ${S.aTab===k?"on":""}" data-at="${k}">${v}</button>`).join("")}</div></div><div id="ab"></div>`;
  app.querySelectorAll("[data-at]").forEach(b => b.onclick = () => { S.aTab = b.dataset.at; render(); });
  const ab = $("#ab");
  ({dash: adminDash, groups: adminGroups, trainers: adminTrainers, report: adminReport})[S.aTab](ab);
}

function adminDash(el){
  if (!S.unsubDash) {
    S.unsubDash = onSnapshot(query(collection(db, "att"), where("date", "==", today())), snap => { S.aDash = snap.docs.map(d => d.data()); if (S.view === "admin" && S.aTab === "dash") render(); }, () => {});
  }
  const byG = {}; S.aDash.forEach(d => byG[d.groupId] = d);
  const gs = sortedGroups();
  let pres = 0, abs = 0, done = 0;
  const rows = gs.map(g => {
    const d = byG[g.id], n = (g.students||[]).length;
    const c = {p:0,l:0,a:0,e:0}; if (d) { done++; Object.values(d.rec||{}).forEach(r => r.st && c[r.st]++); }
    pres += c.p + c.l; abs += c.a;
    return `<tr><td class="nm">${esc(g.course)}</td><td class="nm">${esc(tName(g.trainerId))}</td><td>${n}</td>
      <td>${d ? `<span class="pill p">${c.p + c.l}</span>` : "—"}</td><td>${d ? `<span class="pill a">${c.a}</span>` : "—"}</td><td>${d ? c.e : "—"}</td>
      <td>${d ? `<span class="pill p">تم التحضير</span>` : `<span class="pill">لم يُحضّر</span>`}</td></tr>`;
  }).join("");
  el.innerHTML = `
  <div class="card"><h2>لوحة اليوم · ${esc(fmtDate(today()))}</h2>
    <div class="stats">
      <div class="stat"><div class="n">${done}/${gs.length}</div><div class="l">شعب تم تحضيرها</div></div>
      <div class="stat"><div class="n">${pres}</div><div class="l">حاضر ومتأخر</div></div>
      <div class="stat"><div class="n">${abs}</div><div class="l">غائب</div></div>
      <div class="stat"><div class="n">${Object.keys(S.trainers).length}</div><div class="l">مدرب ومدربة</div></div>
    </div></div>
  ${gs.length ? "" : `<div class="notice">البوابة فاضية. روح لتبويب "المدربين والرموز" واستورد ملف البيانات الأولية.</div>`}
  <div class="tbl"><table><thead><tr><th class="nm">المقرر</th><th class="nm">المدرب/ة</th><th>العدد</th><th>حاضر</th><th>غائب</th><th>مستأذن</th><th>الحالة</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty">ما فيه مقررات بعد</td></tr>`}</tbody></table></div>`;
}

function adminGroups(el){
  const gs = sortedGroups();
  const unassigned = gs.filter(g => !g.trainerId || !S.trainers[g.trainerId]).length;
  el.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">المقررات والطلاب</h2><button class="btn gold" id="newG">+ شعبة مقرر جديدة</button></div>
  <p class="muted" style="margin:8px 0 0">كل شعبة = مقرر + مدرب أو مدربة + طلابهم. أي تعديل هنا يظهر في بوابة المدرب فوراً.</p>
  ${unassigned ? `<div class="notice" style="margin-top:10px">فيه ${unassigned} شعبة بدون مدرب. افتحها واختر المدرب عشان تظهر في بوابته.</div>` : ""}
  <div class="row" style="margin-top:10px"><input type="text" id="gq" class="grow" placeholder="ابحث باسم مقرر أو مدرب أو طالب"></div></div>
  <div class="list" id="glist"></div>`;
  const draw = q => {
    q = (q||"").trim();
    const list = gs.filter(g => !q || (g.course||"").includes(q) || tName(g.trainerId).includes(q) || (g.students||[]).some(s => s.name.includes(q)));
    $("#glist").innerHTML = list.map(g => `
      <div class="item"><div class="grow"><div class="t">${esc(g.course)}</div>
        <div class="muted">${esc(tName(g.trainerId))} ${g.mode ? "· " + esc(g.mode) : ""} · ${(g.students||[]).length} متدرب (${countG(g,"m")} طالب، ${countG(g,"f")} طالبة)</div></div>
        ${!g.trainerId || !S.trainers[g.trainerId] ? `<span class="pill warn">بدون مدرب</span>` : ""}
        <button class="btn sm" data-eg="${esc(g.id)}">فتح وتعديل</button></div>`).join("") || `<div class="card empty">ما فيه نتائج</div>`;
    $("#glist").querySelectorAll("[data-eg]").forEach(b => b.onclick = () => openGroup(b.dataset.eg));
  };
  draw(""); $("#gq").oninput = e => draw(e.target.value);
  $("#newG").onclick = () => openGroup(null);
}

function trainerOptions(sel){ return `<option value="">بدون مدرب</option>` + Object.values(S.trainers).sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t => `<option value="${esc(t.id)}" ${t.id===sel?"selected":""}>${esc(trainerTitle(t))}</option>`).join(""); }
function closeModal(){ $("#modal").classList.remove("on"); S._modalGroup = null; render(); }
function openGroup(id){
  const g = id ? S.groups[id] : null;
  S._modalGroup = id || ("g-" + uid());
  const courses = [...new Set(Object.values(S.groups).map(x => x.course))].sort((a,b)=>a.localeCompare(b,"ar"));
  $("#modalBox").innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-family:var(--display);color:var(--green);font-weight:600">${g ? "تعديل شعبة" : "شعبة مقرر جديدة"}</h2><button class="btn sm" id="mx">إغلاق</button></div>
    <div class="row">
      <label class="f grow" for="mc">المقرر<input type="text" id="mc" list="courses" value="${esc(g ? g.course : "")}" placeholder="اسم المقرر"></label>
      <datalist id="courses">${courses.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
      <label class="f grow" for="mt2">المدرب/ة<select id="mt2">${trainerOptions(g ? g.trainerId : "")}</select></label>
      <label class="f" for="mm" style="min-width:130px">نمط الحضور<select id="mm"><option value="">—</option>${["حضوري","عن بعد"].map(m => `<option ${g && g.mode===m?"selected":""}>${m}</option>`).join("")}</select></label>
    </div>
    <div class="row"><button class="btn pri" id="msave">حفظ بيانات الشعبة</button>${g ? `<button class="btn danger" id="mdel">حذف الشعبة</button>` : ""}</div>
    <hr style="border:0;border-top:1px solid var(--line);margin:0">
    <div><h3>الطلاب (<span id="mcount">0</span>)</h3><div class="chips" id="mstu"></div></div>
    <div class="card" style="background:var(--bg)">
      <h3>إضافة طلاب</h3>
      <label class="f" for="madd">اكتب كل اسم في سطر<textarea id="madd" placeholder="محمد عبدالله&#10;سعود عبدالله"></textarea></label>
      <div class="row" style="margin-top:8px">
        <select id="mg" style="width:auto"><option value="m">طلاب</option><option value="f">طالبات</option></select>
        <button class="btn pri" id="maddB">إضافة للشعبة</button>
      </div>
      <div class="row" style="margin-top:10px">
        <select id="mcopy" class="grow"><option value="">نسخ الطلاب من شعبة أخرى…</option>${sortedGroups().filter(x => x.id !== id).map(x => `<option value="${esc(x.id)}">${esc(x.course)} · ${esc(tName(x.trainerId))} (${(x.students||[]).length})</option>`).join("")}</select>
        <button class="btn" id="mcopyB">نسخ</button>
      </div>
    </div>`;
  $("#modal").classList.add("on");
  renderModalStudents();
  $("#mx").onclick = closeModal;
  const base = () => { const c = S.groups[S._modalGroup]; const d = c ? clone(c) : {course: "", trainerId: "", mode: "", students: []}; delete d.id; return d; };
  const header = d => { d.course = $("#mc").value.trim(); d.trainerId = $("#mt2").value; d.mode = $("#mm").value; return d; };
  const write = d => { S.groups[S._modalGroup] = {id: S._modalGroup, ...d}; saveDoc("groups/" + S._modalGroup, d); renderModalStudents(); };
  $("#msave").onclick = () => { if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر"); write(header(base())); toast("تم الحفظ"); };
  $("#maddB").onclick = () => {
    if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر أولاً");
    const names = $("#madd").value.split(/\n+/).map(s => s.replace(/^[\s\d\-.)،]+/, "").trim()).filter(Boolean);
    if (!names.length) return;
    const d = header(base()), have = new Set(d.students.map(s => s.name)), gen = $("#mg").value; let n = 0;
    names.forEach(nm => { if (!have.has(nm)) { d.students.push({id: "s" + uid(), name: nm, gender: gen}); n++; } });
    write(d); $("#madd").value = ""; toast(`انضاف ${n} ${gen === "f" ? "طالبة" : "طالب"}`);
  };
  $("#mcopyB").onclick = () => {
    const src = S.groups[$("#mcopy").value]; if (!src) return;
    if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر أولاً");
    const d = header(base()), have = new Set(d.students.map(s => s.name)); let n = 0;
    (src.students||[]).forEach(s => { if (!have.has(s.name)) { d.students.push({id: "s" + uid(), name: s.name, gender: s.gender}); n++; } });
    write(d); toast(`انضاف ${n} متدرب`);
  };
  if (g) $("#mdel").onclick = () => {
    const b = $("#mdel");
    if (b.dataset.sure) { deleteDoc(ref("groups/" + S._modalGroup)).then(() => toast("انحذفت الشعبة")).catch(handleWriteErr); delete S.groups[S._modalGroup]; closeModal(); }
    else { b.dataset.sure = "1"; b.textContent = "متأكد؟ اضغط مرة ثانية للحذف"; }
  };
}
function renderModalStudents(){
  const g = S.groups[S._modalGroup]; const st = (g && g.students) || [];
  const box = $("#mstu"); if (!box) return;
  $("#mcount").textContent = st.length;
  box.innerHTML = st.length ? st.map(s => `<span class="chip"><span class="pill ${s.gender}">${GENDER[s.gender]}</span>${esc(s.name)}<button aria-label="حذف ${esc(s.name)}" data-rm="${esc(s.id)}">×</button></span>`).join("") : `<span class="muted">ما فيه طلاب بعد</span>`;
  box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
    const d = clone(S.groups[S._modalGroup]); delete d.id; d.students = d.students.filter(s => s.id !== b.dataset.rm);
    S.groups[S._modalGroup] = {id: S._modalGroup, ...d}; saveDoc("groups/" + S._modalGroup, d); renderModalStudents();
  });
}

/* trainer accounts: created through a second Firebase app so the admin stays signed in */
let secAuth = null;
async function createTrainerAccount(tid, code){
  if (!secAuth) secAuth = getAuth(initializeApp(firebaseConfig, "secondary"));
  const t = S.trainers[tid];
  const ver = ((t && t.ver) || 0) + 1;
  const email = `${tid}.v${ver}@${DOMAIN}`;
  const cred = await createUserWithEmailAndPassword(secAuth, email, code);
  await signOut(secAuth);
  return {uid: cred.user.uid, email, ver};
}
function publicList(over){
  const list = {};
  Object.values(over || S.trainers).forEach(t => { if (t.email) list[t.id] = {name: t.name, gender: t.gender, email: t.email}; });
  return {list};
}
async function saveTrainer(tid, data, code){
  const b = writeBatch(db);
  b.set(ref("trainers/" + tid), data);
  if (code) b.set(ref("secrets/" + tid), {code});
  const all = {...S.trainers, [tid]: {id: tid, ...data}};
  b.set(ref("public/trainers"), publicList(all));
  await b.commit();
}

function adminTrainers(el){
  const ts = Object.values(S.trainers).sort((a,b)=>a.name.localeCompare(b.name,"ar"));
  el.innerHTML = `
  <div class="card"><h2>المدربين والرموز</h2>
    <p class="muted" style="margin-top:0">كل مدرب يدخل بوابته باسمه ورمزه. أرسل الرمز للمدرب بشكل خاص.</p>
    <form id="nt" class="row" autocomplete="off">
      <input type="text" id="ntn" class="grow" placeholder="اسم المدرب أو المدربة" required>
      <select id="ntg" style="width:auto"><option value="m">مدرب</option><option value="f">مدربة</option></select>
      <button class="btn gold" type="submit" id="ntb">+ إضافة</button>
    </form>
  </div>
  <div class="list">${ts.map(t => {
    const gs = Object.values(S.groups).filter(g => g.trainerId === t.id);
    const n = gs.reduce((a,g) => a + (g.students||[]).length, 0);
    return `<div class="item"><div class="grow"><div class="t">${esc(trainerTitle(t))}</div><div class="muted">${gs.length} شعبة · ${n} متدرب${gs.length ? " · " + gs.map(g => esc(g.course)).join("، ") : ""}</div></div>
      <span class="code">${esc(S.secrets[t.id] || "••••••")}</span>
      <button class="btn sm" data-copy="${esc(t.id)}">نسخ الرمز</button>
      <button class="btn sm" data-new="${esc(t.id)}">رمز جديد</button>
      <button class="btn sm danger" data-del="${esc(t.id)}">حذف</button></div>`; }).join("")}</div>
  <div class="card"><h2>استيراد البيانات الأولية</h2>
    <p class="muted" style="margin-top:0">اختر ملف <b>asas-seed.json</b> مرة وحدة بس عند التشغيل الأول. ينشئ المدربين برموزهم ويضيف المقررات والطلاب.</p>
    <div class="row"><input type="file" id="seedF" accept=".json,application/json" class="grow"><button class="btn pri" id="seedB">استيراد</button></div>
    <div id="seedLog" class="muted" style="margin-top:8px"></div>
  </div>`;
  $("#nt").onsubmit = async e => {
    e.preventDefault();
    const name = $("#ntn").value.trim(); if (!name) return;
    $("#ntb").disabled = true;
    const tid = "t-" + uid(), code = newCode();
    try {
      const acc = await createTrainerAccount(tid, code);
      const data = {name, gender: $("#ntg").value, ...acc};
      await saveTrainer(tid, data, code);
      toast(`انضاف ${name} · الرمز ${code}`);
    } catch (err) { handleWriteErr(err); }
    $("#ntb").disabled = false;
  };
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    const t = S.trainers[b.dataset.copy], code = S.secrets[t.id];
    const msg = `${trainerTitle(t)}، رمز دخولك لبوابة التحضير في معهد أسس: ${code}\nرابط البوابة: ${location.href.split("#")[0]}`;
    try { await navigator.clipboard.writeText(msg); toast("انتسخت رسالة الرمز"); } catch { toast("المتصفح منع النسخ"); }
  });
  el.querySelectorAll("[data-new]").forEach(b => b.onclick = async () => {
    const tid = b.dataset.new, code = newCode(); b.disabled = true;
    try {
      const acc = await createTrainerAccount(tid, code);
      const data = clone(S.trainers[tid]); delete data.id; Object.assign(data, acc);
      await saveTrainer(tid, data, code);
      toast("انعمل رمز جديد، الرمز القديم ما عاد يشتغل");
    } catch (err) { handleWriteErr(err); b.disabled = false; }
  });
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "متأكد؟"; return; }
    const tid = b.dataset.del, batch = writeBatch(db);
    Object.values(S.groups).filter(g => g.trainerId === tid).forEach(g => batch.update(ref("groups/" + g.id), {trainerId: ""}));
    batch.delete(ref("trainers/" + tid)); batch.delete(ref("secrets/" + tid));
    const rest = {...S.trainers}; delete rest[tid];
    batch.set(ref("public/trainers"), publicList(rest));
    try { await batch.commit(); toast("انحذف المدرب، وشعبه صارت بدون مدرب"); } catch (err) { handleWriteErr(err); }
  });
  $("#seedB").onclick = async () => {
    const f = $("#seedF").files[0]; if (!f) return toast("اختر الملف أولاً");
    let data; try { data = JSON.parse(await f.text()); } catch { return toast("الملف غير صالح"); }
    const log = m => { $("#seedLog").textContent = m; };
    $("#seedB").disabled = true;
    try {
      const all = {...S.trainers};
      for (const t of data.trainers || []) {
        if (S.trainers[t.id]) { log(`${t.name}: موجود من قبل`); continue; }
        log(`إنشاء حساب ${t.name}…`);
        S.trainers[t.id] = {id: t.id, ver: 0};
        const acc = await createTrainerAccount(t.id, t.code);
        const d = {name: t.name, gender: t.gender, ...acc};
        all[t.id] = {id: t.id, ...d};
        const b2 = writeBatch(db); b2.set(ref("trainers/" + t.id), d); b2.set(ref("secrets/" + t.id), {code: t.code}); await b2.commit();
      }
      const b3 = writeBatch(db);
      b3.set(ref("public/trainers"), publicList(all));
      (data.groups || []).forEach(g => { const d = clone(g); delete d.id; b3.set(ref("groups/" + g.id), d); });
      await b3.commit();
      log(`تم: ${(data.trainers||[]).length} مدرب و${(data.groups||[]).length} شعبة.`);
      toast("اكتمل الاستيراد");
    } catch (err) { console.error(err); log("توقف الاستيراد: " + (err.code || err.message)); }
    $("#seedB").disabled = false;
  };
}

function adminReport(el){
  const gs = sortedGroups();
  if (!S.aReportGroup || !S.groups[S.aReportGroup]) S.aReportGroup = gs[0] && gs[0].id;
  el.innerHTML = `<div class="card"><h2>تقرير الحضور</h2>
    <label class="f" for="rg">الشعبة<select id="rg">${gs.map(g => `<option value="${esc(g.id)}" ${g.id===S.aReportGroup?"selected":""}>${esc(g.course)} · ${esc(tName(g.trainerId))}</option>`).join("")}</select></label></div>
    <div id="rbody"></div>`;
  $("#rg").onchange = e => { S.aReportGroup = e.target.value; if (S.unsubReport) S.unsubReport(); S.unsubReport = null; S.aReport = []; render(); };
  if (!S.aReportGroup) { $("#rbody").innerHTML = `<div class="card empty">ما فيه شعب بعد</div>`; return; }
  if (!S.unsubReport) {
    S.unsubReport = onSnapshot(query(collection(db, "att"), where("groupId", "==", S.aReportGroup)), snap => { S.aReport = snap.docs.map(d => d.data()); if (S.view === "admin" && S.aTab === "report") render(); }, () => {});
  }
  $("#rbody").innerHTML = `<div class="card">${matrixTable(S.groups[S.aReportGroup], S.aReport)}</div>`;
  bindCopy();
}

render();
