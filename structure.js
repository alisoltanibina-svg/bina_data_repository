// File: structure.js
// Purpose: RTL storyline of dashboard stations. Pearl walks the gold thread, then copy appears.

const STOPS = [
    {
        kicker: "دروازه",
        place: "خانه · پردهٔ ورود",
        body: "از همین آستانه وارد می‌شوی. رتبهٔ استان‌ها و گزارش سالانه همین‌جا دیده می‌شود. خط از مرز شروع نمی‌شود؛ از یک در شروع می‌شود."
    },
    {
        kicker: "ذره",
        place: "صفحهٔ شاخص · سری زمانی",
        body: "راه باریک می‌شود تا به یک عدد برسد: یک نرخ، یک سال، یک شهرستان. بدون این کف، بقیهٔ اتاق‌ها تزئینی‌اند."
    },
    {
        kicker: "اتاق",
        place: "کاوشگر داده · موزاییک موضوعی",
        body: "ذره‌ها اینجا خانواده می‌شوند. هر تصویر یک زیرموضوع است؛ هر زیرموضوع سقفی است روی چند مشاهدهٔ خرد."
    },
    {
        kicker: "وزن",
        place: "نمودار حبابی · وزن‌دهی",
        body: "مسیر به کارگاه کوک می‌رسد. اسلایدر را که حرکت بدهی، ابر استان‌ها جابه‌جا می‌شود. فرمول پشت پرده پنهان نیست."
    },
    {
        kicker: "خویشاوندی",
        place: "نقشهٔ شباهت استان‌ها",
        body: "پیچ مسیر از جغرافیا جدا می‌شود. سؤال این است کدام استان در نیمرخ به دیگری شبیه است، نه کدام‌یک هم‌مرز است."
    },
    {
        kicker: "زمان",
        place: "مقایسهٔ طولی · اسپارک‌لاین",
        body: "همان نیمرخ سال‌به‌سال کشیده می‌شود. استان را در برابر هم‌ترازها می‌بینی، و در برابر دیروز خودش."
    },
    {
        kicker: "میزان",
        place: "شاخص کلی · رتبه‌بندی",
        body: "راه‌ها برای یک لحظه به یک عدد می‌رسند. این میزان برای رتبه است، نه برای اینکه جای پرونده را بگیرد."
    },
    {
        kicker: "پرونده",
        place: "ماتریس وضعیت · پروفایل استان و شهرستان",
        body: "این اتاق بایگانی زنده است: قوت، ضعف، تغییر دوره. عدد واحد اینجا دوباره چهره پیدا می‌کند."
    },
    {
        kicker: "نبض",
        place: "پایان مسیر · بازگشت به خانه",
        body: "از کف مشاهده تا سقف تصمیم. اگر ایران را بفهمی، از ذره شروع کرده‌ای. نردبان همان مسیری است که آمدی."
    }
];

const WALK_MS = 900;
const COPY_DELAY = 920;

const copy = document.getElementById("copy");
const rail = document.getElementById("rail");
const nextBtn = document.getElementById("next");
const overviewBtn = document.getElementById("overview");
const walker = document.getElementById("walker");
const threadRun = document.getElementById("thread-run");
const stations = [...document.querySelectorAll(".station")];
const n = STOPS.length;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let index = -1;
let timer = 0;
let gen = 0;

STOPS.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", s.kicker);
    b.addEventListener("click", () => go(i));
    rail.appendChild(b);
});
const dots = [...rail.querySelectorAll("button")];

function scatterAtoms() {
    const host = document.getElementById("mark-atoms");
    if (!host || host.childElementCount) return;
    const count = 18;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
        const radius = Math.sqrt((i + 0.5) / count) * 38;
        const angle = i * golden;
        const x = 50 + radius * Math.cos(angle);
        const y = 50 + radius * Math.sin(angle);
        const d = document.createElement("span");
        d.className = "dot";
        d.style.right = (100 - Math.max(8, Math.min(92, x))) + "%";
        d.style.top = Math.max(8, Math.min(92, y)) + "%";
        d.style.background = i % 5 === 0 ? "#b08948" : "#1b242e";
        host.appendChild(d);
    }
}

function stationCenter(i) {
    const el = stations[i];
    const line = walker.parentElement;
    if (!el || !line) return 0;
    const a = el.getBoundingClientRect();
    const b = line.getBoundingClientRect();
    const mid = a.left + a.width / 2;
    return ((b.right - mid) / b.width) * 100;
}

function setWalker(pct) {
    const p = Math.max(0, Math.min(100, pct));
    walker.style.right = p + "%";
    threadRun.style.transform = "scaleX(" + (p / 100) + ")";
}

function hideCopy() {
    copy.classList.remove("is-visible");
    copy.setAttribute("aria-hidden", "true");
}

function showCopy() {
    const s = STOPS[index];
    if (!s) return;
    document.getElementById("kicker").textContent = s.kicker;
    document.getElementById("place").textContent = s.place;
    document.getElementById("body").textContent = s.body;
    copy.classList.add("is-visible");
    copy.setAttribute("aria-hidden", "false");
}

function mark() {
    stations.forEach((el, i) => el.classList.toggle("is-on", i === index));
    dots.forEach((d, i) => d.setAttribute("aria-current", i === index ? "true" : "false"));
    overviewBtn.hidden = index < 0;
    document.body.classList.toggle("is-on", index >= 0);
}

function goOverview() {
    gen += 1;
    if (timer) window.clearTimeout(timer);
    hideCopy();
    index = -1;
    mark();
    setWalker(0);
}

function go(i) {
    const next = (i + n) % n;
    const my = ++gen;
    hideCopy();
    if (timer) window.clearTimeout(timer);
    index = next;
    mark();
    setWalker(stationCenter(next));
    const wait = reduced ? 0 : COPY_DELAY;
    timer = window.setTimeout(() => {
        if (my !== gen) return;
        showCopy();
    }, wait);
}

stations.forEach((el) => {
    el.addEventListener("click", () => go(Number(el.dataset.i)));
});
nextBtn.addEventListener("click", () => {
    if (index < 0) go(0);
    else go(index + 1);
});
overviewBtn.addEventListener("click", goOverview);
window.addEventListener("resize", () => {
    if (index >= 0) setWalker(stationCenter(index));
});

scatterAtoms();
setWalker(0);
mark();
