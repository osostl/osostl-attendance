import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, query, where, onSnapshot, setDoc, deleteDoc, writeBatch, getDoc, getDocs, addDoc, orderBy, limit, serverTimestamp, runTransaction, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

/* ---------- constants ---------- */
const DOMAIN = "osostl.local";                       // login emails are internal, never mailed
const ROLE_EMAIL = {admin: "admin@" + DOMAIN, academic: "acadmic@" + DOMAIN, finance: "finance@" + DOMAIN, auditor: "audit@" + DOMAIN};
const ROLES = {admin: "الإدارة", academic: "مسؤول الشؤون الأكاديمية", finance: "المالية", auditor: "جهة رقابية (قراءة فقط)"};
const RO = () => S.adminRole === "auditor";
const FIN = () => S.adminRole === "finance";
const SEES_FIN = () => S.adminRole === "finance" || S.adminRole === "admin";
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
const hijriShort = d => { try { return new Date(d + "T12:00:00").toLocaleDateString("ar-SA-u-ca-islamic-umalqura-nu-latn", {day: "numeric", month: "long"}); } catch { return ""; } };
const fmtDate = d => { try { return new Date(d + "T12:00:00").toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", {weekday: "long", day: "numeric", month: "long"}) + " · " + hijriShort(d); } catch { return d; } };
/* a stored YYYY-MM-DD shown with its Hijri date beside it */
const dH = d => { if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return esc(d || ""); try { return `${esc(d)} <span class="muted" style="font-size:12px">(${esc(new Date(d + "T12:00:00").toLocaleDateString("ar-SA-u-ca-islamic-umalqura-nu-latn", {day: "numeric", month: "numeric", year: "numeric"}))})</span>`; } catch { return esc(d); } };
const uid = () => Math.random().toString(36).slice(2, 9);
const newCode = () => String(Math.floor(100000 + Math.random() * 900000));
const clone = o => JSON.parse(JSON.stringify(o));
const digits = s => String(s || "").trim().replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const norm = s => String(s || "").trim().replace(/\s+/g, " ").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "").replace(/عبد ال/g, "عبدال");
const letter = m => m >= 90 ? "ممتاز" : m >= 80 ? "جيد جداً" : m >= 70 ? "جيد" : m >= PASS ? "مقبول" : "راسب";
const validLink = u => /^https:\/\/\S+$/i.test(String(u || "").trim());
const isTeams = u => /teams\.(microsoft|live)\.com/i.test(String(u || ""));
const meetLabel = u => isTeams(u) ? "على Teams" : "";
const addMin = (hm, m) => { const [h, mm] = hm.split(":").map(Number); const t = Math.max(0, h * 60 + mm + m); return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
const todayDay = () => ({Sun: "الأحد", Mon: "الاثنين", Tue: "الثلاثاء", Wed: "الأربعاء", Thu: "الخميس"})[new Date().toLocaleDateString("en-US", {timeZone: "Asia/Riyadh", weekday: "short"})] || "";
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
  sys: null, ann: {all: [], trainers: [], students: []}, logs: [],
  aTab: "dash", aDash: [], unsubDash: null, aReportGroup: null, aReport: [], unsubReport: null, aGradeGroup: null,
};

/* ---------- boot ---------- */
if (!configured) {
  $("#app").innerHTML = `<div class="notice err">البوابة تحتاج إعدادات Firebase في ملف config.js.</div>`;
} else {
  onSnapshot(ref("public/site"), snap => { S.site = snap.exists() ? snap.data() : {}; licQR(); if (!S.authUser && S.view === "home") render(); }, () => { S.site = {}; });
  onSnapshot(ref("public/stats"), snap => { S.stats = snap.exists() ? snap.data() : null; if (!S.authUser && S.view === "home") render(); }, () => {});
  onSnapshot(ref("public/survey"), snap => { S.survey = snap.exists() ? snap.data() : null; if (S.role === "student" && !busyEditing()) render(); }, () => {});
  S.verify = (new URLSearchParams(location.search).get("verify") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || null;
  onSnapshot(ref("public/system"), snap => { S.sys = snap.exists() ? snap.data() : {}; render(); }, () => { S.sys = {}; render(); });
  onSnapshot(ref("ann/all"), snap => { S.ann.all = (snap.exists() && snap.data().items) || []; renderAnn(); }, () => {});
  onAuthStateChanged(auth, user => {
    stopAll();
    S.authUser = user; S.role = null; S.adminRole = null; S.me = null; S.myNum = null; S.authReady = true;
    if (!user) { if (["trainer","admin","student"].includes(S.view)) S.view = "home"; render(); return; }
    const local = (user.email || "").split("@")[0];
    const role = Object.keys(ROLE_EMAIL).find(k => ROLE_EMAIL[k] === user.email);
    if (role) { S.role = "admin"; S.adminRole = role; S.view = "admin"; }
    else if (local.startsWith("st-")) { S.role = "student"; S.myNum = local.split(".")[0].slice(3); S.view = "student"; }
    else { S.role = "trainer"; S.view = "trainer"; }
    if (S.role !== "admin") {
      const myId = S.role === "student" ? S.myNum : local.split(".")[0];
      getDoc(ref("public/disabled")).then(snap => { if (snap.exists() && (snap.data().list || {})[myId]) { S.disabledMsg = true; signOut(auth); } }).catch(() => {});
    }
    startData();
    S._loginLog = S.role !== "student";
    render();
  });
}

function sub(q, fn){ S.subs.push(onSnapshot(q, fn, err => fail(err))); }
function startData(){
  S.loaded = {trainers: false, groups: false};
  const annDocs = S.role === "admin" ? ["trainers", "students"] : S.role === "trainer" ? ["trainers"] : ["students"];
  annDocs.forEach(k => S.subs.push(onSnapshot(ref("ann/" + k), snap => { S.ann[k] = (snap.exists() && snap.data().items) || []; renderAnn(); }, () => {})));
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
    S.subs.push(onSnapshot(query(collection(db, "excuses"), where("num", "==", S.myNum)), snap => { S.myExc = snap.docs.map(d => ({id: d.id, ...d.data()})); if (!busyEditing()) render(); }, () => {}));
    S.subs.push(onSnapshot(query(collection(db, "warnings"), where("num", "==", S.myNum)), snap => { S.myWarn = snap.docs.map(d => d.data()); if (!busyEditing()) render(); }, () => {}));
    S.subs.push(onSnapshot(ref("finAccounts/" + S.myNum), snap => { S.myFin = snap.exists() ? snap.data() : null; if (!busyEditing()) render(); }, () => {}));
    S.subs.push(onSnapshot(query(collection(db, "payments"), where("num", "==", S.myNum)), snap => { S.myPay = snap.docs.map(d => ({id: d.id, ...d.data()})); if (!busyEditing()) render(); }, () => {}));
    S.subs.push(onSnapshot(query(collection(db, "certs"), where("num", "==", S.myNum)), snap => { S.myCerts = snap.docs.map(d => d.data()).filter(c => !c.revoked); if (!busyEditing()) render(); }, () => {}));
    S.subs.push(onSnapshot(query(collection(db, "evals"), where("num", "==", S.myNum)), snap => { S.myEvals = snap.docs.map(d => d.data()); if (!busyEditing()) render(); }, () => {}));
    return;
  }
  sub(collection(db, "groups"), snap => {
    S.groups = {}; snap.docs.forEach(d => S.groups[d.id] = {id: d.id, ...d.data()});
    S.loaded.groups = true; afterData();
  });
  S.subs.push(onSnapshot(collection(db, "grades"), snap => { S.grades = {}; snap.docs.forEach(d => S.grades[d.id] = d.data()); afterData(); }, () => {}));
  if (S.role === "admin") {
    S.subs.push(onSnapshot(ref("public/disabled"), snap => { S.disabled = (snap.exists() && snap.data().list) || {}; afterData(); }, () => {}));
    if (SEES_FIN()) startFinance();
    if (!RO()) S.subs.push(onSnapshot(collection(db, "finClear"), snap => { S.finClear = {}; snap.docs.forEach(d => S.finClear[d.id] = d.data()); S.finClearLoaded = true; afterData(); }, () => {}));
    if (FIN()) {
      S.subs.push(onSnapshot(collection(db, "students"), snap => { S.students = {}; snap.docs.forEach(d => S.students[d.id] = d.data()); afterData(); }, () => {}));
      return;
    }
    if (RO()) {
      S.subs.push(onSnapshot(collection(db, "students"), snap => { S.students = {}; snap.docs.forEach(d => S.students[d.id] = d.data()); afterData(); }, () => {}));
      S.subs.push(onSnapshot(collection(db, "warnings"), snap => { S.warnings = {}; snap.docs.forEach(d => S.warnings[d.id] = d.data()); afterData(); }, () => {}));
      S.subs.push(onSnapshot(collection(db, "certs"), snap => { S.certs = {}; snap.docs.forEach(d => { const c = d.data(); S.certs[c.key] = c; }); afterData(); }, () => {}));
      return;
    }
    S.subs.push(onSnapshot(collection(db, "certs"), snap => { S.certs = {}; snap.docs.forEach(d => { const c = d.data(); S.certs[c.key] = c; }); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "excuses"), snap => { S.excuses = snap.docs.map(d => ({id: d.id, ...d.data()})); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "warnings"), snap => { S.warnings = {}; snap.docs.forEach(d => S.warnings[d.id] = d.data()); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "secrets"), snap => { S.secrets = {}; S.trPhones = {}; snap.docs.forEach(d => { S.secrets[d.id] = d.data().code; if (d.data().phone) S.trPhones[d.id] = d.data().phone; }); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "students"), snap => { S.students = {}; snap.docs.forEach(d => S.students[d.id] = d.data()); afterData(); }, () => {}));
    S.subs.push(onSnapshot(collection(db, "studentSecrets"), snap => { S.stSecrets = {}; S.stPhones = {}; snap.docs.forEach(d => { S.stSecrets[d.id] = d.data().code; if (d.data().phone) S.stPhones[d.id] = d.data().phone; }); afterData(); }, () => {}));
  }
}
function fail(err){ console.error(err); $("#app").innerHTML = `<div class="notice err">تعذّر تحميل البيانات. ${err && err.code === "permission-denied" ? "حسابك ما عنده صلاحية، أو قواعد الحماية في Firebase تحتاج تحديث." : "تأكد من الاتصال وحدّث الصفحة."}</div>`; }
function stopAll(){ S.subs.forEach(u => u()); S.subs = []; stopAtt(); stopAdminSubs(); S.trainers = {}; S.groups = {}; S.secrets = {}; S.students = {}; S.stSecrets = {}; S.grades = {}; S.myStudent = null; S.myAtt = []; S.myResults = []; S.myExc = []; S.myWarn = []; S.myEvals = []; S.excuses = []; S.warnings = {}; S.sTab = "home"; S._trainerSynced = false; S.ann.trainers = []; S.ann.students = []; renderAnn(); }

function afterData(){
  if (S._finModal && $("#modal").classList.contains("on") && S._finDraw && !busyEditing()) S._finDraw();
  if (S._loginLog && S.loaded.trainers) { S._loginLog = false; logAction("تسجيل دخول", ""); }
  if (S.role === "admin") syncTrainerNumbers();
  if (SEES_FIN()) syncFinClear();
  if (S.role === "admin" && !RO() && !FIN()) syncPublicStats();
  if (S.view === "trainer" && S.tGroup && !S.groups[S.tGroup]) { S.tGroup = null; stopAtt(); }
  if (S.view === "admin" && $("#modal").classList.contains("on") && S._modalGroup) renderModalStudents();
  if (busyEditing()) return;
  render();
}
function busyEditing(){
  if ([...document.querySelectorAll("#app input[type=file], #modalBox input[type=file]")].some(i => i.files && i.files.length)) return true;   // a picked image not sent yet
  const a = document.activeElement;
  if (!a || !a.closest) return false;
  if (S._busy) return true;
  return (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && (["mlink","recT","recU","recD","wm","wp","mMsg","lockH","aText","aExp","lq","th1","th2","th3","th4","hLabel","hFrom","hTo","repM","exR","exN","arName","arOk","faQ","prN","prF","pAmt","pRef","pN","pvR","fFee","fDis","fDisN","fPh","sB","sAdd","sDed","sNote","salM","exA","exT","exVR","xL","xA","etN","etF","ptN","ptP","ptV","cA","cN","exRef","cdL","cdA","evL","evD","accN","licU","nwT","nwU","nwX","so-maps","so-whatsapp","so-website","so-x","so-instagram","so-snapchat","so-tiktok","so-linkedin"].includes(a.id) || !!a.closest("#roll, #gradesBox, #ab, #sb, #modalBox"));
}

/* ---------- audit log ---------- */
const _logT = {};
function whoAmI(){
  if (S.role === "admin") return ROLES[S.adminRole] || "الإدارة";
  if (S.role === "trainer") { const t = S.trainers[S.me]; return t ? trainerTitle(t) : "مدرب"; }
  return "";
}
function logAction(action, details, throttleKey){
  if (!S.authUser || S.role === "student" || RO()) return;
  if (throttleKey) { const now = Date.now(); if (_logT[throttleKey] && now - _logT[throttleKey] < 180000) return; _logT[throttleKey] = now; }
  addDoc(collection(db, "logs"), {at: serverTimestamp(), uid: S.authUser.uid, role: S.role === "admin" ? S.adminRole : "trainer", who: whoAmI() || S.authUser.email, action, details: String(details || "").slice(0, 300)}).catch(() => {});
}

/* ---------- attendance lock (also enforced in Firestore rules) ---------- */
const lockHours = () => { const h = S.sys && S.sys.lockHours; return typeof h === "number" && h >= 0 ? h : null; };
function isLocked(date){
  const h = lockHours(); if (h === null || S.role === "admin") return false;
  const [y, m, d] = date.split("-").map(Number);
  const end = Date.UTC(y, m - 1, d) - 3 * 3600e3 + (24 + h) * 3600e3;   // end of the day in Riyadh + h hours
  return Date.now() > end;
}

/* ---------- announcements ---------- */
const AUD = {all: "الكل", trainers: "المدربين", students: "الطلاب"};
function liveAnn(list){ const t = today(); return (list || []).filter(a => !a.expires || a.expires >= t); }
function renderAnn(){
  let bar = $("#annBar");
  if (!bar) { bar = document.createElement("div"); bar.id = "annBar"; bar.style.cssText = "max-width:1040px;margin:12px auto 0;padding:0 16px;display:grid;gap:8px"; $("#app").before(bar); }
  const items = [...liveAnn(S.ann.all), ...liveAnn(S.ann.trainers), ...liveAnn(S.ann.students)];
  bar.innerHTML = items.map(a => `<div class="notice" role="status"><b>إعلان${a.audience && a.audience !== "all" ? " · " + AUD[a.audience] : ""}:</b> ${esc(a.text)}</div>`).join("");
}

/* ---------- top bar ---------- */
const trainerTitle = t => (t.gender === "f" ? "المدربة " : "المدرب ") + t.name;
function renderTop(){
  const w = $("#topWho"), sub = $("#topSub");
  const label = {trainer: "بوابة المدربين", admin: "بوابة الشؤون المالية والأكاديمية", student: "بوابة الطلاب", trainerLogin: "بوابة المدربين", adminLogin: "بوابة الشؤون المالية والأكاديمية", studentLogin: "بوابة الطلاب"}[S.view] || "بوابة الحضور والانصراف";
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
function renderFab(){
  let box = $("#waFab");
  const list = waList(S.site), show = list.length > 0 && (!S.authUser || S.role === "student") && !S.verify;
  if (!show) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement("div"); box.id = "waFab"; box.className = "waWrap"; document.body.appendChild(box); }
  const sig = JSON.stringify(list); if (box.dataset.sig === sig) return; box.dataset.sig = sig;
  if (list.length === 1) {
    box.innerHTML = `<a class="waFab" href="${esc(socialUrl("whatsapp", list[0].num))}" target="_blank" rel="noopener" aria-label="تواصل معنا على واتساب" title="${esc(list[0].label || "واتساب")}">${ICON.whatsapp}</a>`;
    return;
  }
  box.innerHTML = `<div class="waMenu" id="waMenu" hidden>${list.map(w => `<a href="${esc(socialUrl("whatsapp", w.num))}" target="_blank" rel="noopener">${ICON.whatsapp}<span>${esc(w.label || "واتساب")}</span></a>`).join("")}</div>
    <button class="waFab" id="waBtn" aria-label="تواصل معنا على واتساب" aria-expanded="false" aria-controls="waMenu">${ICON.whatsapp}</button>`;
  const btn = box.querySelector("#waBtn"), menu = box.querySelector("#waMenu");
  btn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.addEventListener("click", ev => { if (!box.contains(ev.target)) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
}
function render(){
  if (!configured) return;
  renderTop(); renderFab();
  const app = $("#app");
  if (S.verify) { $("#topSub").textContent = "التحقق من الشهادات"; return renderVerify(app); }
  if (!S.authReady || !S.sys) { app.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري التحميل…</p></div>`; return; }
  if (S.sys.maintenance && S.role !== "admin" && S.view !== "adminLogin") {
    app.innerHTML = `<div class="card" style="text-align:center;padding:36px 16px"><h2>الموقع تحت الصيانة</h2>
      <p style="white-space:pre-line">${esc(S.sys.maintenanceMsg || "نعمل على تحسين البوابة، وبنرجع قريباً.")}</p>
      ${S.authUser ? `` : `<button class="btn sm" id="mAdm" style="margin-top:12px">دخول الإدارة</button>`}</div>`;
    if ($("#mAdm")) $("#mAdm").onclick = () => go("adminLogin");
    return;
  }
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


/* ---------- home page: content and helpers ---------- */
const dayOfYear = () => { const [y, m, d] = today().split("-").map(Number); return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5); };
const QUOTES = [
  "كل محاضرة تحضرها خطوة أقرب لهدفك.",
  "التعلّم استثمار ما يخسر أبداً.",
  "المهارة تُبنى بالتكرار، والتميّز يُبنى بالالتزام.",
  "خطوة صغيرة كل يوم، تصنع فرق كبير آخر الفصل.",
  "النجاح ما هو صدفة، هو حضور والتزام كل يوم.",
  "المعرفة اللي تتعلمها اليوم، تفتح لك باب بكرة.",
  "اللي يتعلّم باستمرار، ما يوقف عن التقدّم.",
  "الانضباط جسر بين أهدافك وإنجازاتك.",
  "كل خبير كان في يوم مبتدئ ما استسلم.",
  "اسأل، وجرّب، وتعلّم من الخطأ؛ هذي طريق الإتقان.",
  "وقتك في التدريب يصنع فرقك في سوق العمل.",
  "التزامك اليوم شهادتك بكرة.",
  "الطموح يبدأ بقرار، ويكتمل بالمثابرة.",
  "كل يوم فرصة جديدة تتعلّم فيها شي جديد.",
  "القانون يحمي الحقوق، والمعرفة تحمي صاحبها.",
  "اجعل فضولك أكبر من خوفك من الغلط.",
  "الإتقان ما يجي مرة وحدة، يجي محاضرة بعد محاضرة.",
  "استثمر في نفسك، فهي المشروع اللي ما يخسر.",
  "اللي يحضر بانتظام، يحصد بثقة.",
  "التطوير المهني رحلة، وأنت الحين على الطريق الصح."
];

/* TVTC training calendar 1448-1449, split-semester system (النظام النصفي المجزأ), Gregorian dates as printed */
const TVTC_1448 = {
  holidays: [
    {from: "2026-09-23", to: "2026-09-24", label: "إجازة اليوم الوطني"},
    {from: "2026-10-25", to: "2026-10-25", label: "إجازة مطوّلة"},
    {from: "2026-11-22", to: "2026-11-26", label: "إجازة الخريف"},
    {from: "2026-11-29", to: "2026-11-29", label: "إجازة مطوّلة"},
    {from: "2027-01-07", to: "2027-01-16", label: "إجازة منتصف العام التدريبي"},
    {from: "2027-02-21", to: "2027-02-22", label: "إجازة يوم التأسيس"},
    {from: "2027-02-26", to: "2027-03-13", label: "إجازة عيد الفطر"},
    {from: "2027-04-11", to: "2027-04-11", label: "إجازة مطوّلة"},
    {from: "2027-05-07", to: "2027-05-22", label: "إجازة عيد الأضحى"}
  ],
  events: [
    ["2026-07-19", "بداية تسجيل المستجدين وطلبات التجسير واستعادة القيد، وبداية تسجيل المقررات"],
    ["2026-08-20", "نهاية تسجيل المستجدين وطلبات التجسير"],
    ["2026-08-23", "بداية التدريب، ونهاية تسجيل المقررات وطلبات التحويل"],
    ["2026-09-06", "آخر موعد لحذف المقررات"],
    ["2026-09-20", "آخر فترة للانسحاب، وبداية تسجيل المستجدين للجزء الثاني"],
    ["2026-10-18", "بداية الاختبارات وتسجيل النتائج، وبداية تسجيل المقررات"],
    ["2026-10-22", "نهاية الفترة التدريبية ونهاية تسجيل النتائج"],
    ["2026-11-01", "بداية التدريب، ونهاية تسجيل المقررات وطلبات التحويل"],
    ["2026-11-15", "آخر موعد لحذف المقررات"],
    ["2026-12-06", "آخر فترة للانسحاب، وبداية تسجيل المستجدين وطلبات التجسير واستعادة القيد"],
    ["2027-01-03", "بداية الاختبارات وتسجيل النتائج، وبداية تسجيل المقررات"],
    ["2027-01-06", "نهاية تسجيل النتائج ونهاية الفترة التدريبية"],
    ["2027-01-14", "نهاية تسجيل المستجدين وطلبات التجسير"],
    ["2027-01-17", "بداية التدريب، ونهاية تسجيل المقررات ورفع الجداول وطلبات التحويل"],
    ["2027-01-31", "آخر موعد لحذف المقررات"],
    ["2027-02-14", "آخر فترة للانسحاب، وبداية تسجيل المستجدين للجزء الثاني"],
    ["2027-03-28", "بداية الاختبارات وتسجيل النتائج، وبداية تسجيل المقررات"],
    ["2027-04-01", "نهاية الفترة التدريبية ونهاية تسجيل النتائج"],
    ["2027-04-12", "بداية التدريب، ونهاية تسجيل المقررات وطلبات التحويل"],
    ["2027-04-26", "آخر موعد لحذف المقررات"],
    ["2027-05-02", "بداية تسجيل المستجدين للفصل الصيفي وطلبات التجسير واستعادة القيد"],
    ["2027-05-24", "آخر فترة للانسحاب"],
    ["2027-06-20", "بداية الاختبارات وتسجيل النتائج، وبداية تسجيل المقررات"],
    ["2027-06-24", "نهاية الفترة التدريبية وتسجيل النتائج، وبداية إجازة نهاية العام التدريبي"],
    ["2027-06-27", "بداية التدريب للفصل الصيفي، ونهاية تسجيل المقررات وطلبات التحويل"],
    ["2027-07-11", "الفصل الصيفي: آخر موعد لحذف المقررات"],
    ["2027-07-25", "الفصل الصيفي: آخر فترة للانسحاب، وبداية تسجيل المستجدين"],
    ["2027-08-15", "الفصل الصيفي: بداية الاختبارات وتسجيل النتائج"],
    ["2027-08-19", "الفصل الصيفي: نهاية تسجيل النتائج والفترة التدريبية"]
  ].map(([date, label]) => ({date, label}))
};
/* QR that points at the institute's official license page on the TVTC site */
async function licQR(){
  const url = S.site && S.site.licUrl; if (!url || !/^https:\/\//.test(url)) return "";
  if (S._licQR && S._licQRurl === url) return S._licQR;
  try { const qrcode = await loadQR(); const q = qrcode(0, "M"); q.addData(url); q.make(); S._licQR = q.createSvgTag({cellSize: 3, margin: 0}); S._licQRurl = url; return S._licQR; } catch { return ""; }
}
/* upcoming holidays (they also stop attendance) and academic-calendar events (they don't), nearest first */
function upcomingCal(){
  const t = today(), [y1, m1, d1] = t.split("-").map(Number), base = Date.UTC(y1, m1 - 1, d1);
  const days = d => { const [y, m, dd] = d.split("-").map(Number); return Math.max(0, Math.round((Date.UTC(y, m - 1, dd) - base) / 864e5)); };
  const hol = ((S.sys && S.sys.holidays) || []).filter(h => (h.to || h.from) >= t).map(h => ({label: h.label || "إجازة", from: h.from, to: h.to, hol: true}));
  const ev = ((S.sys && S.sys.events) || []).filter(e => e.date >= t).map(e => ({label: e.label, from: e.date}));
  return [...hol, ...ev].sort((a, b) => a.from.localeCompare(b.from) || (b.hol ? 1 : 0) - (a.hol ? 1 : 0)).map(u => ({...u, days: days(u.from < t ? t : u.from)}));
}
function nextHoliday(){
  const t = today(), list = ((S.sys && S.sys.holidays) || []).filter(h => (h.to || h.from) >= t).sort((a, b) => a.from.localeCompare(b.from));
  const h = list[0]; if (!h) return null;
  const [y1, m1, d1] = t.split("-").map(Number), [y2, m2, d2] = h.from.split("-").map(Number);
  return {...h, days: Math.max(0, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5))};
}
const waList = site => ((site && site.whatsapps) || (site && site.whatsapp ? [{label: "واتساب", num: site.whatsapp}] : [])).filter(x => x && x.num);
const SOCIAL = [["maps", "موقعنا (رابط خرائط Google)"], ["whatsapp", "واتساب"], ["website", "الموقع"], ["x", "إكس"], ["instagram", "إنستغرام"], ["snapchat", "سناب شات"], ["tiktok", "تيك توك"], ["linkedin", "لينكدإن"]];
function socialUrl(k, v){
  v = String(v || "").trim(); if (/^https:\/\//i.test(v)) return v;
  if (k === "maps") return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;
  const u = v.replace(/^@/, "");
  return {whatsapp: `https://wa.me/${normPhone(v)}`, website: `https://${u.replace(/^https?:\/\//i, "")}`, x: `https://x.com/${u}`, instagram: `https://instagram.com/${u}`, snapchat: `https://snapchat.com/add/${u}`, tiktok: `https://tiktok.com/@${u}`, linkedin: `https://linkedin.com/company/${u}`}[k] || "#";
}
const svgI = (body, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  maps: svgI(`<path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>`),
  clock: svgI(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
  news: svgI(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>`),
  help: svgI(`<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4M12 17v.01"/>`),
  student: svgI(`<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/><path d="M22 9v6"/>`, "pico"),
  trainer: svgI(`<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M7 20l3-4M17 20l-3-4M7 9h6M7 12h9"/>`, "pico"),
  admin: svgI(`<path d="M12 3v18M5 7h14"/><path d="M5 7l-3 6a3 3 0 006 0zM19 7l-3 6a3 3 0 006 0z"/><path d="M8 21h8"/>`, "pico"),
  seal: svgI(`<circle cx="12" cy="9" r="6"/><path d="M9.5 9l1.8 1.8L15 7.5"/><path d="M8.5 14l-1.5 7 5-3 5 3-1.5-7"/>`),
  cal: svgI(`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`),
  whatsapp: svgI(`<path d="M4 20l1.3-3.8A8 8 0 1112 20a8 8 0 01-4.2-1.2z"/><path d="M9 9c0 3 3 6 6 6l1-1.5-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2z"/>`),
  website: svgI(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>`),
  x: svgI(`<path d="M4 4l16 16M20 4L4 20"/>`),
  instagram: svgI(`<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/>`),
  snapchat: svgI(`<path d="M12 3c3 0 5 2.2 5 5.5v2l2 1-2 1.2c-.5 1.8-2 3-2 3l3 1.3-3 .8-1 1.7c-1-.4-2-.5-2-.5s-1 .1-2 .5l-1-1.7-3-.8 3-1.3s-1.5-1.2-2-3L5 11.5l2-1v-2C7 5.2 9 3 12 3z"/>`),
  tiktok: svgI(`<path d="M14 3v11.5a3.5 3.5 0 11-3.5-3.5"/><path d="M14 3c.5 2.5 2.5 4.5 5 4.5"/>`),
  linkedin: svgI(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 014 0v4M12 10v7"/>`)
};

const cdCells = ms => { const s = Math.max(0, Math.floor(ms / 1000)), parts = [[Math.floor(s / 86400), "يوم"], [Math.floor(s % 86400 / 3600), "ساعة"], [Math.floor(s % 3600 / 60), "دقيقة"], [s % 60, "ثانية"]]; return parts.map(([v, l]) => `<div><b>${String(v).padStart(2, "0")}</b><span>${l}</span></div>`).join(""); };
const DEFAULT_FAQ = [
  {q: "نسيت رمز الدخول، وش أسوي؟", a: "تواصل مع الشؤون الأكاديمية، ويعطونك رمز جديد على طول."},
  {q: "كيف أرفع عذر غياب؟", a: "من بوابة الطلاب، افتح «الأعذار»، واختر المحاضرة، واكتب السبب، وأرفق صورة العذر."},
  {q: "وين ألقى رابط المحاضرة عن بُعد والتسجيلات؟", a: "في بوابة الطلاب، الصفحة الرئيسية، تحت كل مقرر."},
  {q: "متى تظهر درجاتي؟", a: "بعد ما يرفعها المدرب وتعتمدها الشؤون الأكاديمية، وتظهر لك في الصفحة الرئيسية."},
  {q: "كيف أعرف رسومي والمبلغ المتبقي علي؟", a: "من بوابة الطلاب، افتح «المالية»، وتشوف جدول الدفعات وتقدر تطبع سنداتك."},
  {q: "كيف أثبّت البوابة على جوالي؟", a: "اضغط «تثبيت التطبيق» في الشريط الأخضر فوق. على الآيفون: من Safari اضغط زر المشاركة، ثم «إضافة إلى الشاشة الرئيسية»."}
];
/* staff keep the public counters on the home page fresh (no names, counts only) */
async function syncPublicStats(){
  if (S._statsDone || !S.loaded.groups || !S.loaded.trainers || !Object.keys(S.students || {}).length) return;
  S._statsDone = true;
  try {
    const lectures = (await getCountFromServer(collection(db, "att"))).data().count;
    const d = {students: Object.keys(S.students).length, trainers: Object.keys(S.trainers).length, groups: Object.keys(S.groups).length, lectures, at: today()};
    const cur = S.stats || {};
    if (["students", "trainers", "groups", "lectures"].some(k => cur[k] !== d[k])) await setDoc(ref("public/stats"), d);
  } catch (e) { console.warn("stats", e); }
}

/* ---------- home & logins ---------- */
function renderHome(app){
  const site = S.site || {}, st = S.stats, upcoming = upcomingCal();
  const h = Number(new Intl.DateTimeFormat("en-GB", {timeZone: TZ, hour: "numeric", hourCycle: "h23"}).format(new Date()));
  const greet = h < 12 ? "صباح الخير" : "مساء الخير";
  const links = SOCIAL.filter(([k]) => site[k] && k !== "maps" && k !== "whatsapp");
  const was = waList(site);
  const news = (site.news || []).filter(n => n.title && (!n.until || n.until >= today())).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 4);
  const faq = (site.faq || DEFAULT_FAQ).filter(f => f.q && f.a);
  const cdT = site.countdown && site.countdown.at ? Date.parse(site.countdown.at + ":00+03:00") : NaN;
  const cd = cdT > Date.now() && site.countdown.label ? {label: site.countdown.label, t: cdT} : null;
  const counters = st ? [["students", "متدرب ومتدربة"], ["lectures", "محاضرة منعقدة"]].filter(([k]) => st[k] > 0) : [];
  app.innerHTML = `${S.disabledMsg ? `<div class="notice err">حسابك موقوف مؤقتاً. تواصل مع الشؤون الأكاديمية.</div>` : ""}
  <section class="hero rise">
    <img class="heroLogo" src="logo-mark.png" alt="">
    <div class="heroTxt">
      <span class="greet">${greet}</span>
      <h2>${esc(INST_AR)}</h2>
      <span class="heroEn">${esc(INST_EN)}</span>
      ${site.accNo ? `<span class="accNo">${ICON.seal} مرخّص من المؤسسة العامة للتدريب التقني والمهني · رقم الرخصة ${esc(site.accNo)}</span>` : ""}
      <span class="heroDate">${esc(hijri(today()))} · ${esc(greg(today()))}</span>
    </div>
  </section>
  ${cd ? `<section class="countdown rise" style="--d:1"><span class="cdLbl">${ICON.clock} باقي على ${esc(cd.label)}</span><div class="cdBox" id="cdBox" data-at="${cd.t}">${cdCells(cd.t - Date.now())}</div></section>` : ""}
  <div class="portals">
    <button class="portal pS rise" style="--d:1" id="goS">${ICON.student}<b>بوابة الطلاب</b></button>
    <button class="portal pT rise" style="--d:2" id="goT">${ICON.trainer}<b>بوابة المدربين</b></button>
    <button class="portal pA rise" style="--d:3" id="goA">${ICON.admin}<b>بوابة الشؤون المالية والأكاديمية</b></button>
  </div>
  ${counters.length ? `<section class="counters rise" style="--d:4">${counters.map(([k, l]) => `<div class="ctr"><b data-count="${Number(st[k])}">0</b><span>${l}</span></div>`).join("")}</section>` : ""}
  <div class="duo">
    <form class="card rise" style="--d:5" id="verF"><h2>${ICON.seal} تحقق من شهادة</h2>
      <p class="muted" style="margin-top:0">اكتب رمز التحقق المطبوع على الشهادة.</p>
      <div class="row"><input type="text" id="verC" class="grow" dir="ltr" placeholder="مثل AB12CD34" autocomplete="off" aria-label="رمز التحقق"><button class="btn pri" type="submit">تحقق</button></div></form>
    <div class="card rise" style="--d:6"><h2>${ICON.cal} القادم في التقويم</h2>
      ${upcoming.length ? `<div class="upc">${upcoming.slice(0, 4).map(u => `<div class="upI ${u.hol ? "hol" : ""}"><span class="upD">${u.days === 0 ? "اليوم" : u.days === 1 ? "بكرة" : `بعد ${u.days} ${u.days <= 10 ? "أيام" : "يوم"}`}</span><b>${esc(u.label)}</b><span class="muted">${esc(fmtDate(u.from))}${u.to && u.to !== u.from ? " ← " + esc(fmtDate(u.to)) : ""}</span></div>`).join("")}</div>
        ${upcoming.length > 4 ? `<details class="upMore"><summary>التقويم كامل (${upcoming.length})</summary><div class="upc">${upcoming.slice(4).map(u => `<div class="upI ${u.hol ? "hol" : ""}"><b>${esc(u.label)}</b><span class="muted">${esc(fmtDate(u.from))}${u.to && u.to !== u.from ? " ← " + esc(fmtDate(u.to)) : ""}</span></div>`).join("")}</div></details>` : ""}` : `<p class="muted" style="margin:0">ما فيه مواعيد قادمة مسجّلة.</p>`}</div>
  </div>
  ${site.licUrl && /^https:\/\//.test(site.licUrl) ? `<section class="card licCard rise" style="--d:7"><div class="licQR" id="licQR"></div><div class="grow"><h2>${ICON.seal} ترخيص المعهد</h2><p class="muted" style="margin:0 0 10px">امسح الرمز أو اضغط الزر للتحقق من ترخيص المعهد وبرامجه التدريبية المعتمدة في موقع المؤسسة العامة للتدريب التقني والمهني.</p>${site.accNo ? `<p style="margin:0 0 10px">رقم الرخصة: <b dir="ltr">${esc(site.accNo)}</b></p>` : ""}<a class="btn pri sm" href="${esc(site.licUrl)}" target="_blank" rel="noopener">التحقق من الترخيص</a></div></section>` : ""}
  ${news.length ? `<section class="rise" style="--d:7"><h3 class="secT">${ICON.news} آخر الأخبار</h3><div class="news">${news.map(n => `<article class="nItem"><span class="nDate">${esc(fmtDate(n.date))}</span><b>${esc(n.title)}</b>${n.text ? `<p>${esc(n.text)}</p>` : ""}</article>`).join("")}</div></section>` : ""}
  <blockquote class="quote rise" style="--d:8">${esc(QUOTES[dayOfYear() % QUOTES.length])}</blockquote>
  ${faq.length ? `<section class="card rise" style="--d:9"><h2>${ICON.help} أسئلة شائعة</h2><div class="faq">${faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div></section>` : ""}
  <footer class="foot rise" style="--d:9"><img src="logo-mark.png" alt=""><span>${esc(INST_AR)}</span>
    ${was.length ? `<div class="waRow">${was.map(w => `<a class="mapBtn" href="${esc(socialUrl("whatsapp", w.num))}" target="_blank" rel="noopener">${ICON.whatsapp} ${esc(w.label || "واتساب")}</a>`).join("")}</div>` : ""}
    ${site.maps ? `<a class="mapBtn" href="${esc(socialUrl("maps", site.maps))}" target="_blank" rel="noopener">${ICON.maps} موقعنا على الخريطة</a>` : ""}
    ${links.length ? `<div class="soc">${links.map(([k, label]) => `<a href="${esc(socialUrl(k, site[k]))}" target="_blank" rel="noopener" aria-label="${label}" title="${label}">${ICON[k] || label}</a>`).join("")}</div>` : ""}</footer>`;
  if ($("#licQR")) licQR().then(svg => { if (svg && $("#licQR")) $("#licQR").innerHTML = svg; });
  clearInterval(S._cdTimer);
  if ($("#cdBox")) S._cdTimer = setInterval(() => { const b = $("#cdBox"); if (!b) return clearInterval(S._cdTimer); const left = Number(b.dataset.at) - Date.now(); if (left <= 0) { clearInterval(S._cdTimer); return render(); } b.innerHTML = cdCells(left); }, 1000);
  $("#verF").onsubmit = e => { e.preventDefault(); const c = $("#verC").value.toUpperCase().replace(/[^A-Z0-9]/g, ""); if (!c) return toast("اكتب رمز التحقق"); location.href = `${SITE()}?verify=${c}`; };
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  app.querySelectorAll("[data-count]").forEach(n => {
    const to = Number(n.dataset.count); if (reduce) { n.textContent = to.toLocaleString("en-US"); return; }
    const t0 = performance.now(), dur = 1200;
    const step = t => { const k = Math.min(1, (t - t0) / dur), v = Math.round(to * (1 - Math.pow(1 - k, 3))); n.textContent = v.toLocaleString("en-US"); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
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
  app.innerHTML = loginCard("دخول الشؤون المالية والأكاديمية", `
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
const EVAL_Q = ["وضوح شرح المدرب", "التزام المدرب بالوقت", "تفاعل المدرب مع الطلاب", "فائدة محتوى المقرر", "رضاك العام عن المقرر"];
const EXC_ST = {pending: "قيد المراجعة", accepted: "مقبول", rejected: "مرفوض"};
const EXC_PILL = {pending: "l", accepted: "p", rejected: "a"};
function studentTabs(){
  const open = Object.values(S.groups).filter(g => g.evalOpen && !(S.myEvals || []).some(e => e.groupId === g.id)).length;
  const tabs = [["home", "الرئيسية"], ["att", "حضوري"], ["exc", "الأعذار"], ["warn", "الإنذارات" + ((S.myWarn || []).length ? ` (${S.myWarn.length})` : "")], ["eval", "التقييم" + (open ? ` (${open})` : "")], ...(S.myFin ? [["fin", "المالية"]] : []), ...(S.survey && S.survey.open ? [["survey", "الاستبيان" + (S.surveyDone === S.survey.id ? "" : " (1)")]] : [])];
  return `<div class="card" style="padding:10px 12px"><div class="tabs" style="border:0;padding:0">${tabs.map(([k, v]) => `<button class="tab ${(S.sTab || "home") === k ? "on" : ""}" data-stab="${k}">${v}</button>`).join("")}</div></div>`;
}
function bindStudentTabs(app){ app.querySelectorAll("[data-stab]").forEach(b => b.onclick = () => { S.sTab = b.dataset.stab; render(); window.scrollTo(0, 0); }); }
function myCourseStats(){
  return Object.values(S.groups).sort((a,b) => (a.course||"").localeCompare(b.course||"","ar")).map(g => {
    const entry = (g.students || []).find(s => s.sid === S.myNum);
    const docs = countable(S.myAtt.filter(d => d.groupId === g.id)).sort((a, b) => a.date.localeCompare(b.date));
    return {g, entry, docs, ab: absStats(g, entry ? entry.id : "", docs)};
  });
}
function renderStudent(app){
  const st = S.myStudent;
  if (!st) { app.innerHTML = `<div class="notice err">ما لقينا سجلك. تواصل مع الشؤون الأكاديمية.</div>`; return; }
  if ((S.sTab || "home") !== "home") { app.innerHTML = studentTabs() + `<div id="sb"></div>`; bindStudentTabs(app); ({att: studentAtt, exc: studentExc, warn: studentWarn, eval: studentEval, fin: studentFin, survey: studentSurvey})[S.sTab]($("#sb")); return; }
  const gs = Object.values(S.groups).sort((a,b) => (a.course||"").localeCompare(b.course||"","ar"));
  const res = {}; S.myResults.forEach(r => res[r.groupId] = r);
  const cards = gs.map(g => {
    const entry = (g.students || []).find(s => s.sid === S.myNum);
    const docs = countable(S.myAtt.filter(d => d.groupId === g.id));
    const ab = absStats(g, entry ? entry.id : "", docs);
    const pres = ab.p + ab.l, rate = ab.attPct;
    const d = todayDay(), now = nowHM();
    const live = sessionsFor(g, st.gender).find(x => x.day === d && addMin(x.from, -15) <= now && now <= x.to);
    return {g, rate, sessions: docs.length, pres, r: res[g.id], live, ab};
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
          ${c.rate === null ? "" : `<span class="bar" style="display:block;margin-top:6px;max-width:220px"><i style="width:${c.rate}%"></i></span>
          <div class="muted" style="margin-top:6px">الغياب: ${c.ab.a} (${c.ab.absPct}%) ${levelPill(c.ab)}${c.ab.remaining !== null ? ` · باقي لك ${c.ab.remaining} غياب قبل الحرمان` : ""}</div>`}
          ${(c.g.recordings || []).length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">تسجيلات المحاضرات (${c.g.recordings.length})</summary><div class="list" style="margin-top:6px">${c.g.recordings.filter(r => validLink(r.url)).map(r => `<a class="item" style="padding:8px 10px;text-decoration:none;color:inherit" href="${esc(r.url)}" target="_blank" rel="noopener"><span class="grow">${dH(r.date)} · ${esc(r.title)}</span><span class="btn sm">مشاهدة</span></a>`).join("")}</div></details>` : ""}
          ${c.g.meetLink ? `<div style="margin-top:10px"><button class="btn sm ${c.live ? "gold" : ""}" data-join="${esc(c.g.id)}">${c.live ? "الآن · " : ""}دخول المحاضرة ${meetLabel(c.g.meetLink)}</button>${c.live ? ` <span class="muted">${fmtTime(c.live.from)} – ${fmtTime(c.live.to)}</span>` : ""}</div>` : ""}
        </div>
        <div style="text-align:center;min-width:92px">
          ${c.r ? `<div style="font-size:26px;font-weight:700;color:var(--green)">${c.r.mark}</div><span class="pill ${c.r.mark >= PASS ? "p" : "a"}">${letter(c.r.mark)}</span>` : `<span class="pill">لم تُعتمد بعد</span>`}
        </div>
      </div>`).join("") || `<div class="empty">ما فيه مقررات مسجلة لك بعد.</div>`}</div>
  </div>
  <div class="card"><h2>جدولي الأسبوعي</h2>${weekTable(rows)}</div>
  ${(S.myCerts || []).length ? `<div class="card"><h2>شهاداتي</h2><div class="list">${S.myCerts.map(c => `<div class="item"><div class="grow"><div class="t">${esc(c.course)}</div><div class="muted">حضور ${c.attPct}% · ${esc(greg(c.date))}</div></div><button class="btn sm gold" data-cert="${esc(c.code)}">طباعة الشهادة</button></div>`).join("")}</div></div>` : ""}`;
  app.querySelectorAll("[data-cert]").forEach(b => b.onclick = () => { const c = S.myCerts.find(x => x.code === b.dataset.cert); if (c) printCerts([c]); });
  app.querySelector(".card").insertAdjacentHTML("afterend", studentTabs()); bindStudentTabs(app);
  app.querySelectorAll("[data-join]").forEach(b => b.onclick = () => {
    const g = S.groups[b.dataset.join]; if (!g || !validLink(g.meetLink)) return toast("رابط المحاضرة غير صالح، تواصل مع المدرب");
    window.open(g.meetLink.trim(), "_blank", "noopener");
    const date = today(), id = `${g.id}_${date}_${S.myNum}`;
    if (S._joined && S._joined[id]) return;
    S._joined = {...(S._joined || {}), [id]: 1};
    setDoc(ref("joins/" + id), {groupId: g.id, date, num: S.myNum, time: nowHM(), at: new Date().toISOString()})
      .then(() => toast("انسجل دخولك للمحاضرة")).catch(() => {});
  });
}

function studentAtt(el){
  const cs = myCourseStats(), th = TH();
  el.innerHTML = `<div class="card"><h2>حضوري</h2><p class="muted" style="margin:0">الإنذار الأول عند ${th.warn1}% غياب، والثاني عند ${th.warn2}%، والحرمان عند ${th.deny}%. التأخير يُحسب حضور، والعذر المقبول ما يُحسب غياب.</p></div>
  ${cs.map(({g, entry, docs, ab}) => `<div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(g.course)}</h2>${levelPill(ab)}</div>
    <p class="muted" style="margin:6px 0 10px">${esc(tName(g.trainerId))}</p>
    <div class="stats">
      <div class="stat"><div class="n">${ab.attPct === null ? "—" : ab.attPct + "%"}</div><div class="l">الحضور</div></div>
      <div class="stat"><div class="n">${ab.a}</div><div class="l">غياب (${ab.absPct}%)</div></div>
      <div class="stat"><div class="n">${ab.l}</div><div class="l">تأخير</div></div>
      <div class="stat"><div class="n">${ab.e}</div><div class="l">مستأذن / عذر</div></div>
      <div class="stat"><div class="n">${ab.remaining === null ? "—" : ab.remaining}</div><div class="l">باقي قبل الحرمان</div></div>
    </div>
    ${docs.length ? `<div class="tbl" style="margin-top:10px"><table><thead><tr><th>التاريخ</th><th>الحالة</th><th>الحضور</th><th>الانصراف</th></tr></thead><tbody>
      ${docs.map(d => { const r = (entry && d.rec && d.rec[entry.id]) || {}; const k = r.st || "a"; return `<tr><td>${esc(fmtDate(d.date))}</td><td><span class="pill ${k}">${STATUS[k]}</span></td><td>${fmtTime(r.in)}</td><td>${fmtTime(r.out)}</td></tr>`; }).join("")}
    </tbody></table></div>` : `<p class="muted">ما بدأ التحضير في هذا المقرر.</p>`}
  </div>`).join("") || `<div class="card empty">ما فيه مقررات</div>`}`;
}
async function compressImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    let max = 1400, q = 0.7, out = "";
    for (let t = 0; t < 6; t++) {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL("image/jpeg", q);
      if (out.length < 650000) return out;
      max = Math.round(max * 0.75); q = Math.max(0.4, q - 0.1);
    }
    throw new Error("too-big");
  } finally { URL.revokeObjectURL(url); }
}
function studentExc(el){
  const cs = myCourseStats();
  const absences = [];
  cs.forEach(({g, entry, docs}) => docs.forEach(d => { const r = entry && d.rec && d.rec[entry.id]; if (!r || !r.st || r.st === "a") absences.push({g, date: d.date}); }));
  const sent = new Set((S.myExc || []).map(x => x.groupId + "_" + x.date));
  const opts = absences.filter(a => !sent.has(a.g.id + "_" + a.date)).sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = `<div class="card"><h2>تقديم عذر غياب</h2>
    ${opts.length ? `<form id="exF" class="list" autocomplete="off">
      <label class="f" for="exW">الغياب<select id="exW">${opts.map(a => `<option value="${esc(a.g.id)}|${esc(a.date)}">${esc(a.g.course)} · ${esc(fmtDate(a.date))}</option>`).join("")}</select></label>
      <label class="f" for="exR">سبب الغياب<textarea id="exR" required style="min-height:80px" placeholder="مثل: مراجعة طبية"></textarea></label>
      <label class="f" for="exI">صورة العذر (تقرير طبي أو غيره)<input type="file" id="exI" accept="image/*"></label>
      <button class="btn pri" type="submit" id="exB">إرسال العذر</button>
    </form>` : `<p class="muted" style="margin:0">ما عندك غياب بدون عذر مقدم.</p>`}</div>
  <div class="card"><h2>أعذاري</h2>
    <div class="list">${(S.myExc || []).sort((a, b) => b.date.localeCompare(a.date)).map(x => `<div class="item"><div class="grow"><div class="t">${esc(x.course)} · ${esc(fmtDate(x.date))}</div><div class="muted">${esc(x.reason)}</div>${x.note ? `<div class="muted">رد الشؤون الأكاديمية: ${esc(x.note)}</div>` : ""}</div>
      <span class="pill ${EXC_PILL[x.status]}">${EXC_ST[x.status]}</span>${x.status === "pending" ? `<button class="btn sm danger" data-exdel="${esc(x.id)}">سحب</button>` : ""}</div>`).join("") || `<span class="muted">ما قدمت أعذار</span>`}</div></div>`;
  if ($("#exF")) $("#exF").onsubmit = async e => {
    e.preventDefault();
    const [gid, date] = $("#exW").value.split("|"), g = S.groups[gid], reason = $("#exR").value.trim();
    if (!reason) return toast("اكتب سبب الغياب");
    $("#exB").disabled = true; S._busy = true;
    try {
      let img = "";
      if ($("#exI").files[0]) { $("#exB").textContent = "جاري ضغط الصورة…"; img = await compressImage($("#exI").files[0]); }
      await setDoc(ref(`excuses/${S.myNum}_${gid}_${date}`), {num: S.myNum, name: S.myStudent.name, groupId: gid, course: g.course, date, reason: reason.slice(0, 500), img, status: "pending", note: "", at: new Date().toISOString()});
      toast("انرسل العذر للشؤون الأكاديمية");
    } catch (er) { console.error(er); toast(er.message === "too-big" ? "الصورة كبيرة، جرّب صورة أوضح بحجم أصغر" : "تعذّر إرسال العذر"); }
    S._busy = false; render();
  };
  el.querySelectorAll("[data-exdel]").forEach(b => b.onclick = () => deleteDoc(ref("excuses/" + b.dataset.exdel)).then(() => toast("انسحب العذر")).catch(() => toast("تعذّر السحب")));
}
function studentWarn(el){
  const w = (S.myWarn || []).sort((a, b) => b.date.localeCompare(a.date) || b.level - a.level);
  el.innerHTML = `<div class="card"><h2>الإنذارات</h2>
    <div class="list">${w.map(x => `<div class="item"><div class="grow"><div class="t">${esc(x.levelName)} · ${esc(x.course)}</div><div class="muted">صدر ${esc(fmtDate(x.date))} · نسبة الغياب وقتها ${x.absPct}%</div></div><span class="pill ${LEVEL_PILL[x.level]}">${esc(x.levelName)}</span></div>`).join("") || `<p class="muted" style="margin:0">ما صدر لك أي إنذار.</p>`}</div></div>`;
}
function studentEval(el){
  const open = Object.values(S.groups).filter(g => g.evalOpen);
  const done = new Set((S.myEvals || []).map(e => e.groupId));
  el.innerHTML = `<div class="card"><h2>تقييم المدرب والمقرر</h2><p class="muted" style="margin:0">تقييمك سري، ما يشوفه المدرب. يوصل للشؤون الأكاديمية فقط.</p></div>
  ${open.map(g => done.has(g.id) ? `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(g.course)}</h2><span class="pill p">تم التقييم، شكراً لك</span></div></div>` : `
  <form class="card" data-ev="${esc(g.id)}"><h2>${esc(g.course)}</h2><p class="muted" style="margin-top:0">${esc(tName(g.trainerId))} · من 1 (ضعيف) إلى 5 (ممتاز)</p>
    ${EVAL_Q.map((q, i) => `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span>${q}</span><div class="seg" role="radiogroup" aria-label="${q}">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-q="${i}" data-v="${n}">${n}</button>`).join("")}</div></div>`).join("")}
    <label class="f" for="evc-${esc(g.id)}">ملاحظات (اختياري)<textarea id="evc-${esc(g.id)}" style="min-height:70px"></textarea></label>
    <button class="btn pri" type="submit" style="margin-top:8px">إرسال التقييم</button>
  </form>`).join("") || `<div class="card empty">ما فيه تقييم مفتوح حالياً.</div>`}`;
  el.querySelectorAll("form[data-ev]").forEach(f => {
    const ans = {};
    f.querySelectorAll("[data-q]").forEach(b => b.onclick = () => {
      ans[b.dataset.q] = Number(b.dataset.v);
      f.querySelectorAll(`[data-q="${b.dataset.q}"]`).forEach(x => { const on = x === b; x.style.background = on ? "var(--green)" : ""; x.style.color = on ? "#fff" : ""; });
    });
    f.onsubmit = async e => {
      e.preventDefault();
      if (EVAL_Q.some((_, i) => !ans[i])) return toast("جاوب على كل الأسئلة");
      const gid = f.dataset.ev;
      try { await setDoc(ref(`evals/${gid}_${S.myNum}`), {groupId: gid, num: S.myNum, ratings: EVAL_Q.map((_, i) => ans[i]), comment: $("#evc-" + gid).value.trim().slice(0, 600), at: new Date().toISOString()}); toast("انرسل تقييمك، شكراً لك"); }
      catch (er) { console.error(er); toast("تعذّر إرسال التقييم"); }
    };
  });
}


/* ---------- end-of-program satisfaction survey ---------- */
const SURVEY_Q = ["سهولة إجراءات التسجيل والقبول", "تعامل الشؤون الأكاديمية والإدارة", "مستوى المدربين بشكل عام", "مناسبة البرامج لسوق العمل", "القاعات والتجهيزات والمنصة الإلكترونية", "بوابة الطلاب وسهولة استخدامها", "رضاك العام عن المعهد"];
const RECOMMEND = {yes: "أنصح فيه", maybe: "يمكن", no: "ما أنصح فيه"};
function studentSurvey(el){
  const sv = S.survey;
  if (!sv || !sv.open) { el.innerHTML = `<div class="card empty">ما فيه استبيان مفتوح.</div>`; return; }
  if (S.surveyDone === sv.id) { el.innerHTML = `<div class="card" style="text-align:center"><h2>شكراً لك</h2><p class="muted" style="margin:0">وصلنا رأيك، ويساعدنا نطوّر المعهد.</p></div>`; return; }
  if (S.surveyChecked !== sv.id) {
    S.surveyChecked = sv.id;
    getDoc(ref(`surveys/${sv.id}_${S.myNum}`)).then(x => { if (x.exists()) { S.surveyDone = sv.id; render(); } }).catch(() => {});
  }
  const ans = S._svAns || (S._svAns = {});
  el.innerHTML = `<form class="card" id="svF"><h2>${esc(sv.title || "استبيان رضا المتدربين")}</h2><p class="muted" style="margin-top:0">الاستبيان سري. من 1 (ضعيف) إلى 5 (ممتاز).</p>
    ${SURVEY_Q.map((q, i) => `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span>${q}</span><div class="seg" role="radiogroup" aria-label="${q}">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-sq="${i}" data-v="${n}" style="${ans[i] === n ? "background:var(--green);color:#fff" : ""}">${n}</button>`).join("")}</div></div>`).join("")}
    <div class="row" style="justify-content:space-between;margin:6px 0 10px"><span>تنصح أحد يسجّل في المعهد؟</span><div class="seg" role="radiogroup" aria-label="التوصية">${Object.entries(RECOMMEND).map(([k, v]) => `<button type="button" data-rec="${k}" style="${ans.rec === k ? "background:var(--green);color:#fff" : ""}">${v}</button>`).join("")}</div></div>
    <label class="f" for="svC">وش أكثر شي عجبك؟ ووش نحسّن؟ (اختياري)<textarea id="svC" style="min-height:80px" maxlength="800"></textarea></label>
    <button class="btn pri" type="submit" style="margin-top:8px">إرسال</button></form>`;
  const paint = () => { el.querySelectorAll("[data-sq]").forEach(b => { const on = ans[b.dataset.sq] === Number(b.dataset.v); b.style.background = on ? "var(--green)" : ""; b.style.color = on ? "#fff" : ""; }); el.querySelectorAll("[data-rec]").forEach(b => { const on = ans.rec === b.dataset.rec; b.style.background = on ? "var(--green)" : ""; b.style.color = on ? "#fff" : ""; }); };
  el.querySelectorAll("[data-sq]").forEach(b => b.onclick = () => { ans[b.dataset.sq] = Number(b.dataset.v); paint(); });
  el.querySelectorAll("[data-rec]").forEach(b => b.onclick = () => { ans.rec = b.dataset.rec; paint(); });
  $("#svF").onsubmit = async e => {
    e.preventDefault();
    if (SURVEY_Q.some((_, i) => !ans[i]) || !ans.rec) return toast("جاوب على كل الأسئلة");
    try { await setDoc(ref(`surveys/${sv.id}_${S.myNum}`), {sid: sv.id, num: S.myNum, ratings: SURVEY_Q.map((_, i) => ans[i]), rec: ans.rec, comment: $("#svC").value.trim().slice(0, 800), at: new Date().toISOString()}); S.surveyDone = sv.id; S._svAns = null; render(); }
    catch (er) { if (er && er.code === "permission-denied") { S.surveyDone = sv.id; render(); } else toast("تعذّر الإرسال"); }
  };
}
function adminSurvey(){
  const sv = S.survey || {};
  const box = $("#svBox"); if (!box) return;
  const list = S.surveyAll || [];
  const ids = [...new Set(list.map(x => x.sid))];
  const cur = S.svSel || sv.id || ids[0];
  const l = list.filter(x => x.sid === cur);
  const avg = i => l.length ? (l.reduce((a, x) => a + (x.ratings[i] || 0), 0) / l.length).toFixed(1) : "—";
  const recC = k => l.filter(x => x.rec === k).length;
  box.innerHTML = `<div class="card"><h2>استبيان رضا المتدربين (نهاية البرنامج)</h2>
    <p class="muted" style="margin-top:0">سري. يظهر للطلاب تبويب «الاستبيان» لما يكون مفتوح.</p>
    <div class="row"><input type="text" id="svT" class="grow" placeholder="عنوان الاستبيان، مثل: استبيان نهاية الفصل الأول 1448" value="${esc(sv.title || "")}">
    ${sv.open ? `<span class="pill p">مفتوح</span>${RO() ? "" : `<button class="btn sm" id="svClose">قفل الاستبيان</button>`}` : RO() ? "" : `<button class="btn pri sm" id="svOpen">فتح استبيان جديد</button>`}</div>
    ${ids.length > 1 ? `<label class="f" for="svSel" style="margin-top:8px">النتائج<select id="svSel">${ids.map(i => `<option value="${esc(i)}" ${i === cur ? "selected" : ""}>${esc((list.find(x => x.sid === i) || {}).title || i)}</option>`).join("")}</select></label>` : ""}
    ${l.length ? `<p style="margin:10px 0 4px"><b>${l.length}</b> مشارك من ${Object.keys(S.students || {}).length} طالب · ينصحون: <b>${Math.round(recC("yes") / l.length * 100)}%</b> · يمكن ${recC("maybe")} · ما ينصحون ${recC("no")}</p>
      <div class="tbl"><table><tbody>${SURVEY_Q.map((q, i) => `<tr><td class="nm">${q}</td><td><b>${avg(i)}</b></td><td style="width:40%"><span class="bar" style="display:block"><i style="width:${avg(i) === "—" ? 0 : avg(i) / 5 * 100}%"></i></span></td></tr>`).join("")}</tbody></table></div>
      ${l.filter(x => x.comment).length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">الملاحظات (${l.filter(x => x.comment).length})</summary><div class="list" style="margin-top:6px">${l.filter(x => x.comment).map(x => `<div class="item" style="padding:8px 12px">${esc(x.comment)}</div>`).join("")}</div></details>` : ""}
      <div class="row" style="margin-top:8px"><button class="btn sm" id="svX">تنزيل Excel</button></div>` : `<p class="muted">ما وصلت ردود بعد.</p>`}</div>`;
  const saveSv = (d, msg) => setDoc(ref("public/survey"), d, {merge: true}).then(() => { logAction(msg, d.title || ""); toast("انحفظ"); }).catch(handleWriteErr);
  if ($("#svOpen")) $("#svOpen").onclick = () => { const title = $("#svT").value.trim() || "استبيان رضا المتدربين"; saveSv({id: "sv-" + today().replace(/-/g, "") + "-" + uid(), title, open: true}, "فتح استبيان الرضا"); };
  if ($("#svClose")) $("#svClose").onclick = () => saveSv({open: false}, "قفل استبيان الرضا");
  if ($("#svSel")) $("#svSel").onchange = e => { S.svSel = e.target.value; adminSurvey(); };
  if ($("#svX")) $("#svX").onclick = () => excelDownload("استبيان الرضا", [{title: "الردود", rows: [[INST_AR], ["استبيان رضا المتدربين"], [], [...SURVEY_Q, "التوصية", "الملاحظة"], ...l.map(x => [...x.ratings, RECOMMEND[x.rec] || "", x.comment || ""]), [], [...SURVEY_Q.map((_, i) => Number(avg(i)) || 0), "المتوسط"]], widths: [...SURVEY_Q.map(() => 14), 12, 40]}]);
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
  S.joins = {};
  S.unsubJoins = onSnapshot(query(collection(db, "joins"), where("groupId", "==", S.tGroup), where("date", "==", S.tDate)), snap => {
    S.joins = {}; snap.docs.forEach(d => { const j = d.data(); S.joins[j.num] = j.time; });
    if (S.tTab === "roll" && !busyEditing()) render();
  }, () => {});
}
function stopAtt(){ if (S.unsubAtt) S.unsubAtt(); if (S.unsubGroupAtt) S.unsubGroupAtt(); if (S.unsubJoins) S.unsubJoins(); S.unsubAtt = S.unsubGroupAtt = S.unsubJoins = null; S.att = null; S.groupAtt = []; S.joins = {}; }
function attData(){
  const g = S.groups[S.tGroup];
  return S.att ? clone(S.att) : {groupId: g.id, trainerId: g.trainerId || "", course: g.course, date: S.tDate, rec: {}};
}
function commitAtt(d){
  const hol = isHoliday(S.tDate);
  if (hol) { toast(`هذا اليوم إجازة (${hol.label || "إجازة رسمية"})، ما ينحسب فيه تحضير`); render(); return; }
  if (isLocked(S.tDate)) { toast(`التحضير مقفل لهذا التاريخ (بعد ${lockHours()} ساعة من نهاية يوم المحاضرة). تواصل مع الشؤون الأكاديمية`); render(); return; }
  logAction("تحضير", `${S.groups[S.tGroup].course} · ${S.tDate}`, "att:" + S.tGroup + ":" + S.tDate);
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
    <div class="row" style="margin-bottom:10px">
      <input type="url" id="mlink" class="grow" dir="ltr" placeholder="رابط اجتماع Teams للمقرر" value="${esc(g.meetLink || "")}">
      <button class="btn sm" id="mlSave">حفظ الرابط</button>
      ${validLink(g.meetLink) ? `<a class="btn sm pri" href="${esc(g.meetLink.trim())}" target="_blank" rel="noopener">فتح Teams</a>` : ""}
    </div>
    <details style="margin-bottom:10px"><summary class="muted" style="cursor:pointer">تسجيلات المحاضرات (${(g.recordings || []).length})</summary>
      <div class="list" style="margin-top:8px">${(g.recordings || []).map((r, i) => `<div class="item" style="padding:8px 10px"><span class="grow">${dH(r.date)} · ${esc(r.title)}</span><a class="btn sm" href="${esc(validLink(r.url) ? r.url : "#")}" target="_blank" rel="noopener">فتح</a><button class="btn sm danger" data-rrec="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه تسجيلات</span>`}</div>
      <div class="row" style="margin-top:8px">
        <input type="date" id="recD" value="${today()}" style="width:150px">
        <input type="text" id="recT" class="grow" placeholder="عنوان المحاضرة">
        <input type="url" id="recU" class="grow" dir="ltr" placeholder="رابط التسجيل (OneDrive / Stream / YouTube)">
        <button class="btn sm pri" id="recAdd">+ إضافة</button>
      </div>
    </details>
    <div class="row">
      ${S.tTab === "roll" ? `<label class="f" for="d" style="min-width:170px">تاريخ المحاضرة<input type="date" id="d" value="${esc(S.tDate)}" max="${today()}"></label>${isLocked(S.tDate) ? `<span class="pill a">مقفل للتعديل</span>` : ""}${isHoliday(S.tDate) ? `<span class="pill e">إجازة: ${esc(isHoliday(S.tDate).label || "رسمية")}</span>` : ""}` : ""}
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
        ${Object.keys(S.joins || {}).length ? `<button class="btn gold sm" id="allJ">تحضير اللي دخلوا Teams (${st.filter(s => s.sid && S.joins[s.sid]).length})</button>` : ""}
      </div>
    </div></div>
    <div class="list" id="roll">${st.length ? st.map((s,i) => stuRow(s,i,rec[s.id]||{})).join("") : `<div class="card empty">ما فيه طلاب في هذا المقرر بعد.</div>`}</div>`;
  } else if (S.tTab === "hist") body = `<div class="card"><h2>سجل الحضور</h2>${matrixTable(g, S.groupAtt)}</div>`;
  else body = gradesEditor(g, "trainer");
  app.innerHTML = head + body;
  $("#back").onclick = () => { S.tGroup = null; stopAtt(); render(); };
  const saveRecs = async list => {
    try { await setDoc(ref("groups/" + g.id), {recordings: list}, {merge: true}); S.groups[g.id].recordings = list; logAction("تسجيلات المحاضرات", g.course); render(); return true; }
    catch (e) { handleWriteErr(e); return false; }
  };
  $("#recAdd").onclick = async () => {
    const r = {date: $("#recD").value || today(), title: $("#recT").value.trim() || "محاضرة", url: $("#recU").value.trim()};
    if (!validLink(r.url)) return toast("رابط التسجيل لازم يبدأ بـ https://");
    if (await saveRecs([...(g.recordings || []), r].sort((a, b) => b.date.localeCompare(a.date)))) toast("انضاف التسجيل، والطلاب يشوفونه الحين");
  };
  document.querySelectorAll("[data-rrec]").forEach(b => b.onclick = () => { const l = [...(g.recordings || [])]; l.splice(Number(b.dataset.rrec), 1); saveRecs(l); });
  $("#mlSave").onclick = async () => {
    const v = $("#mlink").value.trim();
    if (v && !validLink(v)) return toast("الرابط لازم يبدأ بـ https://");
    try { await setDoc(ref("groups/" + g.id), {meetLink: v}, {merge: true}); S.groups[g.id].meetLink = v; logAction("رابط Teams", g.course); toast(v ? "انحفظ رابط المحاضرة، والطلاب يشوفونه الحين" : "انشال الرابط"); render(); }
    catch (e) { handleWriteErr(e); }
  };
  if ($("#d")) $("#d").onchange = e => { if (e.target.value) { S.tDate = e.target.value; startAtt(); render(); } };
  app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tTab = b.dataset.tab; render(); });
  if (S.tTab === "roll") {
    bindRoll(st, rec);
    if (isLocked(S.tDate) || isHoliday(S.tDate)) app.querySelectorAll("#roll button, #roll input, #allP, #allOut, #allA, #allJ").forEach(x => x.disabled = true);
  }
  else if (S.tTab === "hist") bindCopy();
  else bindGrades(g, "trainer");
}
function stuRow(s, i, r){
  const stc = r.st || "";
  return `<div class="stu ${stc}" data-s="${esc(s.id)}">
    <span class="num">${i+1}</span>
    <span class="nm">${esc(s.name)} <span class="pill ${s.gender}">${GENDER[s.gender]||""}</span>${s.sid && S.joins && S.joins[s.sid] ? ` <span class="pill e">دخل Teams ${fmtTime(S.joins[s.sid])}</span>` : ""}</span>
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
  if ($("#allJ")) $("#allJ").onclick = () => bulk((s, R) => { const t = s.sid && S.joins[s.sid]; if (t && (!R[s.id] || !R[s.id].st)) R[s.id] = {st: "p", in: t}; });
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
  const put = async d => { S.grades[g.id] = d; try { await setDoc(ref("grades/" + g.id), d); logAction("الدرجات: " + GSTAT[d.status], g.course); return true; } catch (e) { handleWriteErr(e); return false; } };
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
    try { await b.commit(); S.grades[g.id] = d; logAction("اعتماد الدرجات ونشرها", g.course); toast("اعتُمدت الدرجات وظهرت للطلاب"); render(); } catch (e) { handleWriteErr(e); }
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
      await b.commit(); S.grades[g.id] = d; logAction("إلغاء اعتماد الدرجات", g.course); toast("أُلغي الاعتماد"); render();
    } catch (e) { handleWriteErr(e); }
  };
}

/* ---------- absence rules (thresholds + holidays from public/system) ---------- */
const TH = () => ({warn1: 10, warn2: 15, deny: 20, certMin: 80, ...((S.sys && S.sys.thresholds) || {})});
const isHoliday = date => ((S.sys && S.sys.holidays) || []).find(h => date >= h.from && date <= (h.to || h.from));
const countable = docs => (docs || []).filter(d => d && d.date && !isHoliday(d.date));
const LEVEL = ["منتظم", "الإنذار الأول", "الإنذار الثاني", "حرمان"];
const LEVEL_PILL = ["p", "l", "a", "a"];
/* absences are counted against the course's planned total when set, otherwise against lectures held so far.
   late = present, excused = not absent, unmarked in a recorded lecture = absent */
function absStats(g, entryId, docs){
  let p = 0, l = 0, a = 0, e = 0;
  docs.forEach(d => { const r = d.rec && d.rec[entryId]; if (!r || !r.st || r.st === "a") a++; else if (r.st === "p") p++; else if (r.st === "l") l++; else e++; });
  const held = docs.length, total = Number(g.totalSessions) || 0, base = total || held;
  const absPct = base ? Math.round(a / base * 1000) / 10 : 0;
  const th = TH(), early = !total && held < 5;   // without a planned total, don't warn on the first few lectures
  const level = early ? 0 : absPct >= th.deny ? 3 : absPct >= th.warn2 ? 2 : absPct >= th.warn1 ? 1 : 0;
  const remaining = total ? Math.max(0, Math.ceil(total * th.deny / 100) - 1 - a) : null;
  return {p, l, a, e, held, total, absPct, attPct: held ? Math.round((p + l) / held * 100) : null, level, remaining};
}
const levelPill = st => `<span class="pill ${LEVEL_PILL[st.level]}">${LEVEL[st.level]}</span>`;


/* ================= printing, Excel export, certificates ================= */
const SITE = () => location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, "");
const INST_AR = "معهد أسس التقنية والقانون العالي للتدريب", INST_EN = "OSOS Higher Institute of Technology & Law for Training";
const hijri = d => { try { return new Date(d + "T12:00:00").toLocaleDateString("ar-SA-u-ca-islamic-umalqura-nu-latn", {day: "numeric", month: "long", year: "numeric"}).replace(/\s*هـ\s*$/, "") + " هـ"; } catch { return ""; } };
const greg = d => { try { return new Date(d + "T12:00:00").toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", {day: "numeric", month: "long", year: "numeric"}) + " م"; } catch { return d; } };
const bothDates = d => `${hijri(d)} · ${greg(d)}`;
/* open the window inside the click, fill it after any awaits (keeps popup blockers happy) */
function openPrint(){
  const w = window.open("", "_blank");
  if (!w) { toast("المتصفح منع فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة لهذا الموقع"); return null; }
  w.document.write(`<p dir="rtl" style="font-family:sans-serif;padding:20px">جاري التجهيز…</p>`);
  return w;
}
const PRINT_CSS = `
@page{size:A4;margin:12mm}
*{box-sizing:border-box}body{margin:0;font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;color:#1d2621;font-size:12.5px;background:#eef1ee}
.bar{position:sticky;top:0;background:#1F5136;color:#fff;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;z-index:2}
.bar button{font:inherit;background:#C9A54C;color:#1F5136;border:0;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer}
.page{background:#fff;width:210mm;min-height:297mm;margin:12px auto;padding:14mm 13mm;position:relative;page-break-after:always;break-after:page}
.page.land{width:297mm;min-height:210mm}
.hd{display:flex;align-items:center;gap:12px;border-bottom:2px solid #C9A54C;padding-bottom:10px;margin-bottom:14px}
.hd img{width:58px;height:58px;object-fit:contain}.hd .t{flex:1}.hd b{display:block;font-size:15px;color:#1F5136}.hd span{font-size:10.5px;color:#8a6d22;letter-spacing:.3px}
.hd .meta{font-size:11px;text-align:left;color:#555}
.hd .licq svg{width:52px;height:52px;display:block}
h1{font-size:19px;color:#1F5136;text-align:center;margin:6px 0 14px}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #c9d2cc;padding:5px 6px;text-align:center}
th{background:#1F5136;color:#fff;font-weight:600}td.n{text-align:right}tr:nth-child(even) td{background:#f6f8f6}
.info{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 18px;margin:0 0 12px;font-size:12.5px}.info div b{color:#1F5136}
.sig{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:40px}.sig div{border-top:1px dashed #999;padding-top:6px;text-align:center;color:#444}
.ft{position:absolute;bottom:8mm;left:13mm;right:13mm;border-top:1px solid #e3e3e3;padding-top:5px;font-size:9.5px;color:#888;display:flex;justify-content:space-between}
.k-p{color:#1E7B46;font-weight:700}.k-a{color:#B3261E;font-weight:700}.k-l{color:#9A6A00;font-weight:700}.k-e{color:#2F5C9A;font-weight:700}
.letter p{font-size:14px;line-height:2}
.cert{border:3px double #C9A54C;outline:10px solid #1F5136;outline-offset:-22px;padding:22mm 20mm;text-align:center}
.cert img.logo{width:120px}.cert h1{font-size:30px;margin:8px 0 2px}.cert .en{color:#8a6d22;font-size:12px;letter-spacing:1px}
.cert .who{font-size:26px;color:#1F5136;font-weight:700;margin:16px 0 6px}.cert p{font-size:15px;line-height:2}
.cert .qr{position:absolute;bottom:20mm;left:22mm;text-align:center;font-size:9.5px;color:#555}.cert .qr svg{width:92px;height:92px}
@media print{body{background:#fff}.bar{display:none}.page{margin:0;width:auto;min-height:auto}}
`;
const fillPrintFin = (w, title, pages, land) => fillPrint(w, title, pages, land, "المالية");
function fillPrint(w, title, pages, land, dept){
  if (!w) return;
  const head = `<header class="hd"><img src="${SITE()}logo-mark.png" alt=""><div class="t"><b>${INST_AR}</b><span>${INST_EN}</span></div><div class="meta">${esc(dept || "الشؤون الأكاديمية")}<br>${esc(bothDates(today()))}${S.site && S.site.accNo ? `<br>رقم الرخصة: ${esc(S.site.accNo)}` : ""}</div>${S._licQR && S.site && S.site.licUrl === S._licQRurl ? `<div class="licq">${S._licQR}</div>` : ""}</header>`;
  w.document.open();
  w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap" rel="stylesheet">
  <style>${PRINT_CSS}${land ? "@page{size:A4 landscape}" : ""}</style></head><body>
  <div class="bar"><span>${esc(title)}</span><button onclick="print()">طباعة / حفظ PDF</button></div>
  ${pages.map(pg => `<section class="page${land ? " land" : ""}">${pg.noHead ? "" : head}${pg.html}<div class="ft"><span>${INST_AR}</span><span>${esc(title)}</span></div></section>`).join("")}
  <script>(document.fonts?document.fonts.ready:Promise.resolve()).then(()=>setTimeout(()=>print(),400))<\/script></body></html>`);
  w.document.close();
}
const KS = {p: "ح", l: "ت", a: "غ", e: "م"};
function groupSheetData(g, docs){
  const {sessions, rows} = matrix(g, docs);
  return {sessions, rows: rows.map(r => ({...r, cells: r.cells.map(c => c.st || "a")}))};
}
function printGroupSheet(g, docs){
  const w = openPrint(); if (!w) return;
  const {sessions, rows} = groupSheetData(g, docs);
  const html = `<h1>كشف الحضور والغياب</h1>
    <div class="info"><div><b>المقرر:</b> ${esc(g.course)}</div><div><b>المدرب/ة:</b> ${esc(tName(g.trainerId))}</div>
    <div><b>عدد المتدربين:</b> ${(g.students || []).length}</div><div><b>المحاضرات:</b> ${sessions.length}${g.totalSessions ? " من " + g.totalSessions : ""} · الحرمان عند ${TH().deny}% غياب</div></div>
    <table><thead><tr><th>م</th><th>الاسم</th><th>الرقم</th>${sessions.map(d => `<th>${esc(d.date.slice(5))}</th>`).join("")}<th>حضور</th><th>غياب</th><th>النسبة</th><th>الحالة</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${r.i + 1}</td><td class="n">${esc(r.s.name)}</td><td>${esc(r.s.sid || "")}</td>${r.cells.map(k => `<td class="k-${k}">${KS[k]}</td>`).join("")}<td>${r.st.attPct === null ? "—" : r.st.attPct + "%"}</td><td>${r.st.a}</td><td>${r.st.absPct}%</td><td>${LEVEL[r.st.level]}</td></tr>`).join("")}
    </tbody></table><p style="font-size:10.5px;color:#666">ح حاضر · ت متأخر · غ غائب · م مستأذن/عذر مقبول</p>
    <div class="sig"><div>المدرب/ة</div><div>الشؤون الأكاديمية</div></div>`;
  fillPrint(w, `كشف حضور ${g.course}`, [{html}], sessions.length > 8);
  logAction("طباعة كشف حضور", g.course);
}
let _xlsx = null;
const loadXLSX = async () => _xlsx || (_xlsx = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs"));
async function excelDownload(name, sheets){
  let X; try { X = await loadXLSX(); } catch { return toast("تعذّر تحميل أداة Excel، تأكد من الاتصال"); }
  const wb = X.utils.book_new();
  sheets.forEach(({title, rows, widths}) => { const ws = X.utils.aoa_to_sheet(rows); if (widths) ws["!cols"] = widths.map(wch => ({wch})); X.utils.book_append_sheet(wb, ws, title.slice(0, 31)); });
  wb.Workbook = {Views: [{RTL: true}]};
  X.writeFile(wb, name.replace(/[\\/:*?"<>|]/g, "-") + ".xlsx");
}
function excelGroupSheet(g, docs){
  const {sessions, rows} = groupSheetData(g, docs);
  const data = [[INST_AR], [`كشف الحضور والغياب · ${g.course} · ${tName(g.trainerId)}`], [`تاريخ الإصدار: ${bothDates(today())}`], [],
    ["م", "الاسم", "الرقم", ...sessions.map(d => d.date), "حضور %", "غياب", "نسبة الغياب %", "الحالة"],
    ...rows.map(r => [r.i + 1, r.s.name, r.s.sid || "", ...r.cells.map(k => STATUS[k]), r.st.attPct, r.st.a, r.st.absPct, LEVEL[r.st.level]])];
  excelDownload(`كشف حضور - ${g.course} - ${tName(g.trainerId)}`, [{title: "الحضور", rows: data, widths: [5, 28, 11, ...sessions.map(() => 11), 8, 7, 12, 14]}]);
  logAction("تصدير Excel", g.course);
}
async function studentReportData(num){
  const snap = await getDocs(query(collection(db, "att"), where("memberNums", "array-contains", num)));
  const docs = snap.docs.map(d => d.data());
  const gs = Object.values(S.groups).filter(g => (g.memberNums || []).includes(num)).sort((a, b) => (a.course || "").localeCompare(b.course || "", "ar"));
  return gs.map(g => { const e = (g.students || []).find(x => x.sid === num); const ds = countable(docs.filter(d => d.groupId === g.id)).sort((a, b) => a.date.localeCompare(b.date)); return {g, e, ds, st: absStats(g, e ? e.id : "", ds)}; });
}
async function printStudentReport(num){
  const w = openPrint(); if (!w) return;
  const s = S.students[num]; const data = await studentReportData(num);
  const html = `<h1>كشف حضور متدرب</h1>
    <div class="info"><div><b>الاسم:</b> ${esc(s.name)}</div><div><b>الرقم الأكاديمي:</b> ${esc(num)}</div></div>
    <table><thead><tr><th>المقرر</th><th>المدرب/ة</th><th>المحاضرات</th><th>حضور</th><th>تأخير</th><th>غياب</th><th>عذر</th><th>نسبة الغياب</th><th>الحالة</th></tr></thead><tbody>
    ${data.map(({g, st}) => `<tr><td class="n">${esc(g.course)}</td><td class="n">${esc(tName(g.trainerId))}</td><td>${st.held}${st.total ? "/" + st.total : ""}</td><td>${st.p}</td><td>${st.l}</td><td>${st.a}</td><td>${st.e}</td><td>${st.absPct}%</td><td>${LEVEL[st.level]}</td></tr>`).join("")}
    </tbody></table>
    ${data.map(({g, e, ds}) => ds.length ? `<h3 style="color:#1F5136;margin:16px 0 6px">${esc(g.course)}</h3><table><thead><tr>${ds.map(d => `<th>${esc(d.date.slice(5))}</th>`).join("")}</tr></thead><tbody><tr>${ds.map(d => { const k = (e && d.rec && d.rec[e.id] && d.rec[e.id].st) || "a"; return `<td class="k-${k}">${KS[k]}</td>`; }).join("")}</tr></tbody></table>` : "").join("")}
    <div class="sig"><div>الشؤون الأكاديمية</div><div>الختم</div></div>`;
  fillPrint(w, `كشف حضور ${s.name}`, [{html}]);
  logAction("طباعة كشف متدرب", `${s.name} · ${num}`);
}
async function excelStudentReport(num){
  const s = S.students[num]; const data = await studentReportData(num);
  const rows = [[INST_AR], [`كشف حضور: ${s.name} · ${num}`], [`تاريخ الإصدار: ${bothDates(today())}`], [], ["المقرر", "المدرب/ة", "المحاضرات", "حضور", "تأخير", "غياب", "عذر", "نسبة الغياب %", "الحالة"],
    ...data.map(({g, st}) => [g.course, tName(g.trainerId), st.held, st.p, st.l, st.a, st.e, st.absPct, LEVEL[st.level]])];
  excelDownload(`كشف حضور - ${s.name}`, [{title: "الحضور", rows, widths: [28, 22, 10, 7, 7, 7, 7, 12, 14]}]);
}
function warningLetter(w){
  const deny = w.level === 3, title = deny ? "إشعار حرمان بسبب الغياب" : `${w.levelName} بسبب الغياب`;
  return `<div class="letter"><h1>${title}</h1>
    <div class="info"><div><b>المتدرب/ة:</b> ${esc(w.name)}</div><div><b>الرقم الأكاديمي:</b> ${esc(w.num)}</div>
    <div><b>المقرر:</b> ${esc(w.course)}</div><div><b>تاريخ الإصدار:</b> ${esc(bothDates(w.date))}</div></div>
    <p>نفيدكم بأن غيابكم في المقرر المذكور بلغ <b>(${w.absences ?? "—"})</b> محاضرة، بنسبة <b>${w.absPct}%</b>${(S.groups[w.groupId] || {}).totalSessions ? ` من إجمالي محاضرات المقرر (${S.groups[w.groupId].totalSessions})` : ""}.</p>
    <p>وبناءً على لائحة الحضور والغياب المعتمدة في المعهد، فقد صدر بحقكم <b>${esc(w.levelName)}</b>${deny ? "، وتُطبَّق بحقكم إجراءات الحرمان وفق اللائحة." : `، علماً بأن الحرمان يقع عند بلوغ نسبة الغياب ${TH().deny}%. نأمل منكم الالتزام بالحضور.`}</p>
    <p>والله ولي التوفيق.</p>
    <div class="sig"><div>الشؤون الأكاديمية<br><small>الاسم والتوقيع والختم</small></div><div>المتدرب/ة<br><small>اطلعت · التوقيع · التاريخ</small></div></div></div>`;
}
function printWarnings(list){
  const w = openPrint(); if (!w) return;
  fillPrint(w, list.length === 1 ? `${list[0].levelName} · ${list[0].name}` : `الإنذارات (${list.length})`, list.map(x => ({html: warningLetter(x)})));
  logAction("طباعة إنذارات", list.map(x => x.name).join("، "));
}
let _qr = null;
const loadQR = () => _qr || (_qr = new Promise((ok, no) => { if (window.qrcode) return ok(window.qrcode); const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"; sc.onload = () => ok(window.qrcode); sc.onerror = no; document.head.appendChild(sc); }));
const verifyUrl = code => `${SITE()}?verify=${code}`;
async function certPage(c){
  let svg = "";
  try { const qrcode = await loadQR(); const q = qrcode(0, "M"); q.addData(verifyUrl(c.code)); q.make(); svg = q.createSvgTag({cellSize: 3, margin: 0}); } catch {}
  return {noHead: true, html: `<div class="cert">
    <img class="logo" src="${SITE()}logo.jpg" alt="">
    <h1>شهادة حضور</h1><div class="en">CERTIFICATE OF ATTENDANCE</div>
    <p style="margin-top:14px">يشهد ${INST_AR} بأن ${c.gender === "f" ? "المتدربة" : "المتدرب"}</p>
    <div class="who">${esc(c.name)}</div>
    <p>صاحب${c.gender === "f" ? "ة" : ""} الرقم الأكاديمي <b>${esc(c.num)}</b>، قد ${c.gender === "f" ? "حضرت" : "حضر"} مقرر <b>${esc(c.course)}</b><br>
    مع ${esc(c.trainer)}، بنسبة حضور <b>${c.attPct}%</b>، وأُصدرت ${c.gender === "f" ? "لها" : "له"} هذه الشهادة بتاريخ ${esc(bothDates(c.date))}.</p>
    <div class="sig" style="margin-top:34px"><div>الشؤون الأكاديمية</div><div>مدير المعهد</div></div>
    <div class="qr">${svg}<div>للتحقق: ${esc(c.code)}</div></div>
  </div>`};
}
async function printCerts(list){
  const w = openPrint(); if (!w) return;
  const pages = []; for (const c of list) pages.push(await certPage(c));
  fillPrint(w, list.length === 1 ? `شهادة حضور · ${list[0].name}` : `شهادات حضور (${list.length})`, pages, true);
}
const certCode = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(10)); r.forEach(x => s += a[x % a.length]); return s; };
function renderVerify(app){
  if (S._vHTML) { app.innerHTML = S._vHTML; return; }
  if (S._vBusy) return; S._vBusy = true;
  app.innerHTML = `<div class="card" style="max-width:560px;width:100%;justify-self:center;text-align:center"><p class="muted">جاري التحقق…</p></div>`;
  const done = () => { S._vHTML = app.innerHTML; };
  getDoc(ref("certs/" + S.verify)).then(snap => {
    if (!snap.exists() || snap.data().revoked) { app.innerHTML = `<div class="card" style="max-width:560px;width:100%;justify-self:center;text-align:center"><h2 style="color:var(--abs)">الشهادة غير موجودة</h2><p>رمز التحقق <b dir="ltr">${esc(S.verify)}</b> غير صحيح، أو الشهادة ملغاة.</p></div>`; return done(); }
    const c = snap.data();
    app.innerHTML = `<div class="card" style="max-width:560px;width:100%;justify-self:center;text-align:center">
      <img src="logo-mark.png" alt="" style="width:90px"><h2 style="color:var(--ok)">✓ شهادة حضور صحيحة</h2>
      <div class="list" style="text-align:right">
        <div class="item"><span class="grow">الاسم</span><b>${esc(c.name)}</b></div>
        <div class="item"><span class="grow">الرقم الأكاديمي</span><b>${esc(c.num)}</b></div>
        <div class="item"><span class="grow">المقرر</span><b>${esc(c.course)}</b></div>
        <div class="item"><span class="grow">نسبة الحضور</span><b>${c.attPct}%</b></div>
        <div class="item"><span class="grow">تاريخ الإصدار</span><b>${esc(bothDates(c.date))}</b></div>
        <div class="item"><span class="grow">رمز التحقق</span><b dir="ltr">${esc(c.code)}</b></div>
      </div><p class="muted">صادرة من ${INST_AR}</p></div>`;
    done();
  }).catch(() => { app.innerHTML = `<div class="notice err">تعذّر التحقق، حاول مرة ثانية.</div>`; });
}

/* ---------- attendance matrix ---------- */
function matrix(g, docs){
  const sessions = countable(docs).sort((a,b) => a.date.localeCompare(b.date));
  const rows = (g.students||[]).map((s,i) => {
    const cells = sessions.map(d => (d.rec && d.rec[s.id]) || {});
    const st = absStats(g, s.id, sessions);
    return {s, i, cells, k: st, st, rate: st.attPct};
  });
  return {sessions, rows};
}
function matrixTable(g, docs){
  const {sessions, rows} = matrix(g, docs);
  if (!sessions.length) return `<div class="card empty">ما فيه محاضرات مسجلة لهذا المقرر بعد.</div>`;
  const cell = r => r.st ? `<span class="pill ${r.st}">${STATUS[r.st]}</span>${r.in ? `<div class="muted" style="font-size:11.5px">${fmtTime(r.in)}${r.out ? " ← " + fmtTime(r.out) : ""}</div>` : ""}` : `<span class="muted">—</span>`;
  return `<div class="row" style="justify-content:space-between"><span class="muted">${sessions.length} محاضرة مسجلة${g.totalSessions ? ` من ${g.totalSessions}` : ""} · الخانة الفاضية تُحسب غياب · الحرمان عند ${TH().deny}% غياب</span><button class="btn sm" id="copyT">نسخ الجدول</button></div>
  <div class="tbl"><table id="mt"><thead><tr><th>م</th><th class="nm">الاسم</th><th>الحضور</th><th>غياب</th><th>نسبة الغياب</th><th>الحالة</th><th>تأخير</th><th>استئذان</th>${sessions.map(d => `<th>${esc(d.date.slice(5))}</th>`).join("")}</tr></thead>
  <tbody>${rows.map(r => `<tr><td>${r.i+1}</td><td class="nm">${esc(r.s.name)}</td>
    <td><div class="row" style="gap:6px;flex-wrap:nowrap"><b>${r.rate}%</b><span class="bar"><i style="width:${r.rate}%"></i></span></div></td>
    <td>${r.k.a}</td><td>${r.st.absPct}%</td><td>${levelPill(r.st)}</td><td>${r.k.l}</td><td>${r.k.e}</td>${r.cells.map(c => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function bindCopy(){
  const b = $("#copyT"); if (!b) return;
  b.onclick = async () => {
    const tsv = [...$("#mt").rows].map(tr => [...tr.cells].map(td => td.innerText.replace(/\s+/g, " ").trim()).join("\t")).join("\n");
    try { await navigator.clipboard.writeText(tsv); toast("انتسخ الجدول، الصقه في Excel"); } catch { toast("المتصفح منع النسخ"); }
  };
}

/* ---------- admin portal ---------- */
function stopAdminSubs(){ if (S.unsubDash) S.unsubDash(); if (S.unsubReport) S.unsubReport(); if (S.unsubLogs) S.unsubLogs(); S.unsubDash = S.unsubReport = S.unsubLogs = null; }
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
  S.students[num] = d; S.stSecrets[num] = code; logAction("إضافة طالب", `${name} · ${num}`);
  return d;
}
function writeGroup(gid, d){
  logAction("تعديل شعبة", d.course, "grp:" + gid);
  delete d.id; d.memberNums = memberNums(d.students);
  S.groups[gid] = {id: gid, ...d}; saveDoc("groups/" + gid, d);
}

function renderAdmin(app){
  if (RO()) {
    const tabsRO = [["dash", "لوحة اليوم"], ["kpi", "المؤشرات"], ["follow", "المتابعة"], ["report", "التقارير"], ["archive", "الأرشيف"]];
    if (!tabsRO.some(([k]) => k === S.aTab)) S.aTab = "dash";
    app.innerHTML = `<div class="notice">حساب قراءة فقط: تقدر تشوف وتطبع وتصدّر، وما تقدر تعدّل شي.</div><div class="card" style="padding:10px 12px"><div class="tabs" style="border:0;padding:0">${tabsRO.map(([k,v]) => `<button class="tab ${S.aTab===k?"on":""}" data-at="${k}">${v}</button>`).join("")}</div></div><div id="ab"></div>`;
    app.querySelectorAll("[data-at]").forEach(b => b.onclick = () => { S.aTab = b.dataset.at; render(); });
    ({dash: adminDash, kpi: adminKpi, follow: adminFollow, report: adminReport, archive: adminArchive})[S.aTab]($("#ab"));
    if (RO()) app.querySelectorAll("#ab [data-issue], #issueAll, #cIssue, [data-rc], [data-twa], [data-wabs], [data-warn]").forEach(x => x.remove());
    return;
  }
  if (FIN()) {
    app.innerHTML = `<div id="ab"></div>`; adminFinance($("#ab")); return;
  }
  const tabs = [["dash","لوحة اليوم"],["kpi","المؤشرات"],["groups","المقررات والطلاب"],["students","الطلاب"],["msgs","الرسائل الجماعية"],["trainers","المدربين والرموز"],["grades","الدرجات"],["follow","المتابعة"],["excuses","الأعذار"],["evals","التقييمات"],["report","التقارير"],["system","النظام"],...(SEES_FIN() ? [["finance","المالية"]] : []),["archive","الأرشيف"],...(S.adminRole === "admin" ? [["logs","السجل"]] : [])];
  if (!tabs.some(([k]) => k === S.aTab)) S.aTab = "dash";
  const waiting = Object.values(S.grades).filter(x => x.status === "submitted").length;
  app.innerHTML = `${S.sys && S.sys.maintenance ? `<div class="notice err">وضع الصيانة شغّال: الموقع مقفل على الكل ما عدا الإدارة. تطفيه من تبويب "النظام".</div>` : ""}<div class="card" style="padding:10px 12px"><div class="tabs" style="border:0;padding:0">${tabs.map(([k,v]) => `<button class="tab ${S.aTab===k?"on":""}" data-at="${k}">${v}${k === "grades" && waiting ? ` (${waiting})` : ""}${k === "excuses" && (S.excuses || []).filter(x => x.status === "pending").length ? ` (${S.excuses.filter(x => x.status === "pending").length})` : ""}</button>`).join("")}</div></div><div id="ab"></div>`;
  app.querySelectorAll("[data-at]").forEach(b => b.onclick = () => { S.aTab = b.dataset.at; render(); });
  ({dash: adminDash, kpi: adminKpi, groups: adminGroups, students: adminStudents, msgs: adminMessages, trainers: adminTrainers, grades: adminGrades, follow: adminFollow, excuses: adminExcuses, evals: adminEvals, report: adminReport, system: adminSystem, archive: adminArchive, finance: adminFinance, logs: adminLogs})[S.aTab]($("#ab"));
}

function adminDash(el){
  if (!S.unsubDash) {
    S.unsubDash = onSnapshot(query(collection(db, "att"), where("date", "==", today())), snap => { S.aDash = snap.docs.map(d => d.data()); if (S.view === "admin" && S.aTab === "dash") render(); }, () => {});
  }
  const byG = {}; S.aDash.forEach(d => byG[d.groupId] = d);
  const gs = sortedGroups();
  const absentToday = [];
  gs.forEach(g => { const d = byG[g.id]; if (!d) return; (g.students || []).forEach(s => { const r = d.rec && d.rec[s.id]; if (r && r.st === "a") absentToday.push({name: s.name, sid: s.sid, course: g.course}); }); });
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
  let excused = 0; S.aDash.forEach(d => Object.values(d.rec || {}).forEach(r => { if (r.st === "e") excused++; }));
  const todayRate = pres + abs + excused ? Math.round(pres / (pres + abs + excused) * 100) : null;
  const dname = todayDay(), now = nowHM(), hol = isHoliday(today());
  const due = hol ? [] : gs.flatMap(g => (g.sessions || []).filter(x => x.day === dname).map(x => ({g, x}))).filter(({g}) => !byG[g.id]);
  const seen = new Set(), missing = due.filter(({g}) => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => a.x.from.localeCompare(b.x.from));
  el.innerHTML = `
  <div class="card"><h2>لوحة اليوم · ${esc(fmtDate(today()))}</h2>
    <div class="stats">
      <div class="stat"><div class="n">${done}/${gs.length}</div><div class="l">شعب تم تحضيرها</div></div>
      <div class="stat"><div class="n">${pres}</div><div class="l">حاضر ومتأخر</div></div>
      <div class="stat"><div class="n">${abs}</div><div class="l">غائب</div></div>
      <div class="stat"><div class="n">${nStu}</div><div class="l">طالب وطالبة</div></div>
      <div class="stat"><div class="n">${todayRate === null ? "—" : todayRate + "%"}</div><div class="l">نسبة حضور اليوم</div></div>
    </div>
    ${hol ? `<div class="notice" style="margin-top:10px">اليوم إجازة: ${esc(hol.label || "رسمية")}</div>` : ""}</div>
  ${missing.length ? `<div class="card"><h2>متابعة المدربين · ما حضّروا اليوم (${missing.length})</h2>
    <div class="list">${missing.map(({g, x}) => `<div class="item"><div class="grow"><div class="t">${esc(tName(g.trainerId))}</div><div class="muted">${esc(g.course)} · ${fmtTime(x.from)} – ${fmtTime(x.to)}</div></div>
      <span class="pill ${now > x.to ? "a" : now >= x.from ? "l" : ""}">${now > x.to ? "انتهت المحاضرة" : now >= x.from ? "المحاضرة الآن" : "لم تبدأ"}</span>
      ${g.trainerId && S.trainers[g.trainerId] ? `<button class="btn sm gold" data-twa="${esc(g.trainerId)}">واتساب</button>` : ""}</div>`).join("")}</div></div>` : ""}
  ${nStu ? "" : `<div class="notice">ما فيه حسابات طلاب بعد. روح لتبويب "الطلاب" واستورد ملف asas-students.json.</div>`}
  <div class="tbl"><table><thead><tr><th class="nm">المقرر</th><th class="nm">المدرب/ة</th><th>العدد</th><th>حاضر</th><th>غائب</th><th>مستأذن</th><th>الحالة</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty">ما فيه مقررات بعد</td></tr>`}</tbody></table></div>
  ${absentToday.length ? `<div class="card"><h2>غياب اليوم (${absentToday.length})</h2>
    <p class="muted" style="margin-top:0">اضغط واتساب، وتفتح محادثة الطالب ورسالة الغياب جاهزة.</p>
    <div class="list">${absentToday.map(a => `<div class="item"><div class="grow"><div class="t">${esc(a.name)}</div><div class="muted">${esc(a.course)}${a.sid ? " · " + esc(a.sid) : ""}</div></div>
      ${a.sid && (S.stPhones || {})[a.sid] ? "" : `<span class="pill">بدون جوال</span>`}
      ${a.sid ? `<button class="btn sm gold" data-wabs="${esc(a.sid)}" data-course="${esc(a.course)}">واتساب</button>` : ""}</div>`).join("")}</div></div>` : ""}`;
  el.querySelectorAll("[data-twa]").forEach(b => b.onclick = () => openWhatsAppTrainer(b.dataset.twa));
  el.querySelectorAll("[data-wabs]").forEach(b => b.onclick = () => openWhatsApp(b.dataset.wabs, {type: "absence", course: b.dataset.course}));
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
      <label class="f" for="mts" style="min-width:150px">عدد المحاضرات الكلي<input type="number" id="mts" min="0" value="${esc(g && g.totalSessions || "")}" placeholder="لحساب الحرمان"></label>
      <label class="f grow" for="mlk" style="min-width:220px">رابط Teams<input type="url" id="mlk" dir="ltr" value="${esc(g && g.meetLink || "")}" placeholder="https://teams.microsoft.com/..."></label>
      <label class="f" for="mm" style="min-width:130px">نمط الحضور<select id="mm"><option value="">—</option>${["حضوري","عن بعد"].map(m => `<option ${g && g.mode===m?"selected":""}>${m}</option>`).join("")}</select></label>
    </div>
    <label class="row" for="mev" style="gap:8px;cursor:pointer"><input type="checkbox" id="mev" ${g && g.evalOpen ? "checked" : ""}> فتح تقييم المدرب والمقرر للطلاب</label>
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
  const header = d => { d.course = $("#mc").value.trim(); d.trainerId = $("#mt2").value; d.mode = $("#mm").value; const l = $("#mlk").value.trim(); d.meetLink = validLink(l) ? l : ""; d.totalSessions = Math.max(0, Math.round(Number($("#mts").value) || 0)); d.evalOpen = $("#mev").checked; return d; };
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
    if (b.dataset.sure) { deleteDoc(ref("groups/" + S._modalGroup)).then(() => { logAction("حذف شعبة", (S.groups[S._modalGroup] || {}).course || ""); toast("انحذفت الشعبة"); }).catch(handleWriteErr); delete S.groups[S._modalGroup]; closeModal(); }
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
  <div class="card"><h2>استيراد متدربين من Excel</h2>
    <p class="muted" style="margin-top:0">الملف فيه أعمدة: <b>الاسم</b> و<b>الجنس</b> (طالب/طالبة)، واختياري <b>الجوال</b>. كل متدرب ينعمل له رقم ورمز. الأسماء الموجودة من قبل تنربط بدون تكرار.</p>
    <div class="row"><input type="file" id="xF" accept=".xlsx,.xls,.csv" class="grow"><button class="btn sm" id="xTpl">تنزيل نموذج</button></div>
    <div class="row" style="margin-top:8px"><select id="xG" class="grow"><option value="">بدون شعبة (أضيفهم بعدين)</option>${sortedGroups().map(g => `<option value="${esc(g.id)}">إضافتهم لشعبة: ${esc(g.course)} · ${esc(tName(g.trainerId))}</option>`).join("")}</select><button class="btn pri" id="xRun">استيراد</button></div>
    <div id="xLog" class="muted" style="margin-top:8px;white-space:pre-line"></div>
  </div>
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
      return `<div class="item"><div class="grow"><div class="t">${esc(s.name)} <span class="pill ${s.gender}">${GENDER[s.gender]}</span>${(S.disabled || {})[s.num] ? ` <span class="pill a">موقوف</span>` : ""}</div>
        <div class="muted">${gs.length} مقرر${gs.length ? " · " + gs.map(g => esc(g.course)).join("، ") : ""}</div></div>
        <span class="code">${esc(s.num)}</span><span class="code">${esc(S.stSecrets[s.num] || "••••••")}</span>
        <span class="pill ${(S.stPhones || {})[s.num] ? "p" : ""}" dir="ltr">${esc((S.stPhones || {})[s.num] || "بدون جوال")}</span>
        <button class="btn sm gold" data-wa="${esc(s.num)}">واتساب</button>
        <button class="btn sm" data-srep="${esc(s.num)}">كشف PDF</button><button class="btn sm" data-sxls="${esc(s.num)}">Excel</button>
        <button class="btn sm" data-scopy="${esc(s.num)}">نسخ</button><button class="btn sm" data-snew="${esc(s.num)}">رمز جديد</button><button class="btn sm" data-sdis="${esc(s.num)}">${(S.disabled || {})[s.num] ? "تفعيل" : "تعطيل"}</button><button class="btn sm danger" data-sdel="${esc(s.num)}">حذف</button></div>`;
    }).join("") || `<div class="card empty">${list.length ? "ما فيه نتائج" : "ما فيه طلاب بعد. استورد الملف من تحت."}</div>`;
    el.querySelectorAll("[data-wa]").forEach(b => b.onclick = () => openWhatsApp(b.dataset.wa));
    el.querySelectorAll("[data-srep]").forEach(b => b.onclick = () => printStudentReport(b.dataset.srep).catch(() => toast("تعذّر تجهيز الكشف")));
    el.querySelectorAll("[data-sxls]").forEach(b => b.onclick = () => excelStudentReport(b.dataset.sxls).catch(() => toast("تعذّر تجهيز الملف")));
    el.querySelectorAll("[data-sdis]").forEach(b => b.onclick = () => setDisabled("students", b.dataset.sdis, !(S.disabled || {})[b.dataset.sdis], (S.students[b.dataset.sdis] || {}).name));
    el.querySelectorAll("[data-sdel]").forEach(b => b.onclick = async () => {
      const num = b.dataset.sdel, st = S.students[num];
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "متأكد؟ يحذف من كل المقررات"; return; }
      b.disabled = true;
      try {
        const bt = writeBatch(db);
        Object.values(S.groups).filter(g => (g.memberNums || []).includes(num)).forEach(g => {
          const d = clone(g); delete d.id; d.students = (d.students || []).filter(x => x.sid !== num); d.memberNums = memberNums(d.students);
          bt.set(ref("groups/" + g.id), d);
        });
        const rs = await getDocs(query(collection(db, "results"), where("num", "==", num)));
        rs.docs.forEach(x => bt.delete(x.ref));
        const pubSnap = await getDoc(ref("public/studentLogin")); const map = (pubSnap.exists() && pubSnap.data().map) || {}; delete map[num];
        bt.set(ref("public/studentLogin"), {map});
        bt.delete(ref("students/" + num)); bt.delete(ref("studentSecrets/" + num));
        await bt.commit();
        delete S.students[num]; logAction("حذف طالب", `${st ? st.name : ""} · ${num}`); toast(`انحذف ${st ? st.name : num}`); render();
      } catch (e) { handleWriteErr(e); b.disabled = false; }
    });
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
        await bt.commit(); logAction("رمز جديد لطالب", `${s.name} · ${num}`); toast("انعمل رمز جديد: " + code);
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
  $("#xTpl").onclick = () => excelDownload("نموذج استيراد المتدربين", [{title: "المتدربين", rows: [["الاسم", "الجنس", "الجوال"], ["محمد عبدالله الفايز", "طالب", "0551234567"], ["لجين عادل", "طالبة", ""]], widths: [32, 10, 14]}]);
  $("#xRun").onclick = () => runExcelImport();
}

async function runExcelImport(){
  const f = $("#xF").files[0]; if (!f) return toast("اختر ملف Excel");
  const lines = []; const log = m => { lines.push(m); const el = $("#xLog"); if (el) el.textContent = lines.slice(-8).join("\n"); };
  let rows;
  try { const X = await loadXLSX(); const wb = X.read(await f.arrayBuffer()); rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, defval: ""}); }
  catch (e) { console.error(e); return toast("تعذّر قراءة الملف"); }
  const head = (rows[0] || []).map(h => norm(h));
  const col = names => head.findIndex(h => names.some(n => h.includes(norm(n))));
  const cN = col(["الاسم", "اسم"]), cG = col(["الجنس", "النوع", "الفئه", "الفئة"]), cP = col(["الجوال", "جوال", "الهاتف", "رقم"]);
  if (cN < 0) return toast("ما لقيت عمود الاسم في أول صف");
  const data = rows.slice(1).map(r => ({name: String(r[cN] || "").trim().replace(/\s+/g, " "), g: cG >= 0 ? String(r[cG] || "") : "", phone: cP >= 0 ? String(r[cP] || "") : ""})).filter(r => r.name);
  if (!data.length) return toast("الملف فاضي");
  const gid = $("#xG").value; S._busy = true; $("#xRun").disabled = true;
  let made = 0, linked = 0, phones = 0; const nums = [];
  try {
    for (const [i, r] of data.entries()) {
      const gender = /طالبه|طالبة|انثى|أنثى|female|^f$/i.test(r.g.trim()) ? "f" : "m";
      let st = findStudent(r.name, gender) || findStudent(r.name);
      if (!st) { log(`(${i + 1}/${data.length}) إنشاء ${r.name}`); st = await createStudent(r.name, gender); made++; } else linked++;
      nums.push(st);
      const ph = normPhone(r.phone);
      if (/^9665\d{8}$/.test(ph) && (S.stPhones || {})[st.num] !== ph) { await setDoc(ref("studentSecrets/" + st.num), {phone: ph}, {merge: true}); phones++; }
    }
  } catch (e) { console.error(e); log(accountErr(e) + " · شغّل الاستيراد مرة ثانية ويكمل من مكانه."); }
  if (gid && S.groups[gid] && nums.length) {
    const d = clone(S.groups[gid]); delete d.id; let n = 0;
    nums.forEach(st => { if (!(d.students || []).some(x => x.sid === st.num)) { d.students = [...(d.students || []), {id: "s" + uid(), name: st.name, gender: st.gender, sid: st.num}]; n++; } });
    if (n) { writeGroup(gid, d); log(`انضاف ${n} للشعبة.`); }
  }
  log(`تم: ${made} جديد، ${linked} موجود من قبل، ${phones} جوال.`);
  logAction("استيراد Excel", `${made} جديد · ${linked} موجود`);
  S._busy = false; const b = $("#xRun"); if (b) b.disabled = false;
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
    let made = 0, i = 0, quotaHit = false;
    for (const s of data.students) {
      i++;
      byName[norm(s.name)] = s.num;
      if (S.students[s.num] && S.students[s.num].uid) continue;
      if (quotaHit) continue;
      log(`(${i}/${data.students.length}) إنشاء حساب ${s.name} · ${s.num}`);
      let acc;
      try { acc = await createAccount("st-" + s.num, 0, s.code); }
      catch (e) {
        if (e && e.code === "auth/too-many-requests") { quotaHit = true; log("Firebase وقف إنشاء الحسابات مؤقتاً. بكمل ربط الطلاب الموجودين، وشغّل الاستيراد بعد ساعة عشان تنعمل الحسابات الباقية."); continue; }
        throw e;
      }
      map[s.num] = acc.ver;
      const b = writeBatch(db);
      b.set(ref("students/" + s.num), {num: s.num, name: s.name, gender: s.gender, ...acc});
      b.set(ref("studentSecrets/" + s.num), {code: s.code});
      b.set(ref("public/studentLogin"), {map});
      await b.commit();
      S.students[s.num] = {num: s.num, name: s.name, gender: s.gender, ...acc}; made++;
    }
    const left = data.students.filter(s => !(S.students[s.num] && S.students[s.num].uid)).length;
    log(`الحسابات: انعمل ${made} الحين${left ? `، وباقي ${left} بدون حساب` : "، وكل الطلاب لهم حسابات"}.`);
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
    if (left) log(`باقي ${left} طالب بدون حساب دخول. شغّل الاستيراد مرة ثانية بعد ساعة.`);
    toast("اكتمل الاستيراد");
  } catch (e) { console.error(e); log("توقف: " + accountErr(e)); }
  S._busy = false; const b = $("#upB"); if (b) b.disabled = false;
  const keep = $("#upLog") ? $("#upLog").textContent : ""; render(); if ($("#upLog")) $("#upLog").textContent = keep;
}

/* ---------- WhatsApp (opens a ready message; the admin presses send) ---------- */
function normPhone(p){
  let d = digits(p).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("05") && d.length === 10) d = "966" + d.slice(1);
  else if (d.startsWith("5") && d.length === 9) d = "966" + d;
  return d;
}
const SIGN = "\n\nالشؤون الأكاديمية\nمعهد أسس التقنية والقانون";
async function waText(num, type, opt){
  const st = S.students[num] || {}, hi = `${st.gender === "f" ? "المتدربة" : "المتدرب"}: ${st.name}\nالرقم الأكاديمي: ${num}\n\n`;
  const gs = Object.values(S.groups).filter(g => (g.memberNums || []).includes(num)).sort((a,b) => (a.course||"").localeCompare(b.course||"","ar"));
  if (type === "absence") return `${hi}نفيدكم بتسجيل غيابكم عن محاضرة (${opt.course}) اليوم ${fmtDate(today())}.\nللاستفسار تواصلوا مع الشؤون الأكاديمية.${SIGN}`;
  if (type === "warning") return `${hi}نفيدكم بصدور (${opt.level}) في مقرر (${opt.course})، حيث بلغت نسبة الغياب ${opt.pct}%.\nنسبة الحرمان ${TH().deny}%، نأمل الالتزام بالحضور.${SIGN}`;
  if (type === "login") return `${hi}بيانات دخولكم لبوابة الطلاب:\nالرقم الأكاديمي: ${num}\nرمز الدخول: ${S.stSecrets[num] || "—"}\nالرابط: ${location.href.split("#")[0].split("?")[0]}${SIGN}`;
  if (type === "note") return `${hi}${opt.note || ""}${SIGN}`;
  if (type === "att") {
    const snap = await getDocs(query(collection(db, "att"), where("memberNums", "array-contains", num)));
    const docs = snap.docs.map(d => d.data());
    const lines = gs.map(g => {
      const e = (g.students || []).find(s => s.sid === num); const ds = docs.filter(d => d.groupId === g.id);
      if (!ds.length) return `• ${g.course}: ما بدأ التحضير`;
      const k = {p:0,l:0,a:0,e:0}; ds.forEach(d => { const r = e && d.rec && d.rec[e.id]; if (r && r.st) k[r.st]++; else k.a++; });
      return `• ${g.course}: حضور ${k.p + k.l} من ${ds.length} (${Math.round((k.p + k.l) / ds.length * 100)}%)، غياب ${k.a}${k.l ? `، تأخير ${k.l}` : ""}${k.e ? `، استئذان ${k.e}` : ""}`;
    });
    return `${hi}سجل الحضور حتى ${fmtDate(today())}:\n${lines.join("\n") || "ما فيه مقررات"}${SIGN}`;
  }
  if (type === "grades") {
    const snap = await getDocs(query(collection(db, "results"), where("num", "==", num)));
    const res = {}; snap.docs.forEach(d => { const r = d.data(); res[r.groupId] = r; });
    const lines = gs.map(g => res[g.id] ? `• ${g.course}: ${res[g.id].mark} من 100 (${letter(res[g.id].mark)})` : `• ${g.course}: لم تُعتمد بعد`);
    return `${hi}الدرجات المعتمدة:\n${lines.join("\n") || "ما فيه مقررات"}${SIGN}`;
  }
  return hi + SIGN;
}
function openWhatsApp(num, preset){
  const st = S.students[num]; if (!st) return;
  S._modalGroup = null;
  const phone = (S.stPhones || {})[num] || "";
  $("#modalBox").innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-family:var(--display);color:var(--green);font-weight:600">واتساب · ${esc(st.name)}</h2><button class="btn sm" id="wx">إغلاق</button></div>
    <div class="row">
      <label class="f grow" for="wp">رقم الجوال<input type="tel" id="wp" dir="ltr" value="${esc(phone)}" placeholder="05xxxxxxxx"></label>
      <button class="btn sm" id="wpSave" style="align-self:flex-end">حفظ الرقم</button>
    </div>
    <div class="row">
      <button class="btn sm" data-wt="att">سجل الحضور</button>
      <button class="btn sm" data-wt="grades">الدرجات</button>
      <button class="btn sm" data-wt="login">بيانات الدخول</button>
      <button class="btn sm" data-wt="note">ملاحظة</button>
    </div>
    <label class="f" for="wm">الرسالة (تقدر تعدّلها)<textarea id="wm" style="min-height:200px"></textarea></label>
    <div class="row"><a class="btn pri" id="wgo" target="_blank" rel="noopener">فتح واتساب وإرسال</a><span class="muted" id="whint"></span></div>
    <div class="card" style="background:var(--bg)">
      <h3>إرفاق ملف (اختياري)</h3>
      <p class="muted" style="margin-top:0">مثل خطاب أو تقرير PDF أو صورة. من الجوال يفتح لك قائمة المشاركة: اختر واتساب ثم الطالب.</p>
      <div class="row"><input type="file" id="wf" class="grow"><button class="btn sm gold" id="wshare">مشاركة الملف مع الرسالة</button></div>
    </div>`;
  $("#modal").classList.add("on");
  $("#wx").onclick = closeModal;
  const link = () => {
    const p = normPhone($("#wp").value), a = $("#wgo");
    if (!/^9665\d{8}$/.test(p)) { a.removeAttribute("href"); a.classList.add("disabled"); $("#whint").textContent = "اكتب رقم جوال سعودي صحيح"; return; }
    a.href = `https://wa.me/${p}?text=${encodeURIComponent($("#wm").value)}`; $("#whint").textContent = "";
  };
  const fill = async (type, opt) => {
    $("#wm").value = "جاري التجهيز…";
    try { $("#wm").value = await waText(num, type, opt || {}); } catch (e) { console.error(e); $("#wm").value = ""; toast("تعذّر تجهيز الرسالة"); }
    if (type === "note") { const t = $("#wm"); t.focus(); t.setSelectionRange(t.value.indexOf("\n\n") + 2, t.value.indexOf("\n\n") + 2); }
    link();
  };
  $("#modalBox").querySelectorAll("[data-wt]").forEach(b => b.onclick = () => fill(b.dataset.wt));
  $("#wm").oninput = link; $("#wp").oninput = link;
  $("#wpSave").onclick = async () => {
    const p = normPhone($("#wp").value);
    if (!/^9665\d{8}$/.test(p)) return toast("رقم الجوال غير صحيح");
    try { await setDoc(ref("studentSecrets/" + num), {phone: p}, {merge: true}); S.stPhones = {...(S.stPhones || {}), [num]: p}; logAction("جوال طالب", `${st.name} · ${num}`); $("#wp").value = p; toast("انحفظ الرقم"); link(); }
    catch (e) { handleWriteErr(e); }
  };
  $("#wgo").onclick = e => { if (!$("#wgo").getAttribute("href")) { e.preventDefault(); toast("اكتب رقم جوال صحيح أولاً"); } };
  $("#wshare").onclick = async () => {
    const f = $("#wf").files[0]; if (!f) return toast("اختر الملف أولاً");
    const data = {files: [f], text: $("#wm").value};
    if (navigator.canShare && navigator.canShare(data)) {
      try { await navigator.share(data); } catch (e) { if (e.name !== "AbortError") toast("تعذّرت المشاركة"); }
    } else {
      toast("هالجهاز ما يدعم مشاركة الملفات. افتح واتساب من الزر، وأرفق الملف من داخل المحادثة");
    }
  };
  fill(preset ? preset.type : "att", preset);
}

function trainerText(tid, type, note){
  const t = S.trainers[tid] || {}, hi = `${t.gender === "f" ? "الأستاذة" : "الأستاذ"} ${t.name}\n\n`;
  if (type === "login") return `${hi}بيانات دخولك لبوابة المدربين:\nرقم المدرب: ${t.num || "—"}\nرمز الدخول: ${S.secrets[tid] || "—"}\nالرابط: ${location.href.split("#")[0].split("?")[0]}${SIGN}`;
  return `${hi}${note || ""}${SIGN}`;
}
function openWhatsAppTrainer(tid){
  const t = S.trainers[tid]; if (!t) return;
  S._modalGroup = null;
  $("#modalBox").innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-family:var(--display);color:var(--green);font-weight:600">واتساب · ${esc(trainerTitle(t))}</h2><button class="btn sm" id="wx">إغلاق</button></div>
    <div class="row">
      <label class="f grow" for="wp">رقم الجوال<input type="tel" id="wp" dir="ltr" value="${esc((S.trPhones || {})[tid] || "")}" placeholder="05xxxxxxxx"></label>
      <button class="btn sm" id="wpSave" style="align-self:flex-end">حفظ الرقم</button>
    </div>
    <div class="row"><button class="btn sm" data-wt="login">بيانات الدخول</button><button class="btn sm" data-wt="note">ملاحظة</button></div>
    <label class="f" for="wm">الرسالة (تقدر تعدّلها)<textarea id="wm" style="min-height:180px"></textarea></label>
    <div class="row"><a class="btn pri" id="wgo" target="_blank" rel="noopener">فتح واتساب وإرسال</a><span class="muted" id="whint"></span></div>`;
  $("#modal").classList.add("on");
  $("#wx").onclick = closeModal;
  const link = () => {
    const p = normPhone($("#wp").value), a = $("#wgo");
    if (!/^9665\d{8}$/.test(p)) { a.removeAttribute("href"); $("#whint").textContent = "اكتب رقم جوال سعودي صحيح"; return; }
    a.href = `https://wa.me/${p}?text=${encodeURIComponent($("#wm").value)}`; $("#whint").textContent = "";
  };
  $("#modalBox").querySelectorAll("[data-wt]").forEach(b => b.onclick = () => { $("#wm").value = trainerText(tid, b.dataset.wt); link(); });
  $("#wm").oninput = link; $("#wp").oninput = link;
  $("#wpSave").onclick = async () => {
    const p = normPhone($("#wp").value);
    if (!/^9665\d{8}$/.test(p)) return toast("رقم الجوال غير صحيح");
    try { await setDoc(ref("secrets/" + tid), {phone: p}, {merge: true}); S.trPhones = {...(S.trPhones || {}), [tid]: p}; logAction("جوال مدرب", t.name); $("#wp").value = p; toast("انحفظ الرقم"); link(); }
    catch (e) { handleWriteErr(e); }
  };
  $("#wgo").onclick = e => { if (!$("#wgo").getAttribute("href")) { e.preventDefault(); toast("اكتب رقم جوال صحيح أولاً"); } };
  $("#wm").value = trainerText(tid, "note"); link();
}

/* bulk messages: prepare every message first, then open WhatsApp one student per click */
function fillVars(t, num){
  const st = S.students[num] || {};
  return t.replace(/\{الاسم\}/g, st.name || "").replace(/\{الرقم\}/g, num).replace(/\{الرمز\}/g, S.stSecrets[num] || "—")
          .replace(/\{الرابط\}/g, location.href.split("#")[0].split("?")[0]);
}
function fillTrainerVars(tpl, tid){
  const t = S.trainers[tid] || {};
  return tpl.replace(/\{الاسم\}/g, t.name ? trainerTitle(t) : "").replace(/\{الرقم\}/g, t.num || "—").replace(/\{الرمز\}/g, S.secrets[tid] || "—")
            .replace(/\{الرابط\}/g, location.href.split("#")[0].split("?")[0]);
}
function adminMessages(el){
  const q = S.msgQ;
  const gs = sortedGroups();
  if (q && q.items.length) {
    const done = q.items.filter(i => i.sent).length, cur = q.items[q.idx];
    el.innerHTML = `
    <div class="card"><h2>الإرسال · ${done} من ${q.items.length}</h2>
      <span class="bar" style="display:block;max-width:none"><i style="width:${Math.round(done / q.items.length * 100)}%"></i></span>
      ${cur ? `<div class="item" style="margin-top:12px"><div class="grow"><div class="t">التالي: ${esc(cur.name)}</div><div class="muted" dir="ltr" style="text-align:right">${esc(cur.phone)}</div></div>
        <a class="btn gold" id="qNext" href="https://wa.me/${cur.phone}?text=${encodeURIComponent(cur.text)}" target="_blank" rel="noopener">فتح واتساب (${q.idx + 1})</a>
        <button class="btn sm" id="qSkip">تخطي</button></div>
        <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">نص الرسالة</summary><pre style="white-space:pre-wrap;font-family:inherit">${esc(cur.text)}</pre></details>`
      : `<div class="notice" style="margin-top:12px">خلصت القائمة.</div>`}
      <div class="row" style="margin-top:12px"><button class="btn sm danger" id="qStop">${cur ? "إيقاف وإلغاء" : "رسالة جديدة"}</button></div>
    </div>
    <div class="list">${q.items.map((i, k) => `<div class="item" style="padding:8px 12px"><span class="grow">${k + 1}. ${esc(i.name)}</span><span class="pill ${i.sent ? "p" : i.skipped ? "a" : ""}">${i.sent ? "انفتح" : i.skipped ? "متخطى" : "بالانتظار"}</span></div>`).join("")}</div>`;
    const adv = mark => { q.items[q.idx][mark] = true; q.idx++; while (q.idx < q.items.length && (q.items[q.idx].sent || q.items[q.idx].skipped)) q.idx++; };
    if ($("#qNext")) $("#qNext").onclick = () => setTimeout(() => { adv("sent"); render(); }, 300);
    if ($("#qSkip")) $("#qSkip").onclick = () => { adv("skipped"); render(); };
    $("#qStop").onclick = () => { S.msgQ = null; render(); };
    return;
  }
  el.innerHTML = `
  <div class="card"><h2>الرسائل الجماعية</h2>
    <p class="muted" style="margin-top:0">تختار المستلمين (مدربين أو طلاب) والرسالة، وبعدها تمر عليهم: كل واحد ضغطة تفتح محادثته ورسالته جاهزة، وأنت تضغط إرسال في واتساب.</p>
    <div class="row">
      <label class="f grow" for="mTo">المستلمون<select id="mTo"><option value="trainers">كل المدربين</option>${Object.values(S.trainers).sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t => `<option value="t:${esc(t.id)}">${esc(trainerTitle(t))}</option>`).join("")}<option value="all" selected>كل الطلاب</option><option value="m">الطلاب فقط</option><option value="f">الطالبات فقط</option>${gs.map(g => `<option value="g:${esc(g.id)}">${esc(g.course)} · ${esc(tName(g.trainerId))}</option>`).join("")}</select></label>
      <label class="f grow" for="mType">الرسالة<select id="mType">
        <option value="login">الرموز: بيانات الدخول لكل طالب</option>
        <option value="custom">رسالة عامة</option>
        <option value="att">سجل الحضور لكل طالب</option>
        <option value="grades">الدرجات المعتمدة لكل طالب</option>
      </select></label>
    </div>
    <label class="f" for="mText" style="margin-top:10px">نص الرسالة <span class="muted">(تقدر تستخدم {الاسم} و{الرقم} و{الرمز} و{الرابط})</span><textarea id="mText" style="min-height:170px"></textarea></label>
    <div id="mInfo" class="muted" style="margin:8px 0"></div>
    <div class="row"><button class="btn pri" id="mPrep">تجهيز الرسائل</button><button class="btn sm" id="mCopy">نسخ النص (لقائمة بث في واتساب)</button></div>
  </div>`;
  const presets = {
    login: "السلام عليكم {الاسم}\n\nبيانات دخولكم لبوابة الطلاب:\nالرقم الأكاديمي: {الرقم}\nرمز الدخول: {الرمز}\nالرابط: {الرابط}" + SIGN,
    custom: "السلام عليكم {الاسم}\n\n" + SIGN,
    trLogin: "السلام عليكم {الاسم}\n\nبيانات دخولك لبوابة المدربين:\nرقم المدرب: {الرقم}\nرمز الدخول: {الرمز}\nالرابط: {الرابط}" + SIGN,
    att: "(يتجهز سجل الحضور لكل طالب حسب بياناته)",
    grades: "(تتجهز الدرجات المعتمدة لكل طالب حسب بياناته)",
  };
  const isTr = () => { const v = $("#mTo").value; return v === "trainers" || v.startsWith("t:"); };
  const phoneOf = n => isTr() ? (S.trPhones || {})[n] : (S.stPhones || {})[n];
  const nameOf = n => isTr() ? ((S.trainers[n] && trainerTitle(S.trainers[n])) || "") : ((S.students[n] || {}).name || "");
  const recips = () => {
    const v = $("#mTo").value;
    if (v === "trainers") return Object.keys(S.trainers);
    if (v.startsWith("t:")) return [v.slice(2)];
    let nums = Object.keys(S.students);
    if (v === "m" || v === "f") nums = nums.filter(n => S.students[n].gender === v);
    if (v.startsWith("g:")) nums = (S.groups[v.slice(2)] || {}).memberNums || [];
    return nums.sort();
  };
  const info = () => {
    const nums = recips(), withP = nums.filter(n => phoneOf(n));
    const miss = nums.filter(n => !phoneOf(n)).map(nameOf).filter(Boolean);
    $("#mInfo").innerHTML = `${withP.length} من ${nums.length} عندهم رقم جوال.${miss.length ? ` <span>بدون جوال: ${esc(miss.slice(0, 8).join("، "))}${miss.length > 8 ? ` و${miss.length - 8} غيرهم` : ""}</span>` : ""}`;
  };
  const setType = () => { const t = $("#mType").value; if (isTr() && (t === "att" || t === "grades")) { toast("سجل الحضور والدرجات للطلاب فقط"); $("#mType").value = "custom"; return setType(); } $("#mText").value = isTr() && t === "login" ? presets.trLogin : presets[t]; $("#mText").disabled = t === "att" || t === "grades"; };
  $("#mTo").onchange = () => { if (isTr() && ["att", "grades"].includes($("#mType").value)) { $("#mType").value = "custom"; setType(); } if (isTr() && $("#mType").value === "login") $("#mText").value = presets.trLogin; else if (!isTr() && $("#mType").value === "login") $("#mText").value = presets.login; info(); }; $("#mType").onchange = setType; setType(); info();
  $("#mCopy").onclick = async () => { try { await navigator.clipboard.writeText($("#mText").value.replace(/\{الاسم\}/g, "").replace(/السلام عليكم \n/, "السلام عليكم\n")); toast("انتسخ النص"); } catch { toast("المتصفح منع النسخ"); } };
  $("#mPrep").onclick = async () => {
    const type = $("#mType").value, tpl = $("#mText").value;
    const tr = isTr();
    const nums = recips().filter(n => /^9665\d{8}$/.test(phoneOf(n) || ""));
    if (!nums.length) return toast(tr ? "ما فيه مدربين عندهم رقم جوال. أضف الأرقام من تبويب المدربين" : "ما فيه مستلمين عندهم رقم جوال. أضف الأرقام من تبويب الطلاب");
    $("#mPrep").disabled = true; S._busy = true;
    const items = [];
    try {
      for (const [k, n] of nums.entries()) {
        $("#mInfo").textContent = `تجهيز ${k + 1} من ${nums.length}…`;
        const text = tr ? fillTrainerVars(tpl, n) : (type === "att" || type === "grades") ? await waText(n, type, {}) : fillVars(tpl, n);
        items.push({num: n, name: nameOf(n), phone: phoneOf(n), text});
      }
      S.msgQ = {items, idx: 0};
    } catch (e) { console.error(e); toast("تعذّر تجهيز الرسائل"); }
    S._busy = false; render();
  };
}

/* ---------- system tab ---------- */
async function saveSite(patch, label){
  try { await setDoc(ref("public/site"), patch, {merge: true}); S.site = {...(S.site || {}), ...patch}; logAction("الصفحة الرئيسية", label); toast("انحفظ"); render(); }
  catch (e) { handleWriteErr(e); }
}
function adminSystem(el){
  const sys = S.sys || {};
  const annRows = k => liveAnnAll(k).map((a, i) => `<div class="item" style="padding:8px 12px"><span class="grow">${esc(a.text)}<div class="muted">${AUD[k]}${a.expires ? " · ينتهي " + esc(a.expires) : " · بدون انتهاء"}</div></span><button class="btn sm danger" data-adel="${k}:${i}">حذف</button></div>`).join("");
  el.innerHTML = `
  <div class="card"><h2>نسخة احتياطية</h2>
    <p class="muted" style="margin-top:0">ينزّل ملف فيه كل بيانات البوابة: المدربين، والطلاب، والرموز، والجوالات، والحضور، والدرجات، والسجل. احفظه في مكان آمن لأن فيه بيانات حساسة.</p>
    <button class="btn pri" id="bkB">تنزيل نسخة احتياطية الآن</button>
  </div>
  <div class="card"><h2>أرشفة الفصل وبدء فصل جديد</h2>
    <p class="muted" style="margin-top:0">ينزّل نسخة احتياطية، ويحفظ ملخص الفصل (حضور ودرجات كل متدرب) في "الأرشيف"، وبعدها يمسح الحضور والدرجات والأعذار والإنذارات والتقييمات. المدربين والطلاب وحساباتهم والشهادات الصادرة تبقى.</p>
    <div class="row"><input type="text" id="arName" class="grow" placeholder="اسم الفصل، مثل: الفصل الأول 1448"></div>
    <label class="row" for="arS" style="gap:8px;margin-top:8px"><input type="checkbox" id="arS"> إفراغ الشعب من الطلاب</label>
    <label class="row" for="arC" style="gap:8px"><input type="checkbox" id="arC"> مسح الجداول وروابط Teams والتسجيلات</label>
    <div class="row" style="margin-top:8px"><input type="text" id="arOk" placeholder='اكتب "أرشفة" للتأكيد' style="width:200px"><button class="btn danger" id="arB">أرشفة وبدء فصل جديد</button></div>
    <div id="arLog" class="muted" style="margin-top:8px;white-space:pre-line"></div>
  </div>
  <div class="card"><h2>وضع الصيانة</h2>
    <p class="muted" style="margin-top:0">يقفل الموقع على المدربين والطلاب، والإدارة تقدر تدخل عادي.</p>
    <label class="f" for="mMsg">رسالة الصيانة<textarea id="mMsg" style="min-height:80px">${esc(sys.maintenanceMsg || "نعمل على تحسين البوابة، وبنرجع قريباً.")}</textarea></label>
    <div class="row" style="margin-top:8px">
      ${sys.maintenance ? `<button class="btn pri" id="mOff">إيقاف الصيانة وفتح الموقع</button>` : `<button class="btn danger" id="mOn">تشغيل وضع الصيانة</button>`}
      <button class="btn sm" id="mSaveMsg">حفظ الرسالة</button>
    </div>
  </div>
  <div class="card"><h2>الصفحة الرئيسية</h2>
    <p class="muted" style="margin-top:0">اللي تكتبه هنا يظهر لأي أحد يفتح البوابة. الخانة الفاضية ما تظهر.</p>
    <h3>ترخيص المعهد</h3>
    <div class="row"><label class="f grow" for="accN">رقم الرخصة<input type="text" id="accN" dir="ltr" value="${esc((S.site || {}).accNo || "")}" placeholder="رقم الرخصة من المؤسسة العامة للتدريب التقني والمهني"></label>
      <label class="f grow" for="licU">رابط التحقق (من باركود الرخصة)<input type="url" id="licU" dir="ltr" value="${esc((S.site || {}).licUrl || "")}" placeholder="https://pt-web.tvtc.gov.sa/..."></label>
      <button class="btn pri sm" id="accSave" style="align-self:flex-end">حفظ</button></div>
    <p class="muted">رقم الرخصة والباركود يظهرون في الصفحة الرئيسية وعلى كل المطبوعات. الباركود يفتح صفحة الرخصة الرسمية في موقع المؤسسة.</p>
    <h3 style="margin-top:16px">أرقام الواتساب</h3>
    <div class="list" id="waL">${(S._waEdit || waList(S.site)).map((w, i) => `<div class="item" style="padding:8px 12px"><input type="text" data-wal="${i}" value="${esc(w.label || "")}" placeholder="القسم، مثل: القبول والتسجيل" class="grow"><input type="tel" data-wan="${i}" dir="ltr" value="${esc(w.num || "")}" placeholder="05xxxxxxxx" style="width:160px"><button class="btn sm danger" data-wadel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه أرقام</span>`}</div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="waAdd">+ رقم</button><button class="btn pri sm" id="waSave">حفظ الأرقام</button></div>
    <h3 style="margin-top:16px">الروابط</h3>
    <div class="row">${SOCIAL.filter(([k]) => k !== "whatsapp").map(([k, l]) => `<label class="f" for="so-${k}" style="flex:1;min-width:150px">${l}<input type="text" id="so-${k}" dir="ltr" value="${esc((S.site || {})[k] || "")}" placeholder="${k === "whatsapp" ? "05xxxxxxxx" : k === "website" ? "example.com" : k === "maps" ? "https://maps.app.goo.gl/..." : "@account"}"></label>`).join("")}</div>
    <div class="row" style="margin-top:8px"><button class="btn pri sm" id="siteSave">حفظ الروابط</button><span class="muted">عدد المتدربين والمحاضرات يتحدث تلقائي.</span></div>
    <h3 style="margin-top:16px">العدّاد التنازلي</h3>
    <div class="row"><input type="text" id="cdL" class="grow" placeholder="مثل: بداية الفصل الثاني" value="${esc(((S.site || {}).countdown || {}).label || "")}"><input type="datetime-local" id="cdA" value="${esc(((S.site || {}).countdown || {}).at || "")}" style="width:220px" aria-label="موعد العدّاد"><button class="btn pri sm" id="cdSave">حفظ</button>${((S.site || {}).countdown || {}).label ? `<button class="btn sm danger" id="cdDel">إيقاف</button>` : ""}</div>
    <p class="muted">يختفي لحاله بعد ما يمر الموعد. الوقت بتوقيت الرياض.</p>
    <h3 style="margin-top:16px">آخر الأخبار</h3>
    <div class="list">${((S.site || {}).news || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(n => `<div class="item" style="padding:8px 12px"><div class="grow"><b>${esc(n.title)}</b><div class="muted">${esc(n.date)}${n.until ? " · يختفي بعد " + esc(n.until) : ""}${n.until && n.until < today() ? " · <b>منتهي</b>" : ""}</div></div><button class="btn sm danger" data-ndel="${esc(n.id)}">حذف</button></div>`).join("") || `<span class="muted">ما فيه أخبار</span>`}</div>
    <div class="row" style="margin-top:8px"><input type="text" id="nwT" class="grow" placeholder="عنوان الخبر" maxlength="90"><input type="date" id="nwU" style="width:170px" aria-label="يختفي بعد"></div>
    <div class="row" style="margin-top:8px"><input type="text" id="nwX" class="grow" placeholder="تفاصيل قصيرة (اختياري)" maxlength="240"><button class="btn gold sm" id="nwAdd">+ إضافة خبر</button></div>
    <p class="muted">تاريخ «يختفي بعد» اختياري. يظهر آخر 4 أخبار.</p>
    <h3 style="margin-top:16px">الأسئلة الشائعة</h3>
    <div class="list" id="fqL">${((S.site || {}).faq || DEFAULT_FAQ).map((f, i) => `<div class="item" style="padding:8px 12px;align-items:flex-start"><div class="grow" style="display:grid;gap:6px"><input type="text" data-fq="${i}" value="${esc(f.q)}" placeholder="السؤال"><textarea data-fa="${i}" style="min-height:50px" placeholder="الجواب">${esc(f.a)}</textarea></div><button class="btn sm danger" data-fdel="${i}">حذف</button></div>`).join("")}</div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="fqAdd">+ سؤال</button><button class="btn pri sm" id="fqSave">حفظ الأسئلة</button></div>
  </div>
  <div class="card"><h2>الشهادات والمالية</h2>
    <p class="muted" style="margin-top:0">إذا شغّلته، ما تطلع شهادة الحضور إلا للطالب اللي سدد رسومه كاملة. الطالب اللي ما انفتح له حساب في المالية ما تطلع له شهادة.</p>
    ${sys.certNeedsFee ? `<button class="btn sm" id="cfOff">إيقاف شرط السداد</button> <span class="pill p">شغّال</span>` : `<button class="btn pri sm" id="cfOn">اشتراط السداد لإصدار الشهادة</button>`}
  </div>
  <div class="card"><h2>قفل التحضير</h2>
    <p class="muted" style="margin-top:0">بعد نهاية يوم المحاضرة بعدد الساعات هذا، المدرب ما يقدر يعدّل التحضير. الإدارة تقدر تعدّل دائماً. فاضي = بدون قفل.</p>
    <div class="row"><input type="number" id="lockH" min="0" max="720" step="1" value="${typeof sys.lockHours === "number" && sys.lockHours >= 0 ? sys.lockHours : ""}" style="width:120px" placeholder="مثل 24"><span class="muted">ساعة</span><button class="btn pri sm" id="lockSave">حفظ</button></div>
    <p class="muted">مثال: 0 = يقدر يعدّل لين نهاية يوم المحاضرة بس. 24 = لين نهاية اليوم اللي بعده.</p>
  </div>
  <div class="card"><h2>نسب الإنذار والحرمان</h2>
    <p class="muted" style="margin-top:0">نسب <b>الغياب</b> من عدد محاضرات المقرر. التأخير يُحسب حضور، والاستئذان ما يُحسب غياب.</p>
    <div class="row">
      <label class="f" for="th1">الإنذار الأول %<input type="number" id="th1" min="0" max="100" value="${TH().warn1}" style="width:110px"></label>
      <label class="f" for="th2">الإنذار الثاني %<input type="number" id="th2" min="0" max="100" value="${TH().warn2}" style="width:110px"></label>
      <label class="f" for="th3">الحرمان %<input type="number" id="th3" min="0" max="100" value="${TH().deny}" style="width:110px"></label>
      <label class="f" for="th4">أقل حضور للشهادة %<input type="number" id="th4" min="0" max="100" value="${TH().certMin}" style="width:130px"></label>
      <button class="btn pri sm" id="thSave" style="align-self:flex-end">حفظ النسب</button>
    </div>
  </div>
  <div class="card"><h2>أيام الإجازات</h2>
    <p class="muted" style="margin-top:0">الأيام هذي ما ينحسب فيها غياب، وما يقدر المدرب يحضّر فيها.</p>
    <div class="list">${((sys.holidays) || []).map((h, i) => `<div class="item" style="padding:8px 12px"><span class="grow">${esc(h.label || "إجازة")}<div class="muted">${esc(h.from)}${h.to && h.to !== h.from ? " ← " + esc(h.to) : ""}</div></span><button class="btn sm danger" data-hdel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه إجازات</span>`}</div>
    <div class="row" style="margin-top:8px">
      <input type="text" id="hLabel" class="grow" placeholder="مثل: اليوم الوطني">
      <label class="muted" for="hFrom">من</label><input type="date" id="hFrom" style="width:160px">
      <label class="muted" for="hTo">إلى</label><input type="date" id="hTo" style="width:160px">
      <button class="btn gold sm" id="hAdd">+ إضافة</button>
    </div>
  </div>
  <div class="card"><h2>التقويم الأكاديمي</h2>
    <p class="muted" style="margin-top:0">مواعيد مثل بداية التدريب والاختبارات وتسجيل المقررات. تظهر في «القادم في التقويم» بالصفحة الرئيسية، وما تأثر على الحضور.</p>
    <div class="row" style="margin-bottom:10px"><button class="btn gold sm" id="tvtcImp">إضافة تقويم المؤسسة 1448-1449 (النصفي المجزأ)</button><span class="muted">يضيف ${TVTC_1448.events.length} موعد و${TVTC_1448.holidays.length} إجازات، وما يكرر الموجود.</span></div>
    <details><summary class="muted" style="cursor:pointer">المواعيد (${((sys.events) || []).length})</summary>
    <div class="list" style="margin-top:8px">${((sys.events) || []).map((e, i) => `<div class="item" style="padding:8px 12px"><span class="grow">${esc(e.label)}<div class="muted">${dH(e.date)}</div></span><button class="btn sm danger" data-evdel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه مواعيد</span>`}</div></details>
    <div class="row" style="margin-top:8px"><input type="text" id="evL" class="grow" placeholder="مثل: بداية الاختبارات النهائية"><input type="date" id="evD" style="width:160px" aria-label="التاريخ"><button class="btn gold sm" id="evAdd">+ إضافة</button></div>
  </div>
  <div class="card"><h2>الإعلانات</h2>
    <p class="muted" style="margin-top:0">تظهر شريط أعلى الموقع، وتختفي تلقائياً بعد تاريخ الانتهاء.</p>
    <label class="f" for="aText">نص الإعلان<textarea id="aText" style="min-height:70px"></textarea></label>
    <div class="row" style="margin-top:8px">
      <select id="aAud" style="width:auto"><option value="all">الكل</option><option value="trainers">المدربين</option><option value="students">الطلاب</option></select>
      <label class="muted" for="aExp">ينتهي</label><input type="date" id="aExp" style="width:160px" min="${today()}">
      <button class="btn gold" id="aAdd">+ نشر الإعلان</button>
    </div>
    <div class="list" style="margin-top:12px">${annRows("all")}${annRows("trainers")}${annRows("students")}</div>
  </div>`;
  $("#bkB").onclick = async () => { $("#bkB").disabled = true; try { await backupAll(); toast("نزلت النسخة الاحتياطية"); } catch (e) { console.error(e); toast("تعذّر أخذ النسخة"); } $("#bkB").disabled = false; };
  $("#arB").onclick = async () => {
    const term = $("#arName").value.trim();
    if (!term) return toast("اكتب اسم الفصل");
    if ($("#arOk").value.trim() !== "أرشفة") return toast('اكتب كلمة "أرشفة" للتأكيد');
    const lines = []; const log = m => { lines.push(m); const e = $("#arLog"); if (e) e.textContent = lines.join("\n"); };
    S._busy = true; $("#arB").disabled = true;
    try { await archiveTerm(term, {clearStudents: $("#arS").checked, clearSchedule: $("#arC").checked}, log); toast("انأرشف الفصل"); }
    catch (e) { console.error(e); log("توقف: " + (e.code || e.message)); }
    S._busy = false;
  };
  const saveSys = async (patch, label) => {
    try { await setDoc(ref("public/system"), patch, {merge: true}); S.sys = {...(S.sys || {}), ...patch}; logAction(label, JSON.stringify(patch).slice(0, 200)); toast("انحفظ"); render(); }
    catch (e) { handleWriteErr(e); }
  };
  if ($("#mOn")) $("#mOn").onclick = () => { const b = $("#mOn"); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "متأكد؟ يقفل الموقع على الكل"; return; } saveSys({maintenance: true, maintenanceMsg: $("#mMsg").value.trim()}, "تشغيل وضع الصيانة"); };
  if ($("#mOff")) $("#mOff").onclick = () => saveSys({maintenance: false}, "إيقاف وضع الصيانة");
  $("#mSaveMsg").onclick = () => saveSys({maintenanceMsg: $("#mMsg").value.trim()}, "تعديل رسالة الصيانة");
  if ($("#cfOn")) $("#cfOn").onclick = () => saveSys({certNeedsFee: true}, "تشغيل شرط السداد للشهادات");
  if ($("#cfOff")) $("#cfOff").onclick = () => saveSys({certNeedsFee: false}, "إيقاف شرط السداد للشهادات");
  $("#siteSave").onclick = async () => {
    const d = {};
    SOCIAL.filter(([k]) => k !== "whatsapp").forEach(([k]) => d[k] = $("#so-" + k).value.trim().slice(0, 120));
    saveSite(d, "تعديل روابط التواصل");
  };
  $("#accSave").onclick = () => {
    const u = $("#licU").value.trim();
    if (u && !/^https:\/\/[^/]*tvtc\.gov\.sa\//i.test(u)) return toast("رابط التحقق لازم يكون من موقع المؤسسة (tvtc.gov.sa)");
    saveSite({accNo: $("#accN").value.trim().slice(0, 40), licUrl: u.slice(0, 300)}, "ترخيص المعهد");
  };
  const readWa = () => [...el.querySelectorAll("[data-wan]")].map(x => ({label: el.querySelector(`[data-wal="${x.dataset.wan}"]`).value.trim().slice(0, 40), num: x.value.trim()}));
  $("#waAdd").onclick = () => { S._waEdit = [...readWa(), {label: "", num: ""}]; render(); };
  el.querySelectorAll("[data-wadel]").forEach(b => b.onclick = () => { const l = readWa(); l.splice(Number(b.dataset.wadel), 1); S._waEdit = l; render(); });
  $("#waSave").onclick = () => {
    const l = readWa().filter(w => w.num);
    const bad = l.find(w => !/^9665\d{8}$/.test(normPhone(w.num))); if (bad) return toast(`رقم غير صحيح: ${bad.num}`);
    S._waEdit = null; saveSite({whatsapps: l.map(w => ({label: w.label || "واتساب", num: w.num})).slice(0, 8), whatsapp: ""}, "أرقام الواتساب");
  };
  $("#cdSave").onclick = () => { const label = $("#cdL").value.trim(), at = $("#cdA").value; if (!label || !at) return toast("اكتب اسم المناسبة وموعدها"); saveSite({countdown: {label, at}}, "العدّاد التنازلي: " + label); };
  if ($("#cdDel")) $("#cdDel").onclick = () => saveSite({countdown: {label: "", at: ""}}, "إيقاف العدّاد");
  $("#nwAdd").onclick = () => { const title = $("#nwT").value.trim(); if (!title) return toast("اكتب عنوان الخبر"); saveSite({news: [...((S.site || {}).news || []), {id: "n-" + uid(), title, text: $("#nwX").value.trim(), date: today(), until: $("#nwU").value || ""}].slice(-30)}, "خبر جديد: " + title); };
  el.querySelectorAll("[data-ndel]").forEach(b => b.onclick = () => saveSite({news: ((S.site || {}).news || []).filter(n => n.id !== b.dataset.ndel)}, "حذف خبر"));
  const readFaq = () => [...el.querySelectorAll("[data-fq]")].map(x => ({q: x.value.trim(), a: el.querySelector(`[data-fa="${x.dataset.fq}"]`).value.trim()}));
  $("#fqSave").onclick = () => saveSite({faq: readFaq().filter(f => f.q && f.a).slice(0, 20)}, "الأسئلة الشائعة");
  $("#fqAdd").onclick = () => { S.site = {...(S.site || {}), faq: [...readFaq(), {q: "", a: ""}]}; render(); };
  el.querySelectorAll("[data-fdel]").forEach(b => b.onclick = () => { const l = readFaq(); l.splice(Number(b.dataset.fdel), 1); saveSite({faq: l.filter(f => f.q && f.a)}, "حذف سؤال"); });
  $("#tvtcImp").onclick = () => {
    const hs = [...((S.sys && S.sys.holidays) || [])], es = [...((S.sys && S.sys.events) || [])];
    let nh = 0, ne = 0;
    TVTC_1448.holidays.forEach(h => { if (!hs.some(x => x.from === h.from && (x.to || x.from) === h.to)) { hs.push(h); nh++; } });
    TVTC_1448.events.forEach(e => { if (!es.some(x => x.date === e.date && x.label === e.label)) { es.push(e); ne++; } });
    if (!nh && !ne) return toast("التقويم مضاف من قبل");
    saveSys({holidays: hs.sort((a, b) => a.from.localeCompare(b.from)), events: es.sort((a, b) => a.date.localeCompare(b.date))}, `تقويم المؤسسة: ${ne} موعد و${nh} إجازة`);
  };
  $("#evAdd").onclick = () => { const label = $("#evL").value.trim(), date = $("#evD").value; if (!label || !date) return toast("اكتب الموعد وتاريخه"); saveSys({events: [...((S.sys && S.sys.events) || []), {date, label}].sort((a, b) => a.date.localeCompare(b.date))}, "موعد: " + label); };
  el.querySelectorAll("[data-evdel]").forEach(b => b.onclick = () => { const l = [...((S.sys && S.sys.events) || [])]; l.splice(Number(b.dataset.evdel), 1); saveSys({events: l}, "حذف موعد"); });
  $("#lockSave").onclick = () => {
    const v = $("#lockH").value.trim();
    if (v !== "" && !(Number(v) >= 0)) return toast("اكتب عدد ساعات صحيح");
    saveSys({lockHours: v === "" ? -1 : Math.round(Number(v))}, "قفل التحضير");
  };
  $("#thSave").onclick = () => {
    const v = ["th1", "th2", "th3", "th4"].map(id => Number($("#" + id).value));
    if (v.some(x => !(x >= 0 && x <= 100))) return toast("النسب لازم تكون بين 0 و100");
    if (!(v[0] < v[1] && v[1] < v[2])) return toast("لازم: الإنذار الأول أقل من الثاني، والثاني أقل من الحرمان");
    saveSys({thresholds: {warn1: v[0], warn2: v[1], deny: v[2], certMin: v[3]}}, "نسب الإنذار والحرمان");
  };
  $("#hAdd").onclick = () => {
    const from = $("#hFrom").value, to = $("#hTo").value || from, label = $("#hLabel").value.trim();
    if (!from) return toast("حدد تاريخ البداية");
    if (to < from) return toast("تاريخ النهاية قبل البداية");
    const list = [...((S.sys && S.sys.holidays) || []), {from, to, label}].sort((a, b) => a.from.localeCompare(b.from));
    saveSys({holidays: list}, "إضافة إجازة");
  };
  el.querySelectorAll("[data-hdel]").forEach(b => b.onclick = () => { const list = [...((S.sys && S.sys.holidays) || [])]; list.splice(Number(b.dataset.hdel), 1); saveSys({holidays: list}, "حذف إجازة"); });
  const saveAnn = async (k, items, label) => {
    try { await setDoc(ref("ann/" + k), {items}); S.ann[k] = items; logAction(label, AUD[k]); renderAnn(); render(); }
    catch (e) { handleWriteErr(e); }
  };
  $("#aAdd").onclick = () => {
    const text = $("#aText").value.trim(), k = $("#aAud").value, exp = $("#aExp").value;
    if (!text) return toast("اكتب نص الإعلان");
    saveAnn(k, [...liveAnnAll(k), {text, audience: k, expires: exp || "", at: today()}], "نشر إعلان");
  };
  el.querySelectorAll("[data-adel]").forEach(b => b.onclick = () => {
    const [k, i] = b.dataset.adel.split(":"); const items = liveAnnAll(k); items.splice(Number(i), 1); saveAnn(k, items, "حذف إعلان");
  });
}
const liveAnnAll = k => liveAnn(S.ann[k]);   // expired ones are dropped on the next save

/* ---------- follow-up tab: deprivation alerts, most absent courses, monthly report ---------- */
async function loadAllAtt(force){
  if (S.allAtt && !force) return;
  const snap = await getDocs(collection(db, "att"));
  S.allAtt = snap.docs.map(d => d.data()); S.allAttAt = new Date();
}
function adminFollow(el){
  if (!S.allAtt) {
    el.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري تحميل سجلات الحضور…</p></div>`;
    loadAllAtt().then(() => { if (S.aTab === "follow") render(); }).catch(e => { console.error(e); el.innerHTML = `<div class="notice err">تعذّر تحميل السجلات.</div>`; });
    return;
  }
  const byGroup = {}; S.allAtt.forEach(d => (byGroup[d.groupId] = byGroup[d.groupId] || []).push(d));
  const gs = sortedGroups(), alerts = [], courses = [];
  gs.forEach(g => {
    const docs = countable(byGroup[g.id]);
    let sum = 0, n = 0;
    (g.students || []).forEach(s => {
      const st = absStats(g, s.id, docs); if (docs.length) { sum += st.absPct; n++; }
      if (st.level) alerts.push({g, s, st});
    });
    if (docs.length) courses.push({g, avg: Math.round(sum / Math.max(n, 1) * 10) / 10, held: docs.length});
  });
  alerts.sort((a, b) => b.st.level - a.st.level || b.st.absPct - a.st.absPct);
  courses.sort((a, b) => b.avg - a.avg);
  const noTotal = gs.filter(g => !g.totalSessions).length;
  const month = S.repMonth || today().slice(0, 7);
  const mDocs = S.allAtt.filter(d => d.date.startsWith(month) && !isHoliday(d.date));
  const mRows = gs.map(g => {
    const docs = mDocs.filter(d => d.groupId === g.id); if (!docs.length) return null;
    let p = 0, a = 0, e = 0, tot = 0;
    (g.students || []).forEach(s => docs.forEach(d => { const r = d.rec && d.rec[s.id]; tot++; if (!r || !r.st || r.st === "a") a++; else if (r.st === "e") e++; else p++; }));
    return {g, held: docs.length, rate: tot ? Math.round(p / tot * 100) : 0, a, e};
  }).filter(Boolean);
  const mStu = [];
  gs.forEach(g => { const docs = mDocs.filter(d => d.groupId === g.id); (g.students || []).forEach(s => { const a = docs.filter(d => { const r = d.rec && d.rec[s.id]; return !r || !r.st || r.st === "a"; }).length; if (a) mStu.push({g, s, a, held: docs.length}); }); });
  mStu.sort((x, y) => y.a - x.a);
  el.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">المتابعة</h2>
    <button class="btn sm" id="fRef">تحديث${S.allAttAt ? " · آخر تحميل " + S.allAttAt.toLocaleTimeString("ar-SA-u-nu-latn", {hour: "2-digit", minute: "2-digit"}) : ""}</button></div>
    <div class="stats" style="margin-top:10px">
      <div class="stat"><div class="n">${alerts.filter(a => a.st.level === 3).length}</div><div class="l">حرمان</div></div>
      <div class="stat"><div class="n">${alerts.filter(a => a.st.level === 2).length}</div><div class="l">إنذار ثاني</div></div>
      <div class="stat"><div class="n">${alerts.filter(a => a.st.level === 1).length}</div><div class="l">إنذار أول</div></div>
      <div class="stat"><div class="n">${Object.keys(S.students).length}</div><div class="l">طالب وطالبة</div></div>
    </div>
    ${noTotal ? `<p class="muted">فيه ${noTotal} مقرر بدون "عدد المحاضرات الكلي"، فنسبته محسوبة من المحاضرات اللي صارت لين الحين. حدده من "المقررات والطلاب" عشان تكون النسب أدق.</p>` : ""}
  </div>
  <div class="card"><h2>تنبيه الحرمان (${alerts.length})</h2>
    ${alerts.length ? `<div class="tbl"><table><thead><tr><th class="nm">الطالب</th><th class="nm">المقرر</th><th>غياب</th><th>النسبة</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${alerts.map(({g, s, st}) => `<tr><td class="nm">${esc(s.name)}</td><td class="nm">${esc(g.course)}</td><td>${st.a}${st.total ? "/" + st.total : ""}</td><td>${st.absPct}%</td><td>${levelPill(st)}</td>
      <td>${s.sid ? (() => { const wid = `${s.sid}_${g.id}_${st.level}`, w = (S.warnings || {})[wid];
        return `${w ? `<span class="pill p">صدر ${esc(w.date.slice(5))}</span> <button class="btn sm" data-pw="${esc(wid)}">طباعة</button>` : `<button class="btn sm" data-issue="${esc(wid)}">إصدار</button>`} <button class="btn sm gold" data-warn="${esc(s.sid)}" data-c="${esc(g.course)}" data-l="${esc(LEVEL[st.level])}" data-p="${st.absPct}">واتساب</button>`; })() : ""}</td></tr>`).join("")}</tbody></table></div>
    ${alerts.some(({g, s, st}) => s.sid && !(S.warnings || {})[`${s.sid}_${g.id}_${st.level}`]) ? `<div class="row" style="margin-top:10px"><button class="btn pri sm" id="issueAll">إصدار كل الإنذارات غير الصادرة</button><span class="muted">الإنذار الصادر يظهر للطالب في بوابته.</span></div>` : ""}`
    : `<p class="muted" style="margin:0">ما فيه طلاب وصلوا نسبة الإنذار.</p>`}
  </div>
  ${Object.values(S.warnings || {}).some(x => x.date === today()) ? `<div class="row"><button class="btn sm" id="pwToday">طباعة الإنذارات الصادرة اليوم (${Object.values(S.warnings).filter(x => x.date === today()).length})</button></div>` : ""}
  <div class="card"><h2>أكثر المقررات غياباً</h2>
    ${courses.length ? `<div class="list">${courses.slice(0, 6).map(c => `<div class="item"><div class="grow"><div class="t">${esc(c.g.course)}</div><div class="muted">${esc(tName(c.g.trainerId))} · ${c.held} محاضرة</div></div><b>${c.avg}%</b><span class="bar" style="width:120px"><i style="width:${Math.min(100, c.avg * 3)}%;background:var(--abs)"></i></span></div>`).join("")}</div>` : `<p class="muted" style="margin:0">ما فيه سجلات بعد.</p>`}
  </div>
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">التقرير الشهري</h2>
    <div class="row"><input type="month" id="repM" value="${esc(month)}" style="width:170px"><button class="btn sm" id="copyM">نسخ للـ Excel</button></div></div>
    ${mRows.length ? `<div class="tbl" style="margin-top:10px"><table id="mtM"><thead><tr><th class="nm">المقرر</th><th class="nm">المدرب/ة</th><th>محاضرات</th><th>نسبة الحضور</th><th>مرات الغياب</th><th>استئذان</th></tr></thead><tbody>
      ${mRows.map(r => `<tr><td class="nm">${esc(r.g.course)}</td><td class="nm">${esc(tName(r.g.trainerId))}</td><td>${r.held}</td><td>${r.rate}%</td><td>${r.a}</td><td>${r.e}</td></tr>`).join("")}</tbody></table></div>
      <h3 style="margin:14px 0 6px">الغياب حسب الطالب</h3>
      <div class="tbl"><table id="mtS"><thead><tr><th class="nm">الطالب</th><th>الرقم</th><th class="nm">المقرر</th><th>غياب</th><th>من</th></tr></thead><tbody>
      ${mStu.map(r => `<tr><td class="nm">${esc(r.s.name)}</td><td>${esc(r.s.sid || "—")}</td><td class="nm">${esc(r.g.course)}</td><td>${r.a}</td><td>${r.held}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">ما فيه غياب في هذا الشهر</td></tr>`}</tbody></table></div>`
    : `<p class="muted">ما فيه تحضير مسجل في هذا الشهر.</p>`}
  </div>`;
  $("#fRef").onclick = () => { S.allAtt = null; render(); };
  $("#repM").onchange = e => { S.repMonth = e.target.value; render(); };
  $("#copyM").onclick = async () => {
    const t = ["#mtM", "#mtS"].map(id => $(id)).filter(Boolean).map(tb => [...tb.rows].map(tr => [...tr.cells].map(td => td.innerText.trim()).join("\t")).join("\n")).join("\n\n");
    if (!t) return toast("ما فيه بيانات");
    try { await navigator.clipboard.writeText(`التقرير الشهري ${month}\n\n` + t); toast("انتسخ التقرير، الصقه في Excel"); } catch { toast("المتصفح منع النسخ"); }
  };
  const issue = async list => {
    const b = writeBatch(db);
    list.forEach(({g, s, st}) => b.set(ref(`warnings/${s.sid}_${g.id}_${st.level}`), {num: s.sid, name: s.name, groupId: g.id, course: g.course, level: st.level, levelName: LEVEL[st.level], absPct: st.absPct, absences: st.a, date: today(), by: S.adminRole}));
    try { await b.commit(); logAction("إصدار إنذارات", list.map(x => `${x.s.name} (${LEVEL[x.st.level]})`).join("، ")); toast(`صدر ${list.length} إنذار`); } catch (e) { handleWriteErr(e); }
  };
  el.querySelectorAll("[data-pw]").forEach(b => b.onclick = () => printWarnings([S.warnings[b.dataset.pw]]));
  if ($("#pwToday")) $("#pwToday").onclick = () => printWarnings(Object.values(S.warnings || {}).filter(x => x.date === today()));
  el.querySelectorAll("[data-issue]").forEach(b => b.onclick = () => { const a = alerts.find(({g, s, st}) => `${s.sid}_${g.id}_${st.level}` === b.dataset.issue); if (a) issue([a]); });
  if ($("#issueAll")) $("#issueAll").onclick = () => issue(alerts.filter(({g, s, st}) => s.sid && !(S.warnings || {})[`${s.sid}_${g.id}_${st.level}`]));
  el.querySelectorAll("[data-warn]").forEach(b => b.onclick = () => openWhatsApp(b.dataset.warn, {type: "warning", course: b.dataset.c, level: b.dataset.l, pct: b.dataset.p}));
}

/* ---------- excuses tab ---------- */
function adminExcuses(el){
  const f = S.excFilter || "pending";
  const list = (S.excuses || []).filter(x => f === "all" || x.status === f).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">أعذار الغياب</h2>
    <div class="tabs" style="border:0;padding:0">${[["pending", "قيد المراجعة"], ["accepted", "مقبولة"], ["rejected", "مرفوضة"], ["all", "الكل"]].map(([k, v]) => `<button class="tab ${f === k ? "on" : ""}" data-ef="${k}">${v}</button>`).join("")}</div></div>
    <p class="muted" style="margin:8px 0 0">قبول العذر يحوّل غياب ذاك اليوم إلى "مستأذن"، فما ينحسب غياب.</p></div>
  <div class="list">${list.map(x => `<div class="card" style="display:grid;gap:8px">
    <div class="row" style="justify-content:space-between"><div><div class="t" style="font-weight:700">${esc(x.name)} · ${esc(x.num)}</div><div class="muted">${esc(x.course)} · ${esc(fmtDate(x.date))}</div></div><span class="pill ${EXC_PILL[x.status]}">${EXC_ST[x.status]}</span></div>
    <div>${esc(x.reason)}</div>
    ${x.img ? `<img src="${esc(x.img)}" alt="صورة العذر" style="max-width:100%;max-height:420px;border-radius:10px;border:1px solid var(--line);justify-self:start">` : `<span class="muted">بدون صورة</span>`}
    ${x.status === "pending" ? `<div class="row"><input type="text" class="grow" id="exn-${esc(x.id)}" placeholder="ملاحظة للطالب (اختياري)"><button class="btn pri sm" data-exok="${esc(x.id)}">قبول</button><button class="btn danger sm" data-exno="${esc(x.id)}">رفض</button></div>` : x.note ? `<div class="muted">الملاحظة: ${esc(x.note)}</div>` : ""}
  </div>`).join("") || `<div class="card empty">ما فيه أعذار هنا.</div>`}</div>`;
  el.querySelectorAll("[data-ef]").forEach(b => b.onclick = () => { S.excFilter = b.dataset.ef; render(); });
  const decide = async (id, ok) => {
    const x = (S.excuses || []).find(y => y.id === id); if (!x) return;
    const note = ($("#exn-" + id) || {}).value || "";
    const b = writeBatch(db);
    b.update(ref("excuses/" + id), {status: ok ? "accepted" : "rejected", note: note.trim(), decidedAt: new Date().toISOString(), by: S.adminRole});
    let applied = false;
    if (ok) {
      const g = S.groups[x.groupId], entry = g && (g.students || []).find(s => s.sid === x.num);
      const aRef = ref(`att/${x.groupId}_${x.date}`), snap = await getDoc(aRef);
      if (entry && snap.exists()) { b.set(aRef, {rec: {[entry.id]: {st: "e", excuse: id}}}, {merge: true}); applied = true; }
    }
    try { await b.commit(); logAction(ok ? "قبول عذر" : "رفض عذر", `${x.name} · ${x.course} · ${x.date}`); toast(ok ? (applied ? "انقبل العذر وتحوّل الغياب إلى مستأذن" : "انقبل العذر. ما فيه تحضير مسجل لذاك اليوم") : "انرفض العذر"); }
    catch (e) { handleWriteErr(e); }
  };
  el.querySelectorAll("[data-exok]").forEach(b => b.onclick = () => decide(b.dataset.exok, true));
  el.querySelectorAll("[data-exno]").forEach(b => b.onclick = () => decide(b.dataset.exno, false));
}

/* ---------- evaluations tab ---------- */
function adminEvals(el){
  if (!S.evalsAll) {
    el.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري تحميل التقييمات…</p></div>`;
    getDocs(collection(db, "surveys")).then(snap => { S.surveyAll = snap.docs.map(d => d.data()).map(x => ({...x, title: x.sid === (S.survey || {}).id ? S.survey.title : x.sid})); if (S.aTab === "evals") adminSurvey(); }).catch(() => {});
    getDocs(collection(db, "evals")).then(snap => { S.evalsAll = snap.docs.map(d => d.data()); if (S.aTab === "evals") render(); }).catch(e => { console.error(e); el.innerHTML = `<div class="notice err">تعذّر تحميل التقييمات، تأكد من تحديث قواعد Firebase.</div>`; });
    return;
  }
  const byG = {}; S.evalsAll.forEach(e => (byG[e.groupId] = byG[e.groupId] || []).push(e));
  const gs = sortedGroups().filter(g => g.evalOpen || byG[g.id]);
  const avg = (list, i) => list.length ? (list.reduce((a, e) => a + (e.ratings[i] || 0), 0) / list.length).toFixed(1) : "—";
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">تقييمات المدربين والمقررات</h2><button class="btn sm" id="evRef">تحديث</button></div>
    <p class="muted" style="margin:8px 0 0">تفتح التقييم لأي مقرر من "المقررات والطلاب" ← فتح وتعديل ← "فتح تقييم المدرب والمقرر". التقييم سري عن المدرب.</p></div>
  ${gs.map(g => { const l = byG[g.id] || [], n = (g.memberNums || []).length, all = l.length ? (l.reduce((a, e) => a + e.ratings.reduce((x, y) => x + y, 0) / e.ratings.length, 0) / l.length).toFixed(1) : "—";
    return `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">${esc(g.course)}</h2><p class="muted" style="margin:4px 0 0">${esc(tName(g.trainerId))} · قيّم ${l.length} من ${n}${g.evalOpen ? "" : " · التقييم مقفل"}</p></div><div style="font-size:28px;font-weight:700;color:var(--green)">${all}<span class="muted" style="font-size:14px"> / 5</span></div></div>
      ${l.length ? `<div class="tbl" style="margin-top:10px"><table><tbody>${EVAL_Q.map((q, i) => `<tr><td class="nm">${q}</td><td><b>${avg(l, i)}</b></td><td style="width:40%"><span class="bar" style="display:block"><i style="width:${avg(l, i) === "—" ? 0 : avg(l, i) / 5 * 100}%"></i></span></td></tr>`).join("")}</tbody></table></div>
      ${l.filter(e => e.comment).length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">الملاحظات (${l.filter(e => e.comment).length})</summary><div class="list" style="margin-top:6px">${l.filter(e => e.comment).map(e => `<div class="item" style="padding:8px 12px">${esc(e.comment)}</div>`).join("")}</div></details>` : ""}` : `<p class="muted">ما وصلت تقييمات بعد.</p>`}
    </div>`; }).join("") || `<div class="card empty">ما فيه تقييمات مفتوحة. افتحها من "المقررات والطلاب".</div>`}`;
  el.insertAdjacentHTML("afterbegin", `<div id="svBox"></div>`); adminSurvey();
  $("#evRef").onclick = () => { S.evalsAll = null; S.surveyAll = null; render(); };
}


/* ---------- indicators dashboard ---------- */
function adminKpi(el){
  if (!S.kpiAtt) {
    el.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري حساب المؤشرات…</p></div>`;
    Promise.all([getDocs(collection(db, "att")), S.evalsAll || RO() ? null : getDocs(collection(db, "evals")).catch(() => null)]).then(([a, e]) => {
      S.kpiAtt = a.docs.map(d => d.data()); if (e) S.evalsAll = e.docs.map(d => d.data());
      if (S.aTab === "kpi") render();
    }).catch(err => { console.error(err); el.innerHTML = `<div class="notice err">تعذّر تحميل البيانات.</div>`; });
    return;
  }
  const att = countable(S.kpiAtt), byG = {}; att.forEach(d => (byG[d.groupId] = byG[d.groupId] || []).push(d));
  const groups = sortedGroups().map(g => {
    const docs = byG[g.id] || [], st = (g.students || []).map(s => absStats(g, s.id, docs));
    const withAtt = st.filter(x => x.attPct !== null);
    const gd = S.grades[g.id] || {}, marks = gd.status === "approved" ? Object.values(gd.marks || {}).filter(x => typeof x === "number") : [];
    const ev = (S.evalsAll || []).filter(e => e.groupId === g.id);
    return {g, held: docs.length, n: st.length,
      att: withAtt.length ? Math.round(withAtt.reduce((a, x) => a + x.attPct, 0) / withAtt.length) : null,
      risk: st.filter(x => x.level === 1 || x.level === 2).length, deny: st.filter(x => x.level === 3).length,
      pass: marks.length ? Math.round(marks.filter(x => x >= PASS).length / marks.length * 100) : null,
      avgMark: marks.length ? Math.round(marks.reduce((a, x) => a + x, 0) / marks.length) : null,
      ev: ev.length ? ev.reduce((a, e) => a + e.ratings.reduce((x, y) => x + y, 0) / e.ratings.length, 0) / ev.length : null};
  });
  const live = groups.filter(x => x.att !== null);
  const overall = live.length ? Math.round(live.reduce((a, x) => a + x.att * x.n, 0) / Math.max(1, live.reduce((a, x) => a + x.n, 0))) : null;
  const trainers = {}; groups.forEach(x => { const k = x.g.trainerId || "_"; (trainers[k] = trainers[k] || []).push(x); });
  const avgOf = (l, k) => { const v = l.filter(x => x[k] !== null); return v.length ? v.reduce((a, x) => a + x[k], 0) / v.length : null; };
  const months = {}; att.forEach(d => { const m = d.date.slice(0, 7); const o = months[m] = months[m] || {pr: 0, all: 0}; const g = S.groups[d.groupId]; (g ? g.students || [] : []).forEach(s => { o.all++; const r = d.rec && d.rec[s.id]; if (r && (r.st === "p" || r.st === "l")) o.pr++; }); });
  const fin = SEES_FIN() && S.finAcc ? finRows().filter(r => r.acc) : null;
  const finT = fin ? {net: fin.reduce((a, r) => a + r.st.net, 0), paid: fin.reduce((a, r) => a + r.st.paid, 0), over: fin.reduce((a, r) => a + r.st.overdue, 0), late: fin.filter(r => r.st.status === "late").length} : null;
  const pctBar = v => v === null ? `<span class="muted">—</span>` : `<div class="row" style="gap:6px;flex-wrap:nowrap"><span class="bar" style="flex:1"><i style="width:${v}%;background:${v < 75 ? "var(--abs)" : v < 85 ? "#D9A400" : "var(--green-2)"}"></i></span><b>${v}%</b></div>`;
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">المؤشرات</h2><button class="btn sm" id="kRef">تحديث</button></div>
    <div class="stats" style="margin-top:10px">
      <div class="stat"><div class="n">${Object.keys(S.students || {}).length || groups.reduce((a, x) => a + x.n, 0)}</div><div class="l">متدرب</div></div>
      <div class="stat"><div class="n">${groups.length}</div><div class="l">مقرر</div></div>
      <div class="stat"><div class="n">${att.length}</div><div class="l">محاضرة منعقدة</div></div>
      <div class="stat"><div class="n" style="color:${overall !== null && overall < 80 ? "var(--abs)" : "var(--green)"}">${overall === null ? "—" : overall + "%"}</div><div class="l">نسبة الحضور العامة</div></div>
      <div class="stat"><div class="n">${groups.reduce((a, x) => a + x.risk, 0)}</div><div class="l">عليهم إنذار</div></div>
      <div class="stat"><div class="n" style="color:var(--abs)">${groups.reduce((a, x) => a + x.deny, 0)}</div><div class="l">حرمان</div></div>
      ${finT ? `<div class="stat"><div class="n">${finT.net ? Math.round(finT.paid / finT.net * 100) : 0}%</div><div class="l">نسبة التحصيل</div></div><div class="stat"><div class="n" style="color:var(--abs)">${SAR(finT.over)}</div><div class="l">متأخر السداد (${finT.late})</div></div>` : ""}
    </div></div>
  <div class="card"><h2>المقررات</h2><div class="tbl"><table><thead><tr><th class="nm">المقرر</th><th class="nm">المدرب/ة</th><th>المحاضرات</th><th style="min-width:150px">الحضور</th><th>إنذار</th><th>حرمان</th><th>النجاح</th><th>تقييم المدرب</th></tr></thead><tbody>
    ${groups.map(x => `<tr><td class="nm">${esc(x.g.course)}</td><td class="nm">${esc(tName(x.g.trainerId))}</td><td>${x.held}</td><td>${pctBar(x.att)}</td><td>${x.risk || "—"}</td><td style="color:${x.deny ? "var(--abs)" : "inherit"}">${x.deny || "—"}</td><td>${x.pass === null ? "—" : x.pass + "%"}</td><td>${x.ev === null ? "—" : x.ev.toFixed(1) + " / 5"}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">ما فيه مقررات</td></tr>`}
  </tbody></table></div><p class="muted">النجاح يظهر بعد اعتماد الدرجات. التقييم من استبيان تقييم المدرب.</p></div>
  <div class="card"><h2>المدربين</h2><div class="tbl"><table><thead><tr><th class="nm">المدرب/ة</th><th>المقررات</th><th style="min-width:150px">متوسط الحضور</th><th>متوسط التقييم</th></tr></thead><tbody>
    ${Object.entries(trainers).map(([k, l]) => { const a = avgOf(l, "att"), e = avgOf(l, "ev"); return `<tr><td class="nm">${esc(k === "_" ? "بدون مدرب" : tName(k))}</td><td>${l.length}</td><td>${pctBar(a === null ? null : Math.round(a))}</td><td>${e === null ? "—" : e.toFixed(1)}</td></tr>`; }).join("")}
  </tbody></table></div></div>
  <div class="card"><h2>الحضور حسب الشهر</h2>${Object.keys(months).length ? `<div class="list">${Object.entries(months).sort().map(([m, o]) => `<div class="item" style="padding:8px 12px"><span style="width:80px">${m}</span><span class="grow">${pctBar(o.all ? Math.round(o.pr / o.all * 100) : null)}</span></div>`).join("")}</div>` : `<p class="muted" style="margin:0">ما فيه تحضير بعد.</p>`}</div>`;
  $("#kRef").onclick = () => { S.kpiAtt = null; render(); };
}

/* ---------- audit log tab ---------- */
function adminLogs(el){
  if (!S.unsubLogs) {
    S.unsubLogs = onSnapshot(query(collection(db, "logs"), orderBy("at", "desc"), limit(300)), snap => {
      S.logs = snap.docs.map(d => d.data()); if (S.view === "admin" && S.aTab === "logs" && !busyEditing()) render();
    }, e => { console.error(e); toast("تعذّر تحميل السجل، تأكد من تحديث قواعد Firebase"); });
  }
  const fmtAt = t => { try { return t.toDate().toLocaleString("ar-SA-u-ca-gregory-nu-latn", {timeZone: TZ, dateStyle: "medium", timeStyle: "short"}); } catch { return "…"; } };
  el.innerHTML = `<div class="card"><h2>سجل العمليات</h2>
    <p class="muted" style="margin-top:0">آخر 300 عملية: مين سوّاها، ووش، ومتى. السجل ما ينحذف ولا ينعدّل.</p>
    <input type="text" id="lq" placeholder="ابحث باسم أو عملية أو مقرر"></div>
    <div class="tbl"><table><thead><tr><th>الوقت</th><th class="nm">مين</th><th class="nm">العملية</th><th class="nm">التفاصيل</th></tr></thead><tbody id="lbody"></tbody></table></div>`;
  const draw = q => {
    q = norm(q || "");
    const rows = S.logs.filter(l => !q || norm(`${l.who} ${l.action} ${l.details}`).includes(q));
    $("#lbody").innerHTML = rows.map(l => `<tr><td>${esc(fmtAt(l.at))}</td><td class="nm">${esc(l.who)}</td><td class="nm">${esc(l.action)}</td><td class="nm" style="white-space:normal">${esc(l.details)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">ما فيه عمليات بعد</td></tr>`;
  };
  draw(""); $("#lq").oninput = e => draw(e.target.value);
}

async function setDisabled(coll, id, on, name){
  const b = writeBatch(db);
  b.set(ref(`${coll}/${id}`), {disabled: on}, {merge: true});
  b.set(ref("public/disabled"), {list: {[id]: on}}, {merge: true});
  try { await b.commit(); S.disabled = {...(S.disabled || {}), [id]: on}; logAction(on ? "تعطيل حساب" : "تفعيل حساب", `${name || ""} · ${id}`); toast(on ? "انوقف الحساب، وما يقدر يدخل لين تفعّله" : "رجع الحساب يشتغل"); render(); }
  catch (e) { handleWriteErr(e); }
}

/* ---------- backup ---------- */
const ALL_COLLS = ["public", "ann", "trainers", "groups", "students", "secrets", "studentSecrets", "att", "grades", "results", "joins", "excuses", "warnings", "evals", "certs", "archives", "logs", "surveys", "fin", "finAccounts", "payments", "salaryPays", "expenses", "commPays", "finClear", "receipts"];
async function backupAll(note){
  const out = {kind: "asas-backup-v1", at: new Date().toISOString(), note: note || "", data: {}};
  for (const c of ALL_COLLS) {
    let snap; try { snap = await getDocs(collection(db, c)); } catch { continue; }   // e.g. finance collections for the academic role
    out.data[c] = {}; snap.docs.forEach(d => { const v = d.data(); if (c === "logs" && v.at && v.at.toDate) v.at = v.at.toDate().toISOString(); out.data[c][d.id] = v; });
  }
  const blob = new Blob([JSON.stringify(out)], {type: "application/json"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `asas-backup-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  logAction("نسخة احتياطية", note || "");
  return out;
}

/* ---------- term archive ---------- */
async function archiveTerm(term, opts, log){
  log("1/4 تنزيل نسخة احتياطية كاملة…");
  const bk = await backupAll("قبل أرشفة " + term);
  const att = Object.values(bk.data.att || {}), results = Object.values(bk.data.results || {});
  log("2/4 حفظ ملخص الفصل…");
  const key = term.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
  for (const g of Object.values(S.groups)) {
    const docs = countable(att.filter(d => d.groupId === g.id));
    const rows = (g.students || []).map(s => { const st = absStats(g, s.id, docs); const r = results.find(x => x.groupId === g.id && x.num === s.sid); return {name: s.name, num: s.sid || "", att: st.attPct, abs: st.a, absPct: st.absPct, level: LEVEL[st.level], mark: r ? r.mark : null}; });
    if (rows.length) await setDoc(ref(`archives/${key}_${g.id}`), {term, termKey: key, groupId: g.id, course: g.course, trainer: tName(g.trainerId), held: docs.length, rows, at: today()});
  }
  log("3/4 مسح بيانات الفصل الحالي…");
  for (const c of ["att", "joins", "grades", "results", "excuses", "warnings", "evals"]) {
    const ids = Object.keys(bk.data[c] || {});
    for (let i = 0; i < ids.length; i += 400) { const b = writeBatch(db); ids.slice(i, i + 400).forEach(id => b.delete(ref(`${c}/${id}`))); await b.commit(); }
    log(`   ${c}: ${ids.length}`);
  }
  log("4/4 تجهيز الشعب للفصل الجديد…");
  const gb = writeBatch(db);
  Object.values(S.groups).forEach(g => {
    const d = clone(g); delete d.id; d.evalOpen = false;
    if (opts.clearStudents) { d.students = []; d.memberNums = []; }
    if (opts.clearSchedule) { d.sessions = []; d.meetLink = ""; d.recordings = []; }
    gb.set(ref("groups/" + g.id), d);
  });
  await gb.commit();
  S.allAtt = null; S.evalsAll = null; S.archives = null;
  logAction("أرشفة الفصل وبدء فصل جديد", term);
  log("تم. الشهادات الصادرة باقية وصفحة التحقق شغالة.");
}
function adminArchive(el){
  if (!S.archives) {
    el.innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري تحميل الأرشيف…</p></div>`;
    getDocs(collection(db, "archives")).then(snap => { S.archives = snap.docs.map(d => d.data()); if (S.aTab === "archive") render(); }).catch(e => { console.error(e); el.innerHTML = `<div class="notice err">تعذّر تحميل الأرشيف، تأكد من تحديث قواعد Firebase.</div>`; });
    return;
  }
  const terms = [...new Set(S.archives.map(a => a.term))];
  const t = S.archTerm && terms.includes(S.archTerm) ? S.archTerm : terms[0];
  const list = S.archives.filter(a => a.term === t).sort((a, b) => a.course.localeCompare(b.course, "ar"));
  el.innerHTML = `<div class="card"><h2>أرشيف الفصول</h2>
    ${terms.length ? `<div class="row"><select id="arT" class="grow">${terms.map(x => `<option ${x === t ? "selected" : ""}>${esc(x)}</option>`).join("")}</select><button class="btn sm" id="arX">تنزيل Excel</button></div>` : `<p class="muted" style="margin:0">ما فيه فصول مؤرشفة. الأرشفة من تبويب "النظام".</p>`}</div>
  ${list.map(a => `<div class="card"><h2>${esc(a.course)}</h2><p class="muted" style="margin-top:0">${esc(a.trainer)} · ${a.held} محاضرة</p>
    <div class="tbl"><table><thead><tr><th class="nm">الاسم</th><th>الرقم</th><th>الحضور</th><th>غياب</th><th>الحالة</th><th>الدرجة</th></tr></thead><tbody>
    ${a.rows.map(r => `<tr><td class="nm">${esc(r.name)}</td><td>${esc(r.num)}</td><td>${r.att === null ? "—" : r.att + "%"}</td><td>${r.abs} (${r.absPct}%)</td><td>${esc(r.level)}</td><td>${r.mark === null ? "—" : r.mark}</td></tr>`).join("")}</tbody></table></div></div>`).join("")}`;
  if ($("#arT")) $("#arT").onchange = e => { S.archTerm = e.target.value; render(); };
  if ($("#arX")) $("#arX").onclick = () => excelDownload(`أرشيف ${t}`, list.map(a => ({title: a.course, rows: [[INST_AR], [`${t} · ${a.course} · ${a.trainer}`], [], ["الاسم", "الرقم", "الحضور %", "غياب", "نسبة الغياب %", "الحالة", "الدرجة"], ...a.rows.map(r => [r.name, r.num, r.att, r.abs, r.absPct, r.level, r.mark])], widths: [30, 12, 10, 8, 12, 14, 8]})));
}



/* ================= fee clearance (read by academic affairs for certificates) ================= */
function syncFinClear(){
  if (S._fcBusy || !S.finAcc || !S.pays || !S.finClearLoaded) return;
  const want = {};
  Object.entries(S.finAcc).forEach(([num, acc]) => { want[num] = accStatus(acc, paysOf(num)).remaining; });
  const b = writeBatch(db); let n = 0;
  Object.entries(want).forEach(([num, rem]) => { const cur = (S.finClear || {})[num]; if (!cur || Math.abs((cur.remaining || 0) - rem) > 0.001) { b.set(ref("finClear/" + num), {remaining: rem}); n++; } });
  Object.keys(S.finClear || {}).forEach(num => { if (!(num in want)) { b.delete(ref("finClear/" + num)); n++; } });
  if (!n || n > 450) return;
  S._fcBusy = true;
  b.commit().catch(() => {}).finally(() => { S._fcBusy = false; });
}

/* ================= finance ================= */
const PLANS = {full: "كامل المبلغ", half: "50% / 50%", monthly: "أقساط شهرية", qasima: "قسيمة بلس (تابي / تمارا)"};
const METHODS = ["تحويل بنكي", "نقد", "مدى / شبكة", "قسيمة بلس"];
const SAR = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", {maximumFractionDigits: 2}) + " ر.س";
const addMonths = (d, k) => { const [y, m, dd] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + k, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(dd, last)).padStart(2, "0")}`; };
function startFinance(){
  S.subs.push(onSnapshot(ref("fin/settings"), snap => { S.finSet = snap.exists() ? snap.data() : {programs: []}; afterData(); }, () => {}));
  S.subs.push(onSnapshot(collection(db, "finAccounts"), snap => { S.finAcc = {}; snap.docs.forEach(d => S.finAcc[d.id] = d.data()); afterData(); }, () => {}));
  S.subs.push(onSnapshot(collection(db, "payments"), snap => { S.pays = snap.docs.map(d => ({id: d.id, ...d.data()})); afterData(); }, () => {}));
  S.subs.push(onSnapshot(collection(db, "expenses"), snap => { S.exps = snap.docs.map(d => ({id: d.id, ...d.data()})); afterData(); }, () => {}));
  S.subs.push(onSnapshot(collection(db, "commPays"), snap => { S.commPays = snap.docs.map(d => ({id: d.id, ...d.data()})); afterData(); }, () => {}));
  S.subs.push(onSnapshot(collection(db, "salaryPays"), snap => { S.salPays = {}; snap.docs.forEach(d => S.salPays[d.id] = d.data()); afterData(); }, () => {}));
}
function buildPlan(net, plan, start, months, second){
  if (!net || !start) return [];
  if (plan === "half") { const a = Math.round(net / 2 * 100) / 100; return [{due: start, amount: a}, {due: second || addMonths(start, 2), amount: Math.round((net - a) * 100) / 100}]; }
  if (plan === "monthly") {
    const n = Math.max(2, Math.min(60, Number(months) || 4)), a = Math.floor(net / n * 100) / 100;
    return Array.from({length: n}, (_, i) => ({due: addMonths(start, i), amount: i === n - 1 ? Math.round((net - a * (n - 1)) * 100) / 100 : a}));
  }
  return [{due: start, amount: net}];
}
/* paid vs schedule: overdue = what fell due by today minus what was paid */
function accStatus(acc, pays){
  const extras = acc.extras || [];
  const net = Math.round((Math.max(0, (Number(acc.fee) || 0) - (Number(acc.discount) || 0)) + extras.reduce((a, x) => a + (Number(x.amount) || 0), 0)) * 100) / 100;
  const paid = pays.filter(p => !p.void).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const inst = [...(acc.installments || []).map((x, ix) => ({...x, ix})), ...extras.map((x, xi) => ({due: x.date, amount: Number(x.amount) || 0, label: x.label, xi}))].sort((a, b) => a.due.localeCompare(b.due));
  let cum = 0, dueNow = 0, next = null;
  inst.forEach(i => { cum += Number(i.amount) || 0; if (i.due <= today()) dueNow = cum; else if (!next && cum > paid) next = i; });
  const remaining = Math.max(0, Math.round((net - paid) * 100) / 100), overdue = Math.max(0, Math.round((dueNow - paid) * 100) / 100);
  const status = !net ? "none" : remaining === 0 ? "paid" : overdue > 0 ? "late" : "ok";
  let run = 0; const sched = inst.map(i => { const before = run; run += Number(i.amount) || 0; const covered = Math.max(0, Math.min(Number(i.amount) || 0, paid - before)); return {...i, covered, st: covered >= (Number(i.amount) || 0) - 0.001 ? "paid" : i.due <= today() ? "late" : covered > 0 ? "part" : "due"}; });
  return {net, paid, remaining, overdue, status, next, sched};
}
const FST = {none: "بدون خطة", paid: "مسدد", ok: "منتظم", late: "متأخر"};
const FST_PILL = {none: "", paid: "p", ok: "e", late: "a"};
const INST_ST = {paid: "مدفوع", late: "متأخر", part: "مدفوع جزئياً", due: "قادم"};
const INST_PILL = {paid: "p", late: "a", part: "l", due: ""};
const paysOf = num => (S.pays || []).filter(p => p.num === num);

function adminFinance(el){
  const t = S.finTab || "sum";
  const tabs = [["sum", "الملخص"], ["acc", "حسابات الطلاب"], ["pay", "الدفعات"], ["rcpt", "الإيصالات"], ["late", "المتأخرين"], ["exp", "المصروفات"], ["sal", "رواتب المدربين"], ["part", "الشركاء والعمولات"], ["rep", "التقرير الشهري"], ["set", "الإعدادات"]];
  el.innerHTML = `<div class="card" style="padding:10px 12px"><div class="tabs" style="border:0;padding:0">${tabs.map(([k, v]) => `<button class="tab ${t === k ? "on" : ""}" data-ft="${k}">${v}</button>`).join("")}</div></div><div id="fb"></div>`;
  el.querySelectorAll("[data-ft]").forEach(b => b.onclick = () => { S.finTab = b.dataset.ft; render(); });
  if (!S.finSet) { $("#fb").innerHTML = `<div class="card"><p class="muted" style="margin:0">جاري التحميل…</p></div>`; return; }
  ({sum: finSummary, acc: finAccounts, pay: finPayments, rcpt: finReceipts, late: finLate, exp: finExpenses, sal: finSalaries, part: finPartners, rep: finReport, set: finSettings})[t]($("#fb"));
}
function finRows(){
  return Object.values(S.students).map(s => { const acc = (S.finAcc || {})[s.num]; return {s, acc, st: acc ? accStatus(acc, paysOf(s.num)) : {net: 0, paid: 0, remaining: 0, overdue: 0, status: "none"}}; });
}
function finSummary(el){
  const rows = finRows(), m = today().slice(0, 7);
  const sum = k => rows.reduce((a, r) => a + r.st[k], 0);
  const monthPaid = (S.pays || []).filter(p => !p.void && (p.date || "").startsWith(m)).reduce((a, p) => a + Number(p.amount), 0);
  const progs = (S.finSet.programs || []).map(pr => { const rs = rows.filter(r => r.acc && r.acc.program === pr.id); return {pr, n: rs.length, net: rs.reduce((a, r) => a + r.st.net, 0), paid: rs.reduce((a, r) => a + r.st.paid, 0)}; });
  const methods = {}; (S.pays || []).filter(p => !p.void).forEach(p => methods[p.method] = (methods[p.method] || 0) + Number(p.amount));
  el.innerHTML = `<div class="card"><h2>الملخص المالي</h2>
    <div class="stats">
      <div class="stat"><div class="n">${SAR(sum("net"))}</div><div class="l">إجمالي المستحق</div></div>
      <div class="stat"><div class="n">${SAR(sum("paid"))}</div><div class="l">المحصّل</div></div>
      <div class="stat"><div class="n">${SAR(sum("remaining"))}</div><div class="l">المتبقي</div></div>
      <div class="stat"><div class="n" style="color:var(--abs)">${SAR(sum("overdue"))}</div><div class="l">متأخر السداد (${rows.filter(r => r.st.status === "late").length} طالب)</div></div>
      <div class="stat"><div class="n">${SAR(monthPaid)}</div><div class="l">محصّل هذا الشهر</div></div>
      <div class="stat"><div class="n">${SAR(monthFlow(m).out)}</div><div class="l">مصروف هذا الشهر</div></div>
      <div class="stat"><div class="n" style="color:${monthFlow(m).net < 0 ? "var(--abs)" : "var(--green)"}">${SAR(monthFlow(m).net)}</div><div class="l">صافي هذا الشهر</div></div>
      <div class="stat"><div class="n">${rows.filter(r => r.st.status === "none").length}</div><div class="l">طلاب بدون خطة سداد</div></div>
    </div></div>
  <div class="card"><h2>حسب البرنامج</h2>${progs.length ? `<div class="tbl"><table><thead><tr><th class="nm">البرنامج</th><th>الطلاب</th><th>المستحق</th><th>المحصّل</th><th>النسبة</th></tr></thead><tbody>${progs.map(x => `<tr><td class="nm">${esc(x.pr.name)}</td><td>${x.n}</td><td>${SAR(x.net)}</td><td>${SAR(x.paid)}</td><td>${x.net ? Math.round(x.paid / x.net * 100) : 0}%</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">أضف البرامج ورسومها من "البرامج والرسوم".</p>`}</div>
  <div class="card"><h2>حسب طريقة الدفع</h2>${Object.keys(methods).length ? `<div class="list">${Object.entries(methods).map(([k, v]) => `<div class="item"><span class="grow">${esc(k)}</span><b>${SAR(v)}</b></div>`).join("")}</div>` : `<p class="muted" style="margin:0">ما فيه دفعات بعد.</p>`}</div>`;
}
function finAccounts(el){
  const progName = id => ((S.finSet.programs || []).find(p => p.id === id) || {}).name || "—";
  el.innerHTML = `<div class="card"><h2>حسابات الطلاب</h2><div class="row"><input type="text" id="faQ" class="grow" placeholder="ابحث بالاسم أو الرقم"><select id="faF" style="width:auto"><option value="">الكل</option>${Object.entries(FST).map(([k, v]) => `<option value="${k}" ${S.faF === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div><div class="list" id="faL"></div>`;
  const draw = () => {
    const q = norm($("#faQ").value), f = $("#faF").value; S.faF = f;
    const rows = finRows().filter(r => (!q || norm(r.s.name).includes(q) || r.s.num.includes(q)) && (!f || r.st.status === f)).sort((a, b) => a.s.num.localeCompare(b.s.num));
    $("#faL").innerHTML = rows.slice(0, 200).map(r => `<div class="item"><div class="grow"><div class="t">${esc(r.s.name)} <span class="muted">${esc(r.s.num)}</span></div>
      <div class="muted">${r.acc ? `${esc(progName(r.acc.program))} · ${PLANS[r.acc.plan] || ""}` : "ما انفتح له حساب"}</div></div>
      ${r.acc ? `<span class="muted">مدفوع ${SAR(r.st.paid)} من ${SAR(r.st.net)}</span>` : ""}<span class="pill ${FST_PILL[r.st.status]}">${FST[r.st.status]}${r.st.overdue ? " · " + SAR(r.st.overdue) : ""}</span>
      <button class="btn sm ${r.acc ? "" : "gold"}" data-fa="${esc(r.s.num)}">${r.acc ? "فتح" : "فتح حساب"}</button></div>`).join("") || `<div class="card empty">ما فيه نتائج</div>`;
    $("#faL").querySelectorAll("[data-fa]").forEach(b => b.onclick = () => openFinAccount(b.dataset.fa));
  };
  draw(); $("#faQ").oninput = draw; $("#faF").onchange = draw;
}
function openFinAccount(num){
  const s = S.students[num]; if (!s) return;
  S._modalGroup = null; S._finModal = num;
  const acc = clone((S.finAcc || {})[num] || {num, name: s.name, program: "", fee: 0, discount: 0, discountNote: "", plan: "full", start: today(), months: 4, installments: [], phone: ""});
  const progs = S.finSet.programs || [];
  const draw = () => {
    const st = accStatus(acc, paysOf(num)), pays = paysOf(num).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    /* which payments covered which installment: payments fill the schedule in date order */
    let pr = 0; const ranges = paysOf(num).filter(p => !p.void).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.receiptNo || "").localeCompare(b.receiptNo || "")).map(p => { const r = {p, from: pr, to: pr + Number(p.amount)}; pr = r.to; return r; });
    let ir = 0; const instRange = st.sched.map(i => { const r = {from: ir, to: ir + Number(i.amount)}; ir = r.to; return r; });
    const instCell = (i, k) => {
      const r = instRange[k], by = ranges.filter(x => x.from < r.to - 0.001 && x.to > r.from + 0.001).map(x => x.p);
      const left = Math.max(0, Math.round((Number(i.amount) - i.covered) * 100) / 100);
      return by.map(p => p.hasImg ? `<button class="btn sm" data-rview="payments:${esc(p.id)}" title="سند ${esc(p.receiptNo)}">إيصال ${esc(p.receiptNo.split("-")[1] || "")}</button>` : `<span class="muted" style="font-size:12px">سند ${esc(p.receiptNo)} بدون إيصال</span>`).join(" ")
        + (left > 0 && (S.finAcc || {})[num] ? ` <button class="btn sm gold" data-payinst="${left}" data-instlbl="${esc(i.label || "القسط " + (k + 1))}">تسجيل الدفعة</button>` : "");
    };
    $("#modalBox").innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-family:var(--display);color:var(--green);font-weight:600">${esc(s.name)} · ${esc(num)}</h2><button class="btn sm" id="fx">إغلاق</button></div>
    <div class="stats"><div class="stat"><div class="n">${SAR(st.net)}</div><div class="l">الصافي</div></div><div class="stat"><div class="n">${SAR(st.paid)}</div><div class="l">مدفوع</div></div><div class="stat"><div class="n">${SAR(st.remaining)}</div><div class="l">متبقي</div></div><div class="stat"><div class="n" style="color:${st.overdue ? "var(--abs)" : "inherit"}">${SAR(st.overdue)}</div><div class="l">متأخر</div></div></div>
    <div class="card" style="background:var(--bg)"><h3>خطة السداد</h3>
      <div class="row">
        <label class="f grow" for="fP">البرنامج<select id="fP"><option value="">اختر البرنامج</option>${progs.map(p => `<option value="${esc(p.id)}" ${acc.program === p.id ? "selected" : ""}>${esc(p.name)} · ${SAR(p.fee)}</option>`).join("")}</select></label>
        <label class="f" for="fFee" style="width:130px">الرسوم<input type="number" id="fFee" min="0" value="${acc.fee || ""}"></label>
        <label class="f" for="fDis" style="width:120px">الخصم<input type="number" id="fDis" min="0" value="${acc.discount || ""}"></label>
        <label class="f grow" for="fDisN">سبب الخصم<input type="text" id="fDisN" value="${esc(acc.discountNote || "")}" placeholder="مثل: شراكة جامعة حائل"></label>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="f grow" for="fPl">طريقة السداد<select id="fPl">${Object.entries(PLANS).map(([k, v]) => `<option value="${k}" ${acc.plan === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="f" for="fSt" style="width:160px">تاريخ أول دفعة<input type="date" id="fSt" value="${esc(acc.start || today())}"></label>
        <label class="f" for="fMo" style="width:110px;${acc.plan === "monthly" ? "" : "display:none"}">عدد الأشهر<input type="number" id="fMo" min="2" max="60" value="${acc.months || 4}"></label>
        <label class="f" for="fSec" style="width:160px;${acc.plan === "half" ? "" : "display:none"}">موعد الدفعة الثانية<input type="date" id="fSec" value="${esc(acc.second || "")}"></label>
        <button class="btn sm" id="fGen" style="align-self:flex-end">توليد الجدول</button>
      </div>
      ${acc.plan === "qasima" ? `<p class="muted">الطالب يقسّط مع قسيمة بلس، والمعهد يستلم المبلغ كامل. سجّل الدفعة بطريقة "قسيمة بلس" لما يوصل المبلغ.</p>` : ""}
      <div class="row" style="margin-top:8px">
        <label class="f grow" for="fPh">جوال للتذكير (الطالب أو ولي الأمر)<input type="tel" id="fPh" dir="ltr" value="${esc(acc.phone || "")}" placeholder="05xxxxxxxx"></label>
        <label class="f grow" for="fPar">سجّل عن طريق (للعمولة)<select id="fPar"><option value="">بدون شريك</option>${(S.finSet.partners || []).map(p => `<option value="${esc(p.id)}" ${acc.partner === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      </div>
      <div class="tbl" style="margin-top:10px"><table><thead><tr><th>الدفعة</th><th>الاستحقاق</th><th>المبلغ</th><th>الحالة</th><th>الإيصال</th></tr></thead><tbody>
        ${st.sched.map((i, k) => i.xi !== undefined ? `<tr><td>${esc(i.label)}</td><td>${dH(i.due)}</td><td>${SAR(i.amount)}</td><td><span class="pill ${INST_PILL[i.st]}">${INST_ST[i.st]}</span></td><td>${instCell(i, k)}</td></tr>` : `<tr><td>${k + 1}</td><td><input type="date" data-idue="${i.ix}" value="${esc(i.due)}" style="width:150px;padding:4px"></td><td><input type="number" data-iamt="${i.ix}" value="${i.amount}" style="width:110px;padding:4px"></td><td><span class="pill ${INST_PILL[i.st]}">${INST_ST[i.st]}</span></td><td>${instCell(i, k)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">اضغط "توليد الجدول"</td></tr>`}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn pri" id="fSave">حفظ الحساب</button><span class="muted" id="fChk"></span></div>
    </div>
    <div class="card" style="background:var(--bg)"><h3>رسوم إضافية</h3>
      <div class="list">${(acc.extras || []).map((x, i) => `<div class="item" style="padding:8px 12px"><span class="grow">${esc(x.label)} · ${dH(x.date)}</span><b>${SAR(x.amount)}</b><button class="btn sm danger" data-xdel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه رسوم إضافية</span>`}</div>
      <div class="row" style="margin-top:8px"><select id="xT" class="grow"><option value="">نوع الرسوم</option>${(S.finSet.extraTypes || []).map(t => `<option value="${esc(t.name)}" data-fee="${t.fee}">${esc(t.name)} · ${SAR(t.fee)}</option>`).join("")}<option value="_o">أخرى…</option></select>
        <input type="text" id="xL" placeholder="اسم الرسوم" style="width:150px;display:none"><input type="number" id="xA" min="0" placeholder="المبلغ" style="width:110px"><input type="date" id="xD" value="${today()}" style="width:150px">
        <button class="btn sm gold" id="xAdd" ${(S.finAcc || {})[num] ? "" : "disabled"}>+ إضافة</button></div>
    </div>
    <div class="card" style="background:var(--bg)"><h3>تسجيل دفعة</h3>
      <div class="row">
        <label class="f" for="pAmt" style="width:130px">المبلغ<input type="number" id="pAmt" min="0" step="0.01" value="${st.next ? Math.max(0, Math.min(st.remaining, st.overdue || st.next.amount)) : st.remaining || ""}"></label>
        <label class="f" for="pM" style="width:170px">الطريقة<select id="pM">${METHODS.map(m => `<option ${acc.plan === "qasima" && m === "قسيمة بلس" ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="f" for="pD" style="width:160px">التاريخ<input type="date" id="pD" value="${today()}" max="${today()}"></label>
        <label class="f grow" for="pRef">رقم العملية / المرجع<input type="text" id="pRef"></label>
      </div>
      <div class="row" style="margin-top:8px"><label class="f grow" for="pN">ملاحظة<input type="text" id="pN"></label><label class="f grow" for="pImg">صورة الإيصال (اختياري)<input type="file" id="pImg" accept="image/*"></label></div>
      <div class="row" style="margin-top:8px"><button class="btn gold" id="pAdd" ${(S.finAcc || {})[num] ? "" : "disabled"}>تسجيل الدفعة وطباعة السند</button>${(S.finAcc || {})[num] ? "" : `<span class="muted">احفظ الحساب أول</span>`}</div>
    </div>
    <div><h3>الدفعات (${pays.length})</h3><div class="list">${pays.map(p => `<div class="item" style="${p.void ? "opacity:.55" : ""}"><div class="grow"><div class="t">${SAR(p.amount)} · ${esc(p.method)}</div><div class="muted">سند ${esc(p.receiptNo)} · ${dH(p.date)}${p.ref ? " · " + esc(p.ref) : ""}${p.void ? " · ملغى: " + esc(p.voidReason || "") : ""}</div></div>
      ${rcptBtns("payments", p)}<button class="btn sm" data-prc="${esc(p.id)}">السند</button>${p.void ? "" : `<button class="btn sm danger" data-pv="${esc(p.id)}">إلغاء</button>`}</div>`).join("") || `<span class="muted">ما فيه دفعات</span>`}</div></div>
    <div class="row"><button class="btn sm" id="fStmt">كشف حساب PDF</button>${acc.phone ? `<a class="btn sm gold" target="_blank" rel="noopener" href="https://wa.me/${normPhone(acc.phone)}?text=${encodeURIComponent(finReminder(s, st))}">تذكير واتساب</a>` : ""}</div>`;
    $("#fx").onclick = () => { S._finModal = null; closeModal(); };
    const readForm = () => { acc.program = $("#fP").value; acc.fee = Number($("#fFee").value) || 0; acc.discount = Number($("#fDis").value) || 0; acc.discountNote = $("#fDisN").value.trim(); acc.plan = $("#fPl").value; acc.start = $("#fSt").value; acc.months = Number($("#fMo").value) || 4; acc.second = $("#fSec").value; acc.phone = $("#fPh").value.trim(); acc.partner = $("#fPar").value;
      document.querySelectorAll("[data-idue]").forEach(x => { const k = Number(x.dataset.idue); if (acc.installments[k]) acc.installments[k].due = x.value; });
      document.querySelectorAll("[data-iamt]").forEach(x => { const k = Number(x.dataset.iamt); if (acc.installments[k]) acc.installments[k].amount = Number(x.value) || 0; }); };
    $("#xT").onchange = () => { const o = $("#xT").selectedOptions[0]; $("#xL").style.display = $("#xT").value === "_o" ? "" : "none"; if (o && o.dataset.fee) $("#xA").value = o.dataset.fee; };
    const saveExtras = async (list, msg) => { try { await setDoc(ref("finAccounts/" + num), {extras: list}, {merge: true}); acc.extras = list; S.finAcc[num] = {...S.finAcc[num], extras: list}; logAction(msg, s.name); toast("انحفظ"); draw(); } catch (e) { handleWriteErr(e); } };
    $("#xAdd").onclick = () => { const label = $("#xT").value === "_o" ? $("#xL").value.trim() : $("#xT").value, amount = Number($("#xA").value) || 0; if (!label || amount <= 0) return toast("اختر النوع واكتب المبلغ"); saveExtras([...(acc.extras || []), {label, amount, date: $("#xD").value || today()}], `رسوم إضافية: ${label} ${amount}`); };
    $("#modalBox").querySelectorAll("[data-xdel]").forEach(b => b.onclick = () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "متأكد؟"; return; } const l = [...(acc.extras || [])]; const [x] = l.splice(Number(b.dataset.xdel), 1); saveExtras(l, `حذف رسوم إضافية: ${x.label}`); });
    $("#fP").onchange = () => { readForm(); const p = progs.find(x => x.id === acc.program); if (p) acc.fee = Number(p.fee) || 0; draw(); };
    $("#fPl").onchange = () => { readForm(); acc.installments = buildPlan(Math.max(0, acc.fee - acc.discount), acc.plan, acc.start, acc.months, acc.second); draw(); };
    $("#fGen").onclick = () => { readForm(); acc.installments = buildPlan(Math.max(0, acc.fee - acc.discount), acc.plan, acc.start, acc.months, acc.second); draw(); };
    $("#fSave").onclick = async () => {
      readForm();
      const net = Math.max(0, acc.fee - acc.discount), sumI = Math.round(acc.installments.reduce((a, i) => a + i.amount, 0) * 100) / 100;
      if (!acc.fee) return toast("حدد الرسوم");
      if (!acc.installments.length) acc.installments = buildPlan(net, acc.plan, acc.start, acc.months, acc.second);
      else if (Math.abs(sumI - net) > 0.01) return toast(`مجموع الدفعات ${SAR(sumI)} لازم يساوي الصافي ${SAR(net)}`);
      acc.num = num; acc.name = s.name; acc.updatedAt = new Date().toISOString();
      try { await setDoc(ref("finAccounts/" + num), acc); S.finAcc[num] = clone(acc); logAction("حفظ حساب مالي", `${s.name} · ${PLANS[acc.plan]} · ${SAR(net)}`); toast("انحفظ الحساب"); draw(); }
      catch (e) { handleWriteErr(e); }
    };
    $("#pAdd").onclick = async () => {
      const amount = Math.round((Number($("#pAmt").value) || 0) * 100) / 100;
      if (amount <= 0) return toast("اكتب المبلغ");
      if (amount > st.remaining + 0.01) return toast(`المبلغ أكبر من المتبقي (${SAR(st.remaining)})`);
      const w = openPrint(); if (!w) return;
      let img = null; try { img = await pickedImg("#pImg"); } catch { w.close(); return toast("صورة الإيصال كبيرة، صوّرها بدقة أقل"); }
      const pay = {num, name: s.name, amount, method: $("#pM").value, date: $("#pD").value || today(), ref: $("#pRef").value.trim(), note: $("#pN").value.trim(), program: acc.program, by: S.adminRole, void: false};
      try {
        const id = "p-" + uid() + uid();
        await runTransaction(db, async tx => {
          const c = await tx.get(ref("fin/counter")); const n = ((c.exists() && c.data().last) || 0) + 1;
          pay.receiptNo = `${today().slice(0, 4)}-${String(n).padStart(5, "0")}`;
          tx.set(ref("fin/counter"), {last: n}); tx.set(ref("payments/" + id), {...pay, ...(img ? {hasImg: true} : {}), at: serverTimestamp()});
          if (img) tx.set(ref("receipts/" + id), {img, coll: "payments", at: new Date().toISOString(), by: S.adminRole});
        });
        logAction("تسجيل دفعة", `${s.name} · ${SAR(amount)} · سند ${pay.receiptNo}`);
        const after = Math.max(0, Math.round((st.remaining - amount) * 100) / 100);
        fillPrintFin(w, `سند قبض ${pay.receiptNo}`, [{html: receiptHTML({...pay, id}, acc, [...paysOf(num).filter(x => x.id !== id), {...pay, id}])}]);
        toast("انسجلت الدفعة"); if ($("#pImg")) $("#pImg").value = ""; draw();
      } catch (e) { w.close(); handleWriteErr(e); }
    };
    bindRcpt($("#modalBox"));
    $("#modalBox").querySelectorAll("[data-payinst]").forEach(b => b.onclick = () => {
      $("#pAmt").value = b.dataset.payinst; $("#pN").value = b.dataset.instlbl;
      $("#pAmt").closest(".card").scrollIntoView({behavior: "smooth", block: "center"});
      $("#pImg").focus(); toast("المبلغ جاهز، أرفق صورة الإيصال واضغط تسجيل الدفعة");
    });
    $("#modalBox").querySelectorAll("[data-prc]").forEach(b => b.onclick = () => { const p = pays.find(x => x.id === b.dataset.prc); const w = openPrint(); fillPrintFin(w, `سند قبض ${p.receiptNo}`, [{html: receiptHTML(p, acc, paysOf(num))}]); });
    $("#modalBox").querySelectorAll("[data-pv]").forEach(b => b.onclick = async () => {
      const reason = b.dataset.sure ? ($("#pvR") || {}).value : "";
      if (!b.dataset.sure) { b.dataset.sure = 1; b.insertAdjacentHTML("beforebegin", `<input type="text" id="pvR" placeholder="سبب الإلغاء" style="width:160px">`); b.textContent = "تأكيد الإلغاء"; return; }
      if (!reason || !reason.trim()) return toast("اكتب سبب الإلغاء");
      try { await setDoc(ref("payments/" + b.dataset.pv), {void: true, voidReason: reason.trim(), voidBy: S.adminRole, voidAt: new Date().toISOString()}, {merge: true}); logAction("إلغاء دفعة", `${s.name} · ${reason.trim()}`); toast("انلغت الدفعة"); }
      catch (e) { handleWriteErr(e); }
    });
    $("#fStmt").onclick = () => { const w = openPrint(); fillPrintFin(w, `كشف حساب ${s.name}`, [{html: statementHTML(s, acc, accStatus(acc, paysOf(num)), paysOf(num))}]); };
  };
  $("#modal").classList.add("on");
  draw();
  S._finDraw = draw;
}
function finReminder(s, st){
  return `السلام عليكم ${s.name}\nالرقم الأكاديمي: ${s.num}\n\nنذكّركم بسداد المستحقات الدراسية.\nالمتأخر: ${SAR(st.overdue)}\nالمتبقي الكلي: ${SAR(st.remaining)}${st.next ? `\nالدفعة القادمة: ${SAR(st.next.amount)} بتاريخ ${st.next.due}` : ""}\n\nالمالية\n${INST_AR}`;
}
/* the receipt shows the account as it stood right after this payment: total, paid so far, remaining */
function receiptHTML(p, acc, allPays){
  const key = x => `${x.date || ""}|${x.receiptNo || ""}`;
  const net = accStatus(acc, []).net;
  const paidSoFar = Math.round((allPays || []).filter(x => !x.void && x.id !== p.id && key(x) <= key(p)).reduce((a, x) => a + Number(x.amount || 0), 0) * 100) / 100 + (p.void ? 0 : Number(p.amount || 0));
  const after = Math.max(0, Math.round((net - paidSoFar) * 100) / 100);
  const prog = ((S.finSet && S.finSet.programs) || []).find(x => x.id === (p.program || acc.program));
  return `<h1>سند قبض</h1>
  <div class="info"><div><b>رقم السند:</b> ${esc(p.receiptNo || "—")}</div><div><b>التاريخ:</b> ${esc(bothDates(p.date))}</div></div>
  ${p.void ? `<p style="color:#B3261E;font-weight:700;font-size:16px;text-align:center">سند ملغى · ${esc(p.voidReason || "")}</p>` : ""}
  <table><tbody>
    <tr><td class="n" style="width:30%"><b>استلمنا من</b></td><td class="n">${esc(p.name)} · الرقم الأكاديمي ${esc(p.num)}</td></tr>
    <tr><td class="n"><b>مبلغ وقدره</b></td><td class="n" style="font-size:16px"><b>${SAR(p.amount)}</b></td></tr>
    <tr><td class="n"><b>طريقة الدفع</b></td><td class="n">${esc(p.method)}${p.ref ? " · مرجع: " + esc(p.ref) : ""}</td></tr>
    <tr><td class="n"><b>وذلك عن</b></td><td class="n">رسوم ${esc(prog ? prog.name : "البرنامج التدريبي")}${p.note ? " · " + esc(p.note) : ""}</td></tr>
    <tr><td class="n"><b>المبلغ الإجمالي</b></td><td class="n">${SAR(net)}${acc.discount ? ` <span style="color:#666;font-size:11px">(بعد خصم ${SAR(acc.discount)})</span>` : ""}</td></tr>
    <tr><td class="n"><b>المبلغ المسدَّد</b></td><td class="n">${SAR(paidSoFar)} <span style="color:#666;font-size:11px">(شامل هذه الدفعة)</span></td></tr>
    <tr><td class="n"><b>المبلغ المتبقي</b></td><td class="n"><b>${SAR(after)}</b></td></tr>
  </tbody></table>
  <p style="font-size:10.5px;color:#666;margin-top:10px">سند قبض داخلي، وليس فاتورة ضريبية.</p>
  <div class="sig"><div>المحاسب</div><div>الختم</div></div>`;
}
function statementHTML(s, acc, st, pays){
  return `<h1>كشف حساب متدرب</h1>
  <div class="info"><div><b>الاسم:</b> ${esc(s.name)}</div><div><b>الرقم الأكاديمي:</b> ${esc(s.num)}</div><div><b>طريقة السداد:</b> ${PLANS[acc.plan] || ""}</div><div><b>الرسوم:</b> ${SAR(acc.fee)}${acc.discount ? ` · خصم ${SAR(acc.discount)}${acc.discountNote ? " (" + esc(acc.discountNote) + ")" : ""}` : ""}</div></div>
  <table><thead><tr><th>الصافي</th><th>المدفوع</th><th>المتبقي</th><th>المتأخر</th></tr></thead><tbody><tr><td>${SAR(st.net)}</td><td>${SAR(st.paid)}</td><td>${SAR(st.remaining)}</td><td>${SAR(st.overdue)}</td></tr></tbody></table>
  <h3 style="color:#1F5136">جدول الدفعات</h3><table><thead><tr><th>#</th><th>الاستحقاق</th><th>المبلغ</th><th>الحالة</th></tr></thead><tbody>${st.sched.map((i, k) => `<tr><td>${i.label ? esc(i.label) : k + 1}</td><td>${dH(i.due)}</td><td>${SAR(i.amount)}</td><td>${INST_ST[i.st]}</td></tr>`).join("")}</tbody></table>
  <h3 style="color:#1F5136">الدفعات المستلمة</h3><table><thead><tr><th>السند</th><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th></tr></thead><tbody>${pays.filter(p => !p.void).map(p => `<tr><td>${esc(p.receiptNo)}</td><td>${dH(p.date)}</td><td>${SAR(p.amount)}</td><td>${esc(p.method)}</td></tr>`).join("") || `<tr><td colspan="4">ما فيه دفعات</td></tr>`}</tbody></table>
  <div class="sig"><div>المالية</div><div>الختم</div></div>`;
}
function finPayments(el){
  const m = S.payM || today().slice(0, 7);
  const list = (S.pays || []).filter(p => (p.date || "").startsWith(m)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.receiptNo || "").localeCompare(a.receiptNo || ""));
  const tot = list.filter(p => !p.void).reduce((a, p) => a + Number(p.amount), 0);
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">الدفعات</h2><div class="row"><input type="month" id="payM" value="${esc(m)}" style="width:170px"><button class="btn sm" id="payX">تنزيل Excel</button></div></div>
    <p class="muted" style="margin:8px 0 0">${list.filter(p => !p.void).length} دفعة · المجموع <b>${SAR(tot)}</b></p></div>
  <div class="tbl"><table><thead><tr><th>السند</th><th>التاريخ</th><th class="nm">الطالب</th><th>المبلغ</th><th>الطريقة</th><th>المرجع</th><th></th></tr></thead><tbody>
  ${list.map(p => `<tr style="${p.void ? "opacity:.5;text-decoration:line-through" : ""}"><td>${esc(p.receiptNo)}</td><td>${dH(p.date)}</td><td class="nm">${esc(p.name)}</td><td>${SAR(p.amount)}</td><td>${esc(p.method)}</td><td>${esc(p.ref || "")}</td><td>${p.hasImg ? `<button class="btn sm" data-rview="payments:${esc(p.id)}">الإيصال</button> ` : ""}<button class="btn sm" data-fo="${esc(p.num)}">الحساب</button></td></tr>`).join("") || `<tr><td colspan="7" class="empty">ما فيه دفعات في هذا الشهر</td></tr>`}</tbody></table></div>`;
  $("#payM").onchange = e => { S.payM = e.target.value; render(); };
  bindRcpt(el);
  el.querySelectorAll("[data-fo]").forEach(b => b.onclick = () => openFinAccount(b.dataset.fo));
  $("#payX").onclick = () => excelDownload(`الدفعات ${m}`, [{title: "الدفعات", rows: [[INST_AR], [`الدفعات · ${m}`], [], ["السند", "التاريخ", "الطالب", "الرقم", "المبلغ", "الطريقة", "المرجع", "الحالة"], ...list.map(p => [p.receiptNo, p.date, p.name, p.num, Number(p.amount), p.method, p.ref || "", p.void ? "ملغى" : "مستلم"]), [], ["", "", "المجموع", "", tot]], widths: [13, 12, 28, 11, 11, 14, 16, 9]}]);
}
function finLate(el){
  const rows = finRows().filter(r => r.st.status === "late").sort((a, b) => b.st.overdue - a.st.overdue);
  el.innerHTML = `<div class="card"><h2>المتأخرين عن السداد (${rows.length})</h2><p class="muted" style="margin:0">المجموع المتأخر: <b>${SAR(rows.reduce((a, r) => a + r.st.overdue, 0))}</b></p></div>
  <div class="list">${rows.map(r => `<div class="item"><div class="grow"><div class="t">${esc(r.s.name)} <span class="muted">${esc(r.s.num)}</span></div><div class="muted">متأخر ${SAR(r.st.overdue)} · متبقي ${SAR(r.st.remaining)}</div></div>
    ${r.acc.phone ? `<a class="btn sm gold" target="_blank" rel="noopener" href="https://wa.me/${normPhone(r.acc.phone)}?text=${encodeURIComponent(finReminder(r.s, r.st))}">تذكير واتساب</a>` : `<span class="pill">بدون جوال</span>`}
    <button class="btn sm" data-fo="${esc(r.s.num)}">الحساب</button></div>`).join("") || `<div class="card empty">ما فيه متأخرين.</div>`}</div>`;
  el.querySelectorAll("[data-fo]").forEach(b => b.onclick = () => openFinAccount(b.dataset.fo));
}
function finSettings(el){
  const progs = S.finSet.programs || [];
  el.innerHTML = `<div class="card"><h2>البرامج والرسوم</h2>
    <div class="list">${progs.map((p, i) => `<div class="item"><span class="grow"><b>${esc(p.name)}</b></span><input type="number" data-pfee="${i}" value="${p.fee}" style="width:130px"><span class="muted">ر.س</span><button class="btn sm danger" data-pdel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه برامج</span>`}</div>
    <div class="row" style="margin-top:10px"><input type="text" id="prN" class="grow" placeholder="اسم البرنامج، مثل: دبلوم القانون"><input type="number" id="prF" min="0" placeholder="الرسوم" style="width:130px"><button class="btn gold sm" id="prAdd">+ إضافة</button><button class="btn pri sm" id="prSave">حفظ الرسوم</button></div>
    <p class="muted">تغيير رسوم البرنامج ما يغيّر حسابات الطلاب المفتوحة من قبل.</p></div>
  <div class="card"><h2>أنواع الرسوم الإضافية</h2>
    <div class="list">${(S.finSet.extraTypes || []).map((t, i) => `<div class="item"><span class="grow"><b>${esc(t.name)}</b></span><span>${SAR(t.fee)}</span><button class="btn sm danger" data-etdel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه أنواع. مثل: الشهادة، الحقيبة التدريبية، إعادة اختبار.</span>`}</div>
    <div class="row" style="margin-top:10px"><input type="text" id="etN" class="grow" placeholder="مثل: إعادة اختبار"><input type="number" id="etF" min="0" placeholder="المبلغ" style="width:130px"><button class="btn gold sm" id="etAdd">+ إضافة</button></div></div>
  <div class="card"><h2>الشركاء</h2>
    <p class="muted" style="margin-top:0">إعلاميين أو مدربين أو جهات يجيبون طلاب. اختر الشريك في حساب الطالب المالي، وتنحسب عمولته تلقائي.</p>
    <div class="list">${(S.finSet.partners || []).map((p, i) => `<div class="item"><div class="grow"><b>${esc(p.name)}</b> <span class="pill">${esc(p.type)}</span><div class="muted">${p.kind === "percent" ? `${p.value}% من المبلغ المحصّل من الطالب` : `${SAR(p.value)} عن كل طالب بعد أول دفعة`}${p.phone ? ` · <span dir="ltr">${esc(p.phone)}</span>` : ""}</div></div><button class="btn sm danger" data-ptdel="${i}">حذف</button></div>`).join("") || `<span class="muted">ما فيه شركاء</span>`}</div>
    <div class="row" style="margin-top:10px"><input type="text" id="ptN" class="grow" placeholder="اسم الشريك"><select id="ptT" style="width:auto"><option>إعلامي</option><option>مدرب</option><option>جهة</option><option>أخرى</option></select><input type="tel" id="ptP" dir="ltr" placeholder="الجوال" style="width:140px"></div>
    <div class="row" style="margin-top:8px"><select id="ptK" style="width:auto"><option value="fixed">مبلغ ثابت عن كل طالب</option><option value="percent">نسبة من المحصّل</option></select><input type="number" id="ptV" min="0" placeholder="المبلغ أو النسبة" style="width:150px"><button class="btn gold sm" id="ptAdd">+ إضافة شريك</button></div></div>`;
  const saveKey = async (k, list, msg) => { try { await setDoc(ref("fin/settings"), {[k]: list}, {merge: true}); S.finSet[k] = list; logAction(msg, ""); toast("انحفظ"); render(); } catch (e) { handleWriteErr(e); } };
  $("#etAdd").onclick = () => { const name = $("#etN").value.trim(), fee = Number($("#etF").value); if (!name || !(fee > 0)) return toast("اكتب الاسم والمبلغ"); saveKey("extraTypes", [...(S.finSet.extraTypes || []), {name, fee}], "إضافة نوع رسوم: " + name); };
  el.querySelectorAll("[data-etdel]").forEach(b => b.onclick = () => { const l = clone(S.finSet.extraTypes || []); l.splice(Number(b.dataset.etdel), 1); saveKey("extraTypes", l, "حذف نوع رسوم"); });
  $("#ptAdd").onclick = () => { const name = $("#ptN").value.trim(), value = Number($("#ptV").value), kind = $("#ptK").value; if (!name || !(value > 0) || (kind === "percent" && value > 100)) return toast("اكتب الاسم والعمولة"); saveKey("partners", [...(S.finSet.partners || []), {id: "pa-" + uid(), name, type: $("#ptT").value, phone: $("#ptP").value.trim(), kind, value}], "إضافة شريك: " + name); };
  el.querySelectorAll("[data-ptdel]").forEach(b => b.onclick = () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "متأكد؟"; return; } const l = clone(S.finSet.partners || []); l.splice(Number(b.dataset.ptdel), 1); saveKey("partners", l, "حذف شريك"); });
  const save = async list => { try { await setDoc(ref("fin/settings"), {programs: list}, {merge: true}); S.finSet.programs = list; logAction("البرامج والرسوم", list.map(p => `${p.name}: ${p.fee}`).join("، ")); toast("انحفظ"); render(); } catch (e) { handleWriteErr(e); } };
  $("#prAdd").onclick = () => { const name = $("#prN").value.trim(), fee = Number($("#prF").value); if (!name || !(fee >= 0)) return toast("اكتب الاسم والرسوم"); save([...progs, {id: "pr-" + uid(), name, fee}]); };
  $("#prSave").onclick = () => { const list = clone(progs); el.querySelectorAll("[data-pfee]").forEach(x => list[Number(x.dataset.pfee)].fee = Number(x.value) || 0); save(list); };
  el.querySelectorAll("[data-pdel]").forEach(b => b.onclick = () => { const l = clone(progs); l.splice(Number(b.dataset.pdel), 1); save(l); });
}


/* ---- receipt images (compressed into Firestore, kept apart from the payment record) ---- */
const rcptBtns = (coll, x) => x.hasImg ? `<button class="btn sm" data-rview="${coll}:${esc(x.id)}">الإيصال</button>` : x.void ? "" : `<label class="btn sm" style="cursor:pointer">إرفاق إيصال<input type="file" accept="image/*" data-ratt="${coll}:${esc(x.id)}" hidden></label>`;
function bindRcpt(root){
  root.querySelectorAll("[data-rview]").forEach(b => b.onclick = () => {
    const [, id] = b.dataset.rview.split(":");
    const w = window.open("", "_blank"); if (!w) return toast("المتصفح منع فتح النافذة. اسمح بالنوافذ المنبثقة");
    w.document.write("<p style='font-family:sans-serif'>جاري التحميل…</p>");
    getDoc(ref("receipts/" + id)).then(x => {
      const img = x.exists() && x.data().img;
      w.document.open();
      w.document.write(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>الإيصال</title></head><body style="margin:0;background:#222;display:grid;place-items:center;min-height:100vh">${img && /^data:image\//.test(img) ? `<img src="${img}" style="max-width:100%;max-height:100vh">` : `<p style="color:#fff;font-family:sans-serif">ما فيه إيصال</p>`}</body></html>`);
      w.document.close();
    }).catch(() => { w.close(); toast("تعذّر فتح الإيصال"); });
  });
  root.querySelectorAll("[data-ratt]").forEach(inp => inp.onchange = async () => {
    const [coll, id] = inp.dataset.ratt.split(":"), f = inp.files[0]; if (!f) return;
    try { toast("جاري ضغط الصورة ورفعها…"); await saveRcpt(coll, id, await compressImage(f)); logAction("إرفاق إيصال", coll === "payments" ? "دفعة" : "مصروف"); toast("انرفق الإيصال"); inp.value = ""; if (S._finModal && S._finDraw) S._finDraw(); else render(); }
    catch (e) { inp.value = ""; e && e.message === "too-big" ? toast("الصورة كبيرة، صوّرها بدقة أقل") : handleWriteErr(e); }
  });
}
async function saveRcpt(coll, id, img){
  const b = writeBatch(db);
  b.set(ref("receipts/" + id), {img, coll, at: new Date().toISOString(), by: S.adminRole});
  b.set(ref(`${coll}/${id}`), {hasImg: true}, {merge: true});
  await b.commit();
}
const pickedImg = async sel => { const f = $(sel) && $(sel).files[0]; return f ? compressImage(f) : null; };


/* ---- receipts register: every attached receipt in one place, with its reference, printable ---- */
function finReceipts(el){
  const f = S.rcF || {who: "", m: "", kind: "all"};
  const studs = [...new Map((S.pays || []).filter(p => p.hasImg).map(p => [p.num, p.name])).entries()].sort((a, b) => a[1].localeCompare(b[1], "ar"));
  const pays = (S.pays || []).filter(p => p.hasImg && (f.kind !== "exp") && (!f.who || p.num === f.who) && (!f.m || (p.date || "").startsWith(f.m)))
    .map(p => ({coll: "payments", id: p.id, date: p.date, title: `${p.name} · ${p.num}`, sub: `سند ${p.receiptNo} · ${p.method}`, amount: p.amount, ref: p.ref || "", voided: p.void, x: p}));
  const exps = f.who ? [] : (S.exps || []).filter(x => x.hasImg && f.kind !== "pay" && (!f.m || (x.date || "").startsWith(f.m)))
    .map(x => ({coll: "expenses", id: x.id, date: x.date, title: `مصروف: ${x.category}`, sub: `${x.desc || ""}${x.method ? " · " + x.method : ""}`, amount: x.amount, ref: x.ref || "", voided: x.void, x}));
  const list = [...pays, ...exps].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  el.innerHTML = `<div class="card"><h2>الإيصالات</h2>
    <p class="muted" style="margin-top:0">كل الإيصالات المرفقة في مكان واحد. اختر طالب أو اترك «كل الطلاب»، وتقدر تطبعها كلها مرة وحدة.</p>
    <div class="row">
      <select id="rcW" class="grow"><option value="">كل الطلاب</option>${studs.map(([n, nm]) => `<option value="${esc(n)}" ${f.who === n ? "selected" : ""}>${esc(nm)} · ${esc(n)}</option>`).join("")}</select>
      <input type="month" id="rcM" value="${esc(f.m)}" style="width:170px" aria-label="الشهر">
      <select id="rcK" style="width:auto"><option value="all" ${f.kind === "all" ? "selected" : ""}>الدفعات والمصروفات</option><option value="pay" ${f.kind === "pay" ? "selected" : ""}>دفعات الطلاب</option><option value="exp" ${f.kind === "exp" ? "selected" : ""}>المصروفات</option></select>
      ${f.m ? `<button class="btn sm" id="rcAllM">كل الشهور</button>` : ""}
    </div>
    <div class="row" style="margin-top:10px"><b class="grow">${list.length} إيصال · ${SAR(list.filter(x => !x.voided).reduce((a, x) => a + Number(x.amount), 0))}</b>${list.length ? `<button class="btn pri sm" id="rcPrint">طباعة ${list.length === 1 ? "الإيصال" : "الإيصالات (" + list.length + ")"}</button>` : ""}</div></div>
  <div class="list">${list.map(r => `<div class="item" style="${r.voided ? "opacity:.55" : ""}"><div class="grow"><div class="t">${esc(r.title)}${r.voided ? ` <span class="pill a">ملغى</span>` : ""}</div><div class="muted">${dH(r.date)} · ${SAR(r.amount)} · ${esc(r.sub)}</div></div>
      <label class="muted" for="rf-${esc(r.id)}">المرجع</label><input type="text" id="rf-${esc(r.id)}" data-rref="${r.coll}:${esc(r.id)}" value="${esc(r.ref)}" placeholder="رقم العملية" style="width:170px">
      <button class="btn sm" data-rview="${r.coll}:${esc(r.id)}">عرض</button><button class="btn sm" data-rprint="${r.coll}:${esc(r.id)}">طباعة</button></div>`).join("") || `<div class="card empty">ما فيه إيصالات مرفقة${f.who || f.m ? " بهذا الاختيار" : ""}.</div>`}</div>`;
  const setF = d => { S.rcF = {...f, ...d}; render(); };
  $("#rcW").onchange = e => setF({who: e.target.value, kind: e.target.value ? "pay" : f.kind});
  $("#rcM").onchange = e => setF({m: e.target.value});
  $("#rcK").onchange = e => setF({kind: e.target.value});
  if ($("#rcAllM")) $("#rcAllM").onclick = () => setF({m: ""});
  bindRcpt(el);
  el.querySelectorAll("[data-rref]").forEach(inp => inp.onchange = async () => {
    const [coll, id] = inp.dataset.rref.split(":"), v = inp.value.trim().slice(0, 80);
    try { await setDoc(ref(`${coll}/${id}`), {ref: v}, {merge: true}); logAction("مرجع إيصال", v); toast("انحفظ المرجع"); } catch (e) { handleWriteErr(e); }
  });
  const printList = async (items, title) => {
    const w = openPrint(); if (!w) return;
    try {
      const imgs = await Promise.all(items.map(r => getDoc(ref("receipts/" + r.id)).then(x => x.exists() ? x.data().img : null).catch(() => null)));
      const pages = items.map((r, i) => ({html: `<h1>${r.coll === "payments" ? "إيصال دفعة" : "إيصال مصروف"}</h1>
        <table><tbody>
          <tr><td class="n" style="width:28%"><b>${r.coll === "payments" ? "الطالب" : "البند"}</b></td><td class="n">${esc(r.title)}</td></tr>
          <tr><td class="n"><b>التاريخ</b></td><td class="n">${esc(bothDates(r.date))}</td></tr>
          <tr><td class="n"><b>المبلغ</b></td><td class="n"><b>${SAR(r.amount)}</b></td></tr>
          <tr><td class="n"><b>التفاصيل</b></td><td class="n">${esc(r.sub)}</td></tr>
          <tr><td class="n"><b>المرجع</b></td><td class="n">${esc(r.ref || "—")}</td></tr>
          ${r.voided ? `<tr><td class="n"><b>الحالة</b></td><td class="n" style="color:#B3261E"><b>ملغى</b></td></tr>` : ""}
        </tbody></table>
        <div style="text-align:center;margin-top:12px">${imgs[i] && /^data:image\//.test(imgs[i]) ? `<img src="${imgs[i]}" style="max-width:100%;max-height:165mm;border:1px solid #ddd;border-radius:6px">` : `<p>الصورة غير موجودة</p>`}</div>`}));
      fillPrintFin(w, title, pages);
    } catch (e) { w.close(); handleWriteErr(e); }
  };
  if ($("#rcPrint")) $("#rcPrint").onclick = () => printList(list, f.who ? `إيصالات ${(studs.find(x => x[0] === f.who) || [, ""])[1]}` : `الإيصالات${f.m ? " · " + f.m : ""}`);
  el.querySelectorAll("[data-rprint]").forEach(b => b.onclick = () => { const id = b.dataset.rprint.split(":")[1]; const r = list.find(x => x.id === id); printList([r], `إيصال · ${r.title}`); });
}

/* ---- expenses, partners, monthly report ---- */
const EXP_CATS = ["إيجار", "كهرباء وماء وإنترنت", "تسويق وإعلان", "مستلزمات وقرطاسية", "صيانة", "رسوم حكومية", "رواتب إدارية", "أخرى"];
const sumAmt = l => Math.round(l.reduce((a, x) => a + (Number(x.amount != null ? x.amount : x.net) || 0), 0) * 100) / 100;
function monthFlow(m){
  const inc = (S.pays || []).filter(p => !p.void && (p.date || "").startsWith(m));
  const exp = (S.exps || []).filter(x => !x.void && (x.date || "").startsWith(m));
  const sal = Object.values(S.salPays || {}).filter(x => (x.paidDate || "").startsWith(m));
  const com = (S.commPays || []).filter(x => !x.void && (x.date || "").startsWith(m));
  const income = sumAmt(inc), expT = sumAmt(exp), salT = sumAmt(sal), comT = sumAmt(com), out = Math.round((expT + salT + comT) * 100) / 100;
  return {inc, exp, sal, com, income, expT, salT, comT, out, net: Math.round((income - out) * 100) / 100};
}
function finExpenses(el){
  const m = S.expM || today().slice(0, 7);
  const list = (S.exps || []).filter(x => (x.date || "").startsWith(m)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const byCat = {}; list.filter(x => !x.void).forEach(x => byCat[x.category] = (byCat[x.category] || 0) + Number(x.amount));
  el.innerHTML = `<div class="card"><h2>تسجيل مصروف</h2>
    <div class="row"><select id="exC" style="width:auto">${EXP_CATS.map(c => `<option>${c}</option>`).join("")}</select><input type="number" id="exA" min="0" step="0.01" placeholder="المبلغ" style="width:130px"><input type="date" id="exD" value="${today()}" max="${today()}" style="width:160px"><select id="exM2" style="width:auto">${["تحويل بنكي", "نقد", "مدى / شبكة"].map(x => `<option>${x}</option>`).join("")}</select></div>
    <div class="row" style="margin-top:8px"><input type="text" id="exT" class="grow" placeholder="الوصف، مثل: إيجار شهر نوفمبر"><input type="text" id="exRef" placeholder="رقم الفاتورة أو المرجع" style="width:190px"></div>
    <div class="row" style="margin-top:8px"><label class="f grow" for="exImg">صورة الفاتورة أو الإيصال (اختياري)<input type="file" id="exImg" accept="image/*"></label><button class="btn gold" id="exAdd" style="align-self:flex-end">+ تسجيل</button></div></div>
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">مصروفات الشهر</h2><input type="month" id="expM" value="${esc(m)}" style="width:170px"></div>
    <p class="muted">المجموع <b>${SAR(sumAmt(list.filter(x => !x.void)))}</b>${Object.keys(byCat).length ? " · " + Object.entries(byCat).map(([k, v]) => `${esc(k)}: ${SAR(v)}`).join(" · ") : ""}</p>
    <div class="list">${list.map(x => `<div class="item" style="${x.void ? "opacity:.5;text-decoration:line-through" : ""}"><div class="grow"><div class="t">${SAR(x.amount)} · ${esc(x.category)}</div><div class="muted">${dH(x.date)} · ${esc(x.method || "")}${x.desc ? " · " + esc(x.desc) : ""}${x.void ? " · ملغى: " + esc(x.voidReason || "") : ""}</div></div>${rcptBtns("expenses", x)}${x.void ? "" : `<button class="btn sm danger" data-exv="${esc(x.id)}">إلغاء</button>`}</div>`).join("") || `<span class="muted">ما فيه مصروفات في هذا الشهر</span>`}</div></div>`;
  $("#expM").onchange = e => { S.expM = e.target.value; render(); };
  bindRcpt(el);
  $("#exAdd").onclick = async () => {
    const amount = Math.round((Number($("#exA").value) || 0) * 100) / 100; if (amount <= 0) return toast("اكتب المبلغ");
    const d = {category: $("#exC").value, amount, date: $("#exD").value || today(), method: $("#exM2").value, desc: $("#exT").value.trim(), ref: $("#exRef").value.trim(), by: S.adminRole, void: false, at: new Date().toISOString()};
    let img = null; try { img = await pickedImg("#exImg"); } catch { return toast("الصورة كبيرة، صوّرها بدقة أقل"); }
    const id = "e-" + uid() + uid();
    try {
      $("#exAdd").disabled = true;
      await setDoc(ref("expenses/" + id), d);
      if (img) await saveRcpt("expenses", id, img);
      logAction("تسجيل مصروف", `${d.category} · ${SAR(amount)}`); toast("انسجل المصروف"); render();
    } catch (e) { $("#exAdd").disabled = false; handleWriteErr(e); }
  };
  el.querySelectorAll("[data-exv]").forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = 1; b.insertAdjacentHTML("beforebegin", `<input type="text" id="exVR" placeholder="سبب الإلغاء" style="width:150px">`); b.textContent = "تأكيد الإلغاء"; return; }
    const reason = ($("#exVR") || {}).value || ""; if (!reason.trim()) return toast("اكتب سبب الإلغاء");
    try { await setDoc(ref("expenses/" + b.dataset.exv), {void: true, voidReason: reason.trim(), voidBy: S.adminRole, voidAt: new Date().toISOString()}, {merge: true}); logAction("إلغاء مصروف", reason.trim()); } catch (e) { handleWriteErr(e); }
  });
}
function partnerStats(p){
  const rows = Object.values(S.finAcc || {}).filter(a => a.partner === p.id).map(acc => {
    const st = accStatus(acc, paysOf(acc.num));
    const earned = p.kind === "percent" ? Math.round(st.paid * p.value) / 100 : (st.paid > 0 ? Number(p.value) : 0);
    return {acc, st, earned};
  });
  const earned = Math.round(rows.reduce((a, r) => a + r.earned, 0) * 100) / 100;
  const paidOut = sumAmt((S.commPays || []).filter(x => !x.void && x.partnerId === p.id));
  return {rows, earned, paidOut, balance: Math.round((earned - paidOut) * 100) / 100};
}
function finPartners(el){
  const ps = S.finSet.partners || [];
  if (!ps.length) { el.innerHTML = `<div class="card empty">أضف الشركاء من "الإعدادات"، وبعدها اختر الشريك في حساب كل طالب سجّل عن طريقه.</div>`; return; }
  const all = ps.map(p => ({p, ...partnerStats(p)}));
  el.innerHTML = `<div class="card"><h2>الشركاء والعمولات</h2>
    <div class="stats"><div class="stat"><div class="n">${SAR(all.reduce((a, x) => a + x.earned, 0))}</div><div class="l">عمولات مستحقة</div></div><div class="stat"><div class="n">${SAR(all.reduce((a, x) => a + x.paidOut, 0))}</div><div class="l">مصروفة</div></div><div class="stat"><div class="n">${SAR(all.reduce((a, x) => a + x.balance, 0))}</div><div class="l">باقي لهم</div></div></div>
    <p class="muted">النسبة تنحسب من المبلغ اللي دفعه الطالب فعلاً. المبلغ الثابت يستحق بعد أول دفعة من الطالب.</p></div>
  <div class="list">${all.map(x => `<div class="item" style="align-items:flex-start"><div class="grow"><div class="t">${esc(x.p.name)} <span class="pill">${esc(x.p.type)}</span></div>
      <div class="muted">${x.rows.length} طالب · مستحق ${SAR(x.earned)} · مصروف ${SAR(x.paidOut)} · <b>الباقي ${SAR(x.balance)}</b></div>
      ${x.rows.length ? `<details><summary class="muted" style="cursor:pointer">الطلاب</summary><div class="muted">${x.rows.map(r => `${esc(r.acc.name)}: دفع ${SAR(r.st.paid)} ← عمولة ${SAR(r.earned)}`).join("<br>")}</div></details>` : ""}</div>
      <button class="btn sm" data-pst="${esc(x.p.id)}">كشف</button>${x.balance > 0 ? `<button class="btn sm gold" data-ppay="${esc(x.p.id)}">صرف عمولة</button>` : ""}</div>`).join("")}</div>`;
  el.querySelectorAll("[data-pst]").forEach(b => b.onclick = () => { const x = all.find(y => y.p.id === b.dataset.pst); const w = openPrint(); fillPrintFin(w, `كشف عمولات ${x.p.name}`, [{html: partnerHTML(x)}]); });
  el.querySelectorAll("[data-ppay]").forEach(b => b.onclick = () => {
    const x = all.find(y => y.p.id === b.dataset.ppay);
    S._finModal = null; S._modalGroup = null;
    $("#modalBox").innerHTML = `<div class="row" style="justify-content:space-between"><h2 style="margin:0;font-family:var(--display);color:var(--green);font-weight:600">صرف عمولة · ${esc(x.p.name)}</h2><button class="btn sm" id="cx">إغلاق</button></div>
      <p class="muted">الباقي له: ${SAR(x.balance)}</p>
      <div class="row"><label class="f" for="cA" style="width:140px">المبلغ<input type="number" id="cA" value="${x.balance}"></label><label class="f" for="cM" style="width:160px">الطريقة<select id="cM"><option>تحويل بنكي</option><option>نقد</option></select></label><label class="f" for="cD" style="width:160px">التاريخ<input type="date" id="cD" value="${today()}"></label></div>
      <label class="f" for="cN">ملاحظة<input type="text" id="cN"></label><button class="btn gold" id="cGo">تسجيل الصرف وطباعة السند</button>`;
    $("#modal").classList.add("on"); $("#cx").onclick = closeModal;
    $("#cGo").onclick = async () => {
      const amount = Math.round((Number($("#cA").value) || 0) * 100) / 100; if (amount <= 0 || amount > x.balance + 0.01) return toast("المبلغ لازم يكون بين صفر والباقي");
      const w = openPrint(); if (!w) return;
      const d = {partnerId: x.p.id, name: x.p.name, amount, method: $("#cM").value, date: $("#cD").value || today(), note: $("#cN").value.trim(), by: S.adminRole, void: false, at: new Date().toISOString()};
      try { await setDoc(ref("commPays/c-" + uid() + uid()), d); logAction("صرف عمولة", `${x.p.name} · ${SAR(amount)}`); fillPrintFin(w, `سند صرف عمولة ${x.p.name}`, [{html: `<h1>سند صرف عمولة</h1><div class="info"><div><b>الشريك:</b> ${esc(d.name)}</div><div><b>التاريخ:</b> ${esc(bothDates(d.date))}</div><div><b>الطريقة:</b> ${esc(d.method)}</div></div><table><tbody><tr><td class="n"><b>المبلغ</b></td><td style="font-size:16px"><b>${SAR(amount)}</b></td></tr><tr><td class="n"><b>الباقي بعد الصرف</b></td><td>${SAR(x.balance - amount)}</td></tr></tbody></table>${d.note ? `<p>ملاحظة: ${esc(d.note)}</p>` : ""}<div class="sig"><div>المالية</div><div>المستلم<br><small>الاسم والتوقيع</small></div></div>`}]); closeModal(); }
      catch (e) { w.close(); handleWriteErr(e); }
    };
  });
}
function partnerHTML(x){
  const pays = (S.commPays || []).filter(c => !c.void && c.partnerId === x.p.id).sort((a, b) => a.date.localeCompare(b.date));
  return `<h1>كشف عمولات شريك</h1><div class="info"><div><b>الشريك:</b> ${esc(x.p.name)} (${esc(x.p.type)})</div><div><b>العمولة:</b> ${x.p.kind === "percent" ? x.p.value + "% من المحصّل" : SAR(x.p.value) + " عن كل طالب"}</div></div>
  <table><thead><tr><th>الطالب</th><th>المدفوع</th><th>العمولة</th></tr></thead><tbody>${x.rows.map(r => `<tr><td>${esc(r.acc.name)}</td><td>${SAR(r.st.paid)}</td><td>${SAR(r.earned)}</td></tr>`).join("") || `<tr><td colspan="3">ما فيه طلاب</td></tr>`}</tbody></table>
  <h3 style="color:#1F5136">المصروف</h3><table><thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th></tr></thead><tbody>${pays.map(c => `<tr><td>${dH(c.date)}</td><td>${SAR(c.amount)}</td><td>${esc(c.method)}</td></tr>`).join("") || `<tr><td colspan="3">ما انصرف شي</td></tr>`}</tbody></table>
  <table><tbody><tr><td class="n"><b>المستحق</b></td><td>${SAR(x.earned)}</td><td class="n"><b>المصروف</b></td><td>${SAR(x.paidOut)}</td><td class="n"><b>الباقي</b></td><td><b>${SAR(x.balance)}</b></td></tr></tbody></table>`;
}
function finReport(el){
  const m = S.repM2 || today().slice(0, 7), f = monthFlow(m);
  const y = m.slice(0, 4), months = Array.from({length: 12}, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`).map(k => ({k, ...monthFlow(k)}));
  const byCat = {}; f.exp.forEach(x => byCat[x.category] = (byCat[x.category] || 0) + Number(x.amount));
  const html = () => `<h1>التقرير المالي الشهري</h1><div class="info"><div><b>الشهر:</b> ${esc(m)}</div></div>
    <table><tbody>
      <tr><td class="n"><b>الإيرادات (رسوم الطلاب)</b></td><td>${SAR(f.income)}</td></tr>
      ${Object.entries(byCat).map(([k, v]) => `<tr><td class="n">مصروف: ${esc(k)}</td><td>${SAR(v)}</td></tr>`).join("")}
      <tr><td class="n">رواتب المدربين</td><td>${SAR(f.salT)}</td></tr>
      <tr><td class="n">عمولات الشركاء</td><td>${SAR(f.comT)}</td></tr>
      <tr><td class="n"><b>إجمالي المصروفات</b></td><td><b>${SAR(f.out)}</b></td></tr>
      <tr><td class="n"><b>الصافي</b></td><td style="font-size:16px"><b>${SAR(f.net)}</b></td></tr>
    </tbody></table>
    <h3 style="color:#1F5136">سنة ${esc(y)}</h3><table><thead><tr><th>الشهر</th><th>الإيرادات</th><th>المصروفات</th><th>الصافي</th></tr></thead><tbody>${months.map(x => `<tr><td>${x.k}</td><td>${SAR(x.income)}</td><td>${SAR(x.out)}</td><td>${SAR(x.net)}</td></tr>`).join("")}</tbody></table>
    <div class="sig"><div>المالية</div><div>الإدارة</div></div>`;
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">التقرير المالي الشهري</h2><div class="row"><input type="month" id="rpM" value="${esc(m)}" style="width:170px"><button class="btn sm pri" id="rpP">طباعة / PDF</button><button class="btn sm" id="rpX">Excel</button></div></div>
    <div class="stats" style="margin-top:10px"><div class="stat"><div class="n">${SAR(f.income)}</div><div class="l">الإيرادات</div></div><div class="stat"><div class="n">${SAR(f.out)}</div><div class="l">المصروفات</div></div><div class="stat"><div class="n" style="color:${f.net < 0 ? "var(--abs)" : "var(--green)"}">${SAR(f.net)}</div><div class="l">الصافي</div></div></div></div>
  <div class="card"><h2>تفصيل المصروفات</h2><div class="list">${[...Object.entries(byCat), ["رواتب المدربين", f.salT], ["عمولات الشركاء", f.comT]].filter(([, v]) => v).map(([k, v]) => `<div class="item"><span class="grow">${esc(k)}</span><b>${SAR(v)}</b><span class="muted">${f.out ? Math.round(v / f.out * 100) : 0}%</span></div>`).join("") || `<span class="muted">ما فيه مصروفات</span>`}</div></div>
  <div class="card"><h2>سنة ${esc(y)}</h2><div class="tbl"><table><thead><tr><th>الشهر</th><th>الإيرادات</th><th>المصروفات</th><th>الصافي</th></tr></thead><tbody>${months.map(x => `<tr><td>${x.k}</td><td>${SAR(x.income)}</td><td>${SAR(x.out)}</td><td style="color:${x.net < 0 ? "var(--abs)" : "inherit"}">${SAR(x.net)}</td></tr>`).join("")}
    <tr><td><b>المجموع</b></td><td><b>${SAR(months.reduce((a, x) => a + x.income, 0))}</b></td><td><b>${SAR(months.reduce((a, x) => a + x.out, 0))}</b></td><td><b>${SAR(months.reduce((a, x) => a + x.net, 0))}</b></td></tr></tbody></table></div></div>`;
  $("#rpM").onchange = e => { S.repM2 = e.target.value; render(); };
  $("#rpP").onclick = () => { const w = openPrint(); fillPrintFin(w, `التقرير المالي ${m}`, [{html: html()}]); };
  $("#rpX").onclick = () => excelDownload(`التقرير المالي ${m}`, [
    {title: "الشهر", rows: [[INST_AR], [`التقرير المالي · ${m}`], [], ["البند", "المبلغ"], ["الإيرادات", f.income], ...Object.entries(byCat).map(([k, v]) => ["مصروف: " + k, v]), ["رواتب المدربين", f.salT], ["عمولات الشركاء", f.comT], ["إجمالي المصروفات", f.out], ["الصافي", f.net], [], ["تفصيل المصروفات"], ["التاريخ", "البند", "المبلغ", "الوصف"], ...f.exp.map(x => [x.date, x.category, Number(x.amount), x.desc || ""]), ...f.sal.map(x => [x.paidDate, "راتب: " + x.name, Number(x.net), ""]), ...f.com.map(x => [x.date, "عمولة: " + x.name, Number(x.amount), x.note || ""])], widths: [14, 26, 12, 30]},
    {title: "السنة", rows: [[`سنة ${y}`], [], ["الشهر", "الإيرادات", "المصروفات", "الصافي"], ...months.map(x => [x.k, x.income, x.out, x.net])], widths: [12, 14, 14, 14]}]);
}

function finSalaries(el){
  const m = S.salM || today().slice(0, 7), rates = (S.finSet && S.finSet.salaries) || {};
  const ts = Object.values(S.trainers).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  const rec = t => (S.salPays || {})[`${m}_${t.id}`];
  const total = ts.reduce((a, t) => a + (rec(t) ? Number(rec(t).net) : 0), 0), due = ts.reduce((a, t) => a + (rec(t) ? 0 : Number(rates[t.id]) || 0), 0);
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">رواتب المدربين</h2><div class="row"><input type="month" id="salM" value="${esc(m)}" style="width:170px"><button class="btn sm" id="salX">تنزيل Excel</button></div></div>
    <div class="stats" style="margin-top:10px"><div class="stat"><div class="n">${SAR(total)}</div><div class="l">مصروف لشهر ${esc(m)}</div></div><div class="stat"><div class="n">${SAR(due)}</div><div class="l">باقي ما انصرف</div></div><div class="stat"><div class="n">${ts.filter(t => rec(t)).length}/${ts.length}</div><div class="l">مدربين استلموا</div></div></div>
    <p class="muted">الرواتب يشوفها موظف المالية والإدارة بس.</p></div>
  <div class="list">${ts.map(t => { const r = rec(t); return `<div class="item"><div class="grow"><div class="t">${esc(trainerTitle(t))}</div><div class="muted">${r ? `انصرف ${SAR(r.net)} · ${dH(r.paidDate)} · ${esc(r.method)}${r.bonus ? ` · إضافي ${SAR(r.bonus)}` : ""}${r.deduct ? ` · خصم ${SAR(r.deduct)}` : ""}` : "ما انصرف لهذا الشهر"}</div></div>
    <label class="muted" for="sr-${esc(t.id)}">الراتب</label><input type="number" id="sr-${esc(t.id)}" data-rate="${esc(t.id)}" value="${rates[t.id] || ""}" style="width:110px">
    ${r ? `<button class="btn sm" data-svp="${esc(t.id)}">السند</button><button class="btn sm danger" data-sdl="${esc(t.id)}">إلغاء الصرف</button>` : `<button class="btn sm gold" data-spay="${esc(t.id)}">صرف</button>`}</div>`; }).join("")}</div>
  <div class="row"><button class="btn pri sm" id="rateSave">حفظ الرواتب</button></div>`;
  $("#salM").onchange = e => { S.salM = e.target.value; render(); };
  $("#rateSave").onclick = async () => {
    const r = {}; el.querySelectorAll("[data-rate]").forEach(x => { if (x.value !== "") r[x.dataset.rate] = Number(x.value) || 0; });
    try { await setDoc(ref("fin/settings"), {salaries: r}, {merge: true}); S.finSet.salaries = r; logAction("رواتب المدربين", "تعديل الرواتب"); toast("انحفظت الرواتب"); } catch (e) { handleWriteErr(e); }
  };
  el.querySelectorAll("[data-spay]").forEach(b => b.onclick = () => openSalaryPay(b.dataset.spay, m));
  el.querySelectorAll("[data-svp]").forEach(b => b.onclick = () => { const r = rec(S.trainers[b.dataset.svp]); const w = openPrint(); fillPrintFin(w, `سند صرف راتب ${r.name}`, [{html: salaryHTML(r)}]); });
  el.querySelectorAll("[data-sdl]").forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "متأكد؟"; return; }
    try { await deleteDoc(ref(`salaryPays/${m}_${b.dataset.sdl}`)); logAction("إلغاء صرف راتب", `${(S.trainers[b.dataset.sdl] || {}).name} · ${m}`); toast("انلغى الصرف"); } catch (e) { handleWriteErr(e); }
  });
  $("#salX").onclick = () => excelDownload(`رواتب المدربين ${m}`, [{title: "الرواتب", rows: [[INST_AR], [`رواتب المدربين · ${m}`], [], ["المدرب", "الراتب", "إضافي", "خصم", "الصافي", "تاريخ الصرف", "الطريقة", "ملاحظة"], ...ts.map(t => { const r = rec(t); return [t.name, Number(rates[t.id]) || 0, r ? r.bonus || 0 : "", r ? r.deduct || 0 : "", r ? r.net : "", r ? r.paidDate : "لم يُصرف", r ? r.method : "", r ? r.note || "" : ""]; })], widths: [26, 11, 10, 10, 11, 13, 14, 24]}]);
}
function openSalaryPay(tid, m){
  const t = S.trainers[tid], base = Number(((S.finSet && S.finSet.salaries) || {})[tid]) || 0;
  S._modalGroup = null; S._finModal = null;
  $("#modalBox").innerHTML = `<div class="row" style="justify-content:space-between"><h2 style="margin:0;font-family:var(--display);color:var(--green);font-weight:600">صرف راتب · ${esc(trainerTitle(t))}</h2><button class="btn sm" id="sx">إغلاق</button></div>
    <p class="muted" style="margin:0">شهر ${esc(m)}</p>
    <div class="row">
      <label class="f" for="sB" style="width:130px">الراتب<input type="number" id="sB" value="${base}"></label>
      <label class="f" for="sAdd" style="width:120px">إضافي<input type="number" id="sAdd" value="0"></label>
      <label class="f" for="sDed" style="width:120px">خصم<input type="number" id="sDed" value="0"></label>
      <label class="f" for="sMeth" style="width:160px">الطريقة<select id="sMeth">${["تحويل بنكي", "نقد"].map(x => `<option>${x}</option>`).join("")}</select></label>
      <label class="f" for="sD" style="width:160px">تاريخ الصرف<input type="date" id="sD" value="${today()}"></label>
    </div>
    <label class="f" for="sNote">ملاحظة<input type="text" id="sNote" placeholder="مثل: خصم غياب محاضرة"></label>
    <div class="row"><b id="sNet"></b><button class="btn gold" id="sGo">تسجيل الصرف وطباعة السند</button></div>`;
  $("#modal").classList.add("on");
  const net = () => Math.round(((Number($("#sB").value) || 0) + (Number($("#sAdd").value) || 0) - (Number($("#sDed").value) || 0)) * 100) / 100;
  const upd = () => $("#sNet").textContent = "الصافي: " + SAR(net()); upd();
  ["sB", "sAdd", "sDed"].forEach(id => $("#" + id).oninput = upd);
  $("#sx").onclick = closeModal;
  $("#sGo").onclick = async () => {
    if (net() <= 0) return toast("الصافي لازم يكون أكبر من صفر");
    const w = openPrint(); if (!w) return;
    const r = {tid, name: t.name, month: m, base: Number($("#sB").value) || 0, bonus: Number($("#sAdd").value) || 0, deduct: Number($("#sDed").value) || 0, net: net(), method: $("#sMeth").value, paidDate: $("#sD").value || today(), note: $("#sNote").value.trim(), by: S.adminRole, at: new Date().toISOString()};
    try { await setDoc(ref(`salaryPays/${m}_${tid}`), r); logAction("صرف راتب", `${t.name} · ${m} · ${SAR(r.net)}`); fillPrintFin(w, `سند صرف راتب ${t.name}`, [{html: salaryHTML(r)}]); closeModal(); }
    catch (e) { w.close(); handleWriteErr(e); }
  };
}
function salaryHTML(r){
  return `<h1>سند صرف راتب</h1>
  <div class="info"><div><b>المدرب/ة:</b> ${esc(r.name)}</div><div><b>عن شهر:</b> ${esc(r.month)}</div><div><b>تاريخ الصرف:</b> ${esc(bothDates(r.paidDate))}</div><div><b>الطريقة:</b> ${esc(r.method)}</div></div>
  <table><tbody><tr><td class="n"><b>الراتب</b></td><td>${SAR(r.base)}</td></tr><tr><td class="n"><b>إضافي</b></td><td>${SAR(r.bonus)}</td></tr><tr><td class="n"><b>خصم</b></td><td>${SAR(r.deduct)}</td></tr><tr><td class="n"><b>الصافي</b></td><td style="font-size:16px"><b>${SAR(r.net)}</b></td></tr></tbody></table>
  ${r.note ? `<p>ملاحظة: ${esc(r.note)}</p>` : ""}
  <div class="sig"><div>المالية</div><div>المستلم<br><small>الاسم والتوقيع</small></div></div>`;
}
function studentFin(el){
  const acc = S.myFin; if (!acc) { el.innerHTML = `<div class="card empty">ما فيه حساب مالي.</div>`; return; }
  const st = accStatus(acc, S.myPay || []), pays = (S.myPay || []).filter(p => !p.void).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  el.innerHTML = `<div class="card"><h2>المالية</h2><p class="muted" style="margin-top:0">${PLANS[acc.plan] || ""}${acc.discount ? ` · خصم ${SAR(acc.discount)}` : ""}</p>
    <div class="stats"><div class="stat"><div class="n">${SAR(st.net)}</div><div class="l">الرسوم</div></div><div class="stat"><div class="n">${SAR(st.paid)}</div><div class="l">المدفوع</div></div><div class="stat"><div class="n">${SAR(st.remaining)}</div><div class="l">المتبقي</div></div><div class="stat"><div class="n" style="color:${st.overdue ? "var(--abs)" : "inherit"}">${SAR(st.overdue)}</div><div class="l">متأخر</div></div></div>
    ${st.next ? `<div class="notice" style="margin-top:10px">الدفعة القادمة: <b>${SAR(st.next.amount)}</b> بتاريخ ${esc(fmtDate(st.next.due))}</div>` : ""}</div>
  <div class="card"><h2>جدول الدفعات</h2><div class="tbl"><table><thead><tr><th>#</th><th>الاستحقاق</th><th>المبلغ</th><th>الحالة</th></tr></thead><tbody>${st.sched.map((i, k) => `<tr><td>${i.label ? esc(i.label) : k + 1}</td><td>${dH(i.due)}</td><td>${SAR(i.amount)}</td><td><span class="pill ${INST_PILL[i.st]}">${INST_ST[i.st]}</span></td></tr>`).join("")}</tbody></table></div></div>
  <div class="card"><h2>السندات</h2><div class="list">${pays.map(p => `<div class="item"><div class="grow"><div class="t">${SAR(p.amount)}</div><div class="muted">سند ${esc(p.receiptNo)} · ${dH(p.date)} · ${esc(p.method)}</div></div><button class="btn sm" data-myrc="${esc(p.id)}">طباعة</button></div>`).join("") || `<span class="muted">ما فيه دفعات</span>`}</div></div>`;
  el.querySelectorAll("[data-myrc]").forEach(b => b.onclick = () => { const p = pays.find(x => x.id === b.dataset.myrc); const w = openPrint(); fillPrintFin(w, `سند قبض ${p.receiptNo}`, [{html: receiptHTML(p, acc, S.myPay || [])}]); });
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
  if (S._trainerSynced || S.role !== "admin" || RO() || FIN() || !S.loaded.trainers) return;
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
  logAction(S.trainers[tid] ? "رمز جديد لمدرب" : "إضافة مدرب", data.name);
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
      <span class="pill ${(S.trPhones || {})[t.id] ? "p" : ""}" dir="ltr">${esc((S.trPhones || {})[t.id] || "بدون جوال")}</span>
      <button class="btn sm gold" data-twa="${esc(t.id)}">واتساب</button>
      <button class="btn sm" data-copy="${esc(t.id)}">نسخ</button>
      <button class="btn sm" data-new="${esc(t.id)}">رمز جديد</button>
      <button class="btn sm" data-tdis="${esc(t.id)}">${(S.disabled || {})[t.id] ? "تفعيل" : "تعطيل"}</button>
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
  el.querySelectorAll("[data-twa]").forEach(b => b.onclick = () => openWhatsAppTrainer(b.dataset.twa));
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
  el.querySelectorAll("[data-tdis]").forEach(b => b.onclick = () => setDisabled("trainers", b.dataset.tdis, !(S.disabled || {})[b.dataset.tdis], (S.trainers[b.dataset.tdis] || {}).name));
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "متأكد؟"; return; }
    const tid = b.dataset.del, batch = writeBatch(db);
    Object.values(S.groups).filter(g => g.trainerId === tid).forEach(g => batch.update(ref("groups/" + g.id), {trainerId: ""}));
    batch.delete(ref("trainers/" + tid)); batch.delete(ref("secrets/" + tid));
    logAction("حذف مدرب", (S.trainers[tid] || {}).name || tid);
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
  const g = S.groups[S.aReportGroup], docs = countable(S.aReport), th = TH();
  const needFee = !!(S.sys && S.sys.certNeedsFee);
  const feeOf = num => { const f = (S.finClear || {})[num]; return !needFee ? {ok: true} : !f ? {ok: false, why: "ما له حساب مالي"} : f.remaining > 0 ? {ok: false, why: "عليه " + SAR(f.remaining)} : {ok: true}; };
  const cand = (g.students || []).filter(s => s.sid).map(s => { const st = absStats(g, s.id, docs); const pct = Math.round((100 - st.absPct) * 10) / 10; const att = docs.length > 0 && pct >= th.certMin, fee = feeOf(s.sid); return {s, st, pct, att, fee, ok: att && fee.ok, c: (S.certs || {})[`${s.sid}_${g.id}`]}; });
  const toIssue = cand.filter(x => x.ok && !(x.c && !x.c.revoked));
  $("#rbody").innerHTML = `<div class="card"><div class="row" style="margin-bottom:10px"><button class="btn pri sm" id="rPdf">طباعة / PDF</button><button class="btn sm" id="rXls">تنزيل Excel</button></div>${matrixTable(g, S.aReport)}</div>
  <div class="card"><h2>شهادات الحضور</h2>
    <p class="muted" style="margin-top:0">يستحق الشهادة من حضوره ${th.certMin}% أو أكثر${needFee ? "، وسدّد رسومه كاملة" : ""}. كل شهادة عليها QR للتحقق منها.</p>
    ${docs.length ? `<div class="tbl"><table><thead><tr><th class="nm">الطالب</th><th>الحضور</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${cand.map(x => `<tr><td class="nm">${esc(x.s.name)}</td><td>${x.pct}%</td><td>${x.c && !x.c.revoked ? `<span class="pill p">صادرة · ${esc(x.c.code)}</span>` : x.ok ? `<span class="pill">مستحق</span>` : !x.att ? `<span class="pill a">الحضور أقل من ${th.certMin}%</span>` : `<span class="pill l">موقوفة مالياً · ${esc(x.fee.why)}</span>`}</td>
        <td>${x.c && !x.c.revoked ? `<button class="btn sm" data-pc="${esc(x.c.key)}">طباعة</button> <button class="btn sm danger" data-rc="${esc(x.c.key)}">إلغاء</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="margin-top:10px">${toIssue.length ? `<button class="btn gold" id="cIssue">إصدار شهادات المستحقين (${toIssue.length}) وطباعتها</button>` : ""}${cand.some(x => x.c && !x.c.revoked) ? `<button class="btn sm" id="cAll">طباعة كل الشهادات الصادرة</button>` : ""}</div>`
    : `<p class="muted" style="margin:0">ما فيه تحضير مسجل لهذا المقرر.</p>`}
  </div>`;
  bindCopy();
  $("#rPdf").onclick = () => printGroupSheet(g, S.aReport);
  $("#rXls").onclick = () => excelGroupSheet(g, S.aReport);
  if ($("#cIssue")) $("#cIssue").onclick = async () => {
    const w = openPrint(); if (!w) return;
    const b = writeBatch(db), made = [];
    toIssue.forEach(x => { const code = certCode(); const c = {code, key: `${x.s.sid}_${g.id}`, num: x.s.sid, name: x.s.name, gender: x.s.gender, groupId: g.id, course: g.course, trainer: tName(g.trainerId), attPct: x.pct, date: today(), issuedBy: S.adminRole, revoked: false}; b.set(ref("certs/" + code), c); made.push(c); });
    try { await b.commit(); made.forEach(c => S.certs[c.key] = c); logAction("إصدار شهادات حضور", `${g.course} · ${made.length}`); }
    catch (e) { w.close(); return handleWriteErr(e); }
    const pages = []; for (const c of made) pages.push(await certPage(c));
    fillPrint(w, `شهادات حضور · ${g.course}`, pages, true);
  };
  if ($("#cAll")) $("#cAll").onclick = () => printCerts(cand.filter(x => x.c && !x.c.revoked).map(x => x.c));
  $("#rbody").querySelectorAll("[data-pc]").forEach(b => b.onclick = () => printCerts([S.certs[b.dataset.pc]]));
  $("#rbody").querySelectorAll("[data-rc]").forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "متأكد؟"; return; }
    const c = S.certs[b.dataset.rc];
    try { await setDoc(ref("certs/" + c.code), {revoked: true}, {merge: true}); logAction("إلغاء شهادة", `${c.name} · ${c.course}`); toast("أُلغيت الشهادة، وصفحة التحقق بتقول إنها ملغاة"); } catch (e) { handleWriteErr(e); }
  });
}

render();
