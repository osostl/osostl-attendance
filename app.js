import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, query, where, onSnapshot, setDoc, deleteDoc, writeBatch, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

/* ---------- constants ---------- */
const DOMAIN = "osostl.local";                       // login emails are internal, never mailed
const ROLE_EMAIL = {admin: "admin@" + DOMAIN, academic: "acadmic@" + DOMAIN};
const ROLES = {admin: "الإدارة", academic: "مسؤول الشؤون الأكاديمية"};
const STATUS = {p: "حاضر", l: "متأخر", a: "غائب", e: "مستأذن"};
const GENDER = {m: "طالب", f: "طالبة"};
const GSTAT = {none: "لم تُرصد", draft: "مسودة عند المدرب", submitted: "بانتظار الاعتماد", returned: "معادة للمدرب", approved: "معتمدة ومنشورة"};
const GSTAT_PILL = {none: "", draft: "", submitted: "l", returned: "a", approved: "p"};
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
const TZ = "Asia/Riyadh";
const PASS = 60;

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
const digits = s => String(s || "").trim().replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const norm = s => String(s || "").trim().replace(/\s+/g, " ").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "").replace(/عبد ال/g, "عبدال");
const letter = m => m >= 90 ? "ممتاز" : m >= 80 ? "جيد جداً" : m >= 70 ? "جيد" : m >= PASS ? "مقبول" : "راسب";
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 3000); }

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

/* accounts are created through a second Firebase app so the admin stays signed in */
let secAuth = null;
async function createAccount(prefix, oldVer, password){
  if (!secAuth) secAuth = getAuth(initializeApp(firebaseConfig, "secondary"));
  let ver = (oldVer || 0) + 1;
  for (let tries = 0; tries < 4; tries++, ver++) {
    const email = `${prefix}.v${ver}@${DOMAIN}`;
    try {
      const cred = await createUserWithEmailAndPassword(secAuth, email, password);
      await signOut(secAuth);
      return {uid: cred.user.uid, email, ver};
    } catch (e) {
      if (e.code !== "auth/email-already-in-use") throw e;
    }
  }
  throw new Error("email-in-use");
}
const accountErr = e => (e && e.code === "auth/too-many-requests")
  ? "Firebase وقف إنشاء الحسابات مؤقتاً (حد الساعة). انتظر ساعة وكمّل، أو ارفع الحد من Authentication ← Settings."
  : "تعذّر إنشاء الحساب: " + ((e && (e.code || e.message)) || "?");

/* ---------- state ---------- */
const S = {
  authUser: null, role: null, adminRole: null, me: null, myNum: null, authReady: false,
  pub: null, trainers: {}, groups: {}, secrets: {}, students: {}, stSecrets: {}, grades: {},
  myStudent: null, myAtt: [], myResults: [],
  loaded: {trainers: false, groups: false},
  view: "home", subs: [],
  tGroup: null, tDate: today(), tTab: "roll",
  att: null, attPath: null, unsubAtt: null, groupAtt: [], unsubGroupAtt: null,
  aTab: "dash", aDash: [], unsubDash: null, aReportGroup: null, aReport: [], unsubReport: null, aGradeGroup: null,
};

/* ---------- boot ---------- */
if (!configured) {
  $("#app").innerHTML = `<div class="notice err">البوابة تحتاج إعدادات Firebase في ملف config.js.</div>`;
} else {
  onAuthStateChanged(auth, user => {
    stopAll();
    S.authUser = user; S.role = null; S.adminRole = null; S.me = null; S.myNum = null; S.authReady = true;
    if (!user) { if (["trainer","admin","student"].includes(S.view)) S.view = "home"; render(); return; }
    const local = (user.email || "").split("@")[0];
    const role = Object.keys(ROLE_EMAIL).find(k => ROLE_EMAIL[k] === user.email);
    if (role) { S.role = "admin"; S.adminRole = role; S.view = "admin"; }
    else if (local.startsWith("st-")) { S.role = "student"; S.myNum = local.split(".")[0].slice(3); S.view = "student"; }
    else { S.role = "trainer"; S.view = "trainer"; }
    startData();
    render();
  });
}

function sub(q, fn){ S.subs.push(onSnapshot(q, fn, err => fail(err))); }
function startData(){
  S.loaded = {trainers: false, groups: false};
  sub(collection(db, "trainers"), snap => {
    S.trainers = {}; snap.docs.forEach(d => S.trainers[d.id] = {id: d.id, ...d.data()});
    if (S.role === "trainer") { const t = Object.values(S.trainers).find(t => t.uid === S.authUser.uid); S.me = t ? t.id : null; }
    S.loaded.trainers = true; afterData();
  });
  if (S.role === "student") {
    sub(ref("students/" + S.myNum), snap => { S.myStudent = snap.exists() ? snap.data() : null; afterData(); });
    sub(query(collection(db, "groups"), where("memberNums", "array-contains", S.myNum)), snap => {
      S.groups = {}; snap.docs.forEach(d => S.groups[d.id] = {id: d.id, ...d.data()}); S.loaded.groups = true; afterData();
    });
    S.subs.push(onSnapshot(query(collection(db, "att"), where("memberNums", "array-contains", S.myNum)), snap => { S.myAtt = snap.docs.map(d => d.data()); render(); }, () => {}));
    S.subs.push(onSnapshot(query(collection(db, "results"), where("num", "==", S.myNum)), snap => { S.myResults = snap.docs.map(d => d.data()); render(); }, () => {}));
    return;
  }
  sub(collection(db, "groups"), snap => {
    S.groups = {}; snap.docs.forEach(d => S.groups[d.id] = {id: d.id, ...d.data()});
    S.loaded.groups = true; afterData();
  });
  S.subs.push(onSnapshot(collection(db, "grades"), snap => { S.grades = {}; snap.docs.forEach(d => S.grades[d.id] = d.data()); afterData(); }, () => {}));
  if (S.role === "admin") {
    S.subs.push(onSnapshot(collection(db, "secrets"), snap => { S.secrets = {}; snap.docs.forEach(d => S.secrets[d.id] = d.data().code); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "students"), snap => { S.students = {}; snap.docs.forEach(d => S.students[d.id] = d.data()); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "studentSecrets"), snap => { S.stSecrets = {}; snap.docs.forEach(d => S.stSecrets[d.id] = d.data().code); afterData(); }, () => {}));
  }
}
function fail(err){ console.error(err); $("#app").innerHTML = `<div class="notice err">تعذّر تحميل البيانات. ${err && err.code === "permission-denied" ? "حسابك ما عنده صلاحية، أو قواعد الحماية في Firebase تحتاج تحديث." : "تأكد من الاتصال وحدّث الصفحة."}</div>`; }
function stopAll(){ S.subs.forEach(u => u()); S.subs = []; stopAtt(); stopAdminSubs(); S.trainers = {}; S.groups = {}; S.secrets = {}; S.students = {}; S.stSecrets = {}; S.grades = {}; S.myStudent = null; S.myAtt = []; S.myResults = []; S._trainerSynced = false; }

function afterData(){
  if (S.role === "admin") syncTrainerNumbers();
  if (S.view === "trainer" && S.tGroup && !S.groups[S.tGroup]) { S.tGroup = null; stopAtt(); }
  if (S.view === "admin" && $("#modal").classList.contains("on") && S._modalGroup) renderModalStudents();
  if (busyEditing()) return;
  render();
}
function busyEditing(){
  const a = document.activeElement;
  if (!a || !a.closest) return false;
  if (S._busy) return true;
  return (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !!a.closest("#roll, #gradesBox, #ab");
}

/* ---------- top bar ---------- */
const trainerTitle = t => (t.gender === "f" ? "المدربة " : "المدرب ") + t.name;
function renderTop(){
  const w = $("#topWho"), sub = $("#topSub");
  const label = {trainer: "بوابة المدربين", admin: "بوابة الشؤون الأكاديمية", student: "بوابة الطلاب", trainerLogin: "بوابة المدربين", adminLogin: "بوابة الشؤون الأكاديمية", studentLogin: "بوابة الطلاب"}[S.view] || "بوابة الحضور والانصراف";
  sub.textContent = label;
  if (S.authUser) {
    let who = "";
    if (S.role === "trainer" && S.trainers[S.me]) who = trainerTitle(S.trainers[S.me]);
    if (S.role === "admin") who = ROLES[S.adminRole];
    if (S.role === "student" && S.myStudent) who = S.myStudent.name;
    w.innerHTML = `<span>${esc(who)}</span><button class="btn ghost sm" id="out">خروج</button>`;
    $("#out").onclick = () => { S.view = "home"; signOut(auth); };
  } else if (S.view !== "home") {
    w.innerHTML = `<button class="btn ghost sm" id="homeBtn">الرئيسية</button>`;
    $("#homeBtn").onclick = () => go("home");
  } else w.innerHTML = "";
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
    if (S.view === "studentLogin") return renderStudentLogin(app);
    return renderHome(app);
  }
  if (!S.loaded.groups || !S.loaded.trainers) { app.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري تحميل البيانات…</p></div>`; return; }
  if (S.role === "admin") return renderAdmin(app);
  if (S.role === "student") return renderStudent(app);
  return renderTrainer(app);
}

/* ---------- home & logins ---------- */
function renderHome(app){
  app.innerHTML = `
  <div class="card"><h2>اختر البوابة</h2><p class="muted" style="margin:0">اليوم ${esc(fmtDate(today()))}</p></div>
  <div class="portals">
    <button class="portal t" id="goS"><b>بوابة الطلاب</b><span class="muted">ادخل برقمك الأكاديمي ورمزك، وشوف جدولك وحضورك ودرجاتك المعتمدة.</span></button>
    <button class="portal t" id="goT"><b>بوابة المدربين</b><span class="muted">ادخل برقمك ورمزك، وحضّر طلابك وارصد الدرجات.</span></button>
    <button class="portal" id="goA"><b>بوابة الشؤون الأكاديمية</b><span class="muted">المدربون والطلاب والمقررات، واعتماد الدرجات والتقارير.</span></button>
  </div>`;
  $("#goS").onclick = () => go("studentLogin");
  $("#goT").onclick = () => go("trainerLogin");
  $("#goA").onclick = () => go("adminLogin");
}
function loginErr(e){
  const c = (e && e.code) || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-login")) return "الرمز غير صحيح.";
  if (c.includes("too-many-requests")) return "محاولات كثيرة، انتظر شوي وحاول مرة ثانية.";
  if (c.includes("network")) return "ما فيه اتصال بالإنترنت.";
  if (c.includes("unauthorized-domain")) return "رابط الموقع غير مضاف في Firebase ← Authentication ← Settings ← Authorized domains.";
  return "تعذّر الدخول. (" + (c || (e && e.message) || "?") + ")";
}
function loginCard(title, fields, onSubmit){
  return `<div class="card" style="max-width:460px;width:100%;justify-self:center"><h2>${title}</h2>
    <form id="lf" class="list" autocomplete="off">${fields}<div id="lerr"></div><button class="btn pri" type="submit" id="lb">دخول</button></form></div>`;
}
async function doLogin(fn, back){
  $("#lb").disabled = true;
  try { await fn(); }
  catch (err) { S.view = back; render(); $("#lerr").innerHTML = `<div class="notice err">${esc(err.userMsg || loginErr(err))}</div>`; }
}
function renderTrainerLogin(app){
  app.innerHTML = loginCard("دخول المدربين", `
    <label class="f" for="tn">رقم المدرب<input type="text" id="tn" inputmode="numeric" required placeholder="مثل 1001"></label>
    <label class="f" for="lc">الرمز<input type="password" id="lc" inputmode="numeric" required></label>`);
  $("#lf").onsubmit = e => {
    e.preventDefault();
    const num = digits($("#tn").value), code = digits($("#lc").value);
    doLogin(async () => {
      const snap = await getDoc(ref("public/trainerLogin"));
      const email = snap.exists() && snap.data().map && snap.data().map[num];
      if (!email) { const er = new Error("no"); er.userMsg = "رقم المدرب غير موجود. تأكد منه من الشؤون الأكاديمية."; throw er; }
      await signInWithEmailAndPassword(auth, email, code);
    }, "trainerLogin");
  };
}
function renderAdminLogin(app){
  app.innerHTML = loginCard("دخول الشؤون الأكاديمية", `
    <label class="f" for="ar">الصفة<select id="ar">${Object.entries(ROLES).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label class="f" for="ac">الرمز<input type="password" id="ac" inputmode="numeric" required></label>`);
  $("#lf").onsubmit = e => { e.preventDefault(); const email = ROLE_EMAIL[$("#ar").value], code = digits($("#ac").value); doLogin(() => signInWithEmailAndPassword(auth, email, code), "adminLogin"); };
}
function renderStudentLogin(app){
  app.innerHTML = loginCard("دخول الطلاب", `
    <label class="f" for="sn">الرقم الأكاديمي<input type="text" id="sn" inputmode="numeric" required placeholder="مثل 20260001"></label>
    <label class="f" for="sc">الرمز<input type="password" id="sc" inputmode="numeric" required></label>`);
  $("#lf").onsubmit = e => {
    e.preventDefault();
    const num = digits($("#sn").value), code = digits($("#sc").value);
    doLogin(async () => {
      const snap = await getDoc(ref("public/studentLogin"));
      const ver = snap.exists() && snap.data().map && snap.data().map[num];
      if (!ver) { const er = new Error("no"); er.userMsg = "الرقم الأكاديمي غير موجود. تأكد منه من الشؤون الأكاديمية."; throw er; }
      await signInWithEmailAndPassword(auth, `st-${num}.v${ver}@${DOMAIN}`, code);
    }, "studentLogin");
  };
}

/* ---------- shared: schedule ---------- */
const sessionsFor = (g, gender) => (g.sessions || []).filter(s => !s.g || !gender || s.g === gender);
const slot = s => `${s.day} ${fmtTime(s.from)} – ${fmtTime(s.to)}${s.room ? " · " + s.room : ""}`;
function weekTable(rows){
  // rows: [{course, trainer, s}]
  if (!rows.length) return `<div class="card empty">ما فيه جدول مسجّل بعد.</div>`;
  const shifts = [...new Set(rows.map(r => r.s.shift || ""))];
  return shifts.map(sh => {
    const rs = rows.filter(r => (r.s.shift || "") === sh).sort((a,b) => DAYS.indexOf(a.s.day) - DAYS.indexOf(b.s.day) || a.s.from.localeCompare(b.s.from));
    return `<h3 style="margin:12px 0 6px">${esc(sh ? "الفترة " + sh.replace("صباحي","الصباحية").replace("مسائي","المسائية") : "الجدول")}</h3>
    <div class="tbl"><table><thead><tr><th>اليوم</th><th>الوقت</th><th class="nm">المقرر</th><th class="nm">المدرب/ة</th><th>القاعة</th></tr></thead><tbody>
    ${rs.map(r => `<tr><td>${esc(r.s.day)}</td><td>${fmtTime(r.s.from)} – ${fmtTime(r.s.to)}</td><td class="nm">${esc(r.course)}</td><td class="nm">${esc(r.trainer)}</td><td>${esc(r.s.room || "—")}</td></tr>`).join("")}
    </tbody></table></div>`;
  }).join("");
}

/* ---------- student portal ---------- */
function renderStudent(app){
  const st = S.myStudent;
  if (!st) { app.innerHTML = `<div class="notice err">ما لقينا سجلك. تواصل مع الشؤون الأكاديمية.</div>`; return; }
  const gs = Object.values(S.groups).sort((a,b) => (a.course||"").localeCompare(b.course||"","ar"));
  const res = {}; S.myResults.forEach(r => res[r.groupId] = r);
  const cards = gs.map(g => {
    const entry = (g.students || []).find(s => s.sid === S.myNum);
    const docs = S.myAtt.filter(d => d.groupId === g.id);
    let pres = 0; docs.forEach(d => { const r = entry && d.rec && d.rec[entry.id]; if (r && (r.st === "p" || r.st === "l")) pres++; });
    const rate = docs.length ? Math.round(pres / docs.length * 100) : null;
    return {g, rate, sessions: docs.length, pres, r: res[g.id]};
  });
  const rated = cards.filter(c => c.rate !== null);
  const avgAtt = rated.length ? Math.round(rated.reduce((a,c) => a + c.rate, 0) / rated.length) : null;
  const approved = cards.filter(c => c.r);
  const avgMark = approved.length ? (approved.reduce((a,c) => a + c.r.mark, 0) / approved.length).toFixed(1) : null;
  const rows = []; gs.forEach(g => sessionsFor(g, st.gender).forEach(s => rows.push({course: g.course, trainer: tName(g.trainerId), s})));
  app.innerHTML = `
  <div class="card">
    <h2>${esc(st.name)}</h2>
    <div class="row"><span class="code">${esc(st.num)}</span><span class="pill ${st.gender}">${GENDER[st.gender] || ""}</span></div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><div class="n">${gs.length}</div><div class="l">مقررات</div></div>
      <div class="stat"><div class="n">${avgAtt === null ? "—" : avgAtt + "%"}</div><div class="l">متوسط الحضور</div></div>
      <div class="stat"><div class="n">${approved.length}/${gs.length}</div><div class="l">درجات معتمدة</div></div>
      <div class="stat"><div class="n">${avgMark === null ? "—" : avgMark}</div><div class="l">متوسط الدرجات</div></div>
    </div>
  </div>
  <div class="card"><h2>مقرراتي ودرجاتي</h2>
    <div class="list">${cards.map(c => `
      <div class="item" style="align-items:flex-start">
        <div class="grow">
          <div class="t">${esc(c.g.course)}</div>
          <div class="muted">${esc(tName(c.g.trainerId))}${c.g.mode ? " · " + esc(c.g.mode) : ""}</div>
          <div class="muted" style="margin-top:4px">الحضور: ${c.rate === null ? "ما بدأ التحضير" : `${c.pres} من ${c.sessions} محاضرة (${c.rate}%)`}</div>
          ${c.rate === null ? "" : `<span class="bar" style="display:block;margin-top:6px;max-width:220px"><i style="width:${c.rate}%"></i></span>`}
        </div>
        <div style="text-align:center;min-width:92px">
          ${c.r ? `<div style="font-size:26px;font-weight:700;color:var(--green)">${c.r.mark}</div><span class="pill ${c.r.mark >= PASS ? "p" : "a"}">${letter(c.r.mark)}</span>` : `<span class="pill">لم تُعتمد بعد</span>`}
        </div>
      </div>`).join("") || `<div class="empty">ما فيه مقررات مسجلة لك بعد.</div>`}</div>
  </div>
  <div class="card"><h2>جدولي الأسبوعي</h2>${weekTable(rows)}</div>`;
}

/* ---------- trainer portal ---------- */
const myGroups = () => Object.values(S.groups).filter(g => g.trainerId === S.me).sort((a,b) => (a.course||"").localeCompare(b.course||"", "ar"));
const countG = (g, gen) => (g.students||[]).filter(s => s.gender === gen).length;
const gradeStatus = gid => (S.grades[gid] && S.grades[gid].status) || "none";
function startAtt(){
  stopAtt();
  if (!S.tGroup) return;
  const path = `att/${S.tGroup}_${S.tDate}`; S.attPath = path; S.att = null;
  S.unsubAtt = onSnapshot(ref(path), snap => {
    if (pending(path)) return;
    S.att = snap.exists() ? snap.data() : null;
    if (!busyEditing()) render();
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
function commitAtt(d){
  const g = S.groups[S.tGroup];
  d.trainerId = g.trainerId || ""; d.memberNums = g.memberNums || []; d.updatedAt = new Date().toISOString();
  S.att = d; saveDoc(S.attPath, d);
}
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
    const rows = []; gs.forEach(g => (g.sessions || []).forEach(s => rows.push({course: g.course + (s.g ? ` (${s.g === "f" ? "طالبات" : "طلاب"})` : ""), trainer: trainerTitle(t), s})));
    app.innerHTML = `
    <div class="card"><h2>أهلاً ${esc(trainerTitle(t))}</h2><p class="muted" style="margin:0">اختر المقرر للتحضير أو رصد الدرجات.</p></div>
    ${gs.length ? `<div class="ggrid">${gs.map(g => `
      <button class="groupcard" data-g="${esc(g.id)}">
        <span style="font-weight:700;color:var(--green)">${esc(g.course)}</span>
        <span class="muted">${(g.students||[]).length} متدرب ${g.mode ? "· " + esc(g.mode) : ""}</span>
        <span><span class="pill ${GSTAT_PILL[gradeStatus(g.id)]}">الدرجات: ${GSTAT[gradeStatus(g.id)]}</span></span>
      </button>`).join("")}</div>
      <div class="card"><h2>جدولي</h2>${weekTable(rows)}</div>`
      : `<div class="card empty">ما فيه مقررات مسجلة باسمك حتى الآن.</div>`}`;
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
      ${S.tTab === "roll" ? `<label class="f" for="d" style="min-width:170px">تاريخ المحاضرة<input type="date" id="d" value="${esc(S.tDate)}" max="${today()}"></label>` : ""}
      <div class="tabs" style="border:0;padding:0;margin-inline-start:auto">
        <button class="tab ${S.tTab==="roll"?"on":""}" data-tab="roll">التحضير</button>
        <button class="tab ${S.tTab==="hist"?"on":""}" data-tab="hist">سجل الحضور</button>
        <button class="tab ${S.tTab==="grades"?"on":""}" data-tab="grades">الدرجات</button>
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
  } else if (S.tTab === "hist") body = `<div class="card"><h2>سجل الحضور</h2>${matrixTable(g, S.groupAtt)}</div>`;
  else body = gradesEditor(g, "trainer");
  app.innerHTML = head + body;
  $("#back").onclick = () => { S.tGroup = null; stopAtt(); render(); };
  if ($("#d")) $("#d").onchange = e => { if (e.target.value) { S.tDate = e.target.value; startAtt(); render(); } };
  app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tTab = b.dataset.tab; render(); });
  if (S.tTab === "roll") bindRoll(st, rec);
  else if (S.tTab === "hist") bindCopy();
  else bindGrades(g, "trainer");
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

/* ---------- grades (trainer + admin) ---------- */
function gradesEditor(g, who){
  const gd = S.grades[g.id] || {};
  const status = gd.status || "none";
  const marks = gd.marks || {};
  const editable = who === "admin" ? status !== "approved" : ["none", "draft", "returned"].includes(status);
  const st = g.students || [];
  const filled = st.filter(s => typeof marks[s.id] === "number").length;
  return `<div class="card" id="gradesBox">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">الدرجات · ${esc(g.course)}</h2><span class="pill ${GSTAT_PILL[status]}">${GSTAT[status]}</span></div>
    ${who === "admin" ? `<p class="muted" style="margin:6px 0 0">${esc(tName(g.trainerId))}</p>` : ""}
    ${status === "returned" && gd.note ? `<div class="notice" style="margin-top:10px"><b>ملاحظة الشؤون الأكاديمية:</b> ${esc(gd.note)}</div>` : ""}
    ${who === "trainer" && status === "submitted" ? `<div class="notice" style="margin-top:10px">رفعت الدرجات، وهي الحين عند الشؤون الأكاديمية للاعتماد. ما تقدر تعدّلها إلا إذا رجعوها لك.</div>` : ""}
    ${status === "approved" ? `<div class="notice" style="margin-top:10px">الدرجات معتمدة وتظهر للطلاب في بوابتهم.</div>` : ""}
    <p class="muted">الدرجة من 100، والنجاح من ${PASS}. مرصود ${filled} من ${st.length}.</p>
    <div class="tbl"><table><thead><tr><th>م</th><th class="nm">الاسم</th><th>الرقم</th><th>الدرجة</th><th>التقدير</th></tr></thead><tbody>
    ${st.map((s,i) => { const m = marks[s.id]; return `<tr><td>${i+1}</td><td class="nm">${esc(s.name)}</td><td>${esc(s.sid || "—")}</td>
      <td>${editable ? `<input type="number" min="0" max="100" step="0.5" data-mark="${esc(s.id)}" value="${typeof m === "number" ? m : ""}" style="width:84px;padding:6px">` : (typeof m === "number" ? `<b>${m}</b>` : "—")}</td>
      <td>${typeof m === "number" ? `<span class="pill ${m >= PASS ? "p" : "a"}">${letter(m)}</span>` : ""}</td></tr>`; }).join("")}
    </tbody></table></div>
    <div class="row" style="margin-top:12px">${gradeButtons(who, status)}</div>
    ${who === "admin" && status !== "approved" ? `<label class="f" for="gnote" style="margin-top:10px">ملاحظة للمدرب عند الإرجاع<input type="text" id="gnote" value="${esc(gd.note || "")}"></label>` : ""}
  </div>`;
}
function gradeButtons(who, status){
  if (who === "trainer") {
    if (!["none", "draft", "returned"].includes(status)) return "";
    return `<button class="btn" id="gSave">حفظ كمسودة</button><button class="btn pri" id="gSubmit">رفع للشؤون الأكاديمية</button>`;
  }
  if (status === "approved") return `<button class="btn danger" id="gUnapprove">إلغاء الاعتماد وإخفاؤها عن الطلاب</button>`;
  return `<button class="btn" id="gSave">حفظ</button><button class="btn pri" id="gApprove">اعتماد ونشر للطلاب</button>${status === "submitted" ? `<button class="btn danger" id="gReturn">إرجاع للمدرب</button>` : ""}`;
}
function readMarks(g){
  const marks = {}; let bad = false;
  document.querySelectorAll("[data-mark]").forEach(inp => {
    const v = inp.value.trim(); if (v === "") return;
    const n = Number(v);
    if (isNaN(n) || n < 0 || n > 100) { bad = true; inp.style.borderColor = "var(--abs)"; } else marks[inp.dataset.mark] = n;
  });
  return bad ? null : marks;
}
function bindGrades(g, who){
  const gd = () => S.grades[g.id] || {};
  const base = status => {
    const marks = readMarks(g); if (!marks) { toast("فيه درجة غير صحيحة، لازم تكون بين 0 و100"); return null; }
    return {groupId: g.id, trainerId: g.trainerId || "", course: g.course, status, marks, memberNums: g.memberNums || [], note: gd().note || "", updatedAt: new Date().toISOString()};
  };
  const put = async d => { S.grades[g.id] = d; try { await setDoc(ref("grades/" + g.id), d); return true; } catch (e) { handleWriteErr(e); return false; } };
  const allFilled = d => (g.students || []).every(s => typeof d.marks[s.id] === "number");
  document.querySelectorAll("[data-mark]").forEach(inp => inp.oninput = () => { const v = Number(inp.value); const td = inp.closest("tr").lastElementChild; td.innerHTML = inp.value === "" || isNaN(v) ? "" : `<span class="pill ${v >= PASS ? "p" : "a"}">${letter(v)}</span>`; });
  if ($("#gSave")) $("#gSave").onclick = async () => { const d = base(who === "trainer" ? "draft" : (gd().status && gd().status !== "none" ? gd().status : "draft")); if (d && await put(d)) { toast("انحفظت الدرجات"); render(); } };
  if ($("#gSubmit")) $("#gSubmit").onclick = async () => {
    const d = base("submitted"); if (!d) return;
    if (!allFilled(d)) return toast("ارصد درجات كل الطلاب قبل الرفع");
    d.submittedAt = new Date().toISOString();
    if (await put(d)) { toast("ارتفعت الدرجات للشؤون الأكاديمية"); render(); }
  };
  if ($("#gReturn")) $("#gReturn").onclick = async () => {
    const d = base("returned"); if (!d) return; d.note = $("#gnote").value.trim();
    if (await put(d)) { toast("رجعت الدرجات للمدرب"); render(); }
  };
  if ($("#gApprove")) $("#gApprove").onclick = async () => {
    const d = base("approved"); if (!d) return;
    if (!allFilled(d)) return toast("فيه طلاب بدون درجة");
    const missing = (g.students || []).filter(s => !s.sid);
    if (missing.length) return toast(`فيه ${missing.length} طالب بدون رقم أكاديمي، اربطهم أول من تبويب الطلاب`);
    d.approvedAt = new Date().toISOString(); d.approvedBy = S.adminRole; d.note = "";
    const b = writeBatch(db);
    b.set(ref("grades/" + g.id), d);
    (g.students || []).forEach(s => b.set(ref(`results/${s.sid}_${g.id}`), {num: s.sid, groupId: g.id, course: g.course, trainer: tName(g.trainerId), mark: d.marks[s.id], approvedAt: d.approvedAt}));
    try { await b.commit(); S.grades[g.id] = d; toast("اعتُمدت الدرجات وظهرت للطلاب"); render(); } catch (e) { handleWriteErr(e); }
  };
  if ($("#gUnapprove")) $("#gUnapprove").onclick = async () => {
    const btn = $("#gUnapprove");
    if (!btn.dataset.sure) { btn.dataset.sure = "1"; btn.textContent = "متأكد؟ اضغط مرة ثانية"; return; }
    const d = clone(gd()); d.status = "returned"; d.note = "أُلغي الاعتماد للمراجعة";
    const b = writeBatch(db);
    b.set(ref("grades/" + g.id), d);
    try {
      const rs = await getDocs(query(collection(db, "results"), where("groupId", "==", g.id)));
      rs.docs.forEach(x => b.delete(x.ref));
      await b.commit(); S.grades[g.id] = d; toast("أُلغي الاعتماد"); render();
    } catch (e) { handleWriteErr(e); }
  };
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
const memberNums = students => [...new Set((students || []).map(s => s.sid).filter(Boolean))];
const nextNum = () => { const nums = Object.keys(S.students).map(Number).filter(n => n > 20260000); return String(Math.max(20260000, ...nums) + 1); };
function findStudent(name, gender){
  const k = norm(name);
  return Object.values(S.students).find(s => norm(s.name) === k && (!gender || s.gender === gender));
}
async function createStudent(name, gender, num, code){
  num = num || nextNum(); code = code || newCode();
  S.students[num] = {num, name, gender};             // reserve the number locally
  const acc = await createAccount("st-" + num, 0, code);
  const d = {num, name, gender, ...acc};
  const pubSnap = await getDoc(ref("public/studentLogin"));
  const map = (pubSnap.exists() && pubSnap.data().map) || {};
  map[num] = acc.ver;
  const b = writeBatch(db);
  b.set(ref("students/" + num), d); b.set(ref("studentSecrets/" + num), {code}); b.set(ref("public/studentLogin"), {map});
  await b.commit();
  S.students[num] = d; S.stSecrets[num] = code;
  return d;
}
function writeGroup(gid, d){
  delete d.id; d.memberNums = memberNums(d.students);
  S.groups[gid] = {id: gid, ...d}; saveDoc("groups/" + gid, d);
}

function renderAdmin(app){
  const tabs = [["dash","لوحة اليوم"],["groups","المقررات والطلاب"],["students","الطلاب"],["trainers","المدربين والرموز"],["grades","الدرجات"],["report","التقارير"]];
  const waiting = Object.values(S.grades).filter(x => x.status === "submitted").length;
  app.innerHTML = `<div class="card" style="padding:10px 12px"><div class="tabs" style="border:0;padding:0">${tabs.map(([k,v]) => `<button class="tab ${S.aTab===k?"on":""}" data-at="${k}">${v}${k === "grades" && waiting ? ` (${waiting})` : ""}</button>`).join("")}</div></div><div id="ab"></div>`;
  app.querySelectorAll("[data-at]").forEach(b => b.onclick = () => { S.aTab = b.dataset.at; render(); });
  ({dash: adminDash, groups: adminGroups, students: adminStudents, trainers: adminTrainers, grades: adminGrades, report: adminReport})[S.aTab]($("#ab"));
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
  const nStu = Object.keys(S.students).length;
  el.innerHTML = `
  <div class="card"><h2>لوحة اليوم · ${esc(fmtDate(today()))}</h2>
    <div class="stats">
      <div class="stat"><div class="n">${done}/${gs.length}</div><div class="l">شعب تم تحضيرها</div></div>
      <div class="stat"><div class="n">${pres}</div><div class="l">حاضر ومتأخر</div></div>
      <div class="stat"><div class="n">${abs}</div><div class="l">غائب</div></div>
      <div class="stat"><div class="n">${nStu}</div><div class="l">طالب وطالبة</div></div>
    </div></div>
  ${nStu ? "" : `<div class="notice">ما فيه حسابات طلاب بعد. روح لتبويب "الطلاب" واستورد ملف asas-students.json.</div>`}
  <div class="tbl"><table><thead><tr><th class="nm">المقرر</th><th class="nm">المدرب/ة</th><th>العدد</th><th>حاضر</th><th>غائب</th><th>مستأذن</th><th>الحالة</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty">ما فيه مقررات بعد</td></tr>`}</tbody></table></div>`;
}

function adminGroups(el){
  const gs = sortedGroups();
  const unassigned = gs.filter(g => !g.trainerId || !S.trainers[g.trainerId]).length;
  el.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">المقررات والطلاب</h2><button class="btn gold" id="newG">+ شعبة مقرر جديدة</button></div>
  <p class="muted" style="margin:8px 0 0">كل شعبة = مقرر + مدرب أو مدربة + طلابهم + جدولها. أي تعديل يظهر للمدرب والطالب فوراً.</p>
  ${unassigned ? `<div class="notice" style="margin-top:10px">فيه ${unassigned} شعبة بدون مدرب.</div>` : ""}
  <div class="row" style="margin-top:10px"><input type="text" id="gq" class="grow" placeholder="ابحث باسم مقرر أو مدرب أو طالب أو رقم"></div></div>
  <div class="list" id="glist"></div>`;
  const draw = q => {
    q = norm(q || "");
    const list = gs.filter(g => !q || norm(g.course).includes(q) || norm(tName(g.trainerId)).includes(q) || (g.students||[]).some(s => norm(s.name).includes(q) || (s.sid || "").includes(q)));
    $("#glist").innerHTML = list.map(g => `
      <div class="item"><div class="grow"><div class="t">${esc(g.course)}</div>
        <div class="muted">${esc(tName(g.trainerId))} ${g.mode ? "· " + esc(g.mode) : ""} · ${(g.students||[]).length} متدرب (${countG(g,"m")} طالب، ${countG(g,"f")} طالبة) · ${(g.sessions||[]).length} موعد</div></div>
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
      <label class="f grow" for="mc">المقرر<input type="text" id="mc" list="courses" value="${esc(g ? g.course : "")}"></label>
      <datalist id="courses">${courses.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
      <label class="f grow" for="mt2">المدرب/ة<select id="mt2">${trainerOptions(g ? g.trainerId : "")}</select></label>
      <label class="f" for="mm" style="min-width:130px">نمط الحضور<select id="mm"><option value="">—</option>${["حضوري","عن بعد"].map(m => `<option ${g && g.mode===m?"selected":""}>${m}</option>`).join("")}</select></label>
    </div>
    <div class="row"><button class="btn pri" id="msave">حفظ بيانات الشعبة</button>${g ? `<button class="btn danger" id="mdel">حذف الشعبة</button>` : ""}</div>
    <hr style="border:0;border-top:1px solid var(--line);margin:0">
    <div><h3>الجدول</h3><div class="list" id="msess"></div>
      <div class="row" style="margin-top:8px">
        <select id="ssh" style="width:auto"><option>صباحي</option><option>مسائي</option></select>
        <select id="sday" style="width:auto">${DAYS.map(d => `<option>${d}</option>`).join("")}</select>
        <input type="time" id="sfrom" style="width:120px"><input type="time" id="sto" style="width:120px">
        <input type="text" id="sroom" placeholder="قاعة 1 / عن بعد" style="width:140px">
        <select id="sg" style="width:auto"><option value="">الكل</option><option value="m">طلاب</option><option value="f">طالبات</option></select>
        <button class="btn sm" id="saddS">+ موعد</button>
      </div></div>
    <hr style="border:0;border-top:1px solid var(--line);margin:0">
    <div><h3>الطلاب (<span id="mcount">0</span>)</h3><div class="chips" id="mstu"></div></div>
    <div class="card" style="background:var(--bg)">
      <h3>إضافة طلاب</h3>
      <p class="muted" style="margin-top:0">اكتب الاسم أو الرقم الأكاديمي، كل واحد في سطر. إذا الطالب موجود ينربط بسجله، وإذا جديد ينعمل له رقم ورمز.</p>
      <label class="f" for="madd">الأسماء أو الأرقام<textarea id="madd"></textarea></label>
      <div class="row" style="margin-top:8px">
        <select id="mg" style="width:auto"><option value="m">طلاب</option><option value="f">طالبات</option></select>
        <button class="btn pri" id="maddB">إضافة للشعبة</button>
      </div>
      <div id="maddLog" class="muted" style="margin-top:6px"></div>
      <div class="row" style="margin-top:10px">
        <select id="mcopy" class="grow"><option value="">نسخ الطلاب من شعبة أخرى…</option>${sortedGroups().filter(x => x.id !== id).map(x => `<option value="${esc(x.id)}">${esc(x.course)} · ${esc(tName(x.trainerId))} (${(x.students||[]).length})</option>`).join("")}</select>
        <button class="btn" id="mcopyB">نسخ</button>
      </div>
    </div>`;
  $("#modal").classList.add("on");
  renderModalStudents();
  $("#mx").onclick = closeModal;
  const base = () => { const c = S.groups[S._modalGroup]; const d = c ? clone(c) : {course: "", trainerId: "", mode: "", students: [], sessions: []}; delete d.id; return d; };
  const header = d => { d.course = $("#mc").value.trim(); d.trainerId = $("#mt2").value; d.mode = $("#mm").value; return d; };
  const write = d => { writeGroup(S._modalGroup, d); renderModalStudents(); };
  $("#msave").onclick = () => { if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر"); write(header(base())); toast("تم الحفظ"); };
  $("#saddS").onclick = () => {
    if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر أولاً");
    const s = {shift: $("#ssh").value, day: $("#sday").value, from: $("#sfrom").value, to: $("#sto").value, room: $("#sroom").value.trim(), g: $("#sg").value};
    if (!s.from || !s.to) return toast("حدد وقت البداية والنهاية");
    const d = header(base()); d.sessions = [...(d.sessions || []), s]; write(d);
  };
  $("#maddB").onclick = async () => {
    if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر أولاً");
    const lines = $("#madd").value.split(/\n+/).map(s => s.replace(/^[\s\-.)،]*(\d{1,3}[\s\-.)]+)?/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    const gen = $("#mg").value, log = m => { const l = $("#maddLog"); if (l) l.textContent = m; };
    $("#maddB").disabled = true; S._busy = true;
    const d = header(base()); let added = 0, created = 0;
    try {
      for (const line of lines) {
        let st = /^2026\d{4}$/.test(line) ? S.students[line] : findStudent(line, gen) || findStudent(line);
        if (!st || !st.uid) { if (/^\d+$/.test(line)) { log(`الرقم ${line} غير موجود`); continue; } log(`إنشاء رقم لـ ${line}…`); st = await createStudent(line, gen); created++; }
        if (d.students.some(x => x.sid === st.num)) continue;
        d.students.push({id: "s" + uid(), name: st.name, gender: st.gender, sid: st.num}); added++;
      }
      write(d); $("#madd").value = ""; log(`انضاف ${added}، منهم ${created} طالب جديد بأرقام جديدة.`);
    } catch (e) { write(d); log(accountErr(e)); }
    $("#maddB").disabled = false; S._busy = false;
  };
  $("#mcopyB").onclick = () => {
    const src = S.groups[$("#mcopy").value]; if (!src) return;
    if (!$("#mc").value.trim()) return toast("اكتب اسم المقرر أولاً");
    const d = header(base()); let n = 0;
    (src.students||[]).forEach(s => { if (!d.students.some(x => (s.sid && x.sid === s.sid) || norm(x.name) === norm(s.name))) { d.students.push({id: "s" + uid(), name: s.name, gender: s.gender, sid: s.sid || ""}); n++; } });
    write(d); toast(`انضاف ${n} متدرب`);
  };
  if (g) $("#mdel").onclick = () => {
    const b = $("#mdel");
    if (b.dataset.sure) { deleteDoc(ref("groups/" + S._modalGroup)).then(() => toast("انحذفت الشعبة")).catch(handleWriteErr); delete S.groups[S._modalGroup]; closeModal(); }
    else { b.dataset.sure = "1"; b.textContent = "متأكد؟ اضغط مرة ثانية للحذف"; }
  };
}
function renderModalStudents(){
  const g = S.groups[S._modalGroup]; const st = (g && g.students) || []; const ss = (g && g.sessions) || [];
  const box = $("#mstu"); if (!box) return;
  $("#mcount").textContent = st.length;
  box.innerHTML = st.length ? st.map(s => `<span class="chip"><span class="pill ${s.gender}">${GENDER[s.gender]}</span>${esc(s.name)} <span class="muted">${esc(s.sid || "بدون رقم")}</span><button aria-label="حذف ${esc(s.name)}" data-rm="${esc(s.id)}">×</button></span>`).join("") : `<span class="muted">ما فيه طلاب بعد</span>`;
  box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
    const d = clone(S.groups[S._modalGroup]); d.students = d.students.filter(s => s.id !== b.dataset.rm); writeGroup(S._modalGroup, d); renderModalStudents();
  });
  const sb = $("#msess");
  sb.innerHTML = ss.length ? ss.map((s,i) => `<div class="item" style="padding:8px 10px"><span class="grow">${esc(s.shift || "")} · ${esc(slot(s))}${s.g ? ` · ${s.g === "f" ? "طالبات" : "طلاب"}` : ""}</span><button class="btn sm danger" data-rs="${i}">حذف</button></div>`).join("") : `<span class="muted">ما فيه مواعيد</span>`;
  sb.querySelectorAll("[data-rs]").forEach(b => b.onclick = () => {
    const d = clone(S.groups[S._modalGroup]); d.sessions.splice(Number(b.dataset.rs), 1); writeGroup(S._modalGroup, d); renderModalStudents();
  });
}

/* students tab */
function adminStudents(el){
  const list = Object.values(S.students).sort((a,b) => a.num.localeCompare(b.num));
  const groupsOf = num => Object.values(S.groups).filter(g => (g.memberNums || []).includes(num));
  el.innerHTML = `
  <div class="card"><h2>الطلاب</h2>
    <p class="muted" style="margin-top:0">كل طالب له رقم أكاديمي يبدأ بـ 2026 ورمز دخول. أرسل للطالب رسالته من زر "نسخ".</p>
    <form id="ns" class="row" autocomplete="off">
      <input type="text" id="nsn" class="grow" placeholder="اسم طالب جديد" required>
      <select id="nsg" style="width:auto"><option value="m">طالب</option><option value="f">طالبة</option></select>
      <button class="btn gold" type="submit" id="nsb">+ إضافة</button>
    </form>
    <div class="row" style="margin-top:10px"><input type="text" id="sq" class="grow" placeholder="ابحث بالاسم أو الرقم"><button class="btn sm" id="copyAll">نسخ كل الأرقام والرموز</button></div>
  </div>
  <div class="list" id="slist"></div>
  <div class="card"><h2>استيراد الطلاب (مرة وحدة)</h2>
    <p class="muted" style="margin-top:0">اختر ملف <b>asas-students.json</b>. ينشئ أرقام الطلاب وحساباتهم، ويربطهم بالشعب، ويضيف الجدول ومقرر نظام المعاملات المدنية. إذا وقف في النص شغّله مرة ثانية ويكمل من مكانه.</p>
    <div class="row"><input type="file" id="upF" accept=".json,application/json" class="grow"><button class="btn pri" id="upB">تشغيل</button></div>
    <div id="upLog" class="muted" style="margin-top:8px;white-space:pre-line"></div>
  </div>`;
  const draw = q => {
    q = norm(q || "");
    const items = list.filter(s => !q || norm(s.name).includes(q) || s.num.includes(q));
    $("#slist").innerHTML = items.slice(0, 200).map(s => {
      const gs = groupsOf(s.num);
      return `<div class="item"><div class="grow"><div class="t">${esc(s.name)} <span class="pill ${s.gender}">${GENDER[s.gender]}</span></div>
        <div class="muted">${gs.length} مقرر${gs.length ? " · " + gs.map(g => esc(g.course)).join("، ") : ""}</div></div>
        <span class="code">${esc(s.num)}</span><span class="code">${esc(S.stSecrets[s.num] || "••••••")}</span>
        <button class="btn sm" data-scopy="${esc(s.num)}">نسخ</button><button class="btn sm" data-snew="${esc(s.num)}">رمز جديد</button></div>`;
    }).join("") || `<div class="card empty">${list.length ? "ما فيه نتائج" : "ما فيه طلاب بعد. استورد الملف من تحت."}</div>`;
    el.querySelectorAll("[data-scopy]").forEach(b => b.onclick = async () => {
      const s = S.students[b.dataset.scopy];
      const msg = `${s.name}\nرقمك الأكاديمي: ${s.num}\nرمز الدخول: ${S.stSecrets[s.num] || "—"}\nبوابة الطلاب: ${location.href.split("#")[0].split("?")[0]}`;
      try { await navigator.clipboard.writeText(msg); toast("انتسخت رسالة الطالب"); } catch { toast("المتصفح منع النسخ"); }
    });
    el.querySelectorAll("[data-snew]").forEach(b => b.onclick = async () => {
      const num = b.dataset.snew, s = S.students[num], code = newCode(); b.disabled = true;
      try {
        const acc = await createAccount("st-" + num, s.ver || 0, code);
        const pubSnap = await getDoc(ref("public/studentLogin")); const map = (pubSnap.exists() && pubSnap.data().map) || {}; map[num] = acc.ver;
        const bt = writeBatch(db);
        bt.set(ref("students/" + num), {...s, ...acc}); bt.set(ref("studentSecrets/" + num), {code}); bt.set(ref("public/studentLogin"), {map});
        await bt.commit(); toast("انعمل رمز جديد: " + code);
      } catch (e) { toast(accountErr(e)); b.disabled = false; }
    });
  };
  draw(""); $("#sq").oninput = e => draw(e.target.value);
  $("#copyAll").onclick = async () => {
    const tsv = ["الرقم\tالاسم\tالرمز", ...list.map(s => `${s.num}\t${s.name}\t${S.stSecrets[s.num] || ""}`)].join("\n");
    try { await navigator.clipboard.writeText(tsv); toast("انتسخت القائمة، الصقها في Excel"); } catch { toast("المتصفح منع النسخ"); }
  };
  $("#ns").onsubmit = async e => {
    e.preventDefault(); const name = $("#nsn").value.trim(); if (!name) return;
    if (findStudent(name)) return toast("فيه طالب بنفس الاسم");
    $("#nsb").disabled = true;
    try { const s = await createStudent(name, $("#nsg").value); toast(`انضاف ${name} · ${s.num}`); } catch (er) { toast(accountErr(er)); }
    $("#nsb").disabled = false;
  };
  $("#upB").onclick = () => runStudentImport();
}

async function runStudentImport(){
  const f = $("#upF").files[0]; if (!f) return toast("اختر الملف أولاً");
  let data; try { data = JSON.parse(await f.text()); } catch { return toast("الملف غير صالح"); }
  if (data.kind !== "asas-students-v1") return toast("هذا مو ملف الطلاب الصحيح");
  const lines = []; const log = m => { lines.push(m); const el = $("#upLog"); if (el) el.textContent = lines.slice(-8).join("\n"); };
  S._busy = true; $("#upB").disabled = true;
  const alias = {}; Object.entries(data.aliases || {}).forEach(([a, c]) => alias[norm(a)] = norm(c));
  const byName = {};
  try {
    // 1) student accounts
    const pubSnap = await getDoc(ref("public/studentLogin"));
    const map = (pubSnap.exists() && pubSnap.data().map) || {};
    let made = 0, i = 0;
    for (const s of data.students) {
      i++;
      byName[norm(s.name)] = s.num;
      if (S.students[s.num] && S.students[s.num].uid) continue;
      log(`(${i}/${data.students.length}) إنشاء حساب ${s.name} · ${s.num}`);
      const acc = await createAccount("st-" + s.num, 0, s.code);
      map[s.num] = acc.ver;
      const b = writeBatch(db);
      b.set(ref("students/" + s.num), {num: s.num, name: s.name, gender: s.gender, ...acc});
      b.set(ref("studentSecrets/" + s.num), {code: s.code});
      b.set(ref("public/studentLogin"), {map});
      await b.commit();
      S.students[s.num] = {num: s.num, name: s.name, gender: s.gender, ...acc}; made++;
    }
    log(`الحسابات: انعمل ${made}، والموجود من قبل ${data.students.length - made}.`);
    // 2) new groups
    for (const g of data.newGroups || []) {
      if (S.groups[g.id]) continue;
      const d = clone(g); delete d.id; d.memberNums = memberNums(d.students);
      await setDoc(ref("groups/" + g.id), d); S.groups[g.id] = {id: g.id, ...d};
      log(`انضاف مقرر ${g.course}.`);
    }
    // 3) link every group entry to a student number + schedule
    const unmatched = new Set(); let changed = 0;
    for (const g of Object.values(S.groups)) {
      const d = clone(g); delete d.id; let dirty = false;
      (d.students || []).forEach(s => {
        if (s.sid) return;
        const k = alias[norm(s.name)] || norm(s.name);
        const num = byName[k] || (findStudent(s.name, s.gender) || {}).num;
        if (num) { s.sid = num; dirty = true; } else unmatched.add(s.name);
      });
      if (!d.sessions && data.sessions && data.sessions[g.id]) { d.sessions = data.sessions[g.id]; dirty = true; }
      if (!d.trainerId && data.trainerIfEmpty && data.trainerIfEmpty[g.id] && S.trainers[data.trainerIfEmpty[g.id]]) { d.trainerId = data.trainerIfEmpty[g.id]; dirty = true; }
      const mn = memberNums(d.students);
      if (JSON.stringify(mn) !== JSON.stringify(g.memberNums || [])) { d.memberNums = mn; dirty = true; }
      if (dirty) { await setDoc(ref("groups/" + g.id), d); S.groups[g.id] = {id: g.id, ...d}; changed++; }
    }
    log(`الشعب المحدثة: ${changed}.`);
    // 3b) trainer corrections and course splits from the schedule
    for (const [gid, p] of Object.entries(data.setTrainer || {})) {
      const g = S.groups[gid];
      if (!g || g.trainerId !== p.from || !S.trainers[p.to]) continue;
      const d = clone(g); delete d.id; d.trainerId = p.to;
      await setDoc(ref("groups/" + gid), d); S.groups[gid] = {id: gid, ...d};
      log(`${g.course}: المدرب صار ${tName(p.to)}.`);
    }
    for (const sp of data.splits || []) {
      const src = S.groups[sp.from];
      if (!src || S.groups[sp.newId]) continue;
      const moving = (src.students || []).filter(s => s.gender === sp.gender);
      if (!moving.length) continue;
      const nd = {course: src.course, trainerId: sp.trainerId, mode: sp.mode || "", students: moving, sessions: sp.sessions || [], memberNums: memberNums(moving)};
      const od = clone(src); delete od.id;
      od.students = (src.students || []).filter(s => s.gender !== sp.gender);
      od.sessions = (src.sessions || []).filter(s => s.g !== sp.gender);
      od.memberNums = memberNums(od.students);
      const b = writeBatch(db); b.set(ref("groups/" + sp.newId), nd); b.set(ref("groups/" + sp.from), od); await b.commit();
      S.groups[sp.newId] = {id: sp.newId, ...nd}; S.groups[sp.from] = {id: sp.from, ...od};
      log(`${src.course}: ${sp.gender === "f" ? "الطالبات" : "الطلاب"} انتقلوا لشعبة مستقلة مع ${tName(sp.trainerId)}.`);
    }
    // 4) old attendance docs get memberNums so students can see them
    const atts = await getDocs(collection(db, "att")); let fixed = 0;
    for (const a of atts.docs) {
      const d = a.data(), g = S.groups[d.groupId];
      if (!g || (d.memberNums && d.memberNums.length)) continue;
      await setDoc(a.ref, {...d, memberNums: g.memberNums || []}); fixed++;
    }
    if (fixed) log(`سجلات حضور سابقة تحدثت: ${fixed}.`);
    log(unmatched.size ? `أسماء ما انربطت برقم: ${[...unmatched].join("، ")}` : "تم. كل الطلاب مربوطين بأرقامهم.");
    toast("اكتمل الاستيراد");
  } catch (e) { console.error(e); log("توقف: " + accountErr(e)); }
  S._busy = false; const b = $("#upB"); if (b) b.disabled = false;
}

/* trainers tab */
function trainerLoginMap(over){
  const map = {};
  Object.values(over || S.trainers).forEach(t => { if (t.num && t.email) map[t.num] = t.email; });
  return {map};
}
const nextTrainerNum = (over) => String(Math.max(1000, ...Object.values(over || S.trainers).map(t => Number(t.num) || 0)) + 1);
/* give every trainer a number and publish number -> login only (no names) */
async function syncTrainerNumbers(){
  if (S._trainerSynced || S.role !== "admin" || !S.loaded.trainers) return;
  S._trainerSynced = true;
  const all = clone(S.trainers);
  const missing = Object.values(all).filter(t => !t.num).sort((a,b) => a.name.localeCompare(b.name, "ar"));
  const b = writeBatch(db);
  missing.forEach(t => { t.num = nextTrainerNum(all); all[t.id].num = t.num; const d = clone(t); delete d.id; b.set(ref("trainers/" + t.id), d); });
  b.set(ref("public/trainerLogin"), trainerLoginMap(all));
  b.set(ref("public/trainers"), {list: {}});
  try { await b.commit(); if (missing.length) toast(`انعطى ${missing.length} مدرب أرقام دخول`); } catch (e) { S._trainerSynced = false; console.error(e); }
}
async function saveTrainer(tid, data, code){
  const b = writeBatch(db);
  b.set(ref("trainers/" + tid), data);
  if (code) b.set(ref("secrets/" + tid), {code});
  b.set(ref("public/trainerLogin"), trainerLoginMap({...S.trainers, [tid]: {id: tid, ...data}}));
  await b.commit();
}
function adminTrainers(el){
  const ts = Object.values(S.trainers).sort((a,b)=>a.name.localeCompare(b.name,"ar"));
  el.innerHTML = `
  <div class="card"><h2>المدربين والرموز</h2>
    <p class="muted" style="margin-top:0">كل مدرب يدخل برقمه ورمزه. أرسل له رسالته من زر "نسخ" بشكل خاص.</p>
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
      <span class="code">${esc(t.num || "—")}</span><span class="code">${esc(S.secrets[t.id] || "••••••")}</span>
      <button class="btn sm" data-copy="${esc(t.id)}">نسخ</button>
      <button class="btn sm" data-new="${esc(t.id)}">رمز جديد</button>
      <button class="btn sm danger" data-del="${esc(t.id)}">حذف</button></div>`; }).join("")}</div>`;
  $("#nt").onsubmit = async e => {
    e.preventDefault();
    const name = $("#ntn").value.trim(); if (!name) return;
    $("#ntb").disabled = true;
    const tid = "t-" + uid(), code = newCode();
    try { const num = nextTrainerNum(); const acc = await createAccount(tid, 0, code); await saveTrainer(tid, {name, gender: $("#ntg").value, num, ...acc}, code); toast(`انضاف ${name} · الرقم ${num} · الرمز ${code}`); }
    catch (err) { toast(accountErr(err)); }
    $("#ntb").disabled = false;
  };
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    const t = S.trainers[b.dataset.copy], code = S.secrets[t.id];
    const msg = `${trainerTitle(t)}\nرقم المدرب: ${t.num || "—"}\nرمز الدخول: ${code}\nبوابة المدربين: ${location.href.split("#")[0].split("?")[0]}`;
    try { await navigator.clipboard.writeText(msg); toast("انتسخت رسالة الرمز"); } catch { toast("المتصفح منع النسخ"); }
  });
  el.querySelectorAll("[data-new]").forEach(b => b.onclick = async () => {
    const tid = b.dataset.new, code = newCode(); b.disabled = true;
    try {
      const data = clone(S.trainers[tid]); delete data.id;
      const acc = await createAccount(tid, data.ver || 0, code); Object.assign(data, acc);
      await saveTrainer(tid, data, code); toast("انعمل رمز جديد، الرمز القديم ما عاد يشتغل");
    } catch (err) { toast(accountErr(err)); b.disabled = false; }
  });
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "متأكد؟"; return; }
    const tid = b.dataset.del, batch = writeBatch(db);
    Object.values(S.groups).filter(g => g.trainerId === tid).forEach(g => batch.update(ref("groups/" + g.id), {trainerId: ""}));
    batch.delete(ref("trainers/" + tid)); batch.delete(ref("secrets/" + tid));
    const rest = {...S.trainers}; delete rest[tid];
    batch.set(ref("public/trainerLogin"), trainerLoginMap(rest));
    try { await batch.commit(); toast("انحذف المدرب، وشعبه صارت بدون مدرب"); } catch (err) { handleWriteErr(err); }
  });
}

/* grades tab */
function adminGrades(el){
  const order = {submitted: 0, returned: 1, draft: 2, none: 3, approved: 4};
  const gs = sortedGroups().sort((a,b) => order[gradeStatus(a.id)] - order[gradeStatus(b.id)]);
  const cnt = k => gs.filter(g => gradeStatus(g.id) === k).length;
  if (!S.aGradeGroup || !S.groups[S.aGradeGroup]) S.aGradeGroup = null;
  el.innerHTML = `
  <div class="card"><h2>الدرجات</h2>
    <div class="stats">
      <div class="stat"><div class="n">${cnt("submitted")}</div><div class="l">بانتظار الاعتماد</div></div>
      <div class="stat"><div class="n">${cnt("approved")}</div><div class="l">معتمدة ومنشورة</div></div>
      <div class="stat"><div class="n">${cnt("draft") + cnt("returned")}</div><div class="l">عند المدربين</div></div>
      <div class="stat"><div class="n">${cnt("none")}</div><div class="l">لم تُرصد</div></div>
    </div>
    <p class="muted">المسار: المدرب يرصد ويرفع ← الشؤون الأكاديمية تعتمد أو ترجع ← بعد الاعتماد تظهر للطالب.</p>
  </div>
  ${S.aGradeGroup ? `<div class="row"><button class="btn sm" id="gBack">→ كل الشعب</button></div>${gradesEditor(S.groups[S.aGradeGroup], "admin")}` : `
  <div class="list">${gs.map(g => `<div class="item"><div class="grow"><div class="t">${esc(g.course)}</div><div class="muted">${esc(tName(g.trainerId))} · ${(g.students||[]).length} متدرب</div></div>
    <span class="pill ${GSTAT_PILL[gradeStatus(g.id)]}">${GSTAT[gradeStatus(g.id)]}</span><button class="btn sm" data-gg="${esc(g.id)}">فتح</button></div>`).join("")}</div>`}`;
  el.querySelectorAll("[data-gg]").forEach(b => b.onclick = () => { S.aGradeGroup = b.dataset.gg; render(); });
  if ($("#gBack")) { $("#gBack").onclick = () => { S.aGradeGroup = null; render(); }; bindGrades(S.groups[S.aGradeGroup], "admin"); }
}

/* report tab */
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
