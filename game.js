/* ============================================================
   Neon Spins — game logic (zero dependencies)
   - 3 independent reels, 12 equally likely positions each
   - Web Crypto RNG with rejection sampling (no modulo bias)
   - Play money only; no real currency, accounts, or network calls
   ============================================================ */
(function () {
  "use strict";

  var SYMBOLS = [
    { id: "diamond", label: "钻石", glyph: "\u{1F48E}", count: 1, pay3: 100, pay2: 1 },
    { id: "seven",   label: "幸运七", glyph: "7",        count: 1, pay3: 50,  pay2: 1 },
    { id: "star",    label: "星星", glyph: "\u2B50",     count: 2, pay3: 15,  pay2: 1 },
    { id: "bell",    label: "铃铛", glyph: "\u{1F514}", count: 2, pay3: 10,  pay2: 1 },
    { id: "lemon",   label: "柠檬", glyph: "\u{1F34B}", count: 3, pay3: 6,   pay2: 1 },
    { id: "cherry",  label: "樱桃", glyph: "\u{1F352}", count: 3, pay3: 4,   pay2: 2 }
  ];

  var BY_ID = {};
  SYMBOLS.forEach(function (s) { BY_ID[s.id] = s; });

  // 12 positions per reel, repeated 4 times in the DOM for smooth looping.
  var STRIP = [];
  SYMBOLS.forEach(function (s) {
    for (var i = 0; i < s.count; i++) STRIP.push(s.id);
  });
  var COPIES = 4;
  var SPIN_TRANSITION = "transform 1.05s cubic-bezier(.12, .8, .25, 1)";

  var STORAGE_KEY = "neon-spins-state-v1";
  var DEFAULT_STATE = { credits: 1000, bestWin: 0, spins: 0, wins: 0 };

  var state = loadState();
  var spinning = false;
  var reelHeight = 96;

  var creditsEl = document.getElementById("credits");
  var betEl = document.getElementById("bet-display");
  var bestEl = document.getElementById("best-win");
  var spinsEl = document.getElementById("spins");
  var winsEl = document.getElementById("wins");
  var winrateEl = document.getElementById("winrate");
  var resultEl = document.getElementById("result");
  var spinBtn = document.getElementById("spin");
  var refillBtn = document.getElementById("refill");
  var reels = Array.prototype.slice.call(document.querySelectorAll(".reel"));

  /* ---------- Utilities ---------- */
  function loadState() {
    var s = Object.assign({}, DEFAULT_STATE);
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return s;
      var parsed = JSON.parse(raw);
      Object.keys(DEFAULT_STATE).forEach(function (key) {
        var v = Number(parsed[key]);
        if (isFinite(v) && v >= 0) s[key] = Math.floor(v);
      });
    } catch (e) { /* storage unavailable or corrupt — use defaults */ }
    return s;
  }

  function saveState() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { /* private mode / quota — game still works in memory */ }
  }

  // Unbiased integer in [0, max). Uses crypto.getRandomValues when available.
  function secureRandomInt(max) {
    if (!max || max <= 0) return 0;
    var crypto = window.crypto || window.msCrypto;
    if (!crypto || !crypto.getRandomValues) return Math.floor(Math.random() * max);
    var range = 4294967296; // 2^32
    var limit = Math.floor(range / max) * max;
    var buf = new Uint32Array(1);
    var x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }

  function getBet() {
    var checked = document.querySelector('input[name="bet"]:checked');
    return checked ? Number(checked.value) : 5;
  }

  function fmt(n) { return n.toLocaleString("zh-CN"); }

  function announce(message, isWin) {
    resultEl.textContent = message;
    resultEl.classList.toggle("is-loss", !isWin);
  }

  function measureReelHeight() {
    var r = reels[0];
    return r ? r.getBoundingClientRect().height : reelHeight;
  }

  /* ---------- Payout evaluation ---------- */
  function evaluate(a, b, c, bet) {
    if (a === b && b === c) {
      var three = BY_ID[a];
      return { payout: bet * three.pay3, symbol: a, kind: "three" };
    }
    var pairs = [];
    if (a === b) pairs.push(a);
    if (b === c) pairs.push(b);
    if (a === c) pairs.push(a);
    if (pairs.length) {
      var two = BY_ID[pairs[0]];
      return { payout: bet * two.pay2, symbol: pairs[0], kind: "two" };
    }
    return { payout: 0, symbol: null, kind: "none" };
  }

  /* ---------- Rendering ---------- */
  function buildReels() {
    reelHeight = measureReelHeight();
    var initialPositions = [0, 3, 7]; // diamond / star / lemon — avoid a fake jackpot on load
    reels.forEach(function (reel, index) {
      var strip = reel.querySelector(".reel__strip");
      var html = "";
      for (var copy = 0; copy < COPIES; copy++) {
        STRIP.forEach(function (id) {
          html += '<div class="reel__symbol" data-id="' + id + '">' + BY_ID[id].glyph + "</div>";
        });
      }
      strip.innerHTML = html;
      strip.style.transition = SPIN_TRANSITION;
      var start = initialPositions[index] || 0;
      strip.style.transform = "translateY(-" + (start * reelHeight) + "px)";
      reel.dataset.final = String(start);
    });
  }

  function render() {
    creditsEl.textContent = fmt(state.credits);
    betEl.textContent = fmt(getBet());
    bestEl.textContent = fmt(state.bestWin);
    spinsEl.textContent = fmt(state.spins);
    winsEl.textContent = fmt(state.wins);
    winrateEl.textContent = state.spins
      ? (state.wins / state.spins * 100).toFixed(1) + "%"
      : "\u2014";
    creditsEl.classList.toggle("is-win", state.credits > DEFAULT_STATE.credits);
  }

  /* ---------- Spin ---------- */
  function spin() {
    if (spinning) return;
    var bet = getBet();
    if (state.credits < bet) {
      announce("积分不足，无法下注 " + fmt(bet) + " 分。请点击「补充积分」。", false);
      return;
    }

    spinning = true;
    spinBtn.disabled = true;
    refillBtn.disabled = true;
    state.credits -= bet;
    state.spins += 1;
    saveState();
    render();
    announce("转轴旋转中\u2026", false);

    var outcomes = [];
    var reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    reels.forEach(function (reel, index) {
      var strip = reel.querySelector(".reel__strip");
      var finalPos = secureRandomInt(STRIP.length); // 0..11, the settled symbol
      var symbolId = STRIP[finalPos];
      var loops = secureRandomInt(2);               // extra 0..1 full revolutions
      var target = STRIP.length * 2 + finalPos + STRIP.length * loops;

      outcomes.push(symbolId);
      reel.dataset.final = String(finalPos);
      strip.style.transition = SPIN_TRANSITION;
      strip.style.transitionDelay = reduceMotion ? "0s" : (index * 0.1) + "s";
      // Force a style flush so the transition always starts from the old value.
      void strip.offsetHeight;
      strip.style.transform = "translateY(-" + (target * reelHeight) + "px)";
    });

    var wait = reduceMotion ? 140 : 1400;
    window.setTimeout(function () { settle(outcomes, bet); }, wait);
  }

  function settle(outcomes, bet) {
    var result = evaluate(outcomes[0], outcomes[1], outcomes[2], bet);
    var names = outcomes.map(function (id) { return BY_ID[id].label; }).join(" \u00B7 ");

    state.credits += result.payout;
    if (result.payout > 0) {
      state.wins += 1;
      if (result.payout > state.bestWin) state.bestWin = result.payout;
    }

    // Snap each strip back to the first copy without animating.
    reels.forEach(function (reel) {
      var strip = reel.querySelector(".reel__strip");
      strip.style.transition = "none";
      strip.style.transitionDelay = "0s";
      strip.style.transform = "translateY(-" + (Number(reel.dataset.final) * reelHeight) + "px)";
      void strip.offsetHeight;
      strip.style.transition = SPIN_TRANSITION;
    });

    spinning = false;
    spinBtn.disabled = false;
    refillBtn.disabled = false;
    saveState();
    render();

    if (result.kind === "three") {
      announce("三个" + BY_ID[result.symbol].label + "！赢得 " + fmt(result.payout) +
        " 积分（" + bet + " \u00D7 " + BY_ID[result.symbol].pay3 + "）。转轴：" + names, true);
    } else if (result.kind === "two") {
      announce("两个" + BY_ID[result.symbol].label + "！赢得 " + fmt(result.payout) +
        " 积分。转轴：" + names, true);
    } else {
      announce("未中奖。转轴：" + names + "。下次好运！", false);
    }
  }

  function refill() {
    if (spinning) return;
    state.credits = DEFAULT_STATE.credits;
    saveState();
    render();
    announce("已补充至 " + fmt(state.credits) + " 虚拟积分。虚拟积分不可兑换真实财物。", false);
  }

  /* ---------- Events ---------- */
  spinBtn.addEventListener("click", spin);
  refillBtn.addEventListener("click", refill);

  document.querySelectorAll('input[name="bet"]').forEach(function (input) {
    input.addEventListener("change", render);
  });

  // Space anywhere outside an interactive control triggers a spin.
  document.addEventListener("keydown", function (e) {
    if (e.code !== "Space" && e.key !== " ") return;
    var t = e.target;
    if (t && t.closest && t.closest("button, input, summary, a, textarea, select")) return;
    e.preventDefault();
    spin();
  });

  // Keep reel offsets correct when the responsive reel height changes.
  window.addEventListener("resize", function () {
    var h = measureReelHeight();
    if (Math.abs(h - reelHeight) < 0.5) return;
    reelHeight = h;
    reels.forEach(function (reel) {
      var strip = reel.querySelector(".reel__strip");
      var prev = strip.style.transition;
      strip.style.transition = "none";
      strip.style.transform = "translateY(-" + (Number(reel.dataset.final) * h) + "px)";
      void strip.offsetHeight;
      strip.style.transition = prev;
    });
  });

  /* ---------- Init ---------- */
  buildReels();
  render();
})();
