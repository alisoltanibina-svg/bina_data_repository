// File: revayat.js
// Purpose: Scene rail, geometry builders, and one-step navigation for the architecture story.

const scenes = [...document.querySelectorAll("scene")];
const rail = document.querySelector(".rail");
const next = document.querySelector("#next");
const prev = document.querySelector("#prev");

function track(event, extra) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: event }, extra || {}));
}

scenes.forEach((_, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "گام " + (i + 1));
    b.addEventListener("click", () => go(i));
    rail.appendChild(b);
});
const dots = [...rail.querySelectorAll("button")];

const ATOM_COUNT = 31;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const atoms = document.getElementById("atoms");
for (let i = 0; i < ATOM_COUNT; i++) {
    const radius = Math.sqrt((i + 0.5) / ATOM_COUNT) * 42;
    const angle = i * GOLDEN;
    const x = 50 + radius * Math.cos(angle);
    const y = 50 + radius * Math.sin(angle);
    const d = document.createElement("span");
    d.className = "dot";
    d.style.right = (100 - Math.max(6, Math.min(94, x))) + "%";
    d.style.top = Math.max(6, Math.min(94, y)) + "%";
    d.style.animationDelay = (i * 0.018) + "s";
    d.style.background = i % 5 === 0 ? "#b08948" : "#1b242e";
    atoms.appendChild(d);
}

const ROOM_POS = [[18, 22], [58, 12], [38, 48], [8, 58], [70, 56]];
const ROOM_COLORS = ["#fbf6ee", "#efe4cf", "#f7f1e6", "#eadcc4", "#f3eadb"];
const rooms = document.getElementById("rooms");
const ROOM_DOTS = [7, 6, 6, 6, 6];
let roomDotIndex = 0;
ROOM_POS.forEach((p, i) => {
    const c = document.createElement("div");
    c.className = "card-mini";
    c.style.right = p[0] + "%";
    c.style.top = p[1] + "%";
    c.style.animationDelay = (0.1 * i) + "s";
    c.style.background = ROOM_COLORS[i];
    const count = ROOM_DOTS[i];
    for (let n = 0; n < count; n++) {
        const spec = document.createElement("em");
        const t = Math.sqrt((n + 0.5) / count);
        const a = n * GOLDEN;
        const x = 50 + t * 30 * Math.cos(a);
        const y = 50 + t * 30 * Math.sin(a);
        spec.style.left = Math.max(10, Math.min(82, x)) + "%";
        spec.style.top = Math.max(12, Math.min(82, y)) + "%";
        spec.style.background = roomDotIndex % 5 === 0 ? "#b08948" : "#1b242e";
        c.appendChild(spec);
        roomDotIndex += 1;
    }
    rooms.appendChild(c);
});

const WEIGHT_VALS = [72, 44, 86, 31, 58];
const weights = document.getElementById("weights");
WEIGHT_VALS.forEach((w, i) => {
    const row = document.createElement("div");
    row.className = "bar";
    row.style.setProperty("--w", w + "%");
    const fill = document.createElement("i");
    fill.style.setProperty("--w", w + "%");
    fill.style.animationDelay = (0.12 * i) + "s";
    const knob = document.createElement("span");
    knob.style.animationDelay = (0.2 + 0.12 * i) + "s";
    row.appendChild(fill);
    row.appendChild(knob);
    weights.appendChild(row);
});

const MATRIX_COLORS = ["#c9a56a", "#d9d1c3", "#8d9a7b", "#c46a6a", "#c9a56a", "#d9d1c3"];
const matrix = document.getElementById("matrix");
MATRIX_COLORS.forEach((c, i) => {
    const b = document.createElement("b");
    b.style.background = c;
    b.style.animationDelay = (i * 0.06) + "s";
    matrix.appendChild(b);
});
let sceneIndex = 0;
let bridging = false;

function setScene(i, from) {
    if (from === true) from = "atoms";
    sceneIndex = i;
    scenes.forEach((s, n) => {
        s.classList.toggle("is-on", n === i);
        s.classList.remove("is-prep", "is-bridging", "is-thread-out", "is-wait-copy");
    });
    scenes[1].classList.toggle("is-from-bridge", i === 1 && from === "atoms");
    scenes[2].classList.toggle("is-from-rooms", i === 2 && from === "rooms");
    scenes[3].classList.toggle("is-from-weights", i === 3 && from === "weights");
    scenes[4].classList.toggle("is-from-arcs", i === 4 && from === "arcs");
    scenes[5].classList.toggle("is-from-spark", i === 5 && from === "spark");
    scenes[6].classList.toggle("is-from-benches", i === 6 && from === "benches");
    scenes[7].classList.toggle("is-from-matrix", i === 7 && from === "matrix");
    scenes[8].classList.toggle("is-from-iran", i === 8 && from === "iran");
    dots.forEach((d, n) => d.setAttribute("aria-current", n === i ? "true" : "false"));
    if (prev) prev.hidden = i === 0 || bridging;
    if (next) next.hidden = i === scenes.length - 1 || bridging;
    track("story_scene_" + i, { scene: i });
    if (i === scenes.length - 1) track("story_complete");
}

scenes[0].classList.add("is-on");
dots[0].setAttribute("aria-current", "true");
track("story_start");

(function typeSceneTitle() {
    const title = document.querySelector(".scene-title");
    const typed = title && title.querySelector(".scene-title-typed");
    const ghost = title && title.querySelector(".scene-title-ghost");
    if (!typed || !ghost) return;
    const full = ghost.textContent;
    const chars = Array.from(full);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        typed.textContent = full;
        return;
    }
    typed.textContent = "";
    typed.classList.add("is-typing");
    let i = 0;
    const start = () => {
        const step = () => {
            i += 1;
            typed.textContent = chars.slice(0, i).join("");
            if (i < chars.length) setTimeout(step, 72);
            else typed.classList.remove("is-typing");
        };
        setTimeout(step, 450);
    };
    start();
})();

function currentIndex() {
    return sceneIndex;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function tween(ms, fn) {
    return new Promise(resolve => {
        const t0 = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - t0) / ms);
            fn(1 - Math.pow(1 - t, 3), t);
            if (t < 1) requestAnimationFrame(step);
            else resolve();
        };
        requestAnimationFrame(step);
    });
}

function svgToScreen(svg, x, y) {
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    return pt.matrixTransform(svg.getScreenCTM());
}

function pearlScreen() {
    const svg = document.querySelector(".thread-svg");
    const pearl = document.querySelector(".thread-pearl");
    if (!svg || !pearl) return null;
    const pt = svg.createSVGPoint();
    pt.x = Number(pearl.getAttribute("cx"));
    pt.y = Number(pearl.getAttribute("cy"));
    const p = pt.matrixTransform(svg.getScreenCTM());
    const r = Number(pearl.getAttribute("r")) * Math.abs(svg.getScreenCTM().a);
    return { x: p.x, y: p.y, size: r * 2 };
}

async function bridgeToAtoms() {
    if (bridging) return;
    bridging = true;
    const scene0 = scenes[0];
    const scene1 = scenes[1];
    const overlay = document.getElementById("bridge");
    const start = pearlScreen();
    if (!start || !overlay) {
        bridging = false;
        setScene(1);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene0.classList.add("is-bridging");
    await wait(1400);
    await wait(700);

    scene0.classList.add("is-thread-out");
    scene1.classList.add("is-prep");
    atoms.classList.add("is-awaiting");

    overlay.hidden = false;
    overlay.innerHTML = "";
    const ball = document.createElement("div");
    ball.className = "bridge-pearl";
    overlay.appendChild(ball);
    ball.style.left = start.x + "px";
    ball.style.top = start.y + "px";
    ball.style.width = start.size + "px";
    ball.style.height = start.size + "px";
    void ball.offsetWidth;
    const ease = "1.15s cubic-bezier(0.22, 1, 0.36, 1)";
    ball.style.transition = "width " + ease + ", height " + ease;
    const grown = start.size * 2;
    ball.style.width = grown + "px";
    ball.style.height = grown + "px";
    await wait(1150);

    const origin = { x: start.x, y: start.y };
    function pieClip(i, n) {
        const overlap = 0.05;
        const a0 = (i / n) * Math.PI * 2 - Math.PI / 2 - overlap;
        const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2 + overlap;
        const pts = ["50% 50%"];
        for (let s = 0; s <= 5; s++) {
            const a = a0 + (a1 - a0) * (s / 5);
            pts.push((50 + 50 * Math.cos(a)).toFixed(2) + "% " + (50 + 50 * Math.sin(a)).toFixed(2) + "%");
        }
        return "polygon(" + pts.join(",") + ")";
    }

    const shards = [...atoms.children].map((dot, i) => {
        const el = document.createElement("div");
        el.className = "bridge-shard";
        el.style.background = "#b08948";
        el.style.width = grown + "px";
        el.style.height = grown + "px";
        el.style.left = origin.x + "px";
        el.style.top = origin.y + "px";
        el.style.clipPath = pieClip(i, ATOM_COUNT);
        overlay.appendChild(el);
        return el;
    });
    ball.remove();

    const targets = [...atoms.children].map((dot) => {
        const box = dot.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, color: dot.style.background };
    });

    void overlay.offsetWidth;
    shards.forEach((el, i) => {
        const delay = i * 12;
        el.style.transition =
            "left 1.5s cubic-bezier(0.22, 1, 0.36, 1) " + delay + "ms," +
            "top 1.5s cubic-bezier(0.22, 1, 0.36, 1) " + delay + "ms," +
            "width 1.5s cubic-bezier(0.22, 1, 0.36, 1) " + delay + "ms," +
            "height 1.5s cubic-bezier(0.22, 1, 0.36, 1) " + delay + "ms," +
            "clip-path 1.5s cubic-bezier(0.22, 1, 0.36, 1) " + delay + "ms," +
            "background 1.1s ease " + delay + "ms";
        el.style.left = targets[i].x + "px";
        el.style.top = targets[i].y + "px";
        el.style.width = "7px";
        el.style.height = "7px";
        el.style.clipPath = "circle(50%)";
        el.style.background = targets[i].color;
    });
    await wait(1500 + ATOM_COUNT * 12);

    overlay.innerHTML = "";
    overlay.hidden = true;
    scene0.classList.remove("is-on", "is-bridging", "is-thread-out");
    scene1.classList.remove("is-prep");
    bridging = false;
    setScene(1, "atoms");
    atoms.classList.remove("is-awaiting");
}

async function bridgeToRooms() {
    if (bridging) return;
    bridging = true;
    const scene1 = scenes[1];
    const scene2 = scenes[2];
    const overlay = document.getElementById("bridge");
    if (!overlay || !atoms || !rooms) {
        bridging = false;
        setScene(2);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene1.classList.add("is-bridging");
    await wait(1400);

    overlay.hidden = false;
    overlay.innerHTML = "";
    const clones = [...atoms.children].map((dot) => {
        const box = dot.getBoundingClientRect();
        const el = document.createElement("div");
        el.className = "bridge-shard";
        el.style.width = box.width + "px";
        el.style.height = box.height + "px";
        el.style.left = box.left + box.width / 2 + "px";
        el.style.top = box.top + box.height / 2 + "px";
        el.style.background = dot.style.background || "#1b242e";
        overlay.appendChild(el);
        return el;
    });
    atoms.classList.add("is-awaiting");

    scene1.classList.remove("is-on", "is-bridging", "is-from-bridge");
    scene2.classList.add("is-on", "is-from-rooms", "is-wait-copy");
    rooms.classList.add("is-awaiting");
    sceneIndex = 2;
    void overlay.offsetWidth;

    const specs = [...rooms.querySelectorAll("em")];
    const targets = specs.map((em) => {
        const b = em.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });

    clones.forEach((el, i) => {
        if (!targets[i]) return;
        el.style.transition = "left 1.65s cubic-bezier(0.22, 1, 0.36, 1), top 1.65s cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.left = targets[i].x + "px";
        el.style.top = targets[i].y + "px";
    });
    await wait(1700);

    rooms.classList.remove("is-awaiting");
    await wait(950);

    overlay.innerHTML = "";
    overlay.hidden = true;
    atoms.classList.remove("is-awaiting");
    bridging = false;
    setScene(2, "rooms");
}

async function bridgeToWeights() {
    if (bridging) return;
    bridging = true;
    const scene2 = scenes[2];
    const scene3 = scenes[3];
    const overlay = document.getElementById("bridge");
    const cards = [...rooms.children];
    if (!overlay || !cards.length || !weights) {
        bridging = false;
        setScene(3);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene2.classList.add("is-bridging");
    await wait(1400);

    overlay.hidden = false;
    overlay.innerHTML = "";
    const morphs = cards.map((card, i) => {
        const b = card.getBoundingClientRect();
        const box = document.createElement("div");
        box.className = "bridge-morph";
        box.style.left = b.left + "px";
        box.style.top = b.top + "px";
        box.style.width = b.width + "px";
        box.style.height = b.height + "px";
        box.style.background = ROOM_COLORS[i];
        card.querySelectorAll("em").forEach((em) => {
            const eb = em.getBoundingClientRect();
            const d = document.createElement("div");
            d.className = "bridge-morph-dot";
            d.style.left = eb.left - b.left + "px";
            d.style.top = eb.top - b.top + "px";
            d.style.background = em.style.background || "#1b242e";
            box.appendChild(d);
        });
        overlay.appendChild(box);
        return box;
    });
    rooms.classList.add("is-awaiting");

    scene2.classList.remove("is-on", "is-bridging", "is-from-rooms");
    scene3.classList.add("is-on", "is-from-weights", "is-wait-copy");
    weights.querySelectorAll("span").forEach((s) => { s.style.opacity = "1"; });
    sceneIndex = 3;
    void overlay.offsetWidth;

    const bars = [...weights.querySelectorAll(".bar")];
    const dest = bars.map((bar) => {
        const knob = bar.querySelector("span");
        return {
            bar: bar.getBoundingClientRect(),
            knob: knob.getBoundingClientRect()
        };
    });
    weights.classList.add("is-awaiting");

    const ease = "1.55s cubic-bezier(0.22, 1, 0.36, 1)";
    morphs.forEach((box, i) => {
        const d = dest[i];
        if (!d) {
            box.style.transition = "opacity 0.8s ease";
            box.style.opacity = "0";
            return;
        }
        const br = d.bar;
        const kr = d.knob;
        box.querySelectorAll(".bridge-morph-dot").forEach((d) => {
            d.style.transition = "opacity 0.6s ease";
            d.style.opacity = "0";
        });
        box.style.transition = "left " + ease + ", top " + ease + ", width " + ease + ", height " + ease + ", border-radius " + ease + ", background " + ease + ", border-color " + ease;
        box.style.left = kr.left + "px";
        box.style.top = kr.top + "px";
        box.style.width = "13px";
        box.style.height = "13px";
        box.style.borderRadius = "50%";
        box.style.background = "#b08948";
        box.style.borderColor = "transparent";

        const line = document.createElement("div");
        line.className = "bridge-line";
        line.style.left = br.left + "px";
        line.style.top = br.top + br.height / 2 - 1.5 + "px";
        line.style.width = br.width + "px";
        const fill = document.createElement("i");
        fill.style.width = "0";
        line.appendChild(fill);
        overlay.insertBefore(line, overlay.firstChild);
        void line.offsetWidth;
        line.style.transition = "opacity 1.2s cubic-bezier(0.22, 1, 0.36, 1)";
        fill.style.transition = "width 1.4s cubic-bezier(0.22, 1, 0.36, 1)";
        line.style.opacity = "1";
        fill.style.width = (WEIGHT_VALS[i] || 50) + "%";
    });
    await wait(1650);

    overlay.innerHTML = "";
    overlay.hidden = true;
    weights.classList.remove("is-awaiting");
    rooms.classList.remove("is-awaiting");
    bridging = false;
    setScene(3, "weights");
}

async function bridgeToArcs() {
    if (bridging) return;
    bridging = true;
    const scene3 = scenes[3];
    const scene4 = scenes[4];
    const overlay = document.getElementById("bridge");
    const arcSvg = document.querySelector(".arc-map");
    const bars = [...weights.querySelectorAll(".bar")];
    if (!overlay || !arcSvg || bars.length < 4) {
        bridging = false;
        setScene(4);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene3.classList.add("is-bridging");
    await wait(1400);

    const ns = "http://www.w3.org/2000/svg";
    const rows = bars.slice(0, 5).map((bar) => {
        const knob = bar.querySelector("span");
        const br = bar.getBoundingClientRect();
        const kr = knob.getBoundingClientRect();
        return {
            x1: br.left,
            x2: br.right,
            y: br.top + br.height / 2,
            kx: kr.left + kr.width / 2,
            ky: kr.top + kr.height / 2,
            r: Math.max(kr.width, kr.height) / 2
        };
    });

    overlay.hidden = false;
    overlay.innerHTML = "";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bridge-svg");
    overlay.appendChild(svg);

    const lineEls = rows.map((row) => {
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", "M" + row.x1 + " " + row.y + " L" + row.x2 + " " + row.y);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "#c9a56a");
        p.setAttribute("stroke-width", "3");
        p.setAttribute("stroke-linecap", "round");
        svg.appendChild(p);
        return p;
    });
    const knobEls = rows.map((row) => {
        const c = document.createElementNS(ns, "circle");
        c.setAttribute("cx", row.kx);
        c.setAttribute("cy", row.ky);
        c.setAttribute("r", String(row.r));
        c.setAttribute("fill", "#b08948");
        svg.appendChild(c);
        return c;
    });

    weights.classList.add("is-awaiting");
    scene3.classList.remove("is-on", "is-bridging", "is-from-weights");
    scene4.classList.add("is-on", "is-from-arcs", "is-wait-copy", "is-awaiting-arcs");
    sceneIndex = 4;
    void overlay.offsetWidth;

    const scale = Math.abs(arcSvg.getScreenCTM().a);
    const endCircles = [
        { x: 40, y: 110, r: 6, fill: "#1b242e", op: 1 },
        { x: 220, y: 110, r: 6, fill: "#b08948", op: 1 },
        { x: 70, y: 130, r: 4.5, fill: "#1b242e", op: 0.45 },
        { x: 200, y: 128, r: 4.5, fill: "#b08948", op: 0.7 }
    ].map((c) => {
        const p = svgToScreen(arcSvg, c.x, c.y);
        return { x: p.x, y: p.y, r: c.r * scale, fill: c.fill, op: c.op };
    });
    const endPaths = [
        { p0: [40, 110], c1: [80, 20], c2: [180, 20], p3: [220, 110], stroke: "#b08948", w: 1.2 * scale, op: 1 },
        { p0: [70, 130], c1: [110, 60], c2: [160, 70], p3: [200, 128], stroke: "#1b242e", w: 1 * scale, op: 0.35 }
    ].map((d) => ({
        p0: svgToScreen(arcSvg, d.p0[0], d.p0[1]),
        c1: svgToScreen(arcSvg, d.c1[0], d.c1[1]),
        c2: svgToScreen(arcSvg, d.c2[0], d.c2[1]),
        p3: svgToScreen(arcSvg, d.p3[0], d.p3[1]),
        stroke: d.stroke,
        w: d.w,
        op: d.op
    }));

    const alt = rows.map((row, i) => ({
        kx: i % 2 === 0 ? row.x1 : row.x2,
        ky: row.y
    }));
    await tween(800, (k) => {
        knobEls.forEach((c, i) => {
            c.setAttribute("cx", lerp(rows[i].kx, alt[i].kx, k));
            c.setAttribute("cy", lerp(rows[i].ky, alt[i].ky, k));
        });
    });

    const merge = [
        {
            y: (rows[0].y + rows[1].y) / 2,
            x1: Math.min(rows[0].x1, rows[1].x1),
            x2: Math.max(rows[0].x2, rows[1].x2)
        },
        {
            y: (rows[2].y + rows[3].y) / 2,
            x1: Math.min(rows[2].x1, rows[3].x1),
            x2: Math.max(rows[2].x2, rows[3].x2)
        }
    ];
    const kn0 = alt.map((p) => ({ x: p.kx, y: p.ky, r: rows[0].r }));

    await tween(1100, (k) => {
        [[0, 1, 0], [2, 3, 1]].forEach((pair) => {
            const a = pair[0];
            const b = pair[1];
            const m = merge[pair[2]];
            [a, b].forEach((i) => {
                const x1 = lerp(rows[i].x1, m.x1, k);
                const x2 = lerp(rows[i].x2, m.x2, k);
                const y = lerp(rows[i].y, m.y, k);
                lineEls[i].setAttribute("d", "M" + x1 + " " + y + " L" + x2 + " " + y);
            });
            lineEls[b].style.opacity = String(1 - k);
            knobEls[a].setAttribute("cx", lerp(kn0[a].x, m.x1, k));
            knobEls[a].setAttribute("cy", lerp(kn0[a].y, m.y, k));
            knobEls[b].setAttribute("cx", lerp(kn0[b].x, m.x2, k));
            knobEls[b].setAttribute("cy", lerp(kn0[b].y, m.y, k));
        });
        if (lineEls[4]) lineEls[4].style.opacity = String(1 - k);
        if (knobEls[4]) knobEls[4].style.opacity = String(1 - k);
    });

    const curveStart = [
        {
            x1: merge[0].x1, y1: merge[0].y, x2: merge[0].x2, y2: merge[0].y,
            cx1: lerp(merge[0].x1, merge[0].x2, 0.33), cy1: merge[0].y,
            cx2: lerp(merge[0].x1, merge[0].x2, 0.67), cy2: merge[0].y
        },
        {
            x1: merge[1].x1, y1: merge[1].y, x2: merge[1].x2, y2: merge[1].y,
            cx1: lerp(merge[1].x1, merge[1].x2, 0.33), cy1: merge[1].y,
            cx2: lerp(merge[1].x1, merge[1].x2, 0.67), cy2: merge[1].y
        }
    ];
    const keepLines = [lineEls[0], lineEls[2]];
    const keepKnobs = [knobEls[0], knobEls[1], knobEls[2], knobEls[3]];
    const kn1 = [
        { x: merge[0].x1, y: merge[0].y, r: kn0[0].r },
        { x: merge[0].x2, y: merge[0].y, r: kn0[1].r },
        { x: merge[1].x1, y: merge[1].y, r: kn0[2].r },
        { x: merge[1].x2, y: merge[1].y, r: kn0[3].r }
    ];

    await tween(1400, (k) => {
        keepLines.forEach((el, p) => {
            const a = curveStart[p];
            const b = endPaths[p];
            const p0x = lerp(a.x1, b.p0.x, k);
            const p0y = lerp(a.y1, b.p0.y, k);
            const c1x = lerp(a.cx1, b.c1.x, k);
            const c1y = lerp(a.cy1, b.c1.y, k);
            const c2x = lerp(a.cx2, b.c2.x, k);
            const c2y = lerp(a.cy2, b.c2.y, k);
            const p3x = lerp(a.x2, b.p3.x, k);
            const p3y = lerp(a.y2, b.p3.y, k);
            el.setAttribute("d", "M" + p0x + " " + p0y + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + p3x + " " + p3y);
            el.setAttribute("stroke-width", String(lerp(3, b.w, k)));
            el.style.opacity = String(lerp(1, b.op, k));
            if (k > 0.5) el.setAttribute("stroke", b.stroke);
        });
        keepKnobs.forEach((c, i) => {
            const e = endCircles[i];
            c.setAttribute("cx", lerp(kn1[i].x, e.x, k));
            c.setAttribute("cy", lerp(kn1[i].y, e.y, k));
            c.setAttribute("r", String(lerp(kn1[i].r, e.r, k)));
            c.style.opacity = String(lerp(1, e.op, k));
            if (k > 0.45) c.setAttribute("fill", e.fill);
        });
    });

    overlay.innerHTML = "";
    overlay.hidden = true;
    weights.classList.remove("is-awaiting");
    scene4.classList.remove("is-awaiting-arcs");
    bridging = false;
    setScene(4, "arcs");
}

function pt(x, y) { return { x: x, y: y }; }
function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }
function splitCubic(p0, c1, c2, p3, t) {
    const p01 = lerpPt(p0, c1, t);
    const p12 = lerpPt(c1, c2, t);
    const p23 = lerpPt(c2, p3, t);
    const p012 = lerpPt(p01, p12, t);
    const p123 = lerpPt(p12, p23, t);
    const p0123 = lerpPt(p012, p123, t);
    return [[p0, p01, p012, p0123], [p0123, p123, p23, p3]];
}
function cubicPath(segs) {
    let d = "M" + segs[0][0].x + " " + segs[0][0].y;
    segs.forEach((s) => {
        d += " C" + s[1].x + " " + s[1].y + ", " + s[2].x + " " + s[2].y + ", " + s[3].x + " " + s[3].y;
    });
    return d;
}
function sampleSvgPathEl(svg, pathEl, n) {
    const len = Math.max(1, pathEl.getTotalLength());
    const pts = [];
    for (let i = 0; i < n; i++) {
        const p = pathEl.getPointAtLength((len * i) / (n - 1));
        const s = svgToScreen(svg, p.x, p.y);
        pts.push({ x: s.x, y: s.y });
    }
    return pts;
}
function ptsPath(pts) {
    let d = "M" + pts[0].x + " " + pts[0].y;
    for (let i = 1; i < pts.length; i++) d += " L" + pts[i].x + " " + pts[i].y;
    return d;
}
function captureToScreen(svg) {
    const ctm = svg.getScreenCTM();
    return (x, y) => {
        const pt = svg.createSVGPoint();
        pt.x = x;
        pt.y = y;
        const p = pt.matrixTransform(ctm);
        return { x: p.x, y: p.y };
    };
}
function xy(toS, x, y) {
    const p = toS(x, y);
    return p.x + " " + p.y;
}
function connectedBenchesD(toS, tL, tM, tR) {
    const p = (x, y) => xy(toS, x, y);
    const base = 76;
    const r = 8;
    return (
        "M" + p(8, base) +
        " L" + p(16, base) +
        " Q" + p(24, base) + " " + p(24, base - r) +
        " L" + p(24, tL + r) +
        " Q" + p(24, tL) + " " + p(32, tL) +
        " L" + p(80, tL) +
        " Q" + p(88, tL) + " " + p(88, tL + r) +
        " L" + p(88, base - r) +
        " Q" + p(88, base) + " " + p(96, base) +
        " Q" + p(104, base) + " " + p(104, base - r) +
        " L" + p(104, tM + r) +
        " Q" + p(104, tM) + " " + p(112, tM) +
        " L" + p(168, tM) +
        " Q" + p(176, tM) + " " + p(176, tM + r) +
        " L" + p(176, base - r) +
        " Q" + p(176, base) + " " + p(184, base) +
        " Q" + p(192, base) + " " + p(192, base - r) +
        " L" + p(192, tR + r) +
        " Q" + p(192, tR) + " " + p(200, tR) +
        " L" + p(248, tR) +
        " Q" + p(256, tR) + " " + p(256, tR + r) +
        " L" + p(256, base - r) +
        " Q" + p(256, base) + " " + p(264, base) +
        " L" + p(272, base)
    );
}
function benchUD(toS, x, top, w, base, r) {
    const p = (px, py) => xy(toS, px, py);
    return (
        "M" + p(x, base - r) +
        " L" + p(x, top + r) +
        " Q" + p(x, top) + " " + p(x + r, top) +
        " L" + p(x + w - r, top) +
        " Q" + p(x + w, top) + " " + p(x + w, top + r) +
        " L" + p(x + w, base - r)
    );
}
function benchArmD(toS, wx, qLand, free, base, r) {
    const p = (px, py) => xy(toS, px, py);
    return "M" + p(wx, base - r) + " Q" + p(wx, base) + " " + p(qLand, base) + " L" + p(free, base);
}
function boxToScreen(svg, x, y, w, h) {
    const a = svgToScreen(svg, x, y);
    const b = svgToScreen(svg, x + w, y + h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}
function lerpBox(a, b, t) {
    return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t)
    };
}
function setRectBox(el, box, rx) {
    el.setAttribute("x", box.x);
    el.setAttribute("y", box.y);
    el.setAttribute("width", String(Math.max(0.001, box.w)));
    el.setAttribute("height", String(Math.max(0.001, box.h)));
    if (rx != null) {
        el.setAttribute("rx", String(rx));
        el.setAttribute("ry", String(rx));
    }
}
function lerpHex(a, b, t) {
    const parse = (h) => {
        const n = parseInt(String(h).replace("#", ""), 16);
        return [n >> 16, (n >> 8) & 255, n & 255];
    };
    const A = parse(a);
    const B = parse(b);
    return "rgb(" + Math.round(lerp(A[0], B[0], t)) + "," + Math.round(lerp(A[1], B[1], t)) + "," + Math.round(lerp(A[2], B[2], t)) + ")";
}
function sampleClosedPath(pathEl, n) {
    const len = Math.max(1, pathEl.getTotalLength());
    const pts = [];
    for (let i = 0; i < n; i++) {
        const p = pathEl.getPointAtLength((len * i) / n);
        pts.push({ x: p.x, y: p.y });
    }
    return pts;
}
function ptsPathClosed(pts) {
    let d = "M" + pts[0].x + " " + pts[0].y;
    for (let i = 1; i < pts.length; i++) d += " L" + pts[i].x + " " + pts[i].y;
    return d + " Z";
}
function raySegT(ox, oy, dx, dy, ax, ay, bx, by) {
    const ex = bx - ax;
    const ey = by - ay;
    const det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-8) return null;
    const fx = ax - ox;
    const fy = ay - oy;
    const t = (fx * ey - fy * ex) / det;
    const u = (fx * dy - fy * dx) / det;
    if (t >= 0 && u >= 0 && u <= 1) return t;
    return null;
}
function polyRayRadius(cx, cy, ang, poly) {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let best = 0;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const t = raySegT(cx, cy, dx, dy, a.x, a.y, b.x, b.y);
        if (t != null && t > best) best = t;
    }
    return best;
}

async function bridgeToSpark() {
    if (bridging) return;
    bridging = true;
    const scene4 = scenes[4];
    const scene5 = scenes[5];
    const overlay = document.getElementById("bridge");
    const arcSvg = document.querySelector(".arc-map");
    const sparkSvg = document.querySelector(".spark");
    if (!overlay || !arcSvg || !sparkSvg) {
        bridging = false;
        setScene(5);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene4.classList.add("is-bridging");
    await wait(1400);

    const toS = (svg, x, y) => svgToScreen(svg, x, y);
    const a1 = {
        p0: toS(arcSvg, 40, 110), c1: toS(arcSvg, 80, 20),
        c2: toS(arcSvg, 180, 20), p3: toS(arcSvg, 220, 110)
    };
    const a2 = {
        p0: toS(arcSvg, 70, 130), c1: toS(arcSvg, 110, 60),
        c2: toS(arcSvg, 160, 70), p3: toS(arcSvg, 200, 128)
    };
    const circStart = [
        { x: 40, y: 110, r: 6, fill: "#1b242e", op: 1 },
        { x: 220, y: 110, r: 6, fill: "#b08948", op: 1 },
        { x: 70, y: 130, r: 4.5, fill: "#1b242e", op: 0.45 },
        { x: 200, y: 128, r: 4.5, fill: "#b08948", op: 0.7 }
    ].map((c) => {
        const p = toS(arcSvg, c.x, c.y);
        const sc = Math.abs(arcSvg.getScreenCTM().a);
        return { x: p.x, y: p.y, r: c.r * sc, fill: c.fill, op: c.op };
    });

    const ns = "http://www.w3.org/2000/svg";
    overlay.hidden = false;
    overlay.innerHTML = "";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bridge-svg");
    overlay.appendChild(svg);
    const pathA = document.createElementNS(ns, "path");
    const pathB = document.createElementNS(ns, "path");
    pathA.setAttribute("fill", "none");
    pathB.setAttribute("fill", "none");
    pathA.setAttribute("stroke", "#b08948");
    pathB.setAttribute("stroke", "#1b242e");
    pathA.setAttribute("stroke-width", String(1.2 * Math.abs(arcSvg.getScreenCTM().a)));
    pathB.setAttribute("stroke-width", String(1 * Math.abs(arcSvg.getScreenCTM().a)));
    pathA.setAttribute("stroke-linecap", "round");
    pathB.setAttribute("stroke-linecap", "round");
    pathB.style.opacity = "0.35";
    svg.appendChild(pathA);
    svg.appendChild(pathB);
    const bubbles = circStart.map((c) => {
        const el = document.createElementNS(ns, "circle");
        el.setAttribute("cx", c.x);
        el.setAttribute("cy", c.y);
        el.setAttribute("r", String(c.r));
        el.setAttribute("fill", c.fill);
        el.style.opacity = String(c.op);
        svg.appendChild(el);
        return el;
    });
    pathA.setAttribute("d", cubicPath([[a1.p0, a1.c1, a1.c2, a1.p3]]));
    pathB.setAttribute("d", cubicPath([[a2.p0, a2.c1, a2.c2, a2.p3]]));

    scene4.classList.remove("is-on", "is-bridging", "is-from-arcs");
    scene5.classList.add("is-on", "is-from-spark", "is-wait-copy", "is-awaiting-spark");
    sceneIndex = 5;
    void overlay.offsetWidth;

    const scS = Math.abs(sparkSvg.getScreenCTM().a);
    const sparkEnd = {
        segs: [
            [toS(sparkSvg, 8, 62), toS(sparkSvg, 40, 62), toS(sparkSvg, 48, 28), toS(sparkSvg, 86, 40)],
            [toS(sparkSvg, 86, 40), toS(sparkSvg, 124, 52), toS(sparkSvg, 130, 78), toS(sparkSvg, 168, 36)],
            [toS(sparkSvg, 168, 36), toS(sparkSvg, 206, -6), toS(sparkSvg, 220, 18), toS(sparkSvg, 272, 48)]
        ],
        tip: toS(sparkSvg, 272, 48),
        r: 4 * scS,
        w: 1.6 * scS
    };

    const avg = {
        p0: lerpPt(a1.p0, a2.p0, 0.5),
        c1: lerpPt(a1.c1, a2.c1, 0.5),
        c2: lerpPt(a1.c2, a2.c2, 0.5),
        p3: lerpPt(a1.p3, a2.p3, 0.5)
    };

    await tween(1100, (k) => {
        const m1 = {
            p0: lerpPt(a1.p0, avg.p0, k), c1: lerpPt(a1.c1, avg.c1, k),
            c2: lerpPt(a1.c2, avg.c2, k), p3: lerpPt(a1.p3, avg.p3, k)
        };
        const m2 = {
            p0: lerpPt(a2.p0, avg.p0, k), c1: lerpPt(a2.c1, avg.c1, k),
            c2: lerpPt(a2.c2, avg.c2, k), p3: lerpPt(a2.p3, avg.p3, k)
        };
        pathA.setAttribute("d", cubicPath([[m1.p0, m1.c1, m1.c2, m1.p3]]));
        pathB.setAttribute("d", cubicPath([[m2.p0, m2.c1, m2.c2, m2.p3]]));
        pathB.style.opacity = String(0.35 * (1 - k));
        pathA.setAttribute("stroke-width", String(lerp(1.2 * Math.abs(arcSvg.getScreenCTM().a), sparkEnd.w, k * 0.3)));
        [0, 2, 3].forEach((i) => {
            const onto = i === 0 ? m1.p0 : i === 2 ? m2.p0 : m2.p3;
            bubbles[i].setAttribute("cx", lerp(circStart[i].x, onto.x, k));
            bubbles[i].setAttribute("cy", lerp(circStart[i].y, onto.y, k));
            bubbles[i].setAttribute("r", String(lerp(circStart[i].r, 0.2, k)));
            bubbles[i].style.opacity = String(circStart[i].op * (1 - k));
        });
        bubbles[1].setAttribute("cx", m1.p3.x);
        bubbles[1].setAttribute("cy", m1.p3.y);
    });
    pathB.style.opacity = "0";

    const splitA = splitCubic(avg.p0, avg.c1, avg.c2, avg.p3, 1 / 3);
    const splitB = splitCubic(splitA[1][0], splitA[1][1], splitA[1][2], splitA[1][3], 0.5);
    const startSegs = [splitA[0], splitB[0], splitB[1]];
    const keep = { x: Number(bubbles[1].getAttribute("cx")), y: Number(bubbles[1].getAttribute("cy")), r: Number(bubbles[1].getAttribute("r")) };

    await tween(1400, (k) => {
        const segs = startSegs.map((s, i) => [
            lerpPt(s[0], sparkEnd.segs[i][0], k),
            lerpPt(s[1], sparkEnd.segs[i][1], k),
            lerpPt(s[2], sparkEnd.segs[i][2], k),
            lerpPt(s[3], sparkEnd.segs[i][3], k)
        ]);
        pathA.setAttribute("d", cubicPath(segs));
        pathA.setAttribute("stroke", "#b08948");
        pathA.setAttribute("stroke-width", String(lerp(sparkEnd.w * 0.85, sparkEnd.w, k)));
        const tip = segs[2][3];
        bubbles[1].setAttribute("cx", tip.x);
        bubbles[1].setAttribute("cy", tip.y);
        bubbles[1].setAttribute("r", String(lerp(keep.r, sparkEnd.r, k)));
        bubbles[1].setAttribute("fill", "#b08948");
        bubbles[1].style.opacity = "1";
    });

    overlay.innerHTML = "";
    overlay.hidden = true;
    scene5.classList.remove("is-awaiting-spark");
    bridging = false;
    setScene(5, "spark");
}

async function bridgeToBenches() {
    if (bridging) return;
    bridging = true;
    const scene5 = scenes[5];
    const scene6 = scenes[6];
    const overlay = document.getElementById("bridge");
    const sparkSvg = document.querySelector(".spark");
    const benchSvg = document.querySelector(".benches");
    const sparkPath = sparkSvg && sparkSvg.querySelector("path");
    const sparkDot = sparkSvg && sparkSvg.querySelector("circle");
    const benchPath = benchSvg && benchSvg.querySelector("path");
    if (!overlay || !sparkPath || !sparkDot || !benchPath || !sparkSvg.getScreenCTM()) {
        bridging = false;
        setScene(6);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene5.classList.add("is-bridging");
    await wait(1400);

    const N = 120;
    const fromPts = sampleSvgPathEl(sparkSvg, sparkPath, N);
    const scS = Math.abs(sparkSvg.getScreenCTM().a);
    const startR = Number(sparkDot.getAttribute("r")) * scS;
    const startTip = svgToScreen(
        sparkSvg,
        Number(sparkDot.getAttribute("cx")),
        Number(sparkDot.getAttribute("cy"))
    );
    const startW = 1.6 * scS;

    const ns = "http://www.w3.org/2000/svg";
    overlay.hidden = false;
    overlay.innerHTML = "";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bridge-svg");
    overlay.appendChild(svg);

    const path = document.createElementNS(ns, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#b08948");
    path.setAttribute("stroke-width", String(startW));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", ptsPath(fromPts));
    svg.appendChild(path);

    const bubble = document.createElementNS(ns, "circle");
    bubble.setAttribute("cx", startTip.x);
    bubble.setAttribute("cy", startTip.y);
    bubble.setAttribute("r", String(startR));
    bubble.setAttribute("fill", "#b08948");
    svg.appendChild(bubble);

    scene5.classList.remove("is-on", "is-bridging", "is-from-spark");
    scene6.classList.add("is-on", "is-from-benches", "is-wait-copy", "is-awaiting-benches");
    sceneIndex = 6;
    void overlay.offsetWidth;

    if (!benchSvg.getScreenCTM()) {
        overlay.innerHTML = "";
        overlay.hidden = true;
        scene6.classList.remove("is-awaiting-benches");
        bridging = false;
        setScene(6);
        return;
    }

    const toPts = sampleSvgPathEl(benchSvg, benchPath, N);
    const endW = 1.6 * Math.abs(benchSvg.getScreenCTM().a);

    await tween(1500, (k) => {
        const pts = fromPts.map((p, i) => lerpPt(p, toPts[i], k));
        path.setAttribute("d", ptsPath(pts));
        path.setAttribute("stroke-width", String(lerp(startW, endW, k)));
        const tip = pts[pts.length - 1];
        bubble.setAttribute("cx", tip.x);
        bubble.setAttribute("cy", tip.y);
        bubble.setAttribute("r", String(lerp(startR, 0.01, k)));
        bubble.style.opacity = String(1 - k);
    });

    const destRanks = [...benchSvg.querySelectorAll(".rank")];
    const rankScale = Math.abs(benchSvg.getScreenCTM().a);
    const overlayRanks = destRanks.map((t) => {
        const p = svgToScreen(benchSvg, Number(t.getAttribute("x")), Number(t.getAttribute("y")));
        const el = document.createElementNS(ns, "text");
        el.textContent = t.textContent;
        el.setAttribute("x", String(p.x));
        el.setAttribute("y", String(p.y));
        el.setAttribute("text-anchor", "middle");
        el.setAttribute("dominant-baseline", t.getAttribute("dominant-baseline") || "central");
        el.setAttribute("fill", "#1b242e");
        el.setAttribute("font-family", "Noto Nastaliq Urdu, Vazirmatn, Tahoma, serif");
        el.setAttribute("font-size", String(Number(t.getAttribute("font-size") || 14) * rankScale));
        el.setAttribute("font-weight", "600");
        el.style.opacity = "0";
        svg.appendChild(el);
        return el;
    });
    void svg.getBoundingClientRect();
    overlayRanks.forEach((el, i) => {
        el.style.transition = "opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1) " + (i * 160) + "ms";
        el.style.opacity = "1";
    });
    await wait(550 + destRanks.length * 160);

    scene6.classList.remove("is-awaiting-benches");
    overlay.innerHTML = "";
    overlay.hidden = true;
    bridging = false;
    setScene(6, "benches");
}

async function bridgeToMatrix() {
    if (bridging) return;
    bridging = true;
    const scene6 = scenes[6];
    const scene7 = scenes[7];
    const overlay = document.getElementById("bridge");
    const benchSvg = document.querySelector(".benches");
    if (!overlay || !benchSvg || !matrix || !benchSvg.getScreenCTM()) {
        bridging = false;
        setScene(7);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene6.classList.add("is-bridging");
    await wait(1400);

    const ns = "http://www.w3.org/2000/svg";
    const toS = captureToScreen(benchSvg);
    const benchScale = Math.abs(benchSvg.getScreenCTM().a);
    const startW = 1.6 * benchScale;
    const startRx = 8 * benchScale;
    const base = 76;
    const r = 8;
    const topEq = 12;
    const boxes = [
        { x: 24, w: 64, top0: 54, qL0: 16, qR0: 96, fL0: 8, fR0: 96, mid: 56 },
        { x: 104, w: 72, top0: 12, qL0: 96, qR0: 184, fL0: 96, fR0: 184, mid: 140 },
        { x: 192, w: 64, top0: 36, qL0: 184, qR0: 264, fL0: 184, fR0: 272, mid: 224 }
    ];
    boxes.forEach((b) => {
        b.qL1 = b.x + r;
        b.qR1 = b.x + b.w - r;
        b.fL1 = b.mid;
        b.fR1 = b.mid;
    });
    const equalBoxes = boxes.map((b) => boxToScreen(benchSvg, b.x, topEq, b.w, base - topEq));
    const destRanks = [...benchSvg.querySelectorAll(".rank")];

    overlay.hidden = false;
    overlay.innerHTML = "";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bridge-svg");
    overlay.appendChild(svg);

    function strokePath(d, parent) {
        const el = document.createElementNS(ns, "path");
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", "#b08948");
        el.setAttribute("stroke-width", String(startW));
        el.setAttribute("stroke-linecap", "round");
        el.setAttribute("stroke-linejoin", "round");
        el.setAttribute("d", d);
        (parent || svg).appendChild(el);
        return el;
    }

    const path = strokePath(connectedBenchesD(toS, 54, 12, 36));

    const overlayRanks = destRanks.map((t) => {
        const p = toS(Number(t.getAttribute("x")), Number(t.getAttribute("y")));
        const el = document.createElementNS(ns, "text");
        el.textContent = t.textContent;
        el.setAttribute("x", String(p.x));
        el.setAttribute("y", String(p.y));
        el.setAttribute("text-anchor", "middle");
        el.setAttribute("dominant-baseline", t.getAttribute("dominant-baseline") || "central");
        el.setAttribute("fill", "#1b242e");
        el.setAttribute("font-family", "Noto Nastaliq Urdu, Vazirmatn, Tahoma, serif");
        el.setAttribute("font-size", String(Number(t.getAttribute("font-size") || 14) * benchScale));
        el.setAttribute("font-weight", "600");
        svg.appendChild(el);
        return el;
    });

    scene6.classList.remove("is-on", "is-bridging", "is-from-benches");
    scene7.classList.add("is-on", "is-from-matrix", "is-wait-copy", "is-awaiting-matrix");
    sceneIndex = 7;
    void overlay.offsetWidth;

    if (!matrix.getBoundingClientRect().width) {
        overlay.innerHTML = "";
        overlay.hidden = true;
        scene7.classList.remove("is-awaiting-matrix");
        bridging = false;
        setScene(7);
        return;
    }

    const destCells = [...matrix.children].map((el, i) => {
        const rct = el.getBoundingClientRect();
        return { x: rct.left, y: rct.top, w: rct.width, h: rct.height, color: MATRIX_COLORS[i] };
    });
    const destTop = [destCells[2], destCells[1], destCells[0]];
    const destBot = [destCells[5], destCells[4], destCells[3]];

    overlayRanks.forEach((el) => {
        el.style.transition = "opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.opacity = "0";
    });
    await wait(600);
    overlayRanks.forEach((el) => el.remove());

    await tween(950, (k) => {
        path.setAttribute("d", connectedBenchesD(toS, lerp(54, 12, k), 12, lerp(36, 12, k)));
    });

    const groups = boxes.map(() => {
        const g = document.createElementNS(ns, "g");
        svg.appendChild(g);
        return g;
    });
    boxes.forEach((b, i) => strokePath(benchUD(toS, b.x, topEq, b.w, base, r), groups[i]));
    const armL = boxes.map((b, i) => strokePath(benchArmD(toS, b.x, b.qL0, b.fL0, base, r), groups[i]));
    const armR = boxes.map((b, i) => strokePath(benchArmD(toS, b.x + b.w, b.qR0, b.fR0, base, r), groups[i]));
    path.remove();

    await tween(950, (k) => {
        boxes.forEach((b, i) => {
            armL[i].setAttribute("d", benchArmD(toS, b.x, lerp(b.qL0, b.qL1, k), lerp(b.fL0, b.fL1, k), base, r));
            armR[i].setAttribute("d", benchArmD(toS, b.x + b.w, lerp(b.qR0, b.qR1, k), lerp(b.fR0, b.fR1, k), base, r));
        });
    });

    function makeBoxRect(box, rx) {
        const el = document.createElementNS(ns, "rect");
        setRectBox(el, box, rx);
        el.setAttribute("fill", "none");
        el.setAttribute("fill-opacity", "0");
        el.setAttribute("stroke", "#b08948");
        el.setAttribute("stroke-width", String(startW));
        svg.appendChild(el);
        return el;
    }

    const lift = toS(0, base).y - toS(0, base - 16).y;
    const meetY = equalBoxes[0].y + equalBoxes[0].h;
    const origLifted = equalBoxes.map((b) => ({ x: b.x, y: b.y - lift, w: b.w, h: b.h }));
    const dupStart = equalBoxes.map((b) => ({ x: b.x + b.w / 2, y: meetY, w: 0.001, h: 0.001 }));
    const dupGrown = equalBoxes.map((b) => ({ x: b.x, y: meetY, w: b.w, h: b.h }));
    const botRects = dupStart.map((b) => makeBoxRect(b, 0.5));

    await tween(850, (k) => {
        groups.forEach((g) => g.setAttribute("transform", "translate(0," + (-lift * k) + ")"));
        botRects.forEach((el, i) => {
            const box = lerpBox(dupStart[i], dupGrown[i], k);
            setRectBox(el, box, Math.min(startRx, box.w / 2, box.h / 2));
        });
    });

    const topRects = origLifted.map((b) => makeBoxRect(b, startRx));
    groups.forEach((g) => g.remove());

    await tween(1100, (k) => {
        const rx = lerp(startRx, 8, k);
        const sw = lerp(startW, 1.2, k);
        topRects.forEach((el, i) => {
            setRectBox(el, lerpBox(origLifted[i], destTop[i], k), rx);
            el.setAttribute("stroke-width", String(sw));
        });
        botRects.forEach((el, i) => {
            setRectBox(el, lerpBox(dupGrown[i], destBot[i], k), rx);
            el.setAttribute("stroke-width", String(sw));
        });
    });

    await tween(750, (k) => {
        const paint = (el, cell) => {
            el.setAttribute("fill", cell.color || "#d9d1c3");
            el.setAttribute("fill-opacity", String(k));
            el.setAttribute("stroke-opacity", String(1 - k));
        };
        topRects.forEach((el, i) => paint(el, destTop[i]));
        botRects.forEach((el, i) => paint(el, destBot[i]));
    });

    scene7.classList.remove("is-awaiting-matrix");
    overlay.innerHTML = "";
    overlay.hidden = true;
    bridging = false;
    setScene(7, "matrix");
}

async function bridgeToIran() {
    if (bridging) return;
    bridging = true;
    const scene7 = scenes[7];
    const scene8 = scenes[8];
    const overlay = document.getElementById("bridge");
    const iranSvg = document.querySelector(".iran-map");
    const iranPath = iranSvg && iranSvg.querySelector("path");
    const cells = matrix ? [...matrix.children] : [];
    if (!overlay || !iranSvg || !iranPath || cells.length < 6) {
        bridging = false;
        setScene(8);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    scene7.classList.add("is-bridging");
    await wait(1400);

    const startBoxes = cells.map((el, i) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, color: MATRIX_COLORS[i] };
    });

    const ns = "http://www.w3.org/2000/svg";
    overlay.hidden = false;
    overlay.innerHTML = "";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "bridge-svg");
    overlay.appendChild(svg);

    const rects = startBoxes.map((box) => {
        const el = document.createElementNS(ns, "rect");
        setRectBox(el, box, 8);
        el.setAttribute("fill", box.color);
        el.setAttribute("stroke", "none");
        svg.appendChild(el);
        return el;
    });

    scene7.classList.remove("is-on", "is-bridging", "is-from-matrix");
    scene8.classList.add("is-on", "is-from-iran", "is-wait-copy", "is-awaiting-iran");
    sceneIndex = 8;
    void overlay.offsetWidth;

    if (!iranSvg.getScreenCTM()) {
        overlay.innerHTML = "";
        overlay.hidden = true;
        scene8.classList.remove("is-awaiting-iran");
        bridging = false;
        setScene(8);
        return;
    }

    const N = 96;
    const poly = sampleClosedPath(iranPath, 180).map((p) => {
        const s = svgToScreen(iranSvg, p.x, p.y);
        return { x: s.x, y: s.y };
    });
    let cx = 0;
    let cy = 0;
    poly.forEach((p) => { cx += p.x; cy += p.y; });
    cx /= poly.length;
    cy /= poly.length;

    const angles = [];
    for (let i = 0; i < N; i++) angles.push(-Math.PI / 2 + (i / N) * Math.PI * 2);
    const mapR = angles.map((a) => polyRayRadius(cx, cy, a, poly));
    const hits = mapR.filter((r) => r > 1);
    const fallback = hits.length ? hits.reduce((s, r) => s + r, 0) / hits.length : 80;
    for (let i = 0; i < mapR.length; i++) {
        if (!(mapR[i] > 1)) mapR[i] = fallback;
    }
    const radius = Math.min.apply(null, mapR) * 0.96;
    const destCircle = {
        x: cx - radius,
        y: cy - radius,
        w: radius * 2,
        h: radius * 2
    };

    await tween(1100, (k) => {
        rects.forEach((el, i) => {
            const box = lerpBox(startBoxes[i], destCircle, k);
            setRectBox(el, box, lerp(8, radius, k));
            el.setAttribute("fill", lerpHex(startBoxes[i].color, "#b08948", k));
        });
    });

    function polarPts(radii) {
        return angles.map((a, i) => ({
            x: cx + radii[i] * Math.cos(a),
            y: cy + radii[i] * Math.sin(a)
        }));
    }

    const morph = document.createElementNS(ns, "path");
    morph.setAttribute("d", ptsPathClosed(polarPts(angles.map(() => radius))));
    morph.setAttribute("fill", "#b08948");
    morph.setAttribute("fill-opacity", "1");
    morph.setAttribute("stroke", "#b08948");
    morph.setAttribute("stroke-width", "0");
    morph.setAttribute("stroke-linejoin", "round");
    morph.setAttribute("stroke-linecap", "round");
    svg.appendChild(morph);
    rects.forEach((el) => el.remove());
    await wait(180);

    const destW = 1.8 * Math.abs(iranSvg.getScreenCTM().a);
    await tween(1500, (k) => {
        const radii = mapR.map((r) => lerp(radius, r, k));
        morph.setAttribute("d", ptsPathClosed(polarPts(radii)));
        morph.setAttribute("fill-opacity", String(lerp(1, 0.28, k)));
        morph.setAttribute("fill", lerpHex("#b08948", "#c9a56a", k));
        morph.setAttribute("stroke-width", String(lerp(0, destW, k)));
    });

    scene8.classList.remove("is-awaiting-iran");
    overlay.innerHTML = "";
    overlay.hidden = true;
    bridging = false;
    setScene(8, "iran");
}

function go(i) {
    const target = Math.max(0, Math.min(scenes.length - 1, i));
    if (bridging || target === sceneIndex) return;
    if (sceneIndex === 0 && target === 1) {
        bridgeToAtoms();
        return;
    }
    if (sceneIndex === 1 && target === 2) {
        bridgeToRooms();
        return;
    }
    if (sceneIndex === 2 && target === 3) {
        bridgeToWeights();
        return;
    }
    if (sceneIndex === 3 && target === 4) {
        bridgeToArcs();
        return;
    }
    if (sceneIndex === 4 && target === 5) {
        bridgeToSpark();
        return;
    }
    if (sceneIndex === 5 && target === 6) {
        bridgeToBenches();
        return;
    }
    if (sceneIndex === 6 && target === 7) {
        bridgeToMatrix();
        return;
    }
    if (sceneIndex === 7 && target === 8) {
        bridgeToIran();
        return;
    }
    setScene(target);
}
next.addEventListener("click", () => go(currentIndex() + 1));
if (prev) prev.addEventListener("click", () => go(currentIndex() - 1));
window.addEventListener("wheel", (e) => { e.preventDefault(); }, { passive: false });
window.addEventListener("touchmove", (e) => { e.preventDefault(); }, { passive: false });
window.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"].includes(e.key)) {
        e.preventDefault();
    }
});

(function initLightLines() {
    const container = document.getElementById("light-lines");
    if (!container) return;

    const lights = [
        ".light1", ".light2", ".light3", ".light4", ".light5", ".light6",
        ".light7", ".light8", ".light9", ".light10", ".light11", ".light12",
        ".light13", ".light14", ".light15", ".light16", ".light17"
    ].map(selector => ({ selector, from: 1080, to: -1080 }));

    const refs = lights.map(light => ({
        element: container.querySelector(light.selector),
        from: light.from,
        to: light.to,
        duration: ((Math.floor(Math.random() * 59) + 2) * 0.5 + 0.5)
    }));
    const started = refs.map(() => performance.now() - Math.random() * 5000);

    function animate(time) {
        refs.forEach((ref, i) => {
            if (!ref.element) return;
            const progress = ((time - started[i]) / 1000 % ref.duration) / ref.duration;
            const y = ref.from + (ref.to - ref.from) * progress;
            ref.element.style.transform = "translateY(" + y + "px)";
        });
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
})();

(function runThread() {
    const scene0 = document.querySelector("scene[data-step='0']");
    const run = document.querySelector(".thread-run");
    const glow = document.querySelector(".thread-glow");
    if (!scene0 || !run || !glow) return;
    const yTop = 12;
    const yBot = 170;
    const dash = 18;
    const span = yBot - yTop;
    function frame(now) {
        if (scene0.classList.contains("is-on")) {
            run.setAttribute("stroke-dashoffset", String(-(now / 1000) * 56));
            const t = (now / 1800) % 1;
            const y = yBot - t * span;
            glow.setAttribute("y2", String(y));
            glow.setAttribute("y1", String(y - dash));
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();
