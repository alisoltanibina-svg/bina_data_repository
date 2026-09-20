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
    b.addEventListener("click", () => {
        if (window.scrollToStoryScene) window.scrollToStoryScene(i);
        else go(i);
    });
    rail.appendChild(b);
});
const dots = [...rail.querySelectorAll("button")];

const ATOM_COUNT = 31;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
let worldActors = [];
let worldBallSize = 24;
const ORB_PALETTES = [
    { lo: [18, 16, 12], hi: [246, 240, 234] },
    { lo: [42, 28, 8], hi: [236, 210, 148] },
    { lo: [28, 20, 16], hi: [206, 176, 156] },
    { lo: [14, 24, 16], hi: [176, 196, 170] },
    { lo: [32, 14, 12], hi: [214, 156, 142] },
    { lo: [12, 16, 28], hi: [168, 182, 206] },
    { lo: [24, 22, 10], hi: [214, 204, 150] }
];
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
    if (i % 5 === 0) d.classList.add("is-gold");
    atoms.appendChild(d);
}

const ROOM_POS = [[18, 22], [58, 12], [38, 48], [8, 58], [70, 56]];
const ROOM_COLORS = ["#2c2622", "#261f18", "#2a2624", "#231c18", "#29241f"];
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
        const canvas = document.createElement("canvas");
        const pal = roomDotIndex % 5 === 0 ? ORB_PALETTES[1] : ORB_PALETTES[roomDotIndex % ORB_PALETTES.length];
        paintMiniSphere(canvas, pal, roomDotIndex * 11 + 5);
        spec.appendChild(canvas);
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
    const knobCanvas = document.createElement("canvas");
    paintMiniSphere(knobCanvas, ORB_PALETTES[1], i * 13 + 2);
    knob.appendChild(knobCanvas);
    row.appendChild(fill);
    row.appendChild(knob);
    weights.appendChild(row);
});

const MATRIX_COLORS = ["#c9a56a", "#6a6358", "#7d8b6c", "#b56a68", "#c9a56a", "#6a6358"];
const matrix = document.getElementById("matrix");
MATRIX_COLORS.forEach((c, i) => {
    const b = document.createElement("b");
    b.style.background = c;
    b.style.animationDelay = (i * 0.06) + "s";
    matrix.appendChild(b);
});
let sceneIndex = 0;
let bridging = false;
let dropLocked = false;
let pearlSpinning = true;
let lightLinesActive = true;
let lightLinesRaf = 0;

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
    if (prev) prev.hidden = true;
    if (next) next.hidden = true;
    document.body.dataset.scene = String(i);
    if (i === 0) resetScene0();
    const ground = document.getElementById("ground");
    if (ground) ground.classList.toggle("is-out", i !== 0);
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
    const scene0 = document.querySelector("scene[data-step='0']");
    function fitPearlToTitle() {
        if (!title || !scene0) return;
        const w = Math.ceil(title.getBoundingClientRect().width);
        if (!w) return;
        scene0.style.setProperty("--title-w", w + "px");
    }
    if (title && scene0) {
        fitPearlToTitle();
        window.addEventListener("resize", fitPearlToTitle);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(fitPearlToTitle);
        }
    }
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
    const pearl = document.querySelector(".thread-pearl");
    if (!pearl) return null;
    const box = pearl.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        size: Math.min(box.width, box.height)
    };
}

function paintMiniSphere(canvas, pal, seed) {
    const SIZE = 64;
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    const cx = SIZE / 2;
    const r = SIZE / 2 - 0.4;
    const lx = -0.48;
    const ly = -0.52;
    const lz = 0.71;
    function rnd(i, j) {
        const n = Math.sin((i + seed * 13.1) * 127.1 + (j + seed * 7.7) * 311.7) * 43758.5453;
        return n - Math.floor(n);
    }
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const dx = (x + 0.5 - cx) / r;
            const dy = (y + 0.5 - cx) / r;
            const rr = dx * dx + dy * dy;
            const o = (y * SIZE + x) * 4;
            if (rr > 1) {
                data[o + 3] = 0;
                continue;
            }
            const nz = Math.sqrt(1 - rr);
            const ndot = Math.max(0, dx * lx + dy * ly + nz * lz);
            const bounce = Math.max(0, -dx * lx - dy * ly) * (1 - ndot) * 0.22;
            const spec = Math.pow(ndot, 14) * 0.42;
            const contact = Math.max(0, dy - 0.52) * 0.38;
            const limb = rr * rr * 0.12;
            const lon = Math.atan2(dx, nz) + seed * 0.7;
            const lat = Math.asin(Math.max(-1, Math.min(1, dy)));
            const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
            const v = lat / Math.PI + 0.5;
            let grain = 0.46 + (rnd(u * 18, v * 14) - 0.5) * 0.5;
            grain += Math.sin(u * 9 + seed) * 0.08;
            const blot = rnd(u * 6 + seed, v * 5);
            if (blot > 0.62) grain -= 0.22;
            if (blot < 0.28) grain += 0.14;
            const shade = Math.max(0.05, Math.min(1, 0.16 + ndot * 0.78 + bounce + spec - contact - limb));
            const t = Math.max(0, Math.min(1, shade * (0.62 + grain * 0.72)));
            data[o] = pal.lo[0] + t * (pal.hi[0] - pal.lo[0]);
            data[o + 1] = pal.lo[1] + t * (pal.hi[1] - pal.lo[1]);
            data[o + 2] = pal.lo[2] + t * (pal.hi[2] - pal.lo[2]);
            data[o + 3] = rr > 0.94 ? Math.max(0, (1 - Math.sqrt(rr)) / 0.06) * 255 : 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}

function makeMiniOrb(gold, index) {
    const el = document.createElement("div");
    el.className = "mini-orb";
    el.style.position = "fixed";
    el.style.transform = "translate(-50%, -50%)";
    const canvas = document.createElement("canvas");
    const pal = gold ? ORB_PALETTES[1] : ORB_PALETTES[(index || 0) % ORB_PALETTES.length];
    paintMiniSphere(canvas, pal, (index || 0) * 17 + 3);
    el.appendChild(canvas);
    return el;
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function setWorldPose(view, pose) {
    view.style.setProperty("--floor-tilt", pose.tilt + "deg");
    view.style.setProperty("--cam-s", String(pose.s));
    view.style.setProperty("--cam-y", pose.y + "px");
    view.style.setProperty("--cam-z", pose.z + "px");
}

function animateWorldPose(view, from, to, ms, ease, actors) {
    actors = actors || [];
    return new Promise((resolve) => {
        const t0 = performance.now();
        function frame(now) {
            let t = Math.min(1, (now - t0) / ms);
            t = ease(t);
            setWorldPose(view, {
                tilt: from.tilt + (to.tilt - from.tilt) * t,
                s: from.s + (to.s - from.s) * t,
                y: from.y + (to.y - from.y) * t,
                z: from.z + (to.z - from.z) * t
            });
            actors.forEach((a) => {
                floorActor(a.el, a.x0 + (a.x1 - a.x0) * t, a.d0 + (a.d1 - a.d0) * t, 0);
            });
            if (t < 1) requestAnimationFrame(frame);
            else resolve();
        }
        requestAnimationFrame(frame);
    });
}

function floorActor(el, x, depth, lift) {
    el.style.left = x + "px";
    el.style.bottom = depth + "px";
    el.style.top = "auto";
    const liftPx = lift || 0;
    el.style.transform =
        "rotateX(calc(-1 * var(--floor-tilt))) translateZ(2px)" +
        (liftPx ? " translateY(" + liftPx + "px)" : "");
}

function slideOnFloor(el, fromX, toX, depth, ms) {
    return new Promise((resolve) => {
        const t0 = performance.now();
        function frame(now) {
            let t = Math.min(1, (now - t0) / ms);
            t = easeOutCubic(t);
            floorActor(el, fromX + (toX - fromX) * t, depth, 0);
            if (t < 1) requestAnimationFrame(frame);
            else resolve();
        }
        requestAnimationFrame(frame);
    });
}

function fallOnFloor(el, fromX, toX, depth, lift0) {
    return new Promise((resolve) => {
        let x = fromX;
        let lift = lift0;
        let vy = 40;
        let last = performance.now();
        const g = 2200;
        const rest = 0.34;
        function frame(now) {
            const dt = Math.min(0.033, (now - last) / 1000);
            last = now;
            vy += g * dt;
            lift += vy * dt;
            x += (toX - x) * Math.min(1, 1.7 * dt);
            if (lift >= 0 && vy > 0) {
                lift = 0;
                vy = -vy * rest;
                if (Math.abs(vy) < 55) {
                    floorActor(el, toX, depth, 0);
                    resolve();
                    return;
                }
            }
            floorActor(el, x, depth, lift);
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    });
}

function ensureWorld(pivotX, pivotY) {
    const hy = pivotY || window.innerHeight;
    let view = document.getElementById("world-view");
    if (!view) {
        view = document.createElement("div");
        view.id = "world-view";
        view.className = "world-view";
        const stage = document.createElement("div");
        stage.id = "world-stage";
        stage.className = "world-stage";
        const floor = document.createElement("div");
        floor.id = "world-floor";
        floor.className = "world-floor";
        stage.appendChild(floor);
        view.appendChild(stage);
        document.body.appendChild(view);
    }
    view.style.setProperty("--pivot-x", pivotX + "px");
    view.style.setProperty("--pivot-y", hy + "px");
    view.style.perspectiveOrigin = "50% " + hy + "px";
    const floor = document.getElementById("world-floor");
    if (floor) floor.style.bottom = Math.max(0, window.innerHeight - hy) + "px";
    return view;
}

function teardownWorld() {
    const wrap = document.querySelector(".thread-wrap");
    const stage = document.querySelector("scene[data-step='0'] .stage");
    if (wrap && stage && wrap.parentNode !== stage) {
        wrap.classList.remove("world-ball");
        wrap.removeAttribute("style");
        stage.appendChild(wrap);
    }
    const view = document.getElementById("world-view");
    if (view) view.remove();
    document.body.classList.remove("has-world-atoms");
    worldActors = [];
}

function expandGround(originX, originY, scale) {
    const ground = document.getElementById("ground");
    if (!ground) return;
    const span = 1 / Math.max(0.04, scale);
    const widthPx = window.innerWidth * span * 1.6;
    const heightPx = window.innerHeight * span * 1.4;
    ground.style.top = originY + "px";
    ground.style.bottom = "auto";
    ground.style.left = (originX - widthPx / 2) + "px";
    ground.style.right = "auto";
    ground.style.width = widthPx + "px";
    ground.style.height = heightPx + "px";
}

function zoomWorldOut2d(originX, originY, scale) {
    const wrap = document.querySelector(".thread-wrap");
    const ground = document.getElementById("ground");
    const beam = document.querySelector(".beam-reveal");
    const light = document.querySelector(".hover-light");
    const ease = "transform 2.2s cubic-bezier(0.22, 1, 0.36, 1)";
    [ground, beam, light].forEach((el) => {
        if (!el) return;
        const box = el.getBoundingClientRect();
        el.style.transition = ease;
        el.style.transformOrigin = (originX - box.left) + "px " + (originY - box.top) + "px";
        el.style.transform = "scale(" + scale + ")";
    });
    if (wrap) {
        wrap.style.transition = ease;
        wrap.style.transformOrigin = "50% 100%";
        wrap.style.transform = (wrap.style.transform || "translate3d(0,0,0)") + " scale(" + scale + ")";
    }
}

function slideOrb2d(el, endX, duration) {
    return new Promise((resolve) => {
        el.style.transition = "left " + duration + "ms cubic-bezier(0.33, 0.12, 0.2, 1)";
        void el.offsetWidth;
        el.style.left = endX + "px";
        setTimeout(resolve, duration + 30);
    });
}

function fallOrb2d(el, endX, groundY, size) {
    return new Promise((resolve) => {
        let x = parseFloat(el.style.left);
        let y = parseFloat(el.style.top);
        const destY = groundY - size / 2;
        let vx = (endX - x) * 0.32;
        let vy = 18;
        let last = performance.now();
        const g = 780;
        const rest = 0.34;
        function frame(now) {
            const dt = Math.min(0.033, (now - last) / 1000);
            last = now;
            vy += g * dt;
            x += vx * dt;
            y += vy * dt;
            x += (endX - x) * Math.min(1, 1.8 * dt);
            if (y >= destY && vy > 0) {
                y = destY;
                vy = -vy * rest;
                vx *= 0.55;
                if (Math.abs(vy) < 50) {
                    el.style.left = endX + "px";
                    el.style.top = destY + "px";
                    resolve();
                    return;
                }
            }
            el.style.left = x + "px";
            el.style.top = y + "px";
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    });
}

function adoptToFloor(el, floor, floorW, vw, depth, size) {
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const side = size || Math.min(box.width, box.height);
    el.classList.add("world-ball");
    el.style.position = "absolute";
    el.style.width = side + "px";
    el.style.height = side + "px";
    el.style.margin = "0";
    el.style.transition = "none";
    el.style.transformOrigin = "50% 100%";
    const inner = el.querySelector(".thread-pearl");
    if (inner) {
        inner.style.width = "100%";
        inner.style.height = "100%";
        inner.style.left = "0";
        inner.style.top = "0";
        inner.style.margin = "0";
    }
    floorActor(el, floorW / 2 + cx - vw / 2, depth, 0);
    floor.appendChild(el);
}

async function bridgeToAtoms() {
    bridging = true;
    const scene0 = scenes[0];
    const wrap = document.querySelector(".thread-wrap");
    const pearl = document.querySelector(".thread-pearl");
    const overlay = document.getElementById("bridge");
    if (!wrap || !pearl || !overlay) {
        bridging = false;
        setScene(1);
        return;
    }

    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    if (!scene0.classList.contains("is-bridging")) {
        scene0.classList.add("is-bridging");
        await wait(400);
    }

    const face = pearlScreen();
    const ox = face ? face.x : window.innerWidth / 2;
    const oy = face ? face.y + face.size / 2 : window.innerHeight * 0.82;
    const targetOrb = 24;
    const zoom = Math.max(0.05, targetOrb / Math.max(face ? face.size : 280, 1));
    expandGround(ox, oy, zoom);
    zoomWorldOut2d(ox, oy, zoom);
    await wait(2300);

    const ground = document.getElementById("ground");
    const groundY = ground ? ground.getBoundingClientRect().top : oy;
    const w = window.innerWidth;
    const live = pearlScreen();
    const orbSize = Math.max(18, Math.round(live && live.size ? live.size : targetOrb));
    overlay.hidden = false;
    overlay.innerHTML = "";

    const nOrbs = 30;
    const pack2d = Math.min(w * 0.14, 120);
    const slots = [];
    for (let i = 0; i < nOrbs; i++) {
        const radius = Math.sqrt((i + 0.5) / nOrbs) * pack2d;
        const angle = i * GOLDEN;
        slots.push({
            i: i,
            x: ox + radius * Math.cos(angle),
            gold: i % 5 === 0
        });
    }
    const slides = [];
    const falls = [];
    const orbs = [];
    slots.forEach((slot, i) => {
        const el = makeMiniOrb(slot.gold, slot.i);
        el.style.width = orbSize + "px";
        el.style.height = orbSize + "px";
        const fromLeft = slot.x < ox;
        el.style.left = (fromLeft ? -orbSize : w + orbSize) + "px";
        el._slot = slot;
        const falling = i % 7 === 2;
        if (falling) {
            el.style.top = 80 + Math.random() * (window.innerHeight * 0.18) + "px";
            overlay.appendChild(el);
            falls.push({ el: el, x: slot.x, size: orbSize });
        } else {
            el.style.top = (groundY - orbSize / 2) + "px";
            overlay.appendChild(el);
            slides.push({ el: el, x: slot.x, dur: 3200 + Math.round(Math.random() * 1400) });
        }
        orbs.push(el);
    });

    void overlay.offsetWidth;
    const movers = [];
    slides.forEach((s, i) => {
        movers.push(wait(i * 150).then(() => slideOrb2d(s.el, s.x, s.dur)));
    });
    falls.forEach((f, i) => {
        movers.push(wait(280 + i * 220).then(() => fallOrb2d(f.el, f.x, groundY, f.size)));
    });
    await Promise.all(movers);
    await wait(400);

    const vw = window.innerWidth;
    const floorW = 6400;
    const pivotX = (pearlScreen() || { x: ox }).x;
    const view = ensureWorld(pivotX, window.innerHeight);
    const floor = document.getElementById("world-floor");
    const poseFront = { tilt: 88, s: 1, y: 0, z: 0 };
    const poseTop = { tilt: 16, s: 1.55, y: -8, z: 16 };
    setWorldPose(view, poseFront);

    const ballDepth = 160;
    adoptToFloor(wrap, floor, floorW, vw, ballDepth, orbSize);
    const mainX = floorW / 2;
    const pack = 190;
    const actors = [{
        el: wrap,
        x0: parseFloat(wrap.style.left) || mainX,
        d0: ballDepth,
        x1: mainX,
        d1: ballDepth + pack
    }];
    orbs.forEach((el) => {
        adoptToFloor(el, floor, floorW, vw, ballDepth, orbSize);
        const startX = parseFloat(el.style.left);
        const i = el._slot.i;
        const radius = Math.sqrt((i + 0.5) / nOrbs) * pack;
        const angle = i * GOLDEN;
        actors.push({
            el: el,
            x0: startX,
            d0: ballDepth,
            x1: mainX + radius * Math.cos(angle),
            d1: ballDepth + pack + radius * Math.sin(angle)
        });
    });
    if (ground) {
        ground.style.transition = "opacity 2.2s linear";
        ground.classList.add("is-out");
    }
    const cast = document.querySelector(".pearl-cast");
    if (cast) cast.style.opacity = "0";
    overlay.innerHTML = "";
    overlay.hidden = true;

    await animateWorldPose(view, poseFront, poseTop, 2400, easeInOutCubic, actors);

    worldActors = [wrap].concat(orbs);
    worldBallSize = orbSize;
    document.body.classList.add("has-world-atoms");
    if (atoms) atoms.classList.add("is-awaiting");
    bridging = false;
    setScene(1, "atoms");
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
    const sources = worldActors.length ? worldActors : [...atoms.children];
    const clones = sources.map((dot) => {
        const box = dot.getBoundingClientRect();
        const el = document.createElement("div");
        el.className = "mini-orb";
        el.style.position = "fixed";
        el.style.width = Math.max(10, box.width) + "px";
        el.style.height = Math.max(10, box.height) + "px";
        el.style.left = box.left + box.width / 2 + "px";
        el.style.top = box.top + box.height / 2 + "px";
        el.style.transform = "translate(-50%, -50%)";
        const srcCanvas = dot.querySelector("canvas");
        if (srcCanvas) {
            const c = document.createElement("canvas");
            c.width = srcCanvas.width;
            c.height = srcCanvas.height;
            c.getContext("2d").drawImage(srcCanvas, 0, 0);
            el.appendChild(c);
        }
        overlay.appendChild(el);
        return el;
    });
    atoms.classList.add("is-awaiting");
    const world = document.getElementById("world-view");
    if (world) {
        world.style.transition = "opacity 0.55s ease";
        world.style.opacity = "0";
    }
    document.body.classList.remove("has-world-atoms");

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
    teardownWorld();
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

function bouncePearlToGround() {
    return new Promise((resolve) => {
        const wrap = document.querySelector(".thread-wrap");
        const pearl = document.querySelector(".thread-pearl");
        const cast = document.querySelector(".pearl-cast");
        if (!wrap || !pearl) {
            resolve();
            return;
        }

        const wrapBox = wrap.getBoundingClientRect();
        const pearlBox = pearl.getBoundingClientRect();
        const size = pearlBox.height;
        const ground = document.getElementById("ground");
        const surfaceY = ground
            ? ground.getBoundingClientRect().top
            : window.innerHeight - Math.min(window.innerHeight * 0.18, 152);
        const endTop = surfaceY - size;
        const startTop = wrapBox.top;
        const floor = Math.max(8, endTop - startTop);

        wrap.classList.add("is-falling");
        wrap.style.position = "fixed";
        wrap.style.left = wrapBox.left + "px";
        wrap.style.top = startTop + "px";
        wrap.style.width = wrapBox.width + "px";
        wrap.style.height = size + "px";
        wrap.style.zIndex = "14";
        wrap.style.overflow = "visible";
        wrap.style.pointerEvents = "none";
        wrap.style.willChange = "transform";
        wrap.style.transform = "translate3d(0,0,0)";
        pearl.style.transform = "none";

        if (cast) {
            const castW = size * 0.7;
            cast.classList.add("is-grounded");
            document.body.appendChild(cast);
            cast.style.position = "fixed";
            cast.style.left = (pearlBox.left + pearlBox.width / 2) + "px";
            cast.style.top = surfaceY + "px";
            cast.style.bottom = "auto";
            cast.style.width = castW + "px";
            cast.style.height = (size * 0.14) + "px";
            cast.style.marginLeft = (-castW * 0.5) + "px";
            cast.style.zIndex = "13";
            cast.style.transform = "translateY(-42%)";
        }

        let y = 0;
        let vy = 0;
        let acc = 0;
        let last = performance.now();
        let still = 0;
        const G = 1950;
        const REST = 0.5;
        const STOP = 48;
        const STEP = 1 / 120;

        function updateShadow(height) {
            if (!cast) return;
            const t = Math.min(1, height / Math.max(floor, 1));
            cast.style.opacity = String(0.22 + (1 - t) * 0.55);
            cast.style.filter = "blur(" + (4 + t * 7) + "px)";
            const sc = 1 + t * 0.22;
            cast.style.transform = "translateY(-42%) scale(" + sc + ", " + (0.9 + t * 0.18) + ")";
        }

        function step(dt) {
            vy += G * dt;
            vy *= 1 - 0.08 * dt;
            y += vy * dt;
            if (y >= floor && vy > 0) {
                y = floor;
                vy = -vy * REST;
                if (Math.abs(vy) < STOP) {
                    vy = 0;
                    y = floor;
                }
            }
        }

        function frame(now) {
            acc += Math.min(0.05, (now - last) / 1000);
            last = now;
            while (acc >= STEP) {
                step(STEP);
                acc -= STEP;
            }
            wrap.style.transform = "translate3d(0," + y + "px,0)";
            updateShadow(Math.max(0, floor - y));
            if (y >= floor - 0.5 && Math.abs(vy) < 0.5) {
                still += 1;
                if (still > 12) {
                    wrap.style.transform = "translate3d(0," + floor + "px,0)";
                    wrap.style.willChange = "auto";
                    updateShadow(0);
                    resolve();
                    return;
                }
            } else {
                still = 0;
            }
            requestAnimationFrame(frame);
        }

        updateShadow(floor);
        requestAnimationFrame(frame);
    });
}

function resetScene0() {
    dropLocked = false;
    pearlSpinning = true;
    document.body.classList.remove("is-dropping");
    const ground = document.getElementById("ground");
    if (ground) ground.classList.remove("is-out");
    const wrap = document.querySelector(".thread-wrap");
    const pearl = document.querySelector(".thread-pearl");
    const cast = document.querySelector(".pearl-cast");
    if (wrap) {
        wrap.classList.remove("is-falling");
        wrap.removeAttribute("style");
        if (cast && cast.parentNode !== wrap) {
            wrap.insertBefore(cast, wrap.firstChild);
        }
    }
    if (cast) {
        cast.classList.remove("is-grounded");
        cast.removeAttribute("style");
    }
    if (pearl) {
        pearl.removeAttribute("style");
        pearl.querySelectorAll(".pearl-cracks").forEach((el) => el.remove());
    }
    document.querySelectorAll(".pearl-shell").forEach((el) => el.remove());
    teardownWorld();
    const groundReset = document.getElementById("ground");
    if (groundReset) {
        groundReset.style.top = "";
        groundReset.style.bottom = "";
        groundReset.style.left = "";
        groundReset.style.right = "";
        groundReset.style.width = "";
        groundReset.style.height = "";
        groundReset.style.transform = "";
        groundReset.style.transformOrigin = "";
        groundReset.style.transition = "";
    }
    [".beam-reveal", ".hover-light"].forEach((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.style.transform = "";
        el.style.transformOrigin = "";
        el.style.transition = "";
    });
    const overlay = document.getElementById("bridge");
    if (overlay) {
        overlay.innerHTML = "";
        overlay.hidden = true;
    }
    if (typeof lightenByHover === "function" && lightenByHover.reset) lightenByHover.reset();
    restartLightLines();
}

async function dropPearlThenBridge() {
    if (bridging) return;
    bridging = true;
    dropLocked = true;
    pearlSpinning = false;
    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    document.body.classList.add("is-dropping");
    stopLightLines();
    lightenByHover.reset();
    scenes[0].classList.add("is-bridging");
    await wait(1000);
    await bouncePearlToGround();
    await wait(200);
    await bridgeToAtoms();
}

function worldLayout(kind, n, size) {
    const cx = 3200;
    const d0 = 160;
    const pack = 190;
    const s = size || 24;
    const out = [];
    function push(x, d, extra) {
        extra = extra || {};
        out.push({
            x: x,
            d: d,
            size: extra.size != null ? extra.size : s,
            lift: extra.lift || 0,
            opacity: extra.opacity != null ? extra.opacity : 1
        });
    }
    if (kind <= 1) {
        for (let i = 0; i < n; i++) {
            const r = Math.sqrt((i + 0.5) / n) * pack;
            const a = i * GOLDEN;
            push(cx + r * Math.cos(a), d0 + pack + r * Math.sin(a));
        }
        return out;
    }
    if (kind === 2) {
        const centers = [[-210, -70], [200, -90], [8, 28], [-230, 120], [210, 110]];
        const counts = [7, 6, 6, 6, 6];
        let i = 0;
        centers.forEach((c, ci) => {
            const count = counts[ci] || 6;
            for (let k = 0; k < count && i < n; k++) {
                const t = Math.sqrt((k + 0.5) / count);
                const a = k * GOLDEN;
                push(cx + c[0] + t * 42 * Math.cos(a), d0 + pack + c[1] + t * 42 * Math.sin(a));
                i += 1;
            }
        });
        while (out.length < n) push(cx, d0 + pack, { opacity: 0 });
        return out;
    }
    if (kind === 3) {
        const centers = [[-210, -70], [200, -90], [8, 28], [-230, 120], [210, 110]];
        const counts = [7, 6, 6, 6, 6];
        let i = 0;
        centers.forEach((c, ci) => {
            const count = counts[ci] || 6;
            const w = (WEIGHT_VALS[ci] || 50) / 100;
            for (let k = 0; k < count && i < n; k++) {
                const t = Math.sqrt((k + 0.5) / count);
                const a = k * GOLDEN;
                push(
                    cx + c[0] + t * 38 * Math.cos(a),
                    d0 + pack + c[1] + t * 38 * Math.sin(a),
                    { size: s * (0.72 + w * 0.7), lift: -8 - w * 36 }
                );
                i += 1;
            }
        });
        while (out.length < n) push(cx, d0 + pack, { opacity: 0 });
        return out;
    }
    if (kind === 4) {
        const half = Math.floor(n / 2);
        for (let i = 0; i < n; i++) {
            const left = i < half;
            const k = left ? i : i - half;
            const group = left ? half : n - half;
            const t = Math.sqrt((k + 0.5) / group);
            const a = k * GOLDEN;
            const ox = left ? -240 : 240;
            push(cx + ox + t * 70 * Math.cos(a), d0 + pack + t * 70 * Math.sin(a));
        }
        return out;
    }
    if (kind === 5) {
        for (let i = 0; i < n; i++) {
            const t = n === 1 ? 0.5 : i / (n - 1);
            push(
                cx + (t - 0.5) * 560,
                d0 + pack + Math.sin(t * Math.PI * 2.2) * 90 + (i % 3 - 1) * 16
            );
        }
        return out;
    }
    if (kind === 6) {
        const podium = [[0, -20, 1.35, -28], [90, 18, 1.12, -14], [-90, 28, 1, -8]];
        for (let i = 0; i < n; i++) {
            if (i < 3) {
                const p = podium[i];
                push(cx + p[0], d0 + pack + p[1], { size: s * p[2], lift: p[3] });
            } else {
                const t = (i - 3) / Math.max(1, n - 4);
                push(cx + (t - 0.5) * 420, d0 + pack + 120, { size: s * 0.72, opacity: 0.38 });
            }
        }
        return out;
    }
    if (kind === 7) {
        const cols = 3;
        const rows = 2;
        for (let i = 0; i < n; i++) {
            if (i < 6) {
                const c = i % cols;
                const r = Math.floor(i / cols);
                push(cx + (c - 1) * 90, d0 + pack + (r - 0.5) * 90, { size: s * 1.15 });
            } else {
                const t = (i - 6) / Math.max(1, n - 7);
                const a = t * Math.PI * 2;
                push(cx + Math.cos(a) * 200, d0 + pack + Math.sin(a) * 140, { size: s * 0.7, opacity: 0.28 });
            }
        }
        return out;
    }
    for (let i = 0; i < n; i++) {
        const t = Math.sqrt((i + 0.5) / n);
        const a = i * GOLDEN;
        push(cx + t * 70 * Math.cos(a), d0 + pack + t * 90 * Math.sin(a) - 20, { size: s * 0.85, opacity: 0.7 });
    }
    return out;
}

function layoutWorld(kind) {
    if (!worldActors.length) return;
    const floor = document.getElementById("world-floor");
    if (floor) {
        floor.style.transition = "opacity 0.9s ease";
        floor.style.opacity = kind === 8 ? "0.14" : "1";
    }
    const targets = worldLayout(kind, worldActors.length, worldBallSize);
    worldActors.forEach((el, i) => {
        const t = targets[i] || targets[targets.length - 1];
        el.style.transition =
            "left 1.15s cubic-bezier(0.22, 1, 0.36, 1), bottom 1.15s cubic-bezier(0.22, 1, 0.36, 1), transform 1.15s cubic-bezier(0.22, 1, 0.36, 1), width 1.15s cubic-bezier(0.22, 1, 0.36, 1), height 1.15s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.7s ease";
        el.style.width = t.size + "px";
        el.style.height = t.size + "px";
        el.style.opacity = String(t.opacity);
        floorActor(el, t.x, t.d, t.lift);
    });
}

function showWorldIran(on) {
    const view = document.getElementById("world-view");
    if (!view) return;
    let map = view.querySelector(".world-iran");
    if (on && !map) {
        const src = document.querySelector(".iran-map");
        if (!src) return;
        map = src.cloneNode(true);
        map.classList.add("world-iran");
        map.classList.remove("iran-map");
        view.appendChild(map);
    }
    if (map) map.classList.toggle("is-on", !!on);
}

async function goWorldScene(target) {
    if (bridging) return;
    bridging = true;
    if (next) next.hidden = true;
    if (prev) prev.hidden = true;
    const cur = scenes[sceneIndex];
    if (cur) cur.classList.add("is-bridging");
    await wait(380);
    layoutWorld(target);
    showWorldIran(target === 8);
    await wait(1180);
    if (cur) cur.classList.remove("is-bridging");
    bridging = false;
    setScene(target);
}

function go(i) {
    const target = Math.max(0, Math.min(scenes.length - 1, i));
    if (window.scrollToStoryScene) {
        window.scrollToStoryScene(target);
        return;
    }
    if (bridging || target === sceneIndex) return;
    if (sceneIndex === 0 && target === 1) {
        dropPearlThenBridge();
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
document.body.dataset.scene = "0";
document.documentElement.classList.add("story-scroll-mode");

(function bindStoryScrub() {
    const FROM = ["", "bridge", "rooms", "weights", "arcs", "spark", "benches", "matrix", "iran"];
    const MARKS = [0, 0.54, 0.73, 0.82, 0.90, 0.95, 0.975, 0.992, 1];
    const P = {
        drop: [0.00, 0.04],
        zoom: [0.04, 0.13],
        enter: [0.13, 0.31],
        cam: [0.31, 0.43],
        rooms: [0.66, 0.73],
        weights: [0.76, 0.82],
        arcs: [0.85, 0.90],
        spark: [0.92, 0.95],
        benches: [0.96, 0.975],
        matrix: [0.98, 0.992],
        iran: [0.994, 1]
    };

    function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
    function seg(p, a, b) { return b === a ? 1 : clamp01((p - a) / (b - a)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function easeOutBounce(x) {
        const n1 = 7.5625;
        const d1 = 2.75;
        if (x < 1 / d1) return n1 * x * x;
        if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
        if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
        return n1 * (x -= 2.625 / d1) * x + 0.984375;
    }
    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function overlay() { return document.getElementById("bridge"); }

    const pin = { on: false, startTop: 0, floor: 0, left: 0, width: 0, size: 0, surfaceY: 0, ox: 0 };
    let enterOrbs = [];
    let enterMeta = [];
    let camReady = false;
    let camActors = [];
    let zoomAmt = 0.08;
    let zoomSurfaces = null;
    const caches = {};
    let activeMorph = "";

    function pinBall() {
        if (pin.on) return;
        const wrap = document.querySelector(".thread-wrap");
        const pearl = document.querySelector(".thread-pearl");
        const cast = document.querySelector(".pearl-cast");
        if (!wrap || !pearl) return;
        const wrapBox = wrap.getBoundingClientRect();
        const pearlBox = pearl.getBoundingClientRect();
        const size = pearlBox.height;
        const ground = document.getElementById("ground");
        const surfaceY = ground
            ? ground.getBoundingClientRect().top
            : window.innerHeight - Math.min(window.innerHeight * 0.18, 152);
        pin.startTop = wrapBox.top;
        pin.floor = Math.max(8, surfaceY - size - wrapBox.top);
        pin.left = wrapBox.left;
        pin.width = wrapBox.width;
        pin.size = size;
        pin.surfaceY = surfaceY;
        pin.ox = pearlBox.left + pearlBox.width / 2;
        wrap.classList.add("is-falling");
        wrap.style.position = "fixed";
        wrap.style.left = wrapBox.left + "px";
        wrap.style.top = wrapBox.top + "px";
        wrap.style.width = wrapBox.width + "px";
        wrap.style.height = size + "px";
        wrap.style.zIndex = "14";
        wrap.style.overflow = "visible";
        wrap.style.pointerEvents = "none";
        wrap.style.transition = "none";
        wrap.style.visibility = "visible";
        wrap.style.opacity = "1";
        wrap.style.setProperty("--pearl-d", size + "px");
        if (pearl) {
            pearl.style.width = size + "px";
            pearl.style.height = size + "px";
            pearl.style.left = "50%";
            pearl.style.top = "0";
            pearl.style.margin = "0 0 0 " + (-size / 2) + "px";
        }
        document.body.appendChild(wrap);
        if (cast) {
            const castW = size * 0.7;
            cast.classList.add("is-grounded");
            document.body.appendChild(cast);
            cast.style.position = "fixed";
            cast.style.left = (pearlBox.left + pearlBox.width / 2) + "px";
            cast.style.top = surfaceY + "px";
            cast.style.bottom = "auto";
            cast.style.width = castW + "px";
            cast.style.height = (size * 0.14) + "px";
            cast.style.marginLeft = (-castW * 0.5) + "px";
            cast.style.zIndex = "13";
        }
        pin.on = true;
        dropLocked = true;
        pearlSpinning = false;
        stopLightLines();
        document.body.classList.add("is-dropping");
    }

    function resetZoomSurfaces() {
        ["#ground", ".beam-reveal", ".hover-light"].forEach((sel) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.style.transform = "";
            el.style.transformOrigin = "";
            el.style.transition = "";
            el.style.opacity = "";
            el.style.top = "";
            el.style.left = "";
            el.style.width = "";
            el.style.height = "";
            el.style.bottom = "";
            el.style.right = "";
        });
        const ground = document.getElementById("ground");
        if (ground) ground.classList.remove("is-out");
        zoomSurfaces = null;
    }

    function unpinBall() {
        reverseCamera();
        hideAllMorphs();
        const wrap = document.querySelector(".thread-wrap");
        const pearl = document.querySelector(".thread-pearl");
        const stage = document.querySelector("scene[data-step='0'] .stage");
        if (wrap && stage) {
            wrap.classList.remove("is-falling", "world-ball");
            wrap.removeAttribute("style");
            if (wrap.parentNode !== stage) stage.appendChild(wrap);
        }
        if (pearl) pearl.removeAttribute("style");
        const cast = document.querySelector(".pearl-cast");
        if (cast && wrap) {
            cast.classList.remove("is-grounded");
            cast.removeAttribute("style");
            if (cast.parentNode !== wrap) wrap.insertBefore(cast, wrap.firstChild);
        }
        resetZoomSurfaces();
        const ov = overlay();
        if (ov) {
            ov.innerHTML = "";
            ov.hidden = true;
        }
        enterOrbs = [];
        enterMeta = [];
        camActors = [];
        camReady = false;
        worldActors = [];
        pin.on = false;
        dropLocked = false;
        pearlSpinning = true;
        restartLightLines();
        document.body.classList.remove("is-dropping", "has-world-atoms");
        presentRest(0);
    }

    function reverseCamera() {
        if (!camReady) return;
        const wrap = document.querySelector(".thread-wrap");
        const ov = overlay();
        if (wrap) {
            wrap.classList.remove("world-ball");
            document.body.appendChild(wrap);
            wrap.style.position = "fixed";
            wrap.style.left = pin.left + "px";
            wrap.style.top = pin.startTop + "px";
            wrap.style.width = pin.width + "px";
            wrap.style.height = pin.size + "px";
            wrap.style.bottom = "auto";
            wrap.style.right = "auto";
            wrap.style.margin = "0";
            wrap.style.zIndex = "14";
            wrap.style.transformOrigin = "50% 100%";
            wrap.style.transition = "none";
            const inner = wrap.querySelector(".thread-pearl");
            if (inner) {
                inner.style.width = "100%";
                inner.style.height = "100%";
                inner.style.left = "0";
                inner.style.top = "0";
                inner.style.margin = "0";
            }
        }
        if (ov) {
            ov.hidden = false;
            enterOrbs.forEach((el) => {
                el.classList.remove("world-ball");
                el.style.position = "fixed";
                el.style.bottom = "auto";
                el.style.right = "auto";
                el.style.margin = "0";
                el.style.transition = "none";
                el.style.width = (el._orbSize || worldBallSize) + "px";
                el.style.height = (el._orbSize || worldBallSize) + "px";
                ov.appendChild(el);
            });
        }
        const view = document.getElementById("world-view");
        if (view) view.remove();
        const groundBack = document.getElementById("ground");
        if (groundBack) {
            groundBack.classList.remove("is-out");
            groundBack.style.opacity = "";
        }
        camReady = false;
        camActors = [];
        worldActors = [];
        document.body.classList.remove("has-world-atoms");
        invalidateMorphs();
    }

    function clearSceneFlags() {
        scenes.forEach((s) => {
            s.classList.remove(
                "is-on", "is-prep", "is-bridging", "is-wait-copy", "is-thread-out",
                "is-from-bridge", "is-from-rooms", "is-from-weights", "is-from-arcs",
                "is-from-spark", "is-from-benches", "is-from-matrix", "is-from-iran",
                "is-awaiting-arcs", "is-awaiting-spark", "is-awaiting-benches",
                "is-awaiting-matrix", "is-awaiting-iran"
            );
            s.style.opacity = "";
            s.style.setProperty("--copy-on", "0");
        });
        if (atoms) atoms.classList.remove("is-awaiting");
        if (rooms) rooms.classList.remove("is-awaiting");
        if (weights) weights.classList.remove("is-awaiting");
        if (matrix) matrix.classList.remove("is-awaiting");
    }

    function syncRail(i) {
        sceneIndex = i;
        dots.forEach((d, n) => d.setAttribute("aria-current", n === i ? "true" : "false"));
        document.body.dataset.scene = String(i);
    }

    function presentRest(i) {
        clearSceneFlags();
        scenes[i].classList.add("is-on");
        if (FROM[i]) scenes[i].classList.add("is-from-" + FROM[i]);
        scenes[i].style.setProperty("--copy-on", "1");
        if (i === 1) {
            document.body.classList.add("has-world-atoms");
            if (atoms) atoms.classList.add("is-awaiting");
        } else {
            document.body.classList.remove("has-world-atoms");
        }
        syncRail(i);
    }

    function presentMorph(fromI, toI, t) {
        if (t <= 0) {
            presentRest(fromI);
            return { setup: 0, body: 0, reveal: 0 };
        }
        if (t >= 1) {
            presentRest(toI);
            return { setup: 1, body: 1, reveal: 1 };
        }
        const setup = clamp01(t / 0.10);
        const body = clamp01((t - 0.08) / 0.62);
        const reveal = clamp01((t - 0.48) / 0.34);
        clearSceneFlags();
        scenes[fromI].classList.add("is-on", "is-bridging");
        if (FROM[fromI]) scenes[fromI].classList.add("is-from-" + FROM[fromI]);
        scenes[fromI].style.setProperty("--copy-on", fromI === 1 ? "0" : String(1 - setup));
        scenes[toI].classList.add("is-on");
        if (FROM[toI]) scenes[toI].classList.add("is-from-" + FROM[toI]);
        scenes[toI].style.setProperty("--copy-on", String(reveal));
        syncRail(t < 0.5 ? fromI : toI);
        return { setup: setup, body: easeOut(body), reveal: reveal };
    }

    function hideCache(key) {
        const c = caches[key];
        if (!c) return;
        if (c.root) c.root.style.display = "none";
        if (!c.owned) {
            (c.els || []).forEach((el) => { if (el) el.style.display = "none"; });
        }
        if (c.svg) c.svg.style.display = "none";
        if (activeMorph === key) activeMorph = "";
        const ov = overlay();
        if (ov && !activeMorph && camReady) ov.hidden = true;
    }

    function showCache(key) {
        const c = caches[key];
        if (!c) return;
        const ov = overlay();
        if (!ov) return;
        ov.hidden = false;
        if (c.root && c.root.parentNode !== ov) ov.appendChild(c.root);
        if (c.svg && c.svg.parentNode !== ov) ov.appendChild(c.svg);
        if (c.root) c.root.style.display = "";
        if (c.svg) c.svg.style.display = "";
        (c.els || []).forEach((el) => {
            if (!el) return;
            if (el.parentNode !== ov && el.parentNode !== c.root && el.parentNode !== c.svg) ov.appendChild(el);
            el.style.display = "";
        });
    }

    function hideAllMorphs() {
        restoreRoomsOriginals();
        Object.keys(caches).forEach(hideCache);
        activeMorph = "";
        const ov = overlay();
        if (ov && !enterOrbs.some((el) => el.parentNode === ov)) {
            const hasOrbs = enterOrbs.some((el) => ov.contains(el));
            if (!hasOrbs && !camReady) ov.hidden = true;
        }
    }

    function invalidateMorphs() {
        restoreRoomsOriginals();
        Object.keys(caches).forEach((key) => {
            const c = caches[key];
            if (!c.owned) {
                (c.els || []).forEach((el) => { if (el && el.parentNode) el.parentNode.removeChild(el); });
            }
            if (c.svg && c.svg.parentNode) c.svg.parentNode.removeChild(c.svg);
            if (c.root && c.root.parentNode) c.root.parentNode.removeChild(c.root);
            delete caches[key];
        });
        activeMorph = "";
    }

    function activateMorph(key) {
        if (activeMorph === key) {
            showCache(key);
            return;
        }
        Object.keys(caches).forEach((k) => { if (k !== key) hideCache(k); });
        activeMorph = key;
        showCache(key);
    }

    function withPrep(i, fn) {
        const s = scenes[i];
        const on = s.classList.contains("is-on");
        s.classList.add("is-on", "is-prep");
        void s.offsetWidth;
        const out = fn();
        s.classList.remove("is-prep");
        if (!on) s.classList.remove("is-on");
        return out;
    }

    function applyDrop(t) {
        const wrap = document.querySelector(".thread-wrap");
        if (!wrap) return;
        if (t <= 0) return;
        pinBall();
        const y = pin.floor * (1 - (1 - t) * (1 - t));
        wrap.style.transform = "translate3d(0," + y + "px,0)";
        wrap.style.transformOrigin = "50% 100%";
        const cast = document.querySelector(".pearl-cast");
        if (cast) {
            const h = Math.max(0, pin.floor - y);
            const u = Math.min(1, h / Math.max(pin.floor, 1));
            cast.style.opacity = String(0.22 + (1 - u) * 0.55);
            cast.style.filter = "blur(" + (4 + u * 7) + "px)";
            cast.style.transform = "translateY(-42%) scale(" + (1 + u * 0.22) + "," + (0.9 + u * 0.18) + ")";
        }
        if (t < 1) {
            clearSceneFlags();
            scenes[0].classList.add("is-on", "is-bridging");
            scenes[0].style.setProperty("--copy-on", String(1 - clamp01(t / 0.22)));
            syncRail(0);
        }
    }

    function applyZoom(t) {
        const wrap = document.querySelector(".thread-wrap");
        if (!pin.on || !wrap || camReady) return;
        zoomAmt = Math.max(0.05, 24 / Math.max(pin.size, 1));
        if (t <= 0) {
            wrap.style.transform = "translate3d(0," + pin.floor + "px,0)";
            wrap.style.transformOrigin = "50% 100%";
            resetZoomSurfaces();
            return;
        }
        const s = lerp(1, zoomAmt, easeInOut(t));
        const ox = pin.ox;
        const oy = pin.surfaceY;
        if (!zoomSurfaces) {
            expandGround(ox, oy, zoomAmt);
            const ground = document.getElementById("ground");
            const beam = document.querySelector(".beam-reveal");
            const light = document.querySelector(".hover-light");
            zoomSurfaces = [ground, beam, light].map((el) => {
                if (!el) return null;
                const box = el.getBoundingClientRect();
                return { el: el, ox: ox - box.left, oy: oy - box.top };
            }).filter(Boolean);
        }
        zoomSurfaces.forEach((item) => {
            item.el.style.transition = "none";
            item.el.style.transformOrigin = item.ox + "px " + item.oy + "px";
            item.el.style.transform = "scale(" + s + ")";
            item.el.style.opacity = "";
        });
        wrap.style.transformOrigin = "50% 100%";
        wrap.style.transform = "translate3d(0," + pin.floor + "px,0) scale(" + s + ")";
        const groundNow = document.getElementById("ground");
        if (groundNow) {
            groundNow.classList.remove("is-out");
            groundNow.style.opacity = "";
        }
        if (t < 1 && t > 0) {
            clearSceneFlags();
            scenes[0].classList.add("is-on", "is-bridging");
            scenes[0].style.setProperty("--copy-on", "0");
            syncRail(0);
        }
    }

    function ensureEnterOrbs() {
        if (enterOrbs.length) return;
        const ov = overlay();
        const wrap = document.querySelector(".thread-wrap");
        if (!ov || !wrap) return;
        const live = pearlScreen();
        const orbSize = Math.max(18, Math.round(live && live.size ? live.size : 24));
        const ground = document.getElementById("ground");
        const groundY = ground ? ground.getBoundingClientRect().top : pin.surfaceY;
        const w = window.innerWidth;
        const ox = live ? live.x : w / 2;
        ov.hidden = false;
        const nOrbs = 30;
        const pack2d = Math.min(w * 0.14, 120);
        for (let i = 0; i < nOrbs; i++) {
            const radius = Math.sqrt((i + 0.5) / nOrbs) * pack2d;
            const angle = i * GOLDEN;
            const destX = ox + radius * Math.cos(angle);
            const fromLeft = destX < ox;
            const el = makeMiniOrb(i % 5 === 0, i);
            el.style.width = orbSize + "px";
            el.style.height = orbSize + "px";
            el._orbSize = orbSize;
            ov.appendChild(el);
            enterOrbs.push(el);
            enterMeta.push({
                fromX: fromLeft ? -orbSize : w + orbSize,
                destX: destX,
                fromY: groundY - orbSize / 2,
                destY: groundY - orbSize / 2,
                delay: (i % 12) * 0.035,
                size: orbSize
            });
        }
        worldBallSize = orbSize;
    }

    function applyEnter(t) {
        const ov = overlay();
        if (camReady) return;
        if (t <= 0) {
            enterOrbs.forEach((el) => { el.style.opacity = "0"; });
            if (ov && !activeMorph) ov.hidden = true;
            return;
        }
        ensureEnterOrbs();
        if (ov) ov.hidden = false;
        enterOrbs.forEach((el, i) => {
            const m = enterMeta[i];
            const u = clamp01((t - m.delay) / Math.max(0.001, 1 - m.delay));
            const e = easeInOut(u);
            const x = lerp(m.fromX, m.destX, e);
            const y = lerp(m.fromY, m.destY, e);
            el.style.opacity = u > 0 ? "1" : "0";
            el.style.left = x + "px";
            el.style.top = y + "px";
            el.style.bottom = "auto";
            el.style.transform = "translate(-50%, -50%)";
        });
        if (t < 1) {
            clearSceneFlags();
            scenes[0].classList.add("is-on", "is-bridging");
            scenes[0].style.setProperty("--copy-on", "0");
            syncRail(0);
        }
    }

    function applyCamera(t, present, p) {
        const wrap = document.querySelector(".thread-wrap");
        const ov = overlay();
        const ground = document.getElementById("ground");
        if (t <= 0) return;
        if (present == null) present = true;
        ensureEnterOrbs();
        const live = pearlScreen();
        const ox = live ? live.x : window.innerWidth / 2;
        const vw = window.innerWidth;
        const floorW = 6400;
        let horizonY = pin.surfaceY || window.innerHeight;
        if (!camReady) {
            const probe = enterOrbs[0] || wrap;
            if (probe) {
                const pb = probe.getBoundingClientRect();
                if (pb.height) horizonY = pb.top + pb.height;
            } else if (ground) {
                horizonY = ground.getBoundingClientRect().top;
            }
        }
        const view = camReady
            ? (document.getElementById("world-view") || ensureWorld(ox, horizonY))
            : ensureWorld(ox, horizonY);
        if (!view) return;
        view.style.visibility = "visible";
        view.style.opacity = "1";
        const floor = document.getElementById("world-floor");
        const poseFront = { tilt: 90, s: 1, y: 0, z: 0 };
        const poseTop = { tilt: 16, s: 1.55, y: -8, z: 16 };
        const hold = 0.22;
        const camT = t <= hold ? 0 : (t - hold) / (1 - hold);
        const e = easeInOut(camT);
        const pose = {
            tilt: lerp(poseFront.tilt, poseTop.tilt, e),
            s: lerp(poseFront.s, poseTop.s, e),
            y: lerp(poseFront.y, poseTop.y, e),
            z: lerp(poseFront.z, poseTop.z, e)
        };
        const nearDepth = 0;
        const pack = 190;
        const mainX = floorW / 2;
        if (!camReady && floor && wrap) {
            setWorldPose(view, poseFront);
            if (floor) floor.style.setProperty("--floor-fade", "0");
            void view.offsetWidth;
            adoptToFloor(wrap, floor, floorW, vw, nearDepth, worldBallSize);
            camActors = [{
                el: wrap,
                x0: parseFloat(wrap.style.left) || mainX,
                d0: nearDepth,
                x1: mainX,
                d1: pack
            }];
            enterOrbs.forEach((el, i) => {
                adoptToFloor(el, floor, floorW, vw, nearDepth, worldBallSize);
                const startX = parseFloat(el.style.left);
                const radius = Math.sqrt((i + 0.5) / enterOrbs.length) * pack;
                const angle = i * GOLDEN;
                camActors.push({
                    el: el,
                    x0: startX,
                    d0: nearDepth,
                    x1: mainX + radius * Math.cos(angle),
                    d1: pack + radius * Math.sin(angle)
                });
            });
            camReady = true;
            worldActors = [wrap].concat(enterOrbs);
            if (ov && !activeMorph) ov.hidden = true;
        }
        setWorldPose(view, pose);
        if (floor) floor.style.setProperty("--floor-fade", String(Math.min(1, camT * 1.35)));
        camActors.forEach((a) => {
            floorActor(a.el, lerp(a.x0, a.x1, e), lerp(a.d0, a.d1, e), 0);
        });
        if (ground) {
            ground.style.transition = "none";
            ground.style.opacity = String(1 - camT);
            if (camT >= 1) ground.classList.add("is-out");
            else ground.classList.remove("is-out");
        }
        const cast = document.querySelector(".pearl-cast");
        if (cast) cast.style.opacity = "0";
        if (!present) return;
        if (camT < 1) {
            clearSceneFlags();
            scenes[0].classList.add("is-on", "is-bridging");
            scenes[0].style.setProperty("--copy-on", "0");
            document.body.classList.toggle("has-world-atoms", camT > 0.55);
            if (atoms) atoms.classList.toggle("is-awaiting", camT > 0.55);
            syncRail(0);
            return;
        }
        const restSpan = Math.max(0.001, P.rooms[0] - P.cam[1]);
        const u = p == null ? 1 : clamp01((p - P.cam[1]) / restSpan);
        let rest = 0;
        if (u < 0.36) rest = u / 0.36;
        else if (u < 0.70) rest = 1;
        else if (u < 0.84) rest = 1 - (u - 0.70) / 0.14;
        else rest = 0;
        clearSceneFlags();
        scenes[1].classList.add("is-on", "is-from-bridge");
        scenes[1].style.setProperty("--copy-on", String(rest));
        document.body.classList.add("has-world-atoms");
        if (atoms) atoms.classList.add("is-awaiting");
        syncRail(1);
    }

    function cloneCanvas(src) {
        const srcCanvas = src && src.querySelector && src.querySelector("canvas");
        const el = document.createElement("div");
        el.className = "mini-orb";
        el.style.position = "fixed";
        el.style.transform = "translate(-50%, -50%)";
        if (srcCanvas) {
            const c = document.createElement("canvas");
            c.width = srcCanvas.width;
            c.height = srcCanvas.height;
            c.getContext("2d").drawImage(srcCanvas, 0, 0);
            el.appendChild(c);
        }
        return el;
    }

    function putBox(el, a, b, t) {
        const q = b || a;
        el.style.position = "fixed";
        el.style.left = lerp(a.x, q.x, t) + "px";
        el.style.top = lerp(a.y, q.y, t) + "px";
        el.style.width = lerp(a.w, q.w, t) + "px";
        el.style.height = lerp(a.h, q.h, t) + "px";
        el.style.transform = "translate(-50%, -50%)";
        el.style.opacity = "1";
    }

    function boxOf(el) {
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
    }

    function restoreRoomsOriginals() {
        const c = caches.rooms;
        if (!c || !c.owned) return;
        const floor = document.getElementById("world-floor");
        (c.els || []).forEach((el, i) => {
            if (!el) return;
            el.style.display = "";
            el.style.opacity = "1";
            el.style.position = "absolute";
            el.style.right = "auto";
            el.style.margin = "0";
            el.style.transformOrigin = "50% 100%";
            el.classList.add("world-ball");
            const pose = c.floorPose && c.floorPose[i];
            if (floor && pose) {
                floorActor(el, pose.x, pose.d, 0);
                floor.appendChild(el);
            }
        });
        c.owned = false;
    }

    function applyRooms(t) {
        const world = document.getElementById("world-view");
        if (t <= 0) {
            restoreRoomsOriginals();
            hideCache("rooms");
            if (world) {
                world.style.opacity = "1";
                world.style.visibility = "visible";
            }
            if (rooms) {
                rooms.classList.remove("is-awaiting");
                rooms.style.removeProperty("--rooms-draw");
                rooms.style.removeProperty("--rooms-dots");
            }
            return;
        }
        if (!caches.rooms) {
            const fromEls = worldActors.length ? worldActors : [...atoms.children];
            const from = fromEls.map(boxOf);
            const to = withPrep(2, () => [...rooms.querySelectorAll("em")].map(boxOf));
            const cardBoxes = withPrep(2, () => [...rooms.children].map((card) => card.getBoundingClientRect()));
            const ov = overlay();
            const floorPose = fromEls.map((el) => {
                const a = camActors.find((c) => c.el === el);
                return {
                    x: a ? a.x1 : (parseFloat(el.style.left) || 0),
                    d: a ? a.d1 : 0
                };
            });
            const owned = worldActors.length > 0;
            const els = fromEls.map((src, i) => {
                if (!owned) {
                    const clone = cloneCanvas(src);
                    clone.style.width = from[i].w + "px";
                    clone.style.height = from[i].h + "px";
                    ov.appendChild(clone);
                    return clone;
                }
                src.classList.remove("world-ball");
                src.style.position = "fixed";
                src.style.left = from[i].x + "px";
                src.style.top = from[i].y + "px";
                src.style.width = from[i].w + "px";
                src.style.height = from[i].h + "px";
                src.style.bottom = "auto";
                src.style.right = "auto";
                src.style.margin = "0";
                src.style.transform = "translate(-50%, -50%)";
                src.style.transformOrigin = "50% 50%";
                src.style.zIndex = "17";
                src.style.opacity = "1";
                ov.appendChild(src);
                return src;
            });
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("class", "bridge-svg");
            const strokes = cardBoxes.map((b) => {
                const rx = 16;
                const r = document.createElementNS(ns, "rect");
                r.setAttribute("x", String(b.left));
                r.setAttribute("y", String(b.top));
                r.setAttribute("width", String(b.width));
                r.setAttribute("height", String(b.height));
                r.setAttribute("rx", String(rx));
                r.setAttribute("ry", String(rx));
                r.setAttribute("fill", "none");
                r.setAttribute("stroke", "rgba(236, 226, 208, 0.55)");
                r.setAttribute("stroke-width", "1.5");
                r.setAttribute("stroke-linecap", "round");
                r.setAttribute("stroke-linejoin", "round");
                const rad = Math.min(rx, b.width / 2, b.height / 2);
                const peri = Math.max(1, 2 * (b.width + b.height - 2 * rad) + 2 * Math.PI * rad);
                r.setAttribute("stroke-dasharray", String(peri));
                r.setAttribute("stroke-dashoffset", String(peri));
                svg.appendChild(r);
                return { el: r, peri: peri };
            });
            ov.appendChild(svg);
            caches.rooms = { els: els, from: from, to: to, svg: svg, strokes: strokes, owned: owned, floorPose: floorPose };
            if (world) {
                world.style.opacity = "0";
                world.style.visibility = "hidden";
            }
        }
        activateMorph("rooms");
        const ph = presentMorph(1, 2, t);
        const e = ph.body;
        caches.rooms.els.forEach((el, i) => {
            putBox(el, caches.rooms.from[i], caches.rooms.to[i] || caches.rooms.from[i], e);
            el.style.opacity = t >= 1 ? "0" : String(1 - ph.reveal);
        });
        const draw = clamp01((e - 0.12) / 0.55);
        const fill = clamp01((e - 0.72) / 0.22);
        (caches.rooms.strokes || []).forEach((s) => {
            s.el.setAttribute("stroke-dashoffset", String(s.peri * (1 - draw)));
            s.el.style.opacity = String((1 - ph.reveal) * (draw > 0 ? 1 : 0));
        });
        if (caches.rooms.svg) caches.rooms.svg.style.opacity = String(1 - ph.reveal);
        if (world) {
            world.style.opacity = "0";
            world.style.visibility = "hidden";
        }
        if (rooms) {
            rooms.classList.toggle("is-awaiting", fill <= 0);
            rooms.style.setProperty("--rooms-draw", String(fill));
            rooms.style.setProperty("--rooms-dots", String(ph.reveal));
        }
        if (t < 1) document.body.classList.toggle("has-world-atoms", t < 0.45);
        if (t >= 1) {
            hideCache("rooms");
            const ov = overlay();
            if (ov && camReady) ov.hidden = true;
        }
    }

    function applyWeights(t) {
        if (t <= 0) {
            hideCache("weights");
            if (rooms) rooms.classList.remove("is-awaiting");
            if (weights) weights.classList.remove("is-awaiting");
            return;
        }
        if (!caches.weights) {
            const cards = [...rooms.children];
            const from = withPrep(2, () => cards.map((card) => {
                const b = card.getBoundingClientRect();
                const dots = [...card.querySelectorAll("em")].map((em) => {
                    const eb = em.getBoundingClientRect();
                    return { x: eb.left - b.left, y: eb.top - b.top, bg: em.style.background || "#1b242e" };
                });
                return { x: b.left, y: b.top, w: b.width, h: b.height, dots: dots };
            }));
            const dest = withPrep(3, () => [...weights.querySelectorAll(".bar")].map((bar) => {
                const knob = bar.querySelector("span");
                return { bar: bar.getBoundingClientRect(), knob: knob.getBoundingClientRect() };
            }));
            const ov = overlay();
            const els = from.map((f, i) => {
                const box = document.createElement("div");
                box.className = "bridge-morph";
                box.style.left = f.x + "px";
                box.style.top = f.y + "px";
                box.style.width = f.w + "px";
                box.style.height = f.h + "px";
                box.style.background = ROOM_COLORS[i] || "#2c2622";
                f.dots.forEach((d) => {
                    const dot = document.createElement("div");
                    dot.className = "bridge-morph-dot";
                    dot.style.left = d.x + "px";
                    dot.style.top = d.y + "px";
                    dot.style.background = d.bg;
                    box.appendChild(dot);
                });
                ov.appendChild(box);
                return box;
            });
            const lines = dest.map((d) => {
                const line = document.createElement("div");
                line.className = "bridge-line";
                line.style.left = d.bar.left + "px";
                line.style.top = (d.bar.top + d.bar.height / 2 - 1.5) + "px";
                line.style.width = d.bar.width + "px";
                const fill = document.createElement("i");
                fill.style.width = "0";
                line.appendChild(fill);
                ov.insertBefore(line, ov.firstChild);
                return line;
            });
            caches.weights = { els: els.concat(lines), boxes: els, lines: lines, from: from, dest: dest };
        }
        activateMorph("weights");
        const ph = presentMorph(2, 3, t);
        const e = ph.body;
        caches.weights.boxes.forEach((box, i) => {
            const a = caches.weights.from[i];
            const d = caches.weights.dest[i];
            if (!d) {
                box.style.opacity = "0";
                return;
            }
            const kr = d.knob;
            box.style.left = lerp(a.x, kr.left, e) + "px";
            box.style.top = lerp(a.y, kr.top, e) + "px";
            box.style.width = lerp(a.w, kr.width, e) + "px";
            box.style.height = lerp(a.h, kr.height, e) + "px";
            box.style.borderRadius = lerp(16, 99, e) + "px";
            box.style.background = e > 0.45 ? "#b08948" : (ROOM_COLORS[i] || "#2c2622");
            box.style.borderColor = e > 0.45 ? "transparent" : "";
            box.style.opacity = String(1 - ph.reveal);
            box.querySelectorAll(".bridge-morph-dot").forEach((dot) => {
                dot.style.opacity = String(1 - e);
            });
        });
        caches.weights.lines.forEach((line, i) => {
            const fill = line.querySelector("i");
            const u = clamp01((e - 0.15) / 0.85);
            line.style.opacity = String(u * (1 - ph.reveal));
            if (fill) fill.style.width = ((WEIGHT_VALS[i] || 50) * u) + "%";
        });
        if (rooms) rooms.classList.add("is-awaiting");
        if (weights) weights.classList.toggle("is-awaiting", ph.reveal < 1);
        if (t >= 1) hideCache("weights");
    }

    function cubicD(p0, c1, c2, p3) {
        return "M" + p0.x + " " + p0.y + " C " + c1.x + " " + c1.y + ", " + c2.x + " " + c2.y + ", " + p3.x + " " + p3.y;
    }

    function applyArcs(t) {
        if (t <= 0) {
            hideCache("arcs");
            return;
        }
        if (!caches.arcs) {
            const ns = "http://www.w3.org/2000/svg";
            const rows = withPrep(3, () => [...weights.querySelectorAll(".bar")].slice(0, 5).map((bar) => {
                const knob = bar.querySelector("span");
                const br = bar.getBoundingClientRect();
                const kr = knob.getBoundingClientRect();
                return {
                    x1: br.left, x2: br.right, y: br.top + br.height / 2,
                    kx: kr.left + kr.width / 2, ky: kr.top + kr.height / 2,
                    r: Math.max(kr.width, kr.height) / 2
                };
            }));
            const mapped = withPrep(4, () => {
                const arcSvg = document.querySelector(".arc-map");
                if (!arcSvg || !arcSvg.getScreenCTM()) return null;
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
                    stroke: d.stroke, w: d.w, op: d.op
                }));
                return { endCircles: endCircles, endPaths: endPaths };
            });
            if (!mapped) return;
            const ov = overlay();
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("class", "bridge-svg");
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
            ov.appendChild(svg);
            const alt = rows.map((row, i) => ({ kx: i % 2 === 0 ? row.x1 : row.x2, ky: row.y }));
            const merge = [
                { y: (rows[0].y + rows[1].y) / 2, x1: Math.min(rows[0].x1, rows[1].x1), x2: Math.max(rows[0].x2, rows[1].x2) },
                { y: (rows[2].y + rows[3].y) / 2, x1: Math.min(rows[2].x1, rows[3].x1), x2: Math.max(rows[2].x2, rows[3].x2) }
            ];
            caches.arcs = {
                svg: svg, lineEls: lineEls, knobEls: knobEls, rows: rows, alt: alt, merge: merge,
                endCircles: mapped.endCircles, endPaths: mapped.endPaths
            };
        }
        activateMorph("arcs");
        const ph = presentMorph(3, 4, t);
        const k = ph.body;
        const c = caches.arcs;
        const k1 = clamp01(k / 0.22);
        const k2 = clamp01((k - 0.22) / 0.28);
        const k3 = clamp01((k - 0.50) / 0.50);
        const knA = c.alt.map((p, i) => ({
            x: lerp(c.rows[i].kx, p.kx, k1),
            y: lerp(c.rows[i].ky, p.ky, k1),
            r: c.rows[i].r
        }));
        c.knobEls.forEach((el, i) => {
            el.setAttribute("cx", knA[i].x);
            el.setAttribute("cy", knA[i].y);
            el.style.opacity = "1";
        });
        c.lineEls.forEach((el, i) => {
            const row = c.rows[i];
            el.setAttribute("d", "M" + row.x1 + " " + row.y + " L" + row.x2 + " " + row.y);
            el.style.opacity = "1";
            el.setAttribute("stroke-width", "3");
            el.setAttribute("stroke", "#c9a56a");
        });
        if (k2 > 0) {
            [[0, 1, 0], [2, 3, 1]].forEach((pair) => {
                const a = pair[0];
                const b = pair[1];
                const m = c.merge[pair[2]];
                [a, b].forEach((i) => {
                    const x1 = lerp(c.rows[i].x1, m.x1, k2);
                    const x2 = lerp(c.rows[i].x2, m.x2, k2);
                    const y = lerp(c.rows[i].y, m.y, k2);
                    c.lineEls[i].setAttribute("d", "M" + x1 + " " + y + " L" + x2 + " " + y);
                });
                c.lineEls[b].style.opacity = String(1 - k2);
                c.knobEls[a].setAttribute("cx", lerp(knA[a].x, m.x1, k2));
                c.knobEls[a].setAttribute("cy", lerp(knA[a].y, m.y, k2));
                c.knobEls[b].setAttribute("cx", lerp(knA[b].x, m.x2, k2));
                c.knobEls[b].setAttribute("cy", lerp(knA[b].y, m.y, k2));
            });
            if (c.lineEls[4]) c.lineEls[4].style.opacity = String(1 - k2);
            if (c.knobEls[4]) c.knobEls[4].style.opacity = String(1 - k2);
        }
        if (k3 > 0) {
            const kn1 = [
                { x: c.merge[0].x1, y: c.merge[0].y, r: c.rows[0].r },
                { x: c.merge[0].x2, y: c.merge[0].y, r: c.rows[1].r },
                { x: c.merge[1].x1, y: c.merge[1].y, r: c.rows[2].r },
                { x: c.merge[1].x2, y: c.merge[1].y, r: c.rows[3].r }
            ];
            const curveStart = c.merge.map((m) => ({
                x1: m.x1, y1: m.y, x2: m.x2, y2: m.y,
                cx1: lerp(m.x1, m.x2, 0.33), cy1: m.y,
                cx2: lerp(m.x1, m.x2, 0.67), cy2: m.y
            }));
            const keepLines = [c.lineEls[0], c.lineEls[2]];
            const keepKnobs = [c.knobEls[0], c.knobEls[1], c.knobEls[2], c.knobEls[3]];
            keepLines.forEach((el, p) => {
                const a = curveStart[p];
                const b = c.endPaths[p];
                const p0x = lerp(a.x1, b.p0.x, k3);
                const p0y = lerp(a.y1, b.p0.y, k3);
                const c1x = lerp(a.cx1, b.c1.x, k3);
                const c1y = lerp(a.cy1, b.c1.y, k3);
                const c2x = lerp(a.cx2, b.c2.x, k3);
                const c2y = lerp(a.cy2, b.c2.y, k3);
                const p3x = lerp(a.x2, b.p3.x, k3);
                const p3y = lerp(a.y2, b.p3.y, k3);
                el.setAttribute("d", cubicD({ x: p0x, y: p0y }, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x: p3x, y: p3y }));
                el.setAttribute("stroke-width", String(lerp(3, b.w, k3)));
                el.style.opacity = String(lerp(1, b.op, k3) * (1 - ph.reveal));
                if (k3 > 0.5) el.setAttribute("stroke", b.stroke);
            });
            keepKnobs.forEach((el, i) => {
                const dest = c.endCircles[i];
                el.setAttribute("cx", lerp(kn1[i].x, dest.x, k3));
                el.setAttribute("cy", lerp(kn1[i].y, dest.y, k3));
                el.setAttribute("r", String(lerp(kn1[i].r, dest.r, k3)));
                el.style.opacity = String(lerp(1, dest.op, k3) * (1 - ph.reveal));
                if (k3 > 0.45) el.setAttribute("fill", dest.fill);
            });
        }
        c.svg.style.opacity = String(1 - ph.reveal);
        scenes[4].classList.toggle("is-awaiting-arcs", ph.reveal < 1);
        if (weights) weights.classList.toggle("is-awaiting", t > 0 && ph.reveal < 1);
        if (t >= 1) hideCache("arcs");
    }

    function applySpark(t) {
        if (t <= 0) {
            hideCache("spark");
            return;
        }
        if (!caches.spark) {
            const built = withPrep(4, () => {
                const arcSvg = document.querySelector(".arc-map");
                if (!arcSvg || !arcSvg.getScreenCTM()) return null;
                const toS = (x, y) => svgToScreen(arcSvg, x, y);
                const a1 = { p0: toS(40, 110), c1: toS(80, 20), c2: toS(180, 20), p3: toS(220, 110) };
                const a2 = { p0: toS(70, 130), c1: toS(110, 60), c2: toS(160, 70), p3: toS(200, 128) };
                const sc = Math.abs(arcSvg.getScreenCTM().a);
                const circStart = [
                    { x: 40, y: 110, r: 6, fill: "#1b242e", op: 1 },
                    { x: 220, y: 110, r: 6, fill: "#b08948", op: 1 },
                    { x: 70, y: 130, r: 4.5, fill: "#1b242e", op: 0.45 },
                    { x: 200, y: 128, r: 4.5, fill: "#b08948", op: 0.7 }
                ].map((c) => {
                    const p = toS(c.x, c.y);
                    return { x: p.x, y: p.y, r: c.r * sc, fill: c.fill, op: c.op };
                });
                return { a1: a1, a2: a2, circStart: circStart, sc: sc };
            });
            const sparkEnd = withPrep(5, () => {
                const sparkSvg = document.querySelector(".spark");
                if (!sparkSvg || !sparkSvg.getScreenCTM()) return null;
                const scS = Math.abs(sparkSvg.getScreenCTM().a);
                const toS = (x, y) => svgToScreen(sparkSvg, x, y);
                return {
                    segs: [
                        [toS(8, 62), toS(40, 62), toS(48, 28), toS(86, 40)],
                        [toS(86, 40), toS(124, 52), toS(130, 78), toS(168, 36)],
                        [toS(168, 36), toS(206, -6), toS(220, 18), toS(272, 48)]
                    ],
                    r: 4 * scS,
                    w: 1.6 * scS
                };
            });
            if (!built || !sparkEnd) return;
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("class", "bridge-svg");
            const pathA = document.createElementNS(ns, "path");
            const pathB = document.createElementNS(ns, "path");
            pathA.setAttribute("fill", "none");
            pathB.setAttribute("fill", "none");
            pathA.setAttribute("stroke", "#b08948");
            pathB.setAttribute("stroke", "#1b242e");
            pathA.setAttribute("stroke-linecap", "round");
            pathB.setAttribute("stroke-linecap", "round");
            svg.appendChild(pathA);
            svg.appendChild(pathB);
            const bubbles = built.circStart.map((c) => {
                const el = document.createElementNS(ns, "circle");
                el.setAttribute("fill", c.fill);
                svg.appendChild(el);
                return el;
            });
            overlay().appendChild(svg);
            const avg = {
                p0: lerpPt(built.a1.p0, built.a2.p0, 0.5),
                c1: lerpPt(built.a1.c1, built.a2.c1, 0.5),
                c2: lerpPt(built.a1.c2, built.a2.c2, 0.5),
                p3: lerpPt(built.a1.p3, built.a2.p3, 0.5)
            };
            const splitA = splitCubic(avg.p0, avg.c1, avg.c2, avg.p3, 1 / 3);
            const splitB = splitCubic(splitA[1][0], splitA[1][1], splitA[1][2], splitA[1][3], 0.5);
            caches.spark = {
                svg: svg, pathA: pathA, pathB: pathB, bubbles: bubbles,
                a1: built.a1, a2: built.a2, circStart: built.circStart, sc: built.sc,
                sparkEnd: sparkEnd, avg: avg, startSegs: [splitA[0], splitB[0], splitB[1]]
            };
        }
        activateMorph("spark");
        const ph = presentMorph(4, 5, t);
        const k = ph.body;
        const c = caches.spark;
        const k1 = clamp01(k / 0.44);
        const k2 = clamp01((k - 0.44) / 0.56);
        const m1 = {
            p0: lerpPt(c.a1.p0, c.avg.p0, k1), c1: lerpPt(c.a1.c1, c.avg.c1, k1),
            c2: lerpPt(c.a1.c2, c.avg.c2, k1), p3: lerpPt(c.a1.p3, c.avg.p3, k1)
        };
        const m2 = {
            p0: lerpPt(c.a2.p0, c.avg.p0, k1), c1: lerpPt(c.a2.c1, c.avg.c1, k1),
            c2: lerpPt(c.a2.c2, c.avg.c2, k1), p3: lerpPt(c.a2.p3, c.avg.p3, k1)
        };
        if (k2 <= 0) {
            c.pathA.setAttribute("d", cubicPath([[m1.p0, m1.c1, m1.c2, m1.p3]]));
            c.pathB.setAttribute("d", cubicPath([[m2.p0, m2.c1, m2.c2, m2.p3]]));
            c.pathB.style.opacity = String(0.35 * (1 - k1));
            c.pathA.setAttribute("stroke-width", String(lerp(1.2 * c.sc, c.sparkEnd.w, k1 * 0.3)));
            [0, 2, 3].forEach((i) => {
                const onto = i === 0 ? m1.p0 : i === 2 ? m2.p0 : m2.p3;
                c.bubbles[i].setAttribute("cx", lerp(c.circStart[i].x, onto.x, k1));
                c.bubbles[i].setAttribute("cy", lerp(c.circStart[i].y, onto.y, k1));
                c.bubbles[i].setAttribute("r", String(lerp(c.circStart[i].r, 0.2, k1)));
                c.bubbles[i].style.opacity = String(c.circStart[i].op * (1 - k1));
            });
            c.bubbles[1].setAttribute("cx", m1.p3.x);
            c.bubbles[1].setAttribute("cy", m1.p3.y);
            c.bubbles[1].setAttribute("r", String(c.circStart[1].r));
            c.bubbles[1].style.opacity = "1";
        } else {
            const segs = c.startSegs.map((s, i) => [
                lerpPt(s[0], c.sparkEnd.segs[i][0], k2),
                lerpPt(s[1], c.sparkEnd.segs[i][1], k2),
                lerpPt(s[2], c.sparkEnd.segs[i][2], k2),
                lerpPt(s[3], c.sparkEnd.segs[i][3], k2)
            ]);
            c.pathA.setAttribute("d", cubicPath(segs));
            c.pathA.setAttribute("stroke", "#b08948");
            c.pathA.setAttribute("stroke-width", String(lerp(c.sparkEnd.w * 0.85, c.sparkEnd.w, k2)));
            c.pathB.style.opacity = "0";
            const tip = segs[2][3];
            c.bubbles[1].setAttribute("cx", tip.x);
            c.bubbles[1].setAttribute("cy", tip.y);
            c.bubbles[1].setAttribute("r", String(lerp(c.circStart[1].r, c.sparkEnd.r, k2)));
            c.bubbles[1].setAttribute("fill", "#b08948");
            c.bubbles[1].style.opacity = String(1 - ph.reveal);
            [0, 2, 3].forEach((i) => { c.bubbles[i].style.opacity = "0"; });
        }
        c.svg.style.opacity = String(1 - ph.reveal);
        c.pathA.style.opacity = String(1 - ph.reveal);
        scenes[5].classList.toggle("is-awaiting-spark", ph.reveal < 1);
        if (t >= 1) hideCache("spark");
    }

    function applyBenches(t) {
        if (t <= 0) {
            hideCache("benches");
            return;
        }
        if (!caches.benches) {
            const from = withPrep(5, () => {
                const sparkSvg = document.querySelector(".spark");
                const sparkPath = sparkSvg && sparkSvg.querySelector("path");
                const sparkDot = sparkSvg && sparkSvg.querySelector("circle");
                if (!sparkPath || !sparkDot || !sparkSvg.getScreenCTM()) return null;
                const N = 120;
                const fromPts = sampleSvgPathEl(sparkSvg, sparkPath, N);
                const scS = Math.abs(sparkSvg.getScreenCTM().a);
                return {
                    fromPts: fromPts,
                    startR: Number(sparkDot.getAttribute("r")) * scS,
                    startTip: svgToScreen(sparkSvg, Number(sparkDot.getAttribute("cx")), Number(sparkDot.getAttribute("cy"))),
                    startW: 1.6 * scS
                };
            });
            const dest = withPrep(6, () => {
                const benchSvg = document.querySelector(".benches");
                const benchPath = benchSvg && benchSvg.querySelector("path");
                if (!benchPath || !benchSvg.getScreenCTM()) return null;
                const N = 120;
                const rankScale = Math.abs(benchSvg.getScreenCTM().a);
                return {
                    toPts: sampleSvgPathEl(benchSvg, benchPath, N),
                    endW: 1.6 * Math.abs(benchSvg.getScreenCTM().a),
                    ranks: [...benchSvg.querySelectorAll(".rank")].map((node) => {
                        const p = svgToScreen(benchSvg, Number(node.getAttribute("x")), Number(node.getAttribute("y")));
                        return {
                            x: p.x, y: p.y, text: node.textContent,
                            baseline: node.getAttribute("dominant-baseline") || "central",
                            size: Number(node.getAttribute("font-size") || 14) * rankScale
                        };
                    })
                };
            });
            if (!from || !dest) return;
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("class", "bridge-svg");
            const path = document.createElementNS(ns, "path");
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "#b08948");
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            svg.appendChild(path);
            const bubble = document.createElementNS(ns, "circle");
            bubble.setAttribute("fill", "#b08948");
            svg.appendChild(bubble);
            const rankEls = dest.ranks.map((r) => {
                const el = document.createElementNS(ns, "text");
                el.textContent = r.text;
                el.setAttribute("x", String(r.x));
                el.setAttribute("y", String(r.y));
                el.setAttribute("text-anchor", "middle");
                el.setAttribute("dominant-baseline", r.baseline);
                el.setAttribute("fill", "#c9a56a");
                el.setAttribute("font-family", "Noto Nastaliq Urdu, Vazirmatn, Tahoma, serif");
                el.setAttribute("font-size", String(r.size));
                el.setAttribute("font-weight", "600");
                svg.appendChild(el);
                return el;
            });
            overlay().appendChild(svg);
            caches.benches = { svg: svg, path: path, bubble: bubble, rankEls: rankEls, from: from, dest: dest };
        }
        activateMorph("benches");
        const ph = presentMorph(5, 6, t);
        const k = ph.body;
        const c = caches.benches;
        const k1 = clamp01(k / 0.72);
        const k2 = clamp01((k - 0.72) / 0.28);
        const pts = c.from.fromPts.map((p, i) => lerpPt(p, c.dest.toPts[i], k1));
        c.path.setAttribute("d", ptsPath(pts));
        c.path.setAttribute("stroke-width", String(lerp(c.from.startW, c.dest.endW, k1)));
        const tip = pts[pts.length - 1];
        c.bubble.setAttribute("cx", tip.x);
        c.bubble.setAttribute("cy", tip.y);
        c.bubble.setAttribute("r", String(lerp(c.from.startR, 0.01, k1)));
        c.bubble.style.opacity = String((1 - k1) * (1 - ph.reveal));
        c.path.style.opacity = String(1 - ph.reveal);
        c.rankEls.forEach((el, i) => {
            const u = clamp01((k2 - i * 0.12) / 0.5);
            el.style.opacity = String(u * (1 - ph.reveal));
        });
        c.svg.style.opacity = String(1 - ph.reveal * 0.15);
        scenes[6].classList.toggle("is-awaiting-benches", ph.reveal < 1);
        if (t >= 1) hideCache("benches");
    }

    function applyMatrix(t) {
        if (t <= 0) {
            hideCache("matrix");
            return;
        }
        if (!caches.matrix) {
            const built = withPrep(6, () => {
                const benchSvg = document.querySelector(".benches");
                if (!benchSvg || !benchSvg.getScreenCTM()) return null;
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
                const destRanks = [...benchSvg.querySelectorAll(".rank")].map((node) => {
                    const p = toS(Number(node.getAttribute("x")), Number(node.getAttribute("y")));
                    return {
                        x: p.x, y: p.y, text: node.textContent,
                        baseline: node.getAttribute("dominant-baseline") || "central",
                        size: Number(node.getAttribute("font-size") || 14) * benchScale
                    };
                });
                const lift = toS(0, base).y - toS(0, base - 16).y;
                return {
                    toS: toS, startW: startW, startRx: startRx, base: base, r: r, topEq: topEq,
                    boxes: boxes, equalBoxes: equalBoxes, destRanks: destRanks, lift: lift
                };
            });
            const destCells = withPrep(7, () => [...matrix.children].map((el, i) => {
                const rct = el.getBoundingClientRect();
                return { x: rct.left, y: rct.top, w: rct.width, h: rct.height, color: MATRIX_COLORS[i] };
            }));
            if (!built || destCells.length < 6) return;
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("class", "bridge-svg");
            function strokePath(d, parent) {
                const el = document.createElementNS(ns, "path");
                el.setAttribute("fill", "none");
                el.setAttribute("stroke", "#b08948");
                el.setAttribute("stroke-width", String(built.startW));
                el.setAttribute("stroke-linecap", "round");
                el.setAttribute("stroke-linejoin", "round");
                el.setAttribute("d", d);
                (parent || svg).appendChild(el);
                return el;
            }
            const path = strokePath(connectedBenchesD(built.toS, 54, 12, 36));
            const rankEls = built.destRanks.map((r) => {
                const el = document.createElementNS(ns, "text");
                el.textContent = r.text;
                el.setAttribute("x", String(r.x));
                el.setAttribute("y", String(r.y));
                el.setAttribute("text-anchor", "middle");
                el.setAttribute("dominant-baseline", r.baseline);
                el.setAttribute("fill", "#c9a56a");
                el.setAttribute("font-family", "Noto Nastaliq Urdu, Vazirmatn, Tahoma, serif");
                el.setAttribute("font-size", String(r.size));
                el.setAttribute("font-weight", "600");
                svg.appendChild(el);
                return el;
            });
            const groups = built.boxes.map(() => {
                const g = document.createElementNS(ns, "g");
                svg.appendChild(g);
                return g;
            });
            const ud = built.boxes.map((b, i) => strokePath(benchUD(built.toS, b.x, built.topEq, b.w, built.base, built.r), groups[i]));
            const armL = built.boxes.map((b, i) => strokePath(benchArmD(built.toS, b.x, b.qL0, b.fL0, built.base, built.r), groups[i]));
            const armR = built.boxes.map((b, i) => strokePath(benchArmD(built.toS, b.x + b.w, b.qR0, b.fR0, built.base, built.r), groups[i]));
            function makeBoxRect(box, rx) {
                const el = document.createElementNS(ns, "rect");
                setRectBox(el, box, rx);
                el.setAttribute("fill", "none");
                el.setAttribute("fill-opacity", "0");
                el.setAttribute("stroke", "#b08948");
                el.setAttribute("stroke-width", String(built.startW));
                svg.appendChild(el);
                return el;
            }
            const meetY = built.equalBoxes[0].y + built.equalBoxes[0].h;
            const origLifted = built.equalBoxes.map((b) => ({ x: b.x, y: b.y - built.lift, w: b.w, h: b.h }));
            const dupStart = built.equalBoxes.map((b) => ({ x: b.x + b.w / 2, y: meetY, w: 0.001, h: 0.001 }));
            const dupGrown = built.equalBoxes.map((b) => ({ x: b.x, y: meetY, w: b.w, h: b.h }));
            const botRects = dupStart.map((b) => makeBoxRect(b, 0.5));
            const topRects = origLifted.map((b) => makeBoxRect(b, built.startRx));
            overlay().appendChild(svg);
            caches.matrix = {
                svg: svg, path: path, rankEls: rankEls, groups: groups, ud: ud, armL: armL, armR: armR,
                botRects: botRects, topRects: topRects, built: built, destCells: destCells,
                origLifted: origLifted, dupStart: dupStart, dupGrown: dupGrown,
                destTop: [destCells[2], destCells[1], destCells[0]],
                destBot: [destCells[5], destCells[4], destCells[3]]
            };
        }
        activateMorph("matrix");
        const ph = presentMorph(6, 7, t);
        const k = ph.body;
        const c = caches.matrix;
        const b = c.built;
        const k0 = clamp01(k / 0.10);
        const k1 = clamp01((k - 0.10) / 0.18);
        const k2 = clamp01((k - 0.28) / 0.18);
        const k3 = clamp01((k - 0.46) / 0.16);
        const k4 = clamp01((k - 0.62) / 0.22);
        const k5 = clamp01((k - 0.84) / 0.16);
        c.rankEls.forEach((el) => { el.style.opacity = String((1 - k0) * (1 - ph.reveal)); });
        c.path.setAttribute("d", connectedBenchesD(b.toS, lerp(54, 12, k1), 12, lerp(36, 12, k1)));
        c.path.style.display = k2 > 0 ? "none" : "";
        c.groups.forEach((g) => { g.style.display = (k2 > 0 && k4 <= 0) ? "" : "none"; });
        if (k2 > 0) {
            b.boxes.forEach((box, i) => {
                c.armL[i].setAttribute("d", benchArmD(b.toS, box.x, lerp(box.qL0, box.qL1, k2), lerp(box.fL0, box.fL1, k2), b.base, b.r));
                c.armR[i].setAttribute("d", benchArmD(b.toS, box.x + box.w, lerp(box.qR0, box.qR1, k2), lerp(box.fR0, box.fR1, k2), b.base, b.r));
            });
            c.groups.forEach((g) => g.setAttribute("transform", "translate(0," + (-b.lift * k3) + ")"));
        }
        const showRects = k3 > 0;
        c.botRects.forEach((el, i) => {
            el.style.display = showRects ? "" : "none";
            const grown = lerpBox(c.dupStart[i], c.dupGrown[i], k3);
            const dest = k4 > 0 ? lerpBox(c.dupGrown[i], c.destBot[i], k4) : grown;
            const rx = k4 > 0 ? lerp(b.startRx, 8, k4) : Math.min(b.startRx, dest.w / 2, dest.h / 2);
            setRectBox(el, dest, rx);
            el.setAttribute("stroke-width", String(k4 > 0 ? lerp(b.startW, 1.2, k4) : b.startW));
            el.setAttribute("fill", c.destBot[i].color || "#d9d1c3");
            el.setAttribute("fill-opacity", String(k5));
            el.setAttribute("stroke-opacity", String(1 - k5));
            el.style.opacity = String(1 - ph.reveal);
        });
        c.topRects.forEach((el, i) => {
            el.style.display = k4 > 0 || k3 >= 1 ? "" : "none";
            const dest = k4 > 0 ? lerpBox(c.origLifted[i], c.destTop[i], k4) : c.origLifted[i];
            const rx = k4 > 0 ? lerp(b.startRx, 8, k4) : b.startRx;
            setRectBox(el, dest, rx);
            el.setAttribute("stroke-width", String(k4 > 0 ? lerp(b.startW, 1.2, k4) : b.startW));
            el.setAttribute("fill", c.destTop[i].color || "#d9d1c3");
            el.setAttribute("fill-opacity", String(k5));
            el.setAttribute("stroke-opacity", String(1 - k5));
            el.style.opacity = String(1 - ph.reveal);
        });
        c.svg.style.opacity = String(1 - ph.reveal * 0.2);
        scenes[7].classList.toggle("is-awaiting-matrix", ph.reveal < 1);
        if (t >= 1) hideCache("matrix");
    }

    function applyIran(t) {
        if (t <= 0) {
            hideCache("iran");
            return;
        }
        if (!caches.iran) {
            const startBoxes = withPrep(7, () => [...matrix.children].map((el, i) => {
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height, color: MATRIX_COLORS[i] };
            }));
            const mapped = withPrep(8, () => {
                const iranSvg = document.querySelector(".iran-map");
                const iranPath = iranSvg && iranSvg.querySelector("path");
                if (!iranSvg || !iranPath || !iranSvg.getScreenCTM()) return null;
                const poly = sampleClosedPath(iranPath, 180).map((p) => {
                    const s = svgToScreen(iranSvg, p.x, p.y);
                    return { x: s.x, y: s.y };
                });
                let cx = 0;
                let cy = 0;
                poly.forEach((p) => { cx += p.x; cy += p.y; });
                cx /= poly.length;
                cy /= poly.length;
                const N = 96;
                const angles = [];
                for (let i = 0; i < N; i++) angles.push(-Math.PI / 2 + (i / N) * Math.PI * 2);
                const mapR = angles.map((a) => polyRayRadius(cx, cy, a, poly));
                const hits = mapR.filter((r) => r > 1);
                const fallback = hits.length ? hits.reduce((s, r) => s + r, 0) / hits.length : 80;
                for (let i = 0; i < mapR.length; i++) if (!(mapR[i] > 1)) mapR[i] = fallback;
                const radius = Math.min.apply(null, mapR) * 0.96;
                return {
                    cx: cx, cy: cy, angles: angles, mapR: mapR, radius: radius,
                    destW: 1.8 * Math.abs(iranSvg.getScreenCTM().a),
                    destCircle: { x: cx - radius, y: cy - radius, w: radius * 2, h: radius * 2 }
                };
            });
            if (!mapped || startBoxes.length < 6) return;
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("class", "bridge-svg");
            const rects = startBoxes.map((box) => {
                const el = document.createElementNS(ns, "rect");
                setRectBox(el, box, 8);
                el.setAttribute("fill", box.color);
                el.setAttribute("stroke", "none");
                svg.appendChild(el);
                return el;
            });
            const morph = document.createElementNS(ns, "path");
            morph.setAttribute("fill", "#b08948");
            morph.setAttribute("stroke", "#b08948");
            morph.setAttribute("stroke-linejoin", "round");
            morph.setAttribute("stroke-linecap", "round");
            svg.appendChild(morph);
            overlay().appendChild(svg);
            caches.iran = { svg: svg, rects: rects, morph: morph, startBoxes: startBoxes, mapped: mapped };
        }
        activateMorph("iran");
        const ph = presentMorph(7, 8, t);
        const k = ph.body;
        const c = caches.iran;
        const m = c.mapped;
        const k1 = clamp01(k / 0.42);
        const k2 = clamp01((k - 0.42) / 0.58);
        function polarPts(radii) {
            return m.angles.map((a, i) => ({
                x: m.cx + radii[i] * Math.cos(a),
                y: m.cy + radii[i] * Math.sin(a)
            }));
        }
        c.rects.forEach((el, i) => {
            const box = lerpBox(c.startBoxes[i], m.destCircle, k1);
            setRectBox(el, box, lerp(8, m.radius, k1));
            el.setAttribute("fill", lerpHex(c.startBoxes[i].color, "#b08948", k1));
            el.style.display = k2 > 0 ? "none" : "";
            el.style.opacity = String(1 - ph.reveal);
        });
        if (k2 > 0) {
            const radii = m.mapR.map((r) => lerp(m.radius, r, k2));
            c.morph.style.display = "";
            c.morph.setAttribute("d", ptsPathClosed(polarPts(radii)));
            c.morph.setAttribute("fill-opacity", String(lerp(1, 0.28, k2)));
            c.morph.setAttribute("fill", lerpHex("#b08948", "#c9a56a", k2));
            c.morph.setAttribute("stroke-width", String(lerp(0, m.destW, k2)));
            c.morph.style.opacity = String(1 - ph.reveal);
        } else {
            c.morph.style.display = "none";
        }
        c.svg.style.opacity = String(1 - ph.reveal * 0.2);
        scenes[8].classList.toggle("is-awaiting-iran", ph.reveal < 1);
        if (t >= 1) hideCache("iran");
    }

    function applyLater(p) {
        const world = document.getElementById("world-view");
        if (p < P.rooms[0]) {
            hideAllMorphs();
            if (world) {
                world.style.opacity = camReady ? "1" : "";
                world.style.visibility = camReady ? "visible" : "";
            }
            if (rooms) {
                rooms.classList.remove("is-awaiting");
                rooms.style.removeProperty("--rooms-draw");
                rooms.style.removeProperty("--rooms-dots");
            }
            if (weights) weights.classList.remove("is-awaiting");
            return;
        }
        if (p < P.weights[0]) {
            applyRooms(p < P.rooms[1] ? seg(p, P.rooms[0], P.rooms[1]) : 1);
            return;
        }
        if (world) {
            world.style.opacity = "0";
            world.style.visibility = "hidden";
        }
        document.body.classList.remove("has-world-atoms");
        if (p < P.arcs[0]) {
            applyWeights(p < P.weights[1] ? seg(p, P.weights[0], P.weights[1]) : 1);
            return;
        }
        if (p < P.spark[0]) {
            applyArcs(p < P.arcs[1] ? seg(p, P.arcs[0], P.arcs[1]) : 1);
            return;
        }
        if (p < P.benches[0]) {
            applySpark(p < P.spark[1] ? seg(p, P.spark[0], P.spark[1]) : 1);
            return;
        }
        if (p < P.matrix[0]) {
            applyBenches(p < P.benches[1] ? seg(p, P.benches[0], P.benches[1]) : 1);
            return;
        }
        if (p < P.iran[0]) {
            applyMatrix(p < P.matrix[1] ? seg(p, P.matrix[0], P.matrix[1]) : 1);
            return;
        }
        applyIran(seg(p, P.iran[0], P.iran[1]));
    }

    function applyStory(p) {
        const tDrop = seg(p, P.drop[0], P.drop[1]);
        const tZoom = seg(p, P.zoom[0], P.zoom[1]);
        const tEnter = seg(p, P.enter[0], P.enter[1]);
        const tCam = seg(p, P.cam[0], P.cam[1]);

        if (p <= 0) {
            if (camReady) reverseCamera();
            if (pin.on) unpinBall();
            else presentRest(0);
            hideAllMorphs();
            return;
        }

        if (tCam <= 0) {
            if (camReady) reverseCamera();
            if (!pin.on) pinBall();
            if (tDrop < 1) {
                if (zoomSurfaces) resetZoomSurfaces();
                applyDrop(tDrop);
                applyEnter(0);
            } else {
                applyDrop(1);
                applyZoom(tZoom);
                applyEnter(tZoom >= 1 ? tEnter : 0);
            }
            if (tEnter >= 1 && tCam <= 0) {
                clearSceneFlags();
                scenes[0].classList.add("is-on", "is-bridging");
                scenes[0].style.setProperty("--copy-on", "0");
                syncRail(0);
            }
        } else {
            if (!pin.on) pinBall();
            if (!camReady) {
                applyDrop(1);
                applyZoom(1);
                applyEnter(1);
            }
            applyCamera(tCam, p < P.rooms[0], p);
        }

        if (p >= P.rooms[0]) applyLater(p);
        else {
            hideAllMorphs();
            if (camReady) {
                const world = document.getElementById("world-view");
                if (world) {
                    world.style.opacity = "1";
                    world.style.visibility = "visible";
                }
            }
        }
    }

    function storyProgress() {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        return max <= 0 ? 0 : clamp01(window.scrollY / max);
    }

    window.scrollToStoryScene = function (i) {
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const mark = MARKS[Math.max(0, Math.min(MARKS.length - 1, i))] || 0;
        window.scrollTo(0, mark * max);
    };

    let ticking = false;
    function onScroll() {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            ticking = false;
            applyStory(storyProgress());
        });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => {
        invalidateMorphs();
        zoomSurfaces = null;
        applyStory(storyProgress());
    });
    window.addEventListener("keydown", (e) => {
        if (["ArrowDown", "PageDown", " "].includes(e.key)) {
            e.preventDefault();
            window.scrollBy(0, window.innerHeight * 0.28);
        } else if (["ArrowUp", "PageUp"].includes(e.key)) {
            e.preventDefault();
            window.scrollBy(0, -window.innerHeight * 0.28);
        } else if (e.key === "Home") {
            e.preventDefault();
            window.scrollTo(0, 0);
        } else if (e.key === "End") {
            e.preventDefault();
            window.scrollTo(0, document.documentElement.scrollHeight);
        }
    });
    applyStory(storyProgress());
})();

function stopLightLines() {
    lightLinesActive = false;
    if (lightLinesRaf) cancelAnimationFrame(lightLinesRaf);
    lightLinesRaf = 0;
}

let restartLightLines = function () {};

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
        if (!lightLinesActive) return;
        refs.forEach((ref, i) => {
            if (!ref.element) return;
            const progress = ((time - started[i]) / 1000 % ref.duration) / ref.duration;
            const y = ref.from + (ref.to - ref.from) * progress;
            ref.element.style.transform = "translateY(" + y + "px)";
        });
        lightLinesRaf = requestAnimationFrame(animate);
    }
    restartLightLines = function () {
        lightLinesActive = true;
        if (lightLinesRaf) cancelAnimationFrame(lightLinesRaf);
        lightLinesRaf = requestAnimationFrame(animate);
    };
    if (dropLocked) stopLightLines();
    else lightLinesRaf = requestAnimationFrame(animate);
})();

const pearlLight = { x: -0.48, y: -0.52, z: 0.71, gain: 0.78 };
const pearlLightTarget = { x: -0.48, y: -0.52, z: 0.71, gain: 0.78 };
let lightenNow = 0;
let lightenTarget = 0;
let lightOnNow = 0;
let lightOnTarget = 0;
let beamNow = 24;
let beamTarget = 24;

function lightenByHover(event) {
    if (dropLocked) return;
    const root = document.documentElement;
    const x = event.clientX;
    const y = event.clientY;
    root.style.setProperty("--hover-x", x + "px");
    root.style.setProperty("--hover-y", y + "px");
    lightOnTarget = 1;

    let amount = 0.08;
    let lx = -0.48;
    let ly = -0.52;
    let lz = 0.71;
    let gain = 0.78;
    beamTarget = 26;

    const pearl = document.querySelector(".thread-pearl");
    if (pearl) {
        const box = pearl.getBoundingClientRect();
        if (box.width > 1 && box.height > 1) {
            const cx = box.left + box.width / 2;
            const cy = box.top + box.height / 2;
            const dx = (x - cx) / (box.width / 2);
            const dy = (y - cy) / (box.height / 2);
            const dist = Math.hypot(dx, dy);
            const onBall = Math.max(0, 1 - dist);
            amount = 0.08 + onBall * 0.78;
            beamTarget = 26 + onBall * 110;
            lz = Math.max(0.32, 1.12 - dist * 0.22);
            const len = Math.hypot(dx, dy, lz) || 1;
            lx = dx / len;
            ly = dy / len;
            lz = lz / len;
            gain = 0.7 + amount * 0.55;
        }
    }

    lightenTarget = Math.max(0, Math.min(1, amount));
    pearlLightTarget.x = lx;
    pearlLightTarget.y = ly;
    pearlLightTarget.z = lz;
    pearlLightTarget.gain = gain;
}

lightenByHover.reset = function resetLighten() {
    lightenTarget = 0;
    lightOnTarget = 0;
    beamTarget = 26;
    pearlLightTarget.x = -0.48;
    pearlLightTarget.y = -0.52;
    pearlLightTarget.z = 0.71;
    pearlLightTarget.gain = 0.78;
};

document.addEventListener("pointermove", lightenByHover, { passive: true });
document.addEventListener("pointerleave", lightenByHover.reset);

(function tickLighten() {
    function tick() {
        lightenNow += (lightenTarget - lightenNow) * 0.12;
        if (Math.abs(lightenNow - lightenTarget) < 0.002) lightenNow = lightenTarget;
        lightOnNow += (lightOnTarget - lightOnNow) * 0.18;
        if (Math.abs(lightOnNow - lightOnTarget) < 0.002) lightOnNow = lightOnTarget;
        beamNow += (beamTarget - beamNow) * 0.12;
        if (Math.abs(beamNow - beamTarget) < 0.08) beamNow = beamTarget;
        document.documentElement.style.setProperty("--lighten", lightenNow.toFixed(4));
        document.documentElement.style.setProperty("--light-on", lightOnNow.toFixed(4));
        document.documentElement.style.setProperty("--beam", beamNow.toFixed(2) + "rem");
        pearlLight.x += (pearlLightTarget.x - pearlLight.x) * 0.12;
        pearlLight.y += (pearlLightTarget.y - pearlLight.y) * 0.12;
        pearlLight.z += (pearlLightTarget.z - pearlLight.z) * 0.12;
        pearlLight.gain += (pearlLightTarget.gain - pearlLight.gain) * 0.12;
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
})();

(function spinCharcoalPearl() {
    const canvas = document.getElementById("pearl-canvas");
    const scene0 = document.querySelector("scene[data-step='0']");
    if (!canvas || !scene0 || !canvas.getContext) return;

    const SIZE = 256;
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d", { alpha: true });

    const cx = SIZE / 2;
    const radius = SIZE / 2 - 0.5;
    const lon0 = [];
    const lat = [];
    const nxA = [];
    const nyA = [];
    const nzA = [];
    const rrA = [];
    const pix = [];
    const edge = [];
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const dx = (x + 0.5 - cx) / radius;
            const dy = (y + 0.5 - cx) / radius;
            const rr = dx * dx + dy * dy;
            if (rr > 1) continue;
            const nz = Math.sqrt(1 - rr);
            const nx = dx;
            const ny = dy;
            lon0.push(Math.atan2(nx, nz));
            lat.push(Math.asin(Math.max(-1, Math.min(1, ny))));
            nxA.push(nx);
            nyA.push(ny);
            nzA.push(nz);
            rrA.push(rr);
            pix.push((y * SIZE + x) * 4);
            edge.push(rr > 0.94 ? Math.max(0, (1 - Math.sqrt(rr)) / 0.06) : 1);
        }
    }
    const N = lon0.length;

    const TW = 512;
    const TH = 256;
    const tex = new Float32Array(TW * TH);
    function hash2(i, j) {
        const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
        return n - Math.floor(n);
    }
    function fade(t) { return t * t * (3 - 2 * t); }
    function vnoise(x, y, wrapX) {
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = fade(x - x0);
        const fy = fade(y - y0);
        const h = function (i, j) {
            const ii = ((i % wrapX) + wrapX) % wrapX;
            const jj = Math.max(0, Math.min(TH - 1, j));
            return hash2(ii, jj);
        };
        const a = h(x0, y0);
        const b = h(x0 + 1, y0);
        const c = h(x0, y0 + 1);
        const d = h(x0 + 1, y0 + 1);
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
    for (let y = 0; y < TH; y++) {
        for (let x = 0; x < TW; x++) {
            let n = vnoise(x / 32, y / 32, TW / 32) * 0.45;
            n += vnoise(x / 14, y / 14, TW / 14) * 0.32;
            n += vnoise(x / 6, y / 6, TW / 6) * 0.23;
            const hatch = Math.sin(x * 0.35 + y * 1.55) * 0.07 + Math.sin(x * 0.12 - y * 0.9) * 0.05;
            tex[y * TW + x] = 0.46 + (n - 0.5) * 0.55 + hatch;
        }
    }
    const blobs = [
        { u: 0.08, v: 0.40, s: 0.11, d: -0.42 },
        { u: 0.22, v: 0.58, s: 0.08, d: 0.28 },
        { u: 0.37, v: 0.32, s: 0.13, d: -0.36 },
        { u: 0.51, v: 0.62, s: 0.09, d: 0.22 },
        { u: 0.64, v: 0.44, s: 0.12, d: -0.38 },
        { u: 0.78, v: 0.28, s: 0.07, d: 0.24 },
        { u: 0.88, v: 0.55, s: 0.10, d: -0.3 },
        { u: 0.96, v: 0.70, s: 0.06, d: 0.18 }
    ];
    for (let y = 0; y < TH; y++) {
        const v = y / (TH - 1);
        for (let x = 0; x < TW; x++) {
            const u = x / TW;
            let add = 0;
            for (let b = 0; b < blobs.length; b++) {
                let du = u - blobs[b].u;
                if (du > 0.5) du -= 1;
                if (du < -0.5) du += 1;
                const dv = (v - blobs[b].v) * 1.35;
                const d2 = (du * du + dv * dv) / (blobs[b].s * blobs[b].s);
                if (d2 < 1) add += blobs[b].d * (1 - d2) * (1 - d2);
            }
            tex[y * TW + x] = Math.max(0.05, Math.min(1, tex[y * TW + x] + add));
        }
    }

    const TWO_PI = Math.PI * 2;
    function sample(lon, la) {
        let u = lon / TWO_PI * TW;
        u = ((u % TW) + TW) % TW;
        let v = (la / Math.PI + 0.5) * (TH - 1);
        if (v < 0) v = 0;
        else if (v > TH - 1.001) v = TH - 1.001;
        const x0 = u | 0;
        const y0 = v | 0;
        const x1 = (x0 + 1) % TW;
        const y1 = y0 + 1 < TH ? y0 + 1 : TH - 1;
        const fx = u - x0;
        const fy = v - y0;
        const a = tex[y0 * TW + x0];
        const b = tex[y0 * TW + x1];
        const c = tex[y1 * TW + x0];
        const d = tex[y1 * TW + x1];
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }

    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    let rot = 0;
    let last = performance.now();
    const REV_SEC = 22;
    const spin = TWO_PI / REV_SEC;

    function frame(now) {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (scene0.classList.contains("is-on") && !scene0.classList.contains("is-thread-out")) {
            if (pearlSpinning) rot += spin * dt;
            data.fill(0);
            const lx = pearlLight.x;
            const ly = pearlLight.y;
            const lz = pearlLight.z;
            const gain = pearlLight.gain;
            const lift = 0.14 + lightenNow * 0.18;
            for (let i = 0; i < N; i++) {
                const nx = nxA[i];
                const ny = nyA[i];
                const nz = nzA[i];
                const rr = rrA[i];
                const ndot = Math.max(0, nx * lx + ny * ly + nz * lz);
                const bounce = Math.max(0, -nx * lx - ny * ly) * (1 - ndot) * 0.22;
                const spec = Math.pow(ndot, 14) * (0.42 + lightenNow * 0.35);
                const contact = Math.max(0, ny - 0.52) * 0.38;
                const limb = rr * rr * 0.12;
                const shade = Math.max(0.04, Math.min(1, lift + ndot * gain + bounce + spec - contact - limb));
                const grain = sample(lon0[i] + rot, lat[i]);
                const t = Math.max(0, Math.min(1, shade * (0.62 + grain * 0.72)));
                const o = pix[i];
                data[o] = 18 + t * 228;
                data[o + 1] = 16 + t * 220;
                data[o + 2] = 12 + t * 206;
                data[o + 3] = edge[i] * 255;
            }
            ctx.putImageData(img, 0, 0);
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();


