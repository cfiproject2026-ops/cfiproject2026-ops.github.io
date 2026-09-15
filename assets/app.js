/* ACS Reference — renderer.
   SITE holds everything shared across guides; each guide's own data arrives
   later, on demand, via data/guide-<slug>.js calling window.ACSGUIDE().      */
(function () {
  "use strict";
  var SITE = window.SITE || {};
  var GUIDES = SITE.guides || [];          /* registry: slug, title, doc, counts */
  var LOADED = window.__ACS_LOADED = window.__ACS_LOADED || {};

  /* the current guide. Every renderer below reads these, exactly as before;
     switching guide just re-points them.                                     */
  var G = null, ACS = [], C = {}, IMG = {}, VID = {}, ENDO = [];
  /* filled from SITE at boot; AC 61-65K is site-wide, not a CFI-only asset */
  var RES = SITE.resources || [], PLT = SITE.plt || {}, DATA = { airports: SITE.airports || "" };

  function guideMeta(slug) {
    for (var i = 0; i < GUIDES.length; i++) if (GUIDES[i].slug === slug) return GUIDES[i];
    return null;
  }
  function useGuide(g) {
    G = g;
    ACS = g.acs || [];
    C = g.content || {};
    IMG = g.img || {};
    VID = g.vid || {};
    ENDO = (g.endorsements && g.endorsements.length) ? g.endorsements
                                                    : (SITE.endorsements || []);
    DATA.figcap = g.figcap || {};
    DATA.figsrc = g.figsrc || {};
    FLAT = null; ANCHOR = null;   /* the per-guide task list must be rebuilt; the search
                         index is cached on each payload as g.__idx, so it
                         survives a guide switch and does not belong here */
  }
  /* data/guide-<slug>.js calls this when it finishes loading */
  window.ACSGUIDE = function (slug, payload) {
    payload.slug = slug;
    LOADED[slug] = payload;
  };
  function loadGuide(slug, cb) {
    if (LOADED[slug]) { useGuide(LOADED[slug]); cb(null); return; }
    var sc = document.createElement("script");
    sc.src = "data/guide-" + slug + ".js";
    sc.onload = function () {
      if (!LOADED[slug]) { cb(new Error("guide " + slug + " loaded but registered nothing")); return; }
      useGuide(LOADED[slug]); cb(null);
    };
    sc.onerror = function () { cb(new Error("could not load data/guide-" + slug + ".js")); };
    document.head.appendChild(sc);
  }

  /* Load a guide's data WITHOUT making it the current one. Site-wide search
     needs every guide's text, but switching the module-level context six times
     while the user is looking at one page would be a mess, so this keeps the
     payload and leaves `G` alone. */
  function fetchGuide(slug, cb) {
    if (LOADED[slug]) { cb(null, LOADED[slug]); return; }
    var sc = document.createElement("script");
    sc.src = "data/guide-" + slug + ".js";
    sc.onload = function () {
      if (!LOADED[slug]) { cb(new Error("guide " + slug + " registered nothing")); return; }
      cb(null, LOADED[slug]);
    };
    sc.onerror = function () { cb(new Error("could not load data/guide-" + slug + ".js")); };
    document.head.appendChild(sc);
  }

  /* Fetch every guide, one at a time so a slow connection shows progress
     rather than stalling on six parallel requests. onStep runs after each. */
  function fetchAllGuides(onStep, done) {
    var todo = GUIDES.map(function (g) { return g.slug; });
    var i = 0, failed = [];
    (function next() {
      if (i >= todo.length) { done(failed); return; }
      var slug = todo[i++];
      fetchGuide(slug, function (err) {
        if (err) failed.push(slug);
        if (onStep) onStep(i, todo.length, slug);
        next();
      });
    })();
  }
  function allLoaded() {
    return GUIDES.every(function (g) { return !!LOADED[g.slug]; });
  }

  /* figures live in img/ as files so the browser caches them across guides */
  function imgSrc(id) { return "img/" + id + ".webp"; }

  /* ---------- airports: "CODES\tname\tcity\tstate\tlat\tlon\tsize" per line ---------- */
  var APT = null;
  function airports() {
    if (APT) return APT;
    APT = {};
    var lines = (DATA.airports || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].split("\t");
      if (f.length < 6) continue;
      var rec = { codes: f[0].split("|"), name: f[1], city: f[2], st: f[3],
                  lat: +f[4], lon: +f[5], size: f[6] || "" };
      for (var j = 0; j < rec.codes.length; j++) if (!APT[rec.codes[j]]) APT[rec.codes[j]] = rec;
    }
    return APT;
  }
  function findApt(code) {
    var a = airports(), c = String(code || "").trim().toUpperCase();
    if (!c) return null;
    if (a[c]) return a[c];
    if (c.length === 3 && a["K" + c]) return a["K" + c];       /* FXE -> KFXE */
    if (c.length === 4 && c[0] === "K" && a[c.slice(1)]) return a[c.slice(1)];
    return null;
  }
  /* great-circle distance in nautical miles */
  function nm(a, b) {
    var R = 3440.065, r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    var h = s1 * s1 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* ---------- eligibility checker engine ---------- */
  var CHECK = {};
  try { CHECK = JSON.parse(localStorage.getItem("cfi-check") || "{}"); } catch (e) { CHECK = {}; }
  function saveCheck() { try { localStorage.setItem("cfi-check", JSON.stringify(CHECK)); } catch (e) { } }

  function allItems(def) {
    var out = [];
    (def.groups || []).forEach(function (g) { (g.items || []).forEach(function (i) { out.push(i); }); });
    return out;
  }
  function itemMet(key, it, byId) {
    var st = CHECK[key] || {};
    if (it.type === "number") {
      var v = parseFloat(st[it.id]);
      return !isNaN(v) && v >= it.min;
    }
    if (st[it.id]) return true;
    var alt = it.satisfiedBy || [];
    for (var i = 0; i < alt.length; i++) {
      var a = byId[alt[i]];
      if (a && (CHECK[key] || {})[a.id]) return true;
    }
    return false;
  }
  /* The order certificates are actually earned in, which is also the order a
     tab row should read. `student` is nobody's guide but it is everybody's
     first checklist, so it leads. */
  var CK_ORDER = ["check:student", "check:private", "check:instrument",
                  "check:commercial", "check:commercial-me", "check:cfi",
                  "check:cfi-instrument"];
  var CK_SHORT = {
    "check:student": "Student", "check:private": "Private",
    "check:instrument": "Instrument", "check:commercial": "Commercial",
    "check:commercial-me": "Commercial AMEL", "check:cfi": "Flight instructor",
    "check:cfi-instrument": "CFI-Instrument"
  };
  /* The checker that belongs to the guide you are reading. The Task-page copy
     of this tool used to hardcode "check:student" and a "flight instructor"
     sign-off, so a Commercial reader opened it on the Student tab and was
     told it was the instructor checklist. */
  function ckSelf() {
    var k = G && ("check:" + G.slug);
    return (k && checkDef(k)) ? k : "check:student";
  }
  function ckShort(k) {
    return CK_SHORT[k] || (checkDef(k) || {}).title || k;
  }
  /* Site-wide content: the formulas, nav log, weather decoder, FOI mnemonics,
     pre-solo exam and contact page belong to the site, not to a guide. They are
     loaded once in site.js. A guide may still override one by defining the same
     key in its own content, which is why the guide is checked first. */
  function SC(key) {
    return (C && C[key]) || (SITE.shared && SITE.shared[key]) || null;
  }

  /* A checklist def may come from the guide's own content (legacy) or, as they
     all do now, from SITE.checks - which is loaded with the page, so the portal
     and every guide can show any certificate's list. */
  function checkDef(key) {
    return (C && C[key]) || (SITE.checks && SITE.checks[key]) || null;
  }
  function evalCheck(key) {
    var def = checkDef(key); if (!def) return null;
    var items = allItems(def), byId = {};
    items.forEach(function (i) { byId[i.id] = i; });
    var required = items.filter(function (i) { return i.kind !== "exception"; });
    var missing = required.filter(function (i) { return !itemMet(key, i, byId); });
    return { def: def, items: items, byId: byId, required: required, missing: missing,
             met: required.length - missing.length, total: required.length,
             ok: missing.length === 0 };
  }
  function checkerHtml(key) {
    var r = evalCheck(key); if (!r) return "";
    var st = CHECK[key] || {};
    var h = '<div class="checker" data-check="' + key + '">' +
      '<div class="ck-hd"><div><b>' + esc(r.def.title) + "</b>" +
      '<span class="mono">' + esc(r.def.reg) + "</span></div>" +
      '<button class="btn ghost sm" data-reset="' + key + '">Reset</button></div>' +
      (r.def.intro ? '<p class="ck-intro">' + fmt(r.def.intro) + "</p>" : "") +
      (r.def.note ? '<div class="note gold" style="margin:0 0 16px">' + fmt(r.def.note) + "</div>" : "");

    (r.def.groups || []).forEach(function (g) {
      h += '<div class="ck-group"><h4>' + esc(g.h) + "</h4>";
      (g.items || []).forEach(function (it) {
        var met = itemMet(key, it, r.byId);
        var ex = it.kind === "exception";
        if (it.type === "number") {
          h += '<label class="ck-row num' + (met ? " met" : "") + '">' +
            '<span class="ck-t">' + fmt(it.t) +
            '<span class="ck-reg mono">' + esc(it.reg) + "</span></span>" +
            '<span class="ck-num"><input type="number" min="0" step="0.1" inputmode="decimal" ' +
            'data-item="' + it.id + '" value="' + esc(st[it.id] == null ? "" : st[it.id]) + '" ' +
            'aria-label="' + esc(it.t) + '"><i>of ' + it.min + " " + esc(it.unit) + "</i></span></label>";
        } else {
          h += '<label class="ck-row' + (ex ? " ex" : "") + (met && !ex ? " met" : "") + '">' +
            '<input type="checkbox" data-item="' + it.id + '"' + (st[it.id] ? " checked" : "") + '>' +
            '<span class="ck-t">' + (ex ? '<span class="orx">or</span> ' : "") + fmt(it.t) +
            '<span class="ck-reg mono">' + esc(it.reg) + "</span></span></label>";
        }
      });
      h += "</div>";
    });
    h += '<div class="ck-out" id="ck-out-' + key.replace(":", "-") + '">' + verdictHtml(key) + "</div></div>";
    return h;
  }
  function verdictHtml(key) {
    var r = evalCheck(key); if (!r) return "";
    var pct = r.total ? Math.round((r.met / r.total) * 100) : 0;
    var h = '<div class="verdict ' + (r.ok ? "ok" : (r.met ? "part" : "none")) + '">' +
      '<div class="v-hd"><b>' + (r.ok ? "You meet every item on this list"
        : r.missing.length + " item" + (r.missing.length === 1 ? "" : "s") + " still missing") + "</b>" +
      '<span class="v-count mono">' + r.met + " / " + r.total + "</span></div>" +
      '<div class="bar"><span style="width:' + pct + '%"></span></div>';
    if (r.ok) {
      h += '<p class="v-note">Every requirement on this checklist is ticked. This is a study aid, not a ' +
        "determination of eligibility. Your instructor and the evaluator make that call against your logbook " +
        "and the current regulation.</p>";
    } else {
      h += '<div class="v-list"><div class="v-lbl">What is still missing</div><ol>' +
        r.missing.map(function (i) {
          var extra = "";
          if (i.type === "number") {
            var v = parseFloat((CHECK[key] || {})[i.id]);
            if (!isNaN(v)) extra = ' <span class="short">You entered ' + v + "; you need " +
              (Math.round((i.min - v) * 10) / 10) + " more.</span>";
          }
          return "<li><b>" + fmt(i.t) + '</b> <span class="mono rg">' + esc(i.reg) + "</span><br>" +
            fmt(i.fix || "") + extra + "</li>";
        }).join("") + "</ol></div>";
    }
    return h + "</div>";
  }
  function wireChecker(root) {
    var boxes = root.querySelectorAll("[data-check] input");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].addEventListener("change", onCheckInput);
      if (boxes[i].type === "number") boxes[i].addEventListener("input", onCheckInput);
    }
    var rs = root.querySelectorAll("[data-reset]");
    for (var j = 0; j < rs.length; j++) rs[j].addEventListener("click", function () {
      var k = this.getAttribute("data-reset");
      CHECK[k] = {}; saveCheck();
      var host = document.querySelector('[data-check="' + k + '"]');
      var parent = host.parentNode;
      parent.innerHTML = checkerHtml(k);
      wireChecker(parent);
    });
  }
  function onCheckInput() {
    var host = this.closest("[data-check]"), key = host.getAttribute("data-check");
    CHECK[key] = CHECK[key] || {};
    if (this.type === "checkbox") CHECK[key][this.getAttribute("data-item")] = this.checked;
    else CHECK[key][this.getAttribute("data-item")] = this.value;
    saveCheck();
    var out = host.querySelector(".ck-out");
    if (out) out.innerHTML = verdictHtml(key);
    /* refresh met styling without losing focus */
    var r = evalCheck(key);
    var rows = host.querySelectorAll(".ck-row");
    for (var i = 0; i < rows.length; i++) {
      var inp = rows[i].querySelector("[data-item]"); if (!inp) continue;
      var it = r.byId[inp.getAttribute("data-item")]; if (!it) continue;
      rows[i].classList.toggle("met", it.kind !== "exception" && itemMet(key, it, r.byId));
    }
  }

  /* ---------- cross-country validator ---------- */
  var XCRULES = [
    /* The definition itself comes first, because every hour-building question
       further down this list depends on it and most people never read it. */
    { id: "def", g: "Every certificate and rating", t: "Does this count as cross-country time at all?",
      reg: "61.1(b)(3)(ii)",
      need: "For a private, commercial, instrument or ATP requirement, cross-country time is time in flight that includes a point of landing at least a straight-line distance of more than 50 NM from the original point of departure",
      test: function (r) {
        return { far: [r.maxFromStart > 50, "a landing more than 50 NM straight-line from the original point of departure"],
                 pts: [r.points >= 2, "a landing somewhere other than where you started"] };
      } },
    { id: "pvt-solo", g: "Private pilot", t: "The long solo cross-country",
      reg: "61.109(a)(5)(ii)",
      need: "150 NM total distance, full-stop landings at three points, and one segment with a straight-line distance of more than 50 NM between takeoff and landing",
      test: function (r) {
        return { total: [r.total >= 150, "150 NM total distance"],
                 points: [r.points >= 3, "landings at three points"],
                 leg: [r.maxLeg > 50, "one segment more than 50 NM straight-line"] };
      } },
    { id: "pvt-night", g: "Private pilot", t: "The night dual cross-country",
      reg: "61.109(a)(2)(i)",
      need: "One cross-country flight of over 100 NM total distance, flown at night with an instructor",
      test: function (r) { return { total: [r.total > 100, "over 100 NM total distance"] }; } },
    { id: "com-long", g: "Commercial pilot", t: "The long cross-country",
      reg: "61.129(a)(4)(i)",
      need: "Not less than 300 NM total distance, landings at a minimum of three points, one of which is a straight-line distance of at least 250 NM from the original departure point",
      test: function (r) {
        return { total: [r.total >= 300, "at least 300 NM total distance"],
                 points: [r.points >= 3, "landings at three or more points"],
                 far: [r.maxFromStart >= 250, "one point at least 250 NM straight-line from the departure point"] };
      } },
    { id: "com-day", g: "Commercial pilot", t: "The 2-hour day cross-country",
      reg: "61.129(a)(3)(iii)",
      need: "A 2-hour cross-country in a single-engine airplane in daytime conditions, a total straight-line distance of more than 100 NM from the original point of departure",
      test: function (r) { return { far: [r.maxFromStart > 100, "more than 100 NM straight-line from the departure point"] }; } },
    { id: "com-night", g: "Commercial pilot", t: "The 2-hour night cross-country",
      reg: "61.129(a)(3)(iv)",
      need: "A 2-hour cross-country in a single-engine airplane at night, a total straight-line distance of more than 100 NM from the original point of departure",
      test: function (r) { return { far: [r.maxFromStart > 100, "more than 100 NM straight-line from the departure point"] }; } },
    { id: "ifr-250", g: "Instrument rating", t: "The long IFR cross-country",
      reg: "61.65(d)(2)(ii)",
      need: "One cross-country flight with an instructor, under IFR on a filed flight plan, of 250 NM along airways or ATC-directed routing, with an instrument approach at each airport and three different kinds of approaches",
      test: function (r) {
        return { total: [r.total >= 250, "250 NM along the route flown \u2014 this tool sums straight lines between your airports, so an airways routing will be longer than shown"] };
      } },
    { id: "me-long", g: "Commercial multiengine", t: "The long cross-country",
      reg: "61.129(b)(4)(i)",
      need: "Not less than 300 NM total distance in a multiengine airplane, landings at a minimum of three points, one of which is a straight-line distance of at least 250 NM from the original departure point",
      test: function (r) {
        return { total: [r.total >= 300, "at least 300 NM total distance"],
                 points: [r.points >= 3, "landings at three or more points"],
                 far: [r.maxFromStart >= 250, "one point at least 250 NM straight-line from the departure point"] };
      } },
    { id: "stu-25", g: "Student pilot", t: "Solo takeoffs and landings within 25 NM",
      reg: "61.93(b)(1)",
      need: "Another airport within 25 NM of the airport where the student normally receives training",
      test: function (r) { return { near: [r.maxFromStart <= 25, "within 25 NM of the departure airport"] }; } },
    { id: "stu-50", g: "Student pilot", t: "Repeated solo cross-country, 50 NM limit",
      reg: "61.93(b)(2)",
      need: "Repeated solo cross-country flights not more than 50 NM from the point of departure",
      test: function (r) { return { near: [r.maxFromStart <= 50, "not more than 50 NM from the departure point"] }; } },
    { id: "sport", g: "Sport pilot", t: "The solo cross-country",
      reg: "61.313(a)",
      need: "75 NM total distance, full-stop landings at a minimum of two points, and one segment of at least 25 NM between takeoff and landing",
      test: function (r) {
        return { total: [r.total >= 75, "75 NM total distance"],
                 points: [r.points >= 2, "landings at two or more points"],
                 leg: [r.maxLeg >= 25, "one segment of at least 25 NM"] };
      } }
  ];
  function xcRoute(codes) {
    var pts = [], bad = [];
    codes.forEach(function (c) {
      var a = findApt(c);
      if (a) pts.push({ code: c.toUpperCase(), a: a }); else if (c) bad.push(c.toUpperCase());
    });
    if (pts.length < 2) return { pts: pts, bad: bad, legs: [], total: 0, points: pts.length, maxLeg: 0, maxFromStart: 0 };
    var legs = [], total = 0, maxLeg = 0;
    for (var i = 1; i < pts.length; i++) {
      var d = nm(pts[i - 1].a, pts[i].a);
      legs.push({ from: pts[i - 1], to: pts[i], d: d });
      total += d; if (d > maxLeg) maxLeg = d;
    }
    var maxFromStart = 0;
    for (var j = 1; j < pts.length; j++) {
      var f = nm(pts[0].a, pts[j].a); if (f > maxFromStart) maxFromStart = f;
    }
    return { pts: pts, bad: bad, legs: legs, total: total, points: pts.length,
             maxLeg: maxLeg, maxFromStart: maxFromStart };
  }
  function xcToolHtml() {
    return '<div class="xc">' +
      '<div class="xc-in"><label for="xcRoute">Your route &mdash; airport identifiers in the order you flew them</label>' +
      '<input id="xcRoute" type="text" placeholder="KFXE  KOCF  KLAL  KFXE" autocomplete="off" spellcheck="false">' +
      '<div class="xc-btns"><button class="btn" id="xcGo">Check the route</button>' +
      '<button class="btn ghost" id="xcEx1">Private example</button>' +
      '<button class="btn ghost" id="xcEx2">Commercial example</button></div>' +
      '<p class="muted sm">Four-letter ICAO (KFXE) or the three-letter FAA code (FXE). Separate them with ' +
      'spaces or commas. Put every point you landed at, in order, including the return.</p></div>' +
      '<div id="xcOut"></div></div>';
  }
  function renderXC() {
    var raw = el("xcRoute").value || "";
    var codes = raw.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    var out = el("xcOut");
    if (codes.length < 2) {
      out.innerHTML = '<p class="muted">Enter at least two airports.</p>'; return;
    }
    var r = xcRoute(codes);
    if (r.bad.length) {
      out.innerHTML = '<div class="note flag"><span class="lbl">Not found</span><span class="mono">' +
        esc(r.bad.join(", ")) + '</span> is not in the airport list. Check the spelling, or try the ' +
        "other code format for that field.</div>";
      if (r.pts.length < 2) return;
    } else out.innerHTML = "";

    var h = '<div class="xc-sum">' +
      xcStat(r.total.toFixed(1), "NM", "Total distance flown") +
      xcStat(String(r.points), "", "Points landed at") +
      xcStat(r.maxLeg.toFixed(1), "NM", "Longest single segment") +
      xcStat(r.maxFromStart.toFixed(1), "NM", "Farthest point from departure") +
      "</div>";

    h += '<div class="tablewrap" style="margin:16px 0"><table class="studytable"><thead><tr>' +
      "<th>Leg</th><th>From</th><th>To</th><th>Straight-line distance</th></tr></thead><tbody>" +
      r.legs.map(function (l, i) {
        return '<tr><td class="mono nw" data-l="Leg">' + (i + 1) + "</td>" +
          '<td data-l="From"><b>' + esc(l.from.code) + "</b><br>" + esc(l.from.a.name) +
          (l.from.a.city ? ", " + esc(l.from.a.city) + " " + esc(l.from.a.st) : "") + "</td>" +
          '<td data-l="To"><b>' + esc(l.to.code) + "</b><br>" + esc(l.to.a.name) +
          (l.to.a.city ? ", " + esc(l.to.a.city) + " " + esc(l.to.a.st) : "") + "</td>" +
          '<td class="mono nw" data-l="Distance">' + l.d.toFixed(1) + " NM</td></tr>";
      }).join("") + "</tbody></table></div>";

    h += '<div id="xcMap" class="xc-map"><div class="xc-mapfall">' +
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      "<span>Loading the map&hellip;</span></div></div>";

    h += '<div class="xc-rules"><h3>Does this route satisfy the requirement?</h3>' +
      XCRULES.map(function (rule) {
        var checks = rule.test(r), keys = Object.keys(checks);
        var pass = keys.every(function (k) { return checks[k][0]; });
        return '<details class="xcr ' + (pass ? "pass" : "fail") + '"><summary>' +
          '<span class="mark">' + (pass ? "&#10003;" : "&times;") + "</span>" +
          '<span class="xn"><b>' + esc(rule.t) + '</b><i>' + esc(rule.g) + "</i></span>" +
          '<span class="mono xrg">' + esc(rule.reg) + "</span></summary>" +
          '<div class="xcr-b"><p class="need">' + esc(rule.need) + "</p><ul>" +
          keys.map(function (k) {
            return '<li class="' + (checks[k][0] ? "y" : "n") + '">' +
              (checks[k][0] ? "&#10003; " : "&times; ") + esc(checks[k][1]) + "</li>";
          }).join("") + "</ul></div></details>";
      }).join("") + "</div>";

    h += '<div class="note"><span class="lbl">Read this before you rely on it</span>' +
      "Distances are great-circle between airport reference points, which is how straight-line distance is " +
      "normally measured. This checks <b>distance and number of landing points only</b>. It cannot check the " +
      "things the regulation also requires: whether the landings were full-stop, whether it was solo or dual, " +
      "day or night, the flight time, or the aircraft category and class. Your logbook and your instructor " +
      "settle those. The one instrument item on the list is measured differently again: 61.65(d)(2)(ii)(A) " +
      "counts distance <b>along airways or ATC-directed routing</b>, so a flight this tool shows as short of " +
      "250 NM may still qualify once the real routing is measured.</div>";

    out.innerHTML += h;
    drawMap(r);
  }
  function xcStat(v, unit, label) {
    return '<div class="xs"><b>' + esc(v) + (unit ? '<i>' + esc(unit) + "</i>" : "") +
      "</b><span>" + esc(label) + "</span></div>";
  }
  function drawMap(r) {
    var host = el("xcMap"); if (!host) return;
    function fallback() {
      /* no tiles: draw the route to scale ourselves so the shape is still visible */
      /* equirectangular with a cos(lat) correction so the shape is geographically honest */
      var lats = r.pts.map(function (p) { return p.a.lat; }), lons = r.pts.map(function (p) { return p.a.lon; });
      var la0 = Math.min.apply(null, lats), la1 = Math.max.apply(null, lats);
      var lo0 = Math.min.apply(null, lons), lo1 = Math.max.apply(null, lons);
      var kx = Math.cos((la0 + la1) / 2 * Math.PI / 180);
      var W = 800, H = 420, pad = 40;
      var wSpan = Math.max(0.02, (lo1 - lo0) * kx), hSpan = Math.max(0.02, la1 - la0);
      var sc = Math.min((W - 2 * pad) / wSpan, (H - 2 * pad) / hSpan);
      var cx = (lo0 + lo1) / 2 * kx, cy = (la0 + la1) / 2;
      function X(lon) { return W / 2 + (lon * kx - cx) * sc; }
      function Y(lat) { return H / 2 - (lat - cy) * sc; }
      var pts = r.pts.map(function (p) { return X(p.a.lon).toFixed(1) + "," + Y(p.a.lat).toFixed(1); }).join(" ");
      var dots = r.pts.map(function (p, i) {
        var x = X(p.a.lon), y = Y(p.a.lat);
        return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6" class="d' + (i === 0 ? " s" : "") + '"/>' +
          '<text x="' + (x + 11).toFixed(1) + '" y="' + (y + 4).toFixed(1) + '">' + esc(p.code) + "</text>";
      }).join("");
      host.innerHTML = '<svg class="xc-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img" ' +
        'aria-label="Route diagram"><polyline points="' + pts + '"/>' + dots + "</svg>" +
        '<div class="xc-cap">Route drawn to scale from the airport coordinates. ' +
        "Map tiles need an internet connection.</div>";
    }
    if (!window.L) { fallback(); return; }
    try {
      host.innerHTML = "";
      var map = L.map(host, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 17, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      var line = r.pts.map(function (p) { return [p.a.lat, p.a.lon]; });
      L.polyline(line, { color: "#0E6BA8", weight: 3, opacity: .9 }).addTo(map);
      r.pts.forEach(function (p, i) {
        L.marker([p.a.lat, p.a.lon], {
          icon: L.divIcon({ className: "xc-pin" + (i === 0 ? " start" : ""), html: esc(p.code),
                            iconSize: [54, 22], iconAnchor: [27, 11] })
        }).addTo(map).bindPopup("<b>" + esc(p.code) + "</b><br>" + esc(p.a.name));
      });
      map.fitBounds(L.latLngBounds(line).pad(0.18));
      setTimeout(function () { map.invalidateSize(); }, 120);
    } catch (e) { fallback(); }
  }
  function wireXC() {
    if (!el("xcGo")) return;
    el("xcGo").addEventListener("click", renderXC);
    el("xcRoute").addEventListener("keydown", function (e) { if (e.key === "Enter") renderXC(); });
    el("xcEx1").addEventListener("click", function () {
      el("xcRoute").value = "KFXE KOCF KLAL KFXE"; renderXC();
    });
    el("xcEx2").addEventListener("click", function () {
      el("xcRoute").value = "KFXE KTLH KVLD KFXE"; renderXC();
    });
  }


  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmt(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
  }
  function el(id) { return document.getElementById(id); }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  }
  function areaOf(r) { for (var i = 0; i < ACS.length; i++) if (ACS[i].roman === r) return ACS[i]; return null; }
  function taskOf(code) {
    var p = String(code).split("."), a = areaOf(p[0]);
    if (!a) return null;
    for (var i = 0; i < a.tasks.length; i++) if (a.tasks[i].letter === p[1]) return a.tasks[i];
    return null;
  }
  /* built on demand, because the guide is not loaded at script time */
  var FLAT = null;
  function flat() {
    if (FLAT) return FLAT;
    FLAT = [];
    ACS.forEach(function (a) {
      a.tasks.forEach(function (t) { FLAT.push({ a: a, t: t, code: a.roman + "." + t.letter }); });
    });
    return FLAT;
  }

  /* ---------------------------------------------------------------- anchors --
     Several blocks used to be keyed on a bare Task code - `if (code === "III.A")`
     put the eligibility checkers on the page, `"III.C"` put the weather decoder
     button there, `"II.K"` the endorsement library. Those codes are the RIGHT
     ones for the CFI guide, and the wrong ones for every other guide, because
     a Task code only means something inside its own document. Simon found the
     result on the Commercial guide: the certificate checkers were sitting inside
     "Communications, Light Signals, and Runway Lighting Systems", which is what
     Commercial calls III.A.

     So resolve the anchor from the CURRENT guide's own Task titles instead. A
     guide that has no such Task (Commercial AMEL has no Pilot Qualifications
     Task, and no guide but the CFI has an endorsements Task) simply gets no
     anchor, and the block does not render anywhere in it.                     */
  var ANCHOR_PAT = {
    weather:   /^weather information$/i,
    pilotqual: /^pilot qualifications$/i,
    endorse:   /^endorsements and logbook entries$/i
  };
  var ANCHOR = null;
  function anchorFor(kind) {
    if (!ANCHOR) {
      ANCHOR = {};
      flat().forEach(function (f) {
        var title = String(f.t.title || "");
        for (var k in ANCHOR_PAT) {
          if (!ANCHOR[k] && ANCHOR_PAT[k].test(title)) ANCHOR[k] = f.code;
        }
      });
    }
    return ANCHOR[kind] || null;
  }
  function isAnchor(kind, code) {
    var a = anchorFor(kind);
    return !!a && a === code;
  }
  /* The FOI mnemonics belong to the teaching-theory Area, which only the two
     instructor documents have. Everywhere else Area I is Preflight Preparation
     and the mnemonics must not be wired onto it. */
  function isFoiArea(code) {
    return !!G && (G.slug === "cfi" || G.slug === "cfi-instrument") &&
           /^I\.[A-Z]$/.test(String(code || ""));
  }

  /* Which Tasks the evaluator MUST select, and which are excluded.
     Transcribed from each document's own Area notes and verified at build
     time - NOT pattern-matched, because the notes are rating-conditional and
     one of them says OMIT rather than select.                               */
  function reqSpec() { return (G && G.required) || { required: [], excluded: [], why: {} }; }
  function mandatory(a, t) {
    return reqSpec().required.indexOf(a.roman + "." + t.letter) >= 0;
  }
  function excluded(a, t) {
    return (reqSpec().excluded || []).indexOf(a.roman + "." + t.letter) >= 0;
  }
  function mustWhy(code) { return (reqSpec().why || {})[code] || ""; }


  /* Reference token -> human name + where to find it. Used by the study-table tool. */
  var REFMAP = [
    ["FAA-H-8083-9", "Aviation Instructor's Handbook (AIH)", "https://www.faa.gov/regulations_policies/handbooks_manuals/aviation/aviation_instructors_handbook"],
    ["FAA-H-8083-3", "Airplane Flying Handbook (AFH)", "https://www.faa.gov/regulations_policies/handbooks_manuals/aviation/airplane_handbook"],
    ["FAA-H-8083-25", "Pilot's Handbook of Aeronautical Knowledge (PHAK)", "https://www.faa.gov/regulations_policies/handbooks_manuals/aviation/phak"],
    ["FAA-H-8083-2", "Risk Management Handbook (RMH)", "https://www.faa.gov/regulationspolicies/handbooksmanuals/risk-management-handbook-faa-h-8083-2a"],
    ["FAA-H-8083-28", "Aviation Weather Handbook", "https://www.faa.gov/regulationspolicies/handbooksmanuals/aviation/faa-h-8083-28b-aviation-weather-handbook"],
    ["FAA-H-8083-23", "Seaplane, Skiplane and Float/Ski Handbook", "https://www.faa.gov/regulations_policies/handbooks_manuals/aviation/seaplane_handbook"],
    ["FAA-H-8083-15", "Instrument Flying Handbook", "https://www.faa.gov/regulations_policies/handbooks_manuals/aviation"],
    ["FAA-H-8083-16", "Instrument Procedures Handbook", "https://www.faa.gov/regulations_policies/handbooks_manuals/aviation"],
    ["AC 61-65", "AC 61-65K, Certification: Pilots and Instructors", "https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.information/documentID/1044476"],
    ["AC 61-67", "AC 61-67C, Stall and Spin Awareness Training", "https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.information/documentid/1028760"],
    ["AC 91-73", "AC 91-73B, Procedures During Taxi Operations", "https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.information/documentid/1020226"],
    ["AC 91-92", "AC 91-92, Pilot's Guide to Preflight Weather", "https://www.faa.gov/regulations_policies/advisory_circulars"],
    ["AC 120-71", "AC 120-71, Standard Operating Procedures", "https://www.faa.gov/regulations_policies/advisory_circulars"],
    ["AC 60-28", "AC 60-28, English Language Standard", "https://www.faa.gov/regulations_policies/advisory_circulars"],
    ["AC 68-1", "AC 68-1, BasicMed", "https://www.faa.gov/regulations_policies/advisory_circulars"],
    ["part 61", "14 CFR Part 61 (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-D/part-61"],
    ["parts 61", "14 CFR Part 61 (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-D/part-61"],
    ["part 91", "14 CFR Part 91 (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-91"],
    ["part 43", "14 CFR Part 43 (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-43"],
    ["part 68", "14 CFR Part 68, BasicMed (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-D/part-68"],
    ["part 23", "14 CFR Part 23 (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-23"],
    ["part 39", "14 CFR Part 39, Airworthiness Directives (eCFR)", "https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-39"],
    ["AIM", "Aeronautical Information Manual", "https://www.faa.gov/air_traffic/publications/atpubs/aim_html/"],
    ["Chart Supplement", "Chart Supplement and digital charts", "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dafd/"],
    ["POH/AFM", "The aircraft's own POH / AFM", ""]
  ];
  function refsFor(t) {
    var raw = String(t.references || ""), out = [], seen = {};
    REFMAP.forEach(function (r) {
      if (raw.indexOf(r[0]) >= 0 && !seen[r[1]]) { seen[r[1]] = 1; out.push(r); }
    });
    return out;
  }

  /* ---------- svg icons ---------- */
  var I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h9a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-4v13.5H20z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h11M4 12h11M4 17h7"/><path d="m16.5 16 2 2 3.5-4"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19.5"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    sign: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17.5c3-1 4-6 6.5-6s2 4 4.5 4 3.5-2.5 3.5-2.5"/><path d="M4 21h16"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>',
    quiz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h9l4 4v14H6z"/><path d="M10 12h6M10 16h4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="#EAF2F8"><path d="M21 15.5v-1.9l-8-4.6V3.6a1.6 1.6 0 1 0-3.2 0V9L1.8 13.6v1.9l8-2.4v5.2l-2.4 1.6v1.4l3.9-1 3.9 1v-1.4L13 18.3v-5.2z"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8.5v5M8.5 11h5"/></svg>',
    calc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 12h2M14 12h2M8 16.5h2M14 16.5h2"/></svg>',
    badge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 12.5l2 2 4.5-4.5"/><path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 18h10.5a3.5 3.5 0 0 0 .3-7 5.5 5.5 0 0 0-10.5-1A4 4 0 0 0 7 18z"/><path d="M9 21.5l1-2M13 21.5l1-2"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m7 9 5 5 5-5"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m7 15 5-5 5 5"/></svg>'
  };

  /* ---------- left rail ---------- */
  /* the rail belongs to a context: null on the portal, a slug inside a guide.
     Rebuilding only on a change keeps scroll position and open <details>.     */
  var RAILFOR = undefined;
  function syncRail(slug) {
    if (RAILFOR === slug) return;
    RAILFOR = slug;
    buildRail();
  }

  function railLink(href, nav, icon, label) {
    return '<a href="' + href + '" data-nav="' + nav + '">' + icon + esc(label) + "</a>";
  }
  function buildRail() {
    /* off the portal the rail is the list of guides; inside a guide it is that
       guide's own contents, with a way back out at the top                    */
    var h = "", base = G ? "/g/" + G.slug : "";
    if (!G) {
      h += '<div class="railhd"><span>Study guides</span></div><div class="top">';
      GUIDES.forEach(function (g) {
        h += '<a class="g-' + esc(g.accent) + '" href="' + guideHref(g.slug) + '" data-nav="/g/' + g.slug + '">' +
          '<span class="gdot"></span>' + esc(g.cert) + "</a>";
      });
      h += "</div>";
      h += '<div class="railhd"><span>Tools</span></div><div class="top">' +
        railLink("#/search", "/search", I.search, "Advanced search") +
        railLink("#/codes", "/codes", I.grid, "Missed-code study table") +
        railLink("#/mock", "/mock", I.badge, "Mock checkrides") +
        railLink("#/tools", "/tools", I.calc, "Useful resources") +
        railLink("#/wx", "/wx", I.cloud, "Weather decoder") +
        railLink("#/fplan", "/fplan", I.sign, "ICAO flight plan") +
        railLink("#/endorsements", "/endorsements", I.sign, "Sample endorsements") +
        railLink("#/presolo", "/presolo", I.quiz, "Pre-solo written exam") +
        railLink("#/holding", "/holding", I.grid, "Holding entries") +
        railLink("#/cdi", "/cdi", I.badge, "CDI and HSI") +
        railLink("#/resources", "/resources", I.link, "Official resources") +
        railLink("#/about", "/about", I.user, "About") +
        railLink("#/contact", "/contact", I.mail, "Found something wrong?") +
        "</div>";
      el("rail").innerHTML = h;
      el("brandSub").textContent = "Part 61 · Airplane";
      return;
    }

    var m = guideMeta(G.slug) || {};
    el("brandSub").textContent = m.cert || G.doc;
    h += '<div class="top"><a class="back" href="#/" data-nav="/">' + I.home + "All guides</a></div>";
    h += '<div class="railhd"><span>' + esc(m.short || "This guide") + "</span></div><div class=\"top\">" +
      railLink(here(""), base, I.book, "Guide home") +
      railLink(here("search"), base + "/search", I.search, "Search this guide") +
      railLink(here("eligibility"), base + "/eligibility", I.badge, "Am I eligible?") +
      railLink(here("mock"), base + "/mock", I.quiz, "Mock checkride");
    /* no additional knowledge test on a class add-on - see build.py GUIDES */
    if (m.test) h += railLink(here("codes"), base + "/codes", I.grid, "Missed-code study table");
    if (reqSpec().required.length) h += railLink(here("plan"), base + "/plan", I.check, "What gets tested");
    if (!G.is_pts && !G.teaching) h += railLink(here("addrating"), base + "/addrating", I.check, "Adding this rating");
    if (hasAppx()) h += railLink(here("appx"), base + "/appx", I.book, "Appendices");
    if (ENDO.length) h += railLink(here("endorsements"), base + "/endorsements", I.sign, "Endorsements");
    /* The FOI mnemonics are for someone who has to TEACH the fundamentals of
       instructing, so they sit in the guide block on the two teaching guides
       only. The route still works everywhere, so a link from anywhere lands
       on a real page. */
    if (G.teaching && SC("mnemonics")) {
      h += railLink(here("mnemonics"), base + "/mnemonics", I.quiz, "FOI mnemonics");
    }
    h += "</div>";
    /* These pages are the same everywhere, but keep them INSIDE the guide -
       linking to the site-level route would drop the reader out of the guide
       and reset the rail, losing their place. */
    h += '<div class="railhd"><span>Everywhere</span></div><div class="top">' +
      railLink(here("tools"), base + "/tools", I.calc, "Useful resources") +
      railLink(here("wx"), base + "/wx", I.cloud, "Weather decoder") +
      railLink(here("fplan"), base + "/fplan", I.sign, "ICAO flight plan") +
      (SC("presolo") ? railLink(here("presolo"), base + "/presolo", I.quiz, "Pre-solo written exam") : "") +
      railLink(here("holding"), base + "/holding", I.grid, "Holding entries") +
      railLink(here("cdi"), base + "/cdi", I.badge, "CDI and HSI") +
      (hasIpc() ? railLink(here("ipc"), base + "/ipc", I.check, "Instrument proficiency check") : "") +
      railLink(here("resources"), base + "/resources", I.link, "Official resources") +
      railLink(here("about"), base + "/about", I.user, "About") +
      railLink(here("contact"), base + "/contact", I.mail, "Found something wrong?") +
      "</div>";

    h += '<div class="railhd"><span>Areas of Operation</span>' +
      '<span class="exp"><button type="button" id="expAll" title="Expand all areas">' + I.expand + '</button>' +
      '<button type="button" id="colAll" title="Collapse all areas">' + I.collapse + "</button></span></div>";
    ACS.forEach(function (a) {
      h += '<details class="ar" id="ar-' + a.roman + '"><summary>' +
        '<span class="rn">' + a.roman + '</span><span class="rt">' + esc(a.title) + '</span>' + I.chev +
        '</summary><ul>' +
        '<li><a href="' + here("a/" + a.roman) + '" data-nav="' + base + "/a/" + a.roman + '"><span class="c">—</span>' +
        '<span>Area overview</span></a></li>' +
        a.tasks.map(function (t) {
          var code = a.roman + "." + t.letter;
          return '<li><a href="' + here("t/" + code) + '" data-nav="' + base + "/t/" + code + '">' +
            '<span class="c">' + t.letter + '</span><span>' + esc(t.title) + '</span></a></li>';
        }).join("") + "</ul></details>";
    });
    el("rail").innerHTML = h;
    if (el("expAll")) el("expAll").addEventListener("click", function () { setAll(true); });
    if (el("colAll")) el("colAll").addEventListener("click", function () { setAll(false); });
  }
  function setAll(open) {
    var ds = document.querySelectorAll("#rail details.ar");
    for (var i = 0; i < ds.length; i++) ds[i].open = open;
  }
  /* Exactly ONE rail link is current. Prefix matching is still wanted - a task
     page with an element anchor has to light its task link - but only for the
     LONGEST match, or "Guide home" (data-nav "/g/private") stays lit on every
     page inside the guide, which is the bug this fixes. */
  function markRail(path) {
    var links = document.querySelectorAll("#rail a[data-nav]");
    var best = -1, bestLen = -1;
    for (var j = 0; j < links.length; j++) {
      var nv = links[j].getAttribute("data-nav");
      var match = nv === path || (nv !== "/" && path.indexOf(nv + "/") === 0);
      if (match && nv.length > bestLen) { bestLen = nv.length; best = j; }
    }
    for (var i = 0; i < links.length; i++) {
      var on = i === best;
      links[i].classList.toggle("on", on);
      if (on) {
        var d = links[i].closest("details");
        if (d) d.open = true;
        if (window.innerWidth >= 1024) {
          var r = el("rail"), lt = links[i].offsetTop;
          if (lt < r.scrollTop || lt > r.scrollTop + r.clientHeight - 60) r.scrollTop = lt - 140;
        }
      }
    }
  }

  /* ---------- shared blocks ---------- */
  function refChips(refs) {
    return String(refs || "").split(/[;,]\s*/).filter(Boolean)
      .map(function (r) { return '<span class="chip">' + esc(r.trim()) + "</span>"; }).join("");
  }
  var RATINGWORD = {
    ASEL: "single-engine land airplane", ASES: "single-engine seaplane",
    AMEL: "multiengine land airplane",   AMES: "multiengine seaplane"
  };
  function ratingWordsTitle() {
    var w = { ASEL: "Airplane Single-Engine Land", ASES: "Airplane Single-Engine Sea",
              AMEL: "Airplane Multiengine Land",   AMES: "Airplane Multiengine Sea" };
    return (G && w[G.rating]) || "Airplane";
  }
  function ratingWords() { return (G && RATINGWORD[G.rating]) || "single-engine land airplane"; }
  function acsTable(t, kind, hl) {
    var rows = t[kind]; if (!rows || !rows.length) return "";
    /* A PTS has none of these three buckets - its elements are just numbered. */
    var names = (G && G.is_pts) ? { K: "Elements", R: "Risk Management", S: "Skills" }
                                : { K: "Knowledge", R: "Risk Management", S: "Skills" };
    var lead = (t.lead && t.lead[kind]) || "";
    var h = '<div class="acs ' + kind + '" id="acs-' + kind + '"><div class="hdr"><b>' + names[kind] + "</b>" +
      '<span class="lead">' + esc(lead) + "</span></div><table><tbody>";
    rows.forEach(function (e) {
      var sub = /[a-z]$/.test(e.code);
      var on = hl && hl.toUpperCase() === e.code.toUpperCase();
      var cls = (sub ? "sub " : "") + (on ? "hit " : "") +
                (e.archived ? "arch " : "") + (e.na ? "na " : "");
      /* An element the FAA wrote for another rating, or retired outright, is
         shown exactly as printed and labelled. Hiding it would leave a hole in
         the numbering that looks like a bug in this site. */
      var tail = e.archived
        ? '<span class="elnote">The FAA retired this element. Nothing to study.</span>'
        : e.na
          ? '<span class="elnote">' + esc(e.na) + " only \u2014 not tested in a " +
            esc(ratingWords()) + ".</span>"
          : "";
      h += '<tr id="el-' + e.code + '" class="' + cls.trim() + '">' +
        '<td class="c mono">' + esc(e.code) + "</td>" +
        '<td class="t">' + esc(e.text) + tail + "</td></tr>";
    });
    return h + "</tbody></table></div>";
  }
  /* The CFI guides are written to teach FROM; the rest are written to get a
     student pilot ready to be examined. Same sections, different audience, so
     the headings ask the reader to do the right thing. */
  /* "ACS" or "PTS", whichever document this guide actually is. The CFI-Instrument
     guide is FAA-S-8081-9E, a Practical Test Standard - its own home page warns
     "it has no Knowledge, Risk Management and Skills element codes", and II.C
     teaches "if you talk about K-codes on your own checkride, you are in the
     wrong book". Calling its elements ACS elements taught the opposite. */
  function STD() { return (G && G.is_pts) ? "PTS" : "ACS"; }

  function W(key) {
    var teach = G && G.teaching;
    var V = {
      flow:      ["Teach it in this order",          "Learn it in this order"],
      flowHint:  ["",                                 ""],
      examples:  ["In the airplane, with a real student",
                  "On the day: how the examiner asks it"],
      exHint:    ["What applying it looks like \u2014 not just the definition",
                  "The question, and what a good answer sounds like"],
      more:      ["How to teach it",                 "Going deeper"],
      errHint:   ["What students actually do",       "What busts this task"]
    };
    return (V[key] || ["", ""])[teach ? 0 : 1];
  }

  /* A card may answer several elements at once - "S3, S4, S5" - so each gets
     its own chip, coloured by whether it is a Knowledge, Risk or Skills code
     and linked to that row in the table above. */
  function codeChips(code) {
    if (!code) return "";
    return String(code).split(/\s*,\s*/).filter(Boolean).map(function (c) {
      var kind = /\.R\d/.test(c) ? "r" : /\.S\d/.test(c) ? "s" : "k";
      /* data-jump, not an href: a bare "#el-..." would rewrite the hash and
         the router would take it for a route. */
      return '<button type="button" class="chip lnk ' + kind + '" data-jump="el-' + esc(c) +
        '" title="Show this element in the table above">' + esc(c) + "</button>";
    }).join("");
  }

  function figure(id, cap) {
    if (!IMG[id]) return "";
    var d = imgSrc(id);
    var c = cap || (DATA.figcap && DATA.figcap[id]) || "";
    var src = (DATA.figsrc && DATA.figsrc[id]) || "";
    return '<figure class="fig"><img loading="lazy" src="' + d + '" alt="' + esc(c) + '" data-lb="' + esc(c) + '">' +
      (c ? '<figcaption>' + fmt(c) + (src ? '<span class="src">' + esc(src) + "</span>" : "") + "</figcaption>" : "") +
      "</figure>";
  }
  function videos(list) {
    if (!list || !list.length) return "";
    return '<div class="vids">' + list.map(function (v) {
      return '<div class="vid"><button class="fr" data-yt="' + esc(v.id) + '" aria-label="Play ' + esc(v.t) + '">' +
        '<img loading="lazy" src="https://i.ytimg.com/vi/' + esc(v.id) + '/hqdefault.jpg" alt="">' +
        '<span class="play"><span>' + I.play + "</span></span></button>" +
        '<div class="cap"><b>' + esc(v.t) + "</b><span>" + esc(v.by || "") + "</span></div></div>";
    }).join("") + "</div>";
  }
  /* on-page index */
  function toc(items) {
    if (!items.length) return "";
    return '<details class="toc" open><summary><span>On this page</span>' +
      '<span class="n">' + items.length + " sections</span></summary><ol>" +
      items.map(function (i) {
        return '<li class="lv' + (i.lv || 1) + '"><a href="#' + i.id + '" data-jump="' + i.id + '">' +
          esc(i.t) + "</a></li>";
      }).join("") + "</ol></details>";
  }

  /* ================= SEARCH INDEX =================
     One index per guide, cached on that guide's own payload. The site-wide
     search is the concatenation of the indexes of whatever is loaded - which
     is why the search page loads every guide before it reports "nothing
     found". Searching only the current guide and calling that "the site" was
     the old bug: on the portal there IS no current guide, so it found nothing
     and said so. */
  function guideIndex(g) {
    if (g.__idx) return g.__idx;
    var out = [];
    function add(code, where, text, anchor, kind) {
      if (!text) return;
      /* strip the inline markers so snippets read as sentences, not source */
      var clean = String(text).replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
      if (!clean) return;
      out.push({ g: g.slug, c: code, w: where, t: clean, a: anchor || "",
                 k: kind, l: clean.toLowerCase() });
    }
    (g.acs || []).forEach(function (a) {
      (a.tasks || []).forEach(function (t) {
        var code = a.roman + "." + t.letter, v = (g.content || {})[code] || {};
        add(code, "Summary", v.oneLine, "", "note");
        add(code, "Why it matters", v.why, "why", "note");
        (v.numbers || []).forEach(function (n) { add(code, "Numbers to know", n, "", "note"); });
        (v.memory || []).forEach(function (m) {
          add(code, "Memory aid \u2014 " + m.tag, [m.tag, m.ex, m.note].filter(Boolean).join(". "),
              "memory", "note");
        });
        (v.flow || []).forEach(function (x) { add(code, "In order", x, "flow", "note"); });
        (v.cards || []).forEach(function (k) {
          var an = "c-" + slug(k.h || "");
          add(code, k.h || "Block", [k.h, k.sub].filter(Boolean).join(" \u2014 "), an, "note");
          (k.bullets || []).forEach(function (b) { add(code, k.h || "Block", b, an, "note"); });
          (k.groups || []).forEach(function (gr) {
            (gr.b || []).forEach(function (b) { add(code, (k.h || "Block") + " \u00b7 " + gr.h, b, an, "note"); });
          });
          if (k.more) add(code, (k.h || "Block") + " \u2014 more", k.more, an, "note");
        });
        (v.errors || []).forEach(function (e) { add(code, "Common error", e, "errors", "error"); });
        (v.examples || []).forEach(function (e) {
          add(code, "Scenario question", e.q + " " + e.a, "examples", "example");
        });
        var KIND = { K: "knowledge", R: "risk", S: "skill" };
        "KRS".split("").forEach(function (sec) {
          (t[sec] || []).forEach(function (e) {
            add(code, "ACS element " + e.code, e.text, "el-" + e.code, KIND[sec]);
          });
        });
        add(code, "ACS objective", t.objective, "", "acs");
        add(code, "Task title", t.title, "", "acs");
      });
    });
    g.__idx = out;
    return out;
  }

  /* rows for the current scope: one guide, or every guide that is loaded */
  function searchIndex(slugs) {
    var out = [];
    (slugs && slugs.length ? slugs : GUIDES.map(function (x) { return x.slug; }))
      .forEach(function (sl) { if (LOADED[sl]) out = out.concat(guideIndex(LOADED[sl])); });
    return out;
  }
  /* the guide search still reads the current context */
  function buildIndex() { return G ? guideIndex(G) : []; }

  /* Every document's own prefix. FII must come before FI or the alternation
     matches "FI" and leaves a stray "I". */
  var CODE_RE = /^((?:FII|AI|FI|PA|CA|IR)\.[IVX]+\.[A-Z]\.[KRS]\d+[a-z]?)$/i;
  var TASK_RE = /^(?:(FII|AI|FI|PA|CA|IR)\.)?([IVX]+)\.([A-Z])(?:\.[KRS]\d*)?$/i;

  /* Look an element code up in ONE guide payload. */
  function findIn(g, code) {
    code = code.toUpperCase();
    var acs = g.acs || [];
    for (var i = 0; i < acs.length; i++) {
      var tasks = acs[i].tasks || [];
      for (var j = 0; j < tasks.length; j++) {
        var t = tasks[j];
        for (var s = 0; s < 3; s++) {
          var arr = t["KRS"[s]] || [];
          for (var k = 0; k < arr.length; k++) if (arr[k].code.toUpperCase() === code) {
            return { slug: g.slug, code: acs[i].roman + "." + t.letter,
                     el: arr[k], task: t, area: acs[i] };
          }
        }
      }
    }
    return null;
  }
  /* Current guide first, then every other loaded guide. Commercial and the
     multiengine add-on share the CA prefix, so a code really can live in two
     guides - both are returned and the page offers both. */
  function findElement(code) {
    var out = [], seen = {};
    function look(g) {
      if (!g || seen[g.slug]) return;
      seen[g.slug] = 1;
      var f = findIn(g, code);
      if (f) out.push(f);
    }
    look(G);
    GUIDES.forEach(function (x) { look(LOADED[x.slug]); });
    return out;
  }
  function snippet(text, q, len) {
    len = len || 190;
    var lo = text.toLowerCase(), i = lo.indexOf(q);
    if (i < 0) return esc(text.slice(0, len)) + (text.length > len ? "…" : "");
    var pad = Math.floor((len - q.length) / 2);
    var s = Math.max(0, i - pad), e = Math.min(text.length, i + q.length + pad);
    if (s > 0) { while (s > 0 && !/\s/.test(text[s - 1])) s--; }
    if (e < text.length) { while (e < text.length && !/\s/.test(text[e])) e++; }
    var out = (s > 0 ? "…" : "") + text.slice(s, i) + "\u0001" + text.slice(i, i + q.length) +
      "\u0002" + text.slice(i + q.length, e) + (e < text.length ? "…" : "");
    return esc(out).replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
  }

  /* ---------- pages ---------- */
  function tool(href, icon, title, desc) {
    return '<a class="acard tool" href="' + href + '"><span class="ti">' + icon + "</span>" +
      "<h3>" + esc(title) + "</h3><p>" + esc(desc) + "</p></a>";
  }

  /* ---------- advanced search ----------
     Two scopes. Inside a guide it searches that guide. From the portal it
     searches every guide, which means every guide's data has to be in memory -
     so entering the page starts loading them and the search re-runs as each
     arrives. Filters narrow by guide and by what part of a page the text sits
     in (the ACS wording itself, the study notes, the scenario questions...). */

  var SECTIONS = [
    { k: "acs",       t: "ACS wording" },
    { k: "knowledge", t: "Knowledge" },
    { k: "risk",      t: "Risk management" },
    { k: "skill",     t: "Skills" },
    { k: "note",      t: "Study notes" },
    { k: "example",   t: "Scenario questions" },
    { k: "error",     t: "Common errors" }
  ];
  var SF = { guides: null, sections: null, q: "" };   /* null = no filter */

  function inFilter(set, key) { return !set || set[key]; }
  function anyOn(set) { if (!set) return false; for (var k in set) if (set[k]) return true; return false; }

  function pageSearch(q, isGlobal) {
    q = (q || "").trim();
    SF.q = q;
    var scopeName = isGlobal ? "every guide on this site"
                             : esc((guideMeta(G.slug) || {}).cert || G.title);
    var h = '<div class="eyebrow">Search</div>' +
      '<h1 style="font-size:30px;margin-bottom:12px">' +
      (isGlobal ? "Advanced search" : "Search this guide") + "</h1>" +
      '<p class="lede">Searches every word in ' + scopeName + " — the ACS wording itself, the " +
      "study notes, the scenario questions, the common errors — and shows you the sentence each " +
      "match sits in, with the guide it came from, so you can tell whether it is the right one " +
      "before you open it.</p>" +
      '<div class="bigsearch"><span class="ic">' + I.search + "</span>" +
      '<input id="bq" type="search" value="' + esc(q) +
      '" placeholder="A word, a phrase, or an ACS code such as ' + esc(sampleCode()) +
      '" autocomplete="off" aria-label="Search">' +
      "</div>";

    if (isGlobal) {
      h += '<div class="filters"><div class="frow"><span class="fl">Guides</span>' +
        '<button type="button" class="pill sel on" data-fg="*">All</button>' +
        GUIDES.map(function (g) {
          return '<button type="button" class="pill sel g-' + esc(g.accent) + '" data-fg="' +
            esc(g.slug) + '">' + esc(g.short) + "</button>";
        }).join("") + "</div>";
    } else {
      h += '<div class="filters"><div class="frow"><span class="fl">Scope</span>' +
        '<span class="pill sel on static">' + esc((guideMeta(G.slug) || {}).cert || G.title) + "</span>" +
        '<a class="pill sel" href="#/search' + (q ? "/" + encodeURIComponent(q) : "") +
        '">Search every guide instead</a></div>';
    }
    h += '<div class="frow"><span class="fl">Show</span>' +
      '<button type="button" class="pill sel on" data-fs="*">Everything</button>' +
      SECTIONS.map(function (x) {
        return '<button type="button" class="pill sel" data-fs="' + x.k + '">' + esc(x.t) + "</button>";
      }).join("") + "</div></div>";

    h += '<div class="hintrow">Try: ' + sampleQueries().map(function (x) {
      return '<button class="pill" data-q="' + esc(x) + '">' + esc(x) + "</button>";
    }).join("") + "</div>";
    h += '<div id="sres"></div>';
    return h;
  }
  /* an example code the reader will actually recognise in this context */
  function sampleCode() {
    if (G) { var p = codePrefixes()[0] || "PA"; var f = flat()[0];
             return f ? p + "." + f.code + ".K1" : p + ".I.A.K1"; }
    return "PA.I.C.K2";
  }
  function sampleQueries() {
    if (G && G.teaching) return ["spin", "wake turbulence", "hold short", "pivotal altitude"];
    if (G && /Instrument/i.test(G.title)) return ["holding", "circling", "RAIM", "missed approach"];
    return ["spin", "wake turbulence", "hold short", "density altitude"];
  }

  /* Status line above the results. Always REPLACES - the old code appended,
     so every failed search left its complaint on the page and they piled up
     into a log. */
  function sres(html) { var box = el("sres"); if (box) box.innerHTML = html; }

  function runSearch(q, silent) {
    q = (q || "").trim();
    SF.q = q;
    var global = !G;
    if (q.length < 2) {
      sres(q.length ? '<p class="muted">Type at least two characters.</p>' : "");
      return;
    }

    /* site-wide search needs every guide in memory before it can honestly say
       "nothing found" - load them, showing progress, and re-run when done */
    if (global && !allLoaded()) {
      sres('<div class="loadbar"><div class="spin"></div><p>Loading every guide so the search can ' +
           "cover all of them…</p></div>");
      fetchAllGuides(
        function (done, total) {
          var box = el("sres");
          if (box && box.querySelector(".loadbar p")) {
            box.querySelector(".loadbar p").textContent =
              "Loading every guide so the search can cover all of them… " + done + " of " + total;
          }
        },
        function (failed) {
          if (failed.length === GUIDES.length) {
            sres('<div class="note flag"><span class="lbl">Could not load the guides</span>' +
                 "The search needs each guide's data file and none of them loaded. Reload the page, " +
                 'and if it keeps happening <a href="#/contact">tell me</a>.</div>');
            return;
          }
          runSearch(SF.q);
        });
      return;
    }

    var scope = global
      ? GUIDES.map(function (g) { return g.slug; })
              .filter(function (sl) { return inFilter(SF.guides, sl) && LOADED[sl]; })
      : [G.slug];
    var head = "";

    /* an exact element code goes straight to the element */
    var m = q.replace(/\s+/g, "").match(CODE_RE);
    if (m) {
      var found = findElement(m[1]).filter(function (f) { return scope.indexOf(f.slug) >= 0; });
      if (found.length) {
        sres(found.map(function (f) {
          var gm = guideMeta(f.slug) || {};
          return '<div class="note gold"><span class="lbl">' + esc(gm.cert || f.slug) + " · element found</span>" +
            '<b class="mono">' + esc(f.el.code) + "</b> — " + esc(f.el.text) +
            '<div style="margin-top:10px"><a class="btn" href="' +
            guideHref(f.slug, "t/" + f.code + "/" + encodeURIComponent(f.el.code)) +
            '">Open ' + esc(f.code) + " · " + esc(f.task.title) + "</a></div></div>";
        }).join(""));
        return;
      }
      /* not an error - fall through and search the text for it too */
      head = '<div class="note"><span class="lbl">No element with that exact code here</span>' +
        "<b class=\"mono\">" + esc(q) + "</b> is not in " +
        (global ? "the guides you have selected" : esc(G.doc)) +
        ". Searching the text for it as well:</div>";
    }

    /* a task code such as "II.C" or "IR.VI.A" */
    var tm = q.replace(/\s+/g, "").toUpperCase().match(TASK_RE);
    if (tm) {
      var tcode = tm[2] + "." + tm[3], links = [];
      scope.forEach(function (sl) {
        var g = LOADED[sl]; if (!g) return;
        (g.acs || []).forEach(function (a) {
          if (a.roman !== tm[2]) return;
          (a.tasks || []).forEach(function (t) {
            if (t.letter !== tm[3]) return;
            var gm = guideMeta(sl) || {};
            links.push('<a class="btn" href="' + guideHref(sl, "t/" + tcode) + '">' +
              esc(gm.short || sl) + " · " + esc(tcode) + " " + esc(t.title) + "</a>");
          });
        });
      });
      if (links.length) head += '<div class="note"><span class="lbl">Task code</span>' +
        '<div class="btnrow">' + links.join("") + "</div></div>";
    }

    var idx = searchIndex(scope), lq = q.toLowerCase(), hits = [];
    var secOn = SF.sections;
    for (var i = 0; i < idx.length; i++) {
      var r = idx[i];
      if (secOn && !secOn[r.k]) continue;
      if (r.l.indexOf(lq) >= 0) hits.push(r);
    }
    if (!hits.length) {
      sres(head + '<div class="note"><span class="lbl">No match</span>' +
        "Nothing in " + (global ? "the selected guides" : esc(G.doc)) + " contains “" + esc(q) +
        "”." + (secOn ? " The section filter is narrowing this — try <b>Everything</b>." : "") +
        " Try a shorter word, or the term the FAA would use.</div>");
      return;
    }

    /* group by guide, then by task, preserving each document's own order */
    var byG = {}, gOrder = [];
    hits.forEach(function (x) {
      if (!byG[x.g]) { byG[x.g] = { byTask: {}, order: [], n: 0 }; gOrder.push(x.g); }
      var b = byG[x.g];
      b.n++;
      if (!b.byTask[x.c]) { b.byTask[x.c] = []; b.order.push(x.c); }
      if (b.byTask[x.c].length < 6) b.byTask[x.c].push(x);
    });
    gOrder.sort(function (a, b) {
      return GUIDES.findIndex(function (x) { return x.slug === a; }) -
             GUIDES.findIndex(function (x) { return x.slug === b; });
    });

    var h = head + '<div class="sumline"><b>' + hits.length + "</b> match" +
      (hits.length === 1 ? "" : "es") + " in <b>" + gOrder.length + "</b> guide" +
      (gOrder.length === 1 ? "" : "s") + " for “" + esc(q) + "”" +
      (secOn ? " · filtered" : "") + "</div>";

    gOrder.forEach(function (sl) {
      var g = LOADED[sl], gm = guideMeta(sl) || {}, b = byG[sl];
      var pos = {};
      (g.acs || []).forEach(function (a, ai) {
        (a.tasks || []).forEach(function (t, ti) { pos[a.roman + "." + t.letter] = ai * 100 + ti; });
      });
      b.order.sort(function (x, y) { return (pos[x] || 0) - (pos[y] || 0); });
      if (gOrder.length > 1 || !G) {
        h += '<div class="gbanner a-' + esc(gm.accent || "k") + '">' +
          '<a href="' + guideHref(sl) + '"><b>' + esc(gm.cert || sl) + "</b> " +
          '<span class="mono">' + esc(g.doc) + "</span></a>" +
          "<span>" + b.n + " match" + (b.n === 1 ? "" : "es") + " in " + b.order.length +
          " task" + (b.order.length === 1 ? "" : "s") + "</span></div>";
      }
      b.order.forEach(function (code) {
        var ar = code.split(".")[0], t = null, area = null;
        (g.acs || []).forEach(function (a) {
          if (a.roman !== ar) return;
          area = a;
          (a.tasks || []).forEach(function (x) { if (ar + "." + x.letter === code) t = x; });
        });
        if (!t) return;
        h += '<div class="sgroup"><div class="sg-hd"><a href="' + guideHref(sl, "t/" + code) +
          '"><span class="code">' + esc(code) + "</span> " + esc(t.title) + "</a>" +
          '<span class="ar">Area ' + esc(area.roman) + " · " + esc(area.title) + "</span></div>";
        b.byTask[code].forEach(function (x) {
          h += '<a class="shit" href="' +
            guideHref(sl, "t/" + code + (x.a ? "/" + encodeURIComponent(x.a) : "")) + '">' +
            '<span class="where">' + esc(x.w) + "</span>" +
            '<span class="txt">' + snippet(x.t, lq) + "</span></a>";
        });
        var n = hits.filter(function (x) { return x.g === sl && x.c === code; }).length;
        if (n > b.byTask[code].length) {
          h += '<div class="smore">+' + (n - b.byTask[code].length) + " more on this page</div>";
        }
        h += "</div>";
      });
    });
    sres(h);
  }

  /* the filter pills: "*" clears, anything else toggles one key */
  function wireSearchFilters() {
    var host = document.querySelector(".filters");
    if (!host) return;
    host.addEventListener("click", function (e) {
      var b = e.target.closest("button.sel");
      if (!b) return;
      var isG = b.hasAttribute("data-fg");
      var key = b.getAttribute(isG ? "data-fg" : "data-fs");
      var row = b.parentNode;
      if (key === "*") {
        if (isG) SF.guides = null; else SF.sections = null;
      } else {
        var set = isG ? (SF.guides || {}) : (SF.sections || {});
        set[key] = !set[key];
        if (!anyOn(set)) { if (isG) SF.guides = null; else SF.sections = null; }
        else if (isG) SF.guides = set; else SF.sections = set;
      }
      var cur = isG ? SF.guides : SF.sections;
      row.querySelectorAll("button.sel").forEach(function (x) {
        var k = x.getAttribute(isG ? "data-fg" : "data-fs");
        x.classList.toggle("on", k === "*" ? !cur : !!(cur && cur[k]));
      });
      runSearch(SF.q);
    });
  }

  /* ================= E6B FLIGHT COMPUTER ================= */
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function num(id) { var v = parseFloat((el(id) || {}).value); return isNaN(v) ? null : v; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r0(x) { return Math.round(x); }
  function hdg(x) { x = x % 360; return x < 0 ? x + 360 : x; }
  function pad3(x) { x = r0(hdg(x)); return (x === 0 ? 360 : x).toString().padStart(3, "0"); }

  function pressAlt(elevation, setting) { return elevation + (29.92 - setting) * 1000; }
  function isaTemp(pa) { return 15 - 1.98 * (pa / 1000); }
  function densAlt(elevation, setting, oatC) {
    /* station pressure, then the standard density-altitude relation */
    var sp = setting * Math.pow(1 - 6.8755856e-6 * elevation, 5.2558797);
    var tR = (oatC * 9 / 5 + 32) + 459.67;
    return 145442.16 * (1 - Math.pow(17.326 * sp / tR, 0.235));
  }
  function densRatio(da) { return Math.pow(1 - 6.8755856e-6 * da, 4.2558797); }

  var E6B = [
    { id: "wind", t: "Wind / heading", f: function () {
        return e6row([["e_tas", "True airspeed", "kt", 110], ["e_tc", "True course", "deg", 40],
                      ["e_wd", "Wind FROM", "deg true", 90], ["e_ws", "Wind speed", "kt", 20],
                      ["e_var", "Variation (+W / -E)", "deg", 6], ["e_dev", "Deviation (+/-)", "deg", 0]]);
      }, calc: function () {
        var tas = num("e_tas"), tc = num("e_tc"), wd = num("e_wd"), ws = num("e_ws");
        if (tas === null || tc === null || wd === null || ws === null || tas <= 0) return null;
        var th0 = (wd - tc) * D2R;
        var xw = ws * Math.sin(th0), hw = ws * Math.cos(th0);
        var sinw = xw / tas;
        if (Math.abs(sinw) > 1) return [["Not possible", "The wind is stronger than your true airspeed across the course."]];
        var wca = Math.asin(sinw) * R2D;
        var gs = tas * Math.cos(wca * D2R) - hw;
        var th = tc + wca;
        var vr = num("e_var") || 0, dv = num("e_dev") || 0;
        return [["Wind correction angle", r1(Math.abs(wca)) + " deg " + (wca >= 0 ? "RIGHT" : "LEFT")],
                ["True heading", pad3(th)],
                ["Magnetic heading", pad3(th + vr)],
                ["Compass heading", pad3(th + vr + dv)],
                ["Groundspeed", r1(gs) + " kt"],
                ["Headwind component", (hw >= 0 ? r1(hw) + " kt headwind" : r1(-hw) + " kt tailwind")],
                ["Crosswind component", r1(Math.abs(xw)) + " kt from the " + (xw >= 0 ? "right" : "left")]];
      } },
    { id: "xwind", t: "Runway crosswind", f: function () {
        return e6row([["x_rwy", "Runway heading", "deg magnetic", 90], ["x_wd", "Wind FROM", "deg magnetic", 130],
                      ["x_ws", "Wind speed", "kt", 20], ["x_gust", "Gust (optional)", "kt", null],
                      ["x_demo", "Demonstrated crosswind", "kt", 15]]);
      }, calc: function () {
        var rw = num("x_rwy"), wd = num("x_wd"), ws = num("x_ws");
        if (rw === null || wd === null || ws === null) return null;
        var a = (wd - rw) * D2R;
        var xw = Math.abs(ws * Math.sin(a)), hw = ws * Math.cos(a);
        var out = [["Angle off the runway", r0(Math.abs(hdg(wd - rw) > 180 ? 360 - hdg(wd - rw) : hdg(wd - rw))) + " deg"],
                   ["Crosswind component", r1(xw) + " kt from the " + (Math.sin(a) >= 0 ? "right" : "left")],
                   [hw >= 0 ? "Headwind component" : "TAILWIND component", r1(Math.abs(hw)) + " kt"]];
        var g = num("x_gust");
        if (g !== null) out.push(["Crosswind at the gust", r1(Math.abs(g * Math.sin(a))) + " kt"]);
        var demo = num("x_demo");
        if (demo !== null) {
          var peak = g !== null ? Math.abs(g * Math.sin(a)) : xw;
          out.push(["Against the demonstrated value", peak <= demo
            ? "Within it (" + r1(peak) + " of " + demo + " kt)"
            : "OVER it - " + r1(peak) + " kt against " + demo + " kt demonstrated"]);
        }
        if (hw < 0) out.push(["Note", "A tailwind component. Check the POH limit and the landing distance."]);
        return out;
      } },
    { id: "alt", t: "Pressure / density altitude", f: function () {
        return e6row([["a_elev", "Field elevation", "ft MSL", 65], ["a_alt", "Altimeter setting", "in Hg", 30.15],
                      ["a_oat", "Outside air temperature", "deg C", 30], ["a_cas", "CAS (optional)", "kt", null]]);
      }, calc: function () {
        var e = num("a_elev"), a = num("a_alt"), t = num("a_oat");
        if (e === null || a === null || t === null) return null;
        var pa = pressAlt(e, a), isa = isaTemp(pa), da = densAlt(e, a, t);
        var out = [["Pressure altitude", r0(pa) + " ft"],
                   ["Standard (ISA) temperature there", r1(isa) + " C"],
                   ["ISA deviation", (t - isa >= 0 ? "+" : "") + r1(t - isa) + " C"],
                   ["Density altitude", r0(da) + " ft"],
                   ["Rule of thumb check", r0(pa + 120 * (t - isa)) + " ft  (PA + 120 per degree)"]];
        var cas = num("a_cas");
        if (cas !== null) out.push(["True airspeed at that density altitude", r1(cas / Math.sqrt(densRatio(da))) + " kt"]);
        if (da > e + 2000) out.push(["Watch out", "Density altitude is " + r0(da - e) + " ft above the field. Check the takeoff and climb charts."]);
        return out;
      } },
    { id: "tsd", t: "Time / speed / distance", f: function () {
        return e6row([["t_gs", "Groundspeed", "kt", 112], ["t_d", "Distance", "NM", 42],
                      ["t_min", "Time", "minutes", null]]) +
          '<p class="e6-note">Fill in any two and leave the third blank.</p>';
      }, calc: function () {
        var gs = num("t_gs"), d = num("t_d"), m = num("t_min");
        var have = [gs, d, m].filter(function (x) { return x !== null; }).length;
        if (have < 2) return null;
        if (m === null && gs) { m = d / gs * 60; return [["Time", r1(m) + " minutes  (" + hms(m) + ")"]]; }
        if (d === null && gs && m) { return [["Distance", r1(gs * m / 60) + " NM"]]; }
        if (gs === null && d && m) { return [["Groundspeed", r1(d / (m / 60)) + " kt"]]; }
        return [["Time", r1(d / gs * 60) + " minutes  (" + hms(d / gs * 60) + ")"]];
      } },
    { id: "fuel", t: "Fuel", f: function () {
        return e6row([["f_gph", "Fuel burn", "gal/hr", 9.4], ["f_min", "Time", "minutes", 140],
                      ["f_fob", "Usable fuel on board", "gal", 48], ["f_res", "Reserve required", "minutes", 30]]);
      }, calc: function () {
        var g = num("f_gph"), m = num("f_min");
        if (g === null || g <= 0) return null;
        var out = [];
        if (m !== null) out.push(["Fuel for the flight", r1(g * m / 60) + " gal"]);
        var fob = num("f_fob"), res = num("f_res");
        if (fob !== null) {
          out.push(["Total endurance", r1(fob / g) + " hours  (" + hms(fob / g * 60) + ")"]);
          if (res !== null) {
            var usable = fob - g * res / 60;
            out.push(["Reserve fuel", r1(g * res / 60) + " gal"]);
            out.push(["Endurance to the reserve", r1(usable / g) + " hours  (" + hms(usable / g * 60) + ")"]);
            if (m !== null) {
              var left = fob - g * m / 60;
              out.push(["Fuel on landing", r1(left) + " gal  (" + r1(left / g * 60) + " minutes)"]);
              out.push(["Legal check", left >= g * res / 60
                ? "Meets the " + res + " minute reserve" : "DOES NOT meet the " + res + " minute reserve"]);
            }
          }
        }
        return out.length ? out : null;
      } },
    { id: "wb", t: "Weight and balance", f: function () {
        var rows = [["Empty weight", 1500, 36.5], ["Front seats", 340, 37.0],
                    ["Fuel (lb)", 180, 48.0], ["Rear seats", 0, 73.0], ["Baggage", 40, 95.0]];
        return '<div class="wb-grid"><div class="wb-h">Item</div><div class="wb-h">Weight (lb)</div>' +
          '<div class="wb-h">Arm (in)</div><div class="wb-h">Moment</div>' +
          rows.map(function (r, i) {
            return '<div class="wb-l">' + esc(r[0]) + "</div>" +
              '<input class="wb-i" id="wb_w' + i + '" type="number" step="0.1" value="' + r[1] + '">' +
              '<input class="wb-i" id="wb_a' + i + '" type="number" step="0.01" value="' + r[2] + '">' +
              '<div class="wb-m" id="wb_m' + i + '">-</div>';
          }).join("") + "</div>" +
          e6row([["wb_max", "Max gross weight", "lb", 2450], ["wb_fwd", "Forward CG limit", "in", 35.0],
                 ["wb_aft", "Aft CG limit", "in", 47.3]]);
      }, calc: function () {
        var tw = 0, tm = 0;
        for (var i = 0; i < 5; i++) {
          var w = num("wb_w" + i), a = num("wb_a" + i);
          var m = (w !== null && a !== null) ? w * a : 0;
          var cell = el("wb_m" + i); if (cell) cell.textContent = m ? r1(m).toLocaleString() : "-";
          if (w !== null) tw += w;
          tm += m;
        }
        if (!tw) return null;
        var cg = tm / tw;
        var out = [["Total weight", r1(tw) + " lb"], ["Total moment", r0(tm).toLocaleString() + " lb-in"],
                   ["Centre of gravity", r1(cg * 10) / 10 + " in aft of datum"]];
        var mx = num("wb_max"), fw = num("wb_fwd"), af = num("wb_aft");
        if (mx !== null) out.push(["Against max gross", tw <= mx ? "Within limits (" + r1(mx - tw) + " lb spare)" : "OVER by " + r1(tw - mx) + " lb"]);
        if (fw !== null && af !== null) out.push(["Against the CG envelope",
          (cg >= fw && cg <= af) ? "Within limits" : (cg < fw ? "TOO FAR FORWARD by " + r1(fw - cg) + " in" : "TOO FAR AFT by " + r1(cg - af) + " in")]);
        out.push(["Reminder", "The envelope narrows with weight. Check the CG against the chart AT this weight, not just against the end points."]);
        return out;
      } },
    { id: "turn", t: "Turns and load factor", f: function () {
        return e6row([["r_bank", "Bank angle", "deg", 45], ["r_tas", "True airspeed", "kt", 100],
                      ["r_vs", "Stall speed, wings level", "kt", 50]]);
      }, calc: function () {
        var b = num("r_bank"), tas = num("r_tas");
        if (b === null || b < 0 || b >= 90) return null;
        var lf = 1 / Math.cos(b * D2R);
        var out = [["Load factor", (Math.round(lf * 100) / 100).toFixed(2) + " G"]];
        var vs = num("r_vs");
        if (vs !== null) out.push(["Stall speed in the turn", r1(vs * Math.sqrt(lf)) + " kt  (up " + r1(vs * Math.sqrt(lf) - vs) + " kt)"]);
        if (tas !== null && tas > 0) {
          out.push(["Rate of turn", r1(1091 * Math.tan(b * D2R) / tas) + " deg/sec"]);
          out.push(["Radius of turn", r0(tas * tas / (11.26 * Math.tan(b * D2R))).toLocaleString() + " ft"]);
          out.push(["Bank for standard rate", r0(tas / 10 + 7) + " deg  (rule of thumb)"]);
        }
        return out;
      } },
    { id: "pivot", t: "Pivotal altitude", f: function () {
        return e6row([["p_gs", "Groundspeed", "kt", 90], ["p_elev", "Pylon elevation", "ft MSL", 250]]);
      }, calc: function () {
        var gs = num("p_gs"); if (gs === null) return null;
        var pa = gs * gs / 11.3, e = num("p_elev");
        var out = [["Pivotal altitude", r0(pa) + " ft AGL"]];
        if (e !== null) out.push(["Altitude to fly", r0(pa + e) + " ft MSL"]);
        out.push(["If groundspeed drops to " + r0(gs - 10), r0((gs - 10) * (gs - 10) / 11.3) + " ft AGL - descend"]);
        out.push(["If groundspeed rises to " + r0(gs + 10), r0((gs + 10) * (gs + 10) / 11.3) + " ft AGL - climb"]);
        return out;
      } },
    { id: "desc", t: "Climb and descent", f: function () {
        return e6row([["d_from", "Cruise altitude", "ft", 8500], ["d_to", "Target altitude", "ft", 1000],
                      ["d_gs", "Groundspeed", "kt", 120], ["d_dist", "Distance available (optional)", "NM", null]]);
      }, calc: function () {
        var f = num("d_from"), t = num("d_to"), gs = num("d_gs");
        if (f === null || t === null) return null;
        var lose = f - t;
        var out = [["Altitude to lose", r0(lose) + " ft"],
                   ["Top of descent, 3 degree path", r1(lose / 300) + " NM out"],
                   ["Top of descent, 3-to-1 rule", r1(lose / 1000 * 3) + " NM out"]];
        if (gs !== null) {
          out.push(["Rate of descent for 3 degrees", r0(gs * 5) + " fpm",
                    "groundspeed \u00d7 5 \u2014 the rule of thumb. It runs about 6 percent shallow; " +
                    "the honest multiplier for 3\u00b0 is 5.3, but 5 is the one you can do in your head"]);
          out.push(["Rate of descent for 3 degrees, exactly", r0(gs * 6076 * Math.tan(3 * D2R) / 60) + " fpm",
                    "the trigonometry. Use the rule of thumb to start down, then trim to this"]);
        }
        var d = num("d_dist");
        if (d !== null && d > 0) {
          var grad = lose / d;
          out.push(["Gradient needed", r0(grad) + " ft per NM"]);
          out.push(["As an angle", r1(Math.atan(grad / 6076) * R2D) + "\u00b0",
                    "an instrument approach publishes this as the VDA"]);
          if (gs !== null) out.push(["Rate of descent needed", r0(grad * gs / 60) + " fpm",
                    "gradient \u00d7 groundspeed \u00f7 60"]);
          out.push(["How steep is that", grad <= 318 ? "Shallower than 3 degrees - comfortable"
            : (grad <= 400 ? "Steeper than 3 degrees - plan to slow down early" : "Very steep. Start down sooner or use drag.")]);
        }
        return out;
      } },
    /* Instrument departures publish a CLIMB GRADIENT in feet per nautical
       mile. The airplane's instrument shows feet per MINUTE. Converting
       between them in the air, in the weather, is the whole point of this
       tab: ft/NM x groundspeed / 60 = fpm. The standard gradient is 200 ft/NM
       (TERPS 2-1-3); anything above that is published on the chart and is the
       number that decides whether you can legally accept the procedure. */
    { id: "climb", t: "Climb gradient", f: function () {
        return e6row([["cg_grad", "Required gradient", "ft per NM", 200],
                      ["cg_gs", "Groundspeed", "kt", 100],
                      ["cg_rate", "Climb rate you can actually hold (optional)", "fpm", null],
                      ["cg_alt", "Climb to (optional)", "ft", null],
                      ["cg_dep", "Departure end elevation (optional)", "ft", null]]);
      }, calc: function () {
        var grad = num("cg_grad"), gs = num("cg_gs");
        if (grad === null || gs === null || gs <= 0) return null;
        var need = grad * gs / 60;
        var out = [["Climb rate required", r0(need) + " fpm",
                    "gradient × groundspeed ÷ 60"]];
        out.push(["Standard is 200 ft/NM",
                  grad > 200 ? "This procedure asks for MORE than standard"
                             : grad === 200 ? "This is the standard gradient"
                                            : "Less than standard — check you read the chart right",
                  "TERPS: 200 ft/NM is the standard climb gradient to 400 ft above the departure end"]);
        out.push(["At 200 ft/NM this groundspeed needs", r0(200 * gs / 60) + " fpm",
                  "what a standard departure costs you at this speed"]);
        var have = num("cg_rate");
        if (have !== null && have > 0) {
          var can = have * 60 / gs;
          out.push(["Gradient you can actually make", r0(can) + " ft/NM",
                    "your climb rate × 60 ÷ groundspeed"]);
          out.push(["Can you accept this departure?",
                    can >= grad ? "Yes — " + r0(can - grad) + " ft/NM in hand"
                                : "NO — short by " + r0(grad - can) + " ft/NM",
                    can >= grad ? "" : "Reduce weight, wait for cooler air, or ask for a different departure. " +
                    "The gradient is a terrain clearance requirement, not a suggestion."]);
          var maxgs = have * 60 / grad;
          out.push(["Fastest groundspeed that still makes it", r0(maxgs) + " kt",
                    "above this, your climb rate no longer produces the gradient"]);
        }
        var alt = num("cg_alt"), dep = num("cg_dep");
        if (alt !== null && dep !== null && alt > dep) {
          var gain = alt - dep, nm = gain / grad;
          out.push(["Altitude to gain", r0(gain) + " ft"]);
          out.push(["Distance it takes at this gradient", r1(nm) + " NM",
                    "altitude to gain ÷ gradient"]);
          out.push(["Time it takes", r1(nm / gs * 60) + " min"]);
        }
        return out;
      } },
    { id: "conv", t: "Conversions", f: function () {
        return e6row([["c_val", "Value", "", 100]]) +
          '<div class="e6-sel"><label for="c_kind">Convert</label><select id="c_kind">' +
          ["Nautical miles", "Statute miles", "Kilometres", "Gallons (avgas)", "Pounds (avgas)", "Litres",
           "Degrees Celsius", "Degrees Fahrenheit", "Feet", "Metres", "Knots", "Miles per hour"]
            .map(function (k) { return '<option>' + k + "</option>"; }).join("") + "</select></div>";
      }, calc: function () {
        var v = num("c_val"); if (v === null) return null;
        var k = (el("c_kind") || {}).value;
        var M = {
          "Nautical miles": [["Statute miles", v * 1.15078], ["Kilometres", v * 1.852]],
          "Statute miles": [["Nautical miles", v * 0.868976], ["Kilometres", v * 1.60934]],
          "Kilometres": [["Nautical miles", v * 0.539957], ["Statute miles", v * 0.621371]],
          "Gallons (avgas)": [["Pounds at 6 lb/gal", v * 6], ["Litres", v * 3.78541]],
          "Pounds (avgas)": [["Gallons at 6 lb/gal", v / 6], ["Litres", v / 6 * 3.78541]],
          "Litres": [["Gallons", v * 0.264172], ["Pounds at 6 lb/gal", v * 0.264172 * 6]],
          "Degrees Celsius": [["Degrees Fahrenheit", v * 9 / 5 + 32]],
          "Degrees Fahrenheit": [["Degrees Celsius", (v - 32) * 5 / 9]],
          "Feet": [["Metres", v * 0.3048], ["Nautical miles", v / 6076.12]],
          "Metres": [["Feet", v / 0.3048]],
          "Knots": [["Miles per hour", v * 1.15078], ["Km/h", v * 1.852]],
          "Miles per hour": [["Knots", v * 0.868976], ["Km/h", v * 1.60934]]
        };
        return (M[k] || []).map(function (r) { return [r[0], r1(r[1] * 100) / 100 + ""]; });
      } }
  ];
  function hms(mins) {
    if (!isFinite(mins)) return "-";
    var h = Math.floor(mins / 60), m = Math.round(mins - h * 60);
    if (m === 60) { h++; m = 0; }
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }
  function e6row(fields) {
    return '<div class="e6-grid">' + fields.map(function (f) {
      return '<label class="e6-f"><span>' + esc(f[1]) + (f[2] ? ' <i>' + esc(f[2]) + "</i>" : "") + "</span>" +
        '<input id="' + f[0] + '" type="number" step="any" inputmode="decimal" value="' +
        (f[3] == null ? "" : f[3]) + '"></label>';
    }).join("") + "</div>";
  }
  var e6Tab = "wind";
  function openE6B() {
    var m = el("e6b");
    m.innerHTML = '<div class="e6-box" role="dialog" aria-modal="true" aria-label="E6B flight computer">' +
      '<div class="e6-hd"><b>E6B flight computer</b>' +
      '<button class="e6-x" id="e6close" aria-label="Close">&times;</button></div>' +
      '<div class="e6-tabs">' + E6B.map(function (t) {
        return '<button class="e6-t' + (t.id === e6Tab ? " on" : "") + '" data-e6="' + t.id + '">' + esc(t.t) + "</button>";
      }).join("") + "</div><div class="+'"e6-body" id="e6body"></div></div>';
    m.classList.add("on");
    renderE6B();
    el("e6close").addEventListener("click", closeE6B);
    var tabs = m.querySelectorAll("[data-e6]");
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", function () {
      e6Tab = this.getAttribute("data-e6");
      var all = m.querySelectorAll("[data-e6]");
      for (var j = 0; j < all.length; j++) all[j].classList.toggle("on", all[j] === this);
      renderE6B();
    });
  }
  function closeE6B() { el("e6b").classList.remove("on"); }
  function renderE6B() {
    var t = E6B.filter(function (x) { return x.id === e6Tab; })[0];
    el("e6body").innerHTML = t.f() + '<div class="e6-out" id="e6out"></div>' +
      '<p class="e6-foot">Worked in your browser. Nothing is sent anywhere. ' +
      'Cross-check anything that matters against the POH.</p>';
    var ins = el("e6body").querySelectorAll("input,select");
    for (var i = 0; i < ins.length; i++) {
      ins[i].addEventListener("input", e6calc);
      ins[i].addEventListener("change", e6calc);
    }
    e6calc();
  }
  function e6calc() {
    var t = E6B.filter(function (x) { return x.id === e6Tab; })[0];
    var res = t.calc();
    el("e6out").innerHTML = res && res.length
      ? res.map(function (r) {
          /* a third element is the "why" - where the number comes from, or
             what to do about it. Shown small, under the answer. */
          var long = String(r[1]).length > 44 || r[2];
          return '<div class="e6-r' + (long ? " long" : "") + '"><span>' + esc(r[0]) +
            "</span><b>" + esc(r[1]) + "</b>" +
            (r[2] ? '<i class="e6-why">' + esc(r[2]) + "</i>" : "") + "</div>";
        }).join("")
      : '<div class="e6-empty">Fill in the boxes above.</div>';
  }

  /* ================= NAV LOG ================= */
  /* ======================================================================
     Navigation log — the module is navlog.js, injected here at build time.
     ====================================================================== */
  /* ============================================================================
   Navigation log — laid out like the ATP form.  Injected inside the app IIFE.
   ============================================================================ */

/* ---- an example compass deviation card -------------------------------------
   Every airplane has its own card, swung on a compass rose. This one is only
   here so the sample log has something to work from.                        */
var DEVCARD = [
  { mh:   0, ch:   0 }, { mh:  30, ch:  28 }, { mh:  60, ch:  57 },
  { mh:  90, ch:  86 }, { mh: 120, ch: 117 }, { mh: 150, ch: 148 },
  { mh: 180, ch: 180 }, { mh: 210, ch: 212 }, { mh: 240, ch: 243 },
  { mh: 270, ch: 274 }, { mh: 300, ch: 303 }, { mh: 330, ch: 332 }
];
/* deviation, in degrees, for a given magnetic heading — linear between cards */
function devFor(mh) {
  var m = ((mh % 360) + 360) % 360;
  for (var i = 0; i < DEVCARD.length; i++) {
    var a = DEVCARD[i], b = DEVCARD[(i + 1) % DEVCARD.length];
    var a0 = a.mh, b0 = (i === DEVCARD.length - 1) ? 360 : b.mh;
    if (m >= a0 && m <= b0) {
      var da = a.ch - a.mh;
      var db = (b.ch - b.mh);
      var f = (b0 === a0) ? 0 : (m - a0) / (b0 - a0);
      return Math.round(da + (db - da) * f);
    }
  }
  return 0;
}

/* initial great-circle true course, degrees */
function trueCourse(a, b) {
  var r = Math.PI / 180;
  var y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  var x = Math.cos(a.lat * r) * Math.sin(b.lat * r) -
          Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/* ---- state ---------------------------------------------------------------- */
var NAV = { hdr: {}, legs: [], adv: {}, freq: {}, fuel: {} };
try {
  var _sv = JSON.parse(localStorage.getItem("cfi-navlog-2") || "null");
  if (_sv && _sv.legs) NAV = _sv;
} catch (e) { }
if (!NAV.legs || !NAV.legs.length) NAV.legs = [{}, {}, {}, {}, {}, {}];
NAV.adv = NAV.adv || {}; NAV.freq = NAV.freq || {}; NAV.fuel = NAV.fuel || {};
function saveNav() { try { localStorage.setItem("cfi-navlog-2", JSON.stringify(NAV)); } catch (e) { } }

function nnum(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
function pad3(d) { d = ((Math.round(d) % 360) + 360) % 360; return (d < 100 ? (d < 10 ? "00" : "0") : "") + d; }
function hhmm(mins) {
  if (mins == null || !isFinite(mins)) return "";
  var m = Math.round(mins) % 1440; if (m < 0) m += 1440;
  var h = Math.floor(m / 60), q = m % 60;
  return (h < 10 ? "0" : "") + h + (q < 10 ? "0" : "") + q;
}
/* magnetic variation for one leg.
   Accepts "6W", "6E", "6", "+6", "-6". A bare or signed number falls back to the
   hemisphere set for the whole flight. Returns the degrees to ADD to true.      */
function parseVar(raw, hemi) {
  var t = String(raw == null ? "" : raw).trim().toUpperCase().replace(/[°\s]/g, "");
  if (!t) return null;
  var m = t.match(/^([+-]?\d+(?:\.\d+)?)([WE])?$/);
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (m[2]) return m[2] === "E" ? -Math.abs(n) : Math.abs(n);   /* letter wins */
  if (/^[+-]/.test(m[1])) return n;                             /* signed: + is west */
  return hemi === "E" ? -Math.abs(n) : Math.abs(n);             /* bare: use the default */
}
/* how a variation reads back to the pilot: 7W, 3E, or nothing */
function varLabel(deg) {
  if (deg == null) return "";
  if (deg === 0) return "0";
  return Math.abs(Math.round(deg * 10) / 10) + (deg < 0 ? "E" : "W");
}

function parseZ(s) {
  var m = String(s || "").trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  var h = +m[1], q = +m[2];
  if (h > 23 || q > 59) return null;
  return h * 60 + q;
}

/* ---- the arithmetic -------------------------------------------------------- */
function navCalc() {
  var h = NAV.hdr;
  var hTas = nnum(h.tas), hGph = nnum(h.gph), fob = nnum(h.fob);
  var vrDefault = parseVar(h.var_, h.varEW);
  if (vrDefault == null) vrDefault = 0;
  var off = parseZ(h.timeoff);
  var totalD = 0;
  NAV.legs.forEach(function (l) { var d = nnum(l.dist); if (d != null) totalD += d; });

  var rows = [], cumD = 0, cumT = 0, cumF = 0;
  NAV.legs.forEach(function (l) {
    var o = { tas: "", wca: "", th: "", vr: "", mh: "", dev: "", ch: "", gs: "",
              distrem: "", ete: "", eta: "", fuel: "", frem: "" };
    var vr = parseVar(l.vr, h.varEW);
    var vrOwn = vr != null;
    if (!vrOwn) vr = vrDefault;
    var tas = nnum(l.tas); if (tas == null) tas = hTas;
    var gph = nnum(l.gph); if (gph == null) gph = hGph;
    var tc = nnum(l.tc), wd = nnum(l.wd), wv = nnum(l.wv), d = nnum(l.dist);
    if (tas != null) o.tas = Math.round(tas);
    if (d != null) { cumD += d; o.distrem = r1(totalD - cumD); }

    if (tas != null && tas > 0 && tc != null && wd != null && wv != null) {
      var ang = (wd - tc) * D2R;
      var xw = wv * Math.sin(ang), hw = wv * Math.cos(ang);
      var s = xw / tas;
      if (Math.abs(s) <= 1) {
        var wca = Math.asin(s) * R2D;
        var gs = tas * Math.cos(wca * D2R) - hw;
        var th = tc + wca, mh = th + vr;
        o.vr = varLabel(vr); o.vrOwn = vrOwn;
        var dv = nnum(l.dev); if (dv == null) dv = 0;
        o.wca = (wca >= 0 ? "+" : "−") + Math.abs(Math.round(wca));
        o.th = pad3(th);
        o.mh = pad3(mh);
        o.dev = (dv > 0 ? "+" : (dv < 0 ? "−" : "")) + Math.abs(dv);
        o.ch = pad3(mh + dv);
        o.gs = gs > 0 ? Math.round(gs) : "—";
        if (d != null && gs > 0) {
          var t = d / gs * 60;
          cumT += t;
          o.ete = r1(t);
          o.eta = off == null ? hhmm(cumT) : hhmm(off + cumT);
          if (gph != null) {
            var f = gph * t / 60; cumF += f;
            o.fuel = r1(f);
            if (fob != null) o.frem = r1(fob - cumF);
          }
        }
      }
    }
    rows.push(o);
  });
  var far = nnum(NAV.fuel.far), pers = nnum(NAV.fuel.pers);
  var any = rows.some(function (o) { return o.ete !== "" || o.distrem !== ""; });
  return { rows: rows, totalD: totalD ? r1(totalD) : "", totalT: cumT ? r1(cumT) : "",
           totalF: cumF ? r1(cumF) : "", any: any,
           totalEta: cumT ? (off == null ? hhmm(cumT) : hhmm(off + cumT)) : "",
           landing: fob == null ? null : r1(fob - cumF),
           reqd: (cumF || far || pers) ? r1(cumF + (far || 0) + (pers || 0)) : "",
           far: far, pers: pers, fob: fob };
}

/* ---- the sample ------------------------------------------------------------ */
var NAV_SAMPLE_ROUTE = ["KFXE", "KPHK", "KOBE", "KSEF", "KLAL"];
function buildSample() {
  var pts = [];
  NAV_SAMPLE_ROUTE.forEach(function (c) { var a = findApt(c); if (a) pts.push({ code: c, a: a }); });
  if (pts.length < 3) return false;

  var WD = 250, WV = 15, TAS = 110, GPH = 8.5, VAR = 7;   /* example values only */
  NAV.hdr = {
    acft: "PA-28-181   N4321T",
    route: pts.map(function (p) { return p.code; }).join(" – "),
    notes: "Dual cross-country. Sectional on the yoke, ForeFlight as the backup only.\n" +
           "Diversion practice after " + pts[2].code + ".\n" +
           "Wind, temperature, variation and the deviation card below are EXAMPLE numbers — " +
           "get yours from the winds aloft forecast, the sectional and the airplane.",
    calt: "3500", pwr: "65", palt: "3400", ctemp: "+15", tas: String(TAS), ias: "104",
    gph: String(GPH), mp: "—", rpm: "2350", fob: "48",
    airport: pts[0].code + " " + pts[0].a.name.replace(/ Airport$/, ""), tpa: "1000",
    timeoff: "1430", var_: String(VAR), varEW: "W"
  };
  NAV.legs = [];
  for (var i = 1; i < pts.length; i++) {
    var tc = Math.round(trueCourse(pts[i - 1].a, pts[i].a));
    var dist = r1(nm(pts[i - 1].a, pts[i].a));
    var ang = (WD - tc) * D2R;
    var wca = Math.asin(WV * Math.sin(ang) / TAS) * R2D;
    var mh = tc + wca + VAR;
    NAV.legs.push({
      cp: pts[i].code + "  " + pts[i].a.name.replace(/ (Airport|Regional Airport|International Airport)$/, ""),
      vor: "", freq: "", route: "Direct", alt: "3500",
      wd: String(WD), wv: String(WV), temp: "+15", cas: "104", tas: String(TAS),
      tc: String(tc), dev: String(devFor(mh)), dist: String(dist), gph: String(GPH)
    });
  }
  while (NAV.legs.length < 6) NAV.legs.push({});
  var c = navCalc();
  /* frequencies and ATIS are deliberately left blank: look them up in the
     Chart Supplement and fill them in yourself. That is the point of the box. */
  NAV.adv = { tcheck: "" };
  NAV.freq = {};
  NAV.fuel = { burn: c.totalF, far: r1(GPH * 30 / 60), pers: r1(GPH), fob: "48" };
  NAV.fuel.req = r1(+NAV.fuel.burn + +NAV.fuel.far + +NAV.fuel.pers);
  NAV.sample = true;
  saveNav();
  return true;
}

/* ---- the form -------------------------------------------------------------- */
function nlIn(id, val, cls, ph, type) {
  return '<input class="' + (cls || "") + '" data-nl="' + id + '" type="' + (type || "text") +
    '" value="' + esc(val == null ? "" : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") +
    ' spellcheck="false">';
}
function nlLeg(i, k, val, cls, ph) {
  return '<input class="' + (cls || "") + '" data-leg="' + i + '" data-k="' + k +
    '" value="' + esc(val == null ? "" : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") +
    ' spellcheck="false">';
}
function nlCalc(v) { return '<span class="nl-c">' + esc(v == null || v === "" ? "" : v) + "</span>"; }

var NAV_CRUISE = [["calt", "Cruise ALT"], ["pwr", "%PWR"], ["palt", "P. ALT"], ["ctemp", "Temp"],
                  ["tas", "TAS"], ["ias", "IAS"], ["gph", "GPH"], ["mp", "Manifold Press."],
                  ["rpm", "RPM Setting"], ["fob", "Fuel on Board"]];

function navlogHtml() {
  var c = navCalc(), h = NAV.hdr;
  var x = '<div class="nl-form">';

  /* ---------- title and the header block ---------- */
  x += '<div class="nl-title">Navigation Log</div>';
  x += '<div class="nl-top">';
  x += '<div class="nl-topL">' +
    '<div class="nl-r2"><label><b>Aircraft Number:</b>' + nlIn("acft", h.acft) + "</label>" +
    '<label><b>Route:</b>' + nlIn("route", h.route) + "</label></div>" +
    '<label class="nl-notes"><b>Notes:</b><textarea data-nl="notes" rows="3" spellcheck="false">' +
    esc(h.notes || "") + "</textarea></label>" +
    '<div class="nl-cruisewrap"><table class="nl-cruise"><tr><th class="nlbar" colspan="7">Cruise</th>' +
    '<th class="apt" colspan="3"><span>Airport:</span>' + nlIn("airport", h.airport) +
    '<span>TPA:</span>' + nlIn("tpa", h.tpa) + "</th></tr>" +
    "<tr>" + NAV_CRUISE.map(function (f) { return "<th>" + esc(f[1]) + "</th>"; }).join("") + "</tr>" +
    "<tr>" + NAV_CRUISE.map(function (f) { return "<td>" + nlIn(f[0], h[f[0]]) + "</td>"; }).join("") + "</tr>" +
    "</table></div></div>";
  x += '<div class="nl-topR"><div class="nlbar2">Destination Runway Layout<span>N&uarr;</span></div>' +
    '<textarea data-nl="rwy" class="nl-sketch" spellcheck="false" placeholder="Sketch it, or write the runways, lengths and the pattern direction.">' +
    esc(h.rwy || "") + "</textarea></div>";
  x += "</div>";

  /* ---------- the main table and the side panels ---------- */
  x += '<div class="nl-body"><div class="nl-tablewrap"><table class="nl-main"><thead>' +
    "<tr>" +
    '<th class="n"></th>' +
    '<th class="cp">Check Points <span>(fixes)</span></th>' +
    "<th>VOR <span>Ident &middot; Freq.</span></th>" +
    "<th>Course <span>(Route)</span></th>" +
    "<th>Altitude</th>" +
    "<th>Wind <span>Dir &middot; Vel &middot; Temp</span></th>" +
    "<th>CAS <span>TAS</span></th>" +
    "<th>TC <span>&minus;L +R WCA</span></th>" +
    "<th>TH <span>&minus;E +W Var</span></th>" +
    "<th>MH <span>+/&minus; Dev</span></th>" +
    "<th>CH</th>" +
    "<th>Dist <span>Leg &middot; Rem.</span></th>" +
    "<th>GS <span>Est. &middot; Act.</span></th>" +
    "<th>Time <span>ETE &middot; ETA</span></th>" +
    "<th>Time <span>ATE &middot; ATA</span></th>" +
    "<th>GPH <span>Fuel &middot; Rem</span></th>" +
    '<th class="x no-print"></th></tr></thead><tbody>';

  NAV.legs.forEach(function (l, i) {
    var o = c.rows[i] || {};
    x += "<tr>" +
      '<td class="n">' + (i + 1) + "</td>" +
      '<td class="cp">' + nlLeg(i, "cp", l.cp) + "</td>" +
      '<td class="two">' + nlLeg(i, "vor", l.vor, "", "ident") + nlLeg(i, "freq", l.freq, "", "freq") + "</td>" +
      "<td>" + nlLeg(i, "route", l.route) + "</td>" +
      "<td>" + nlLeg(i, "alt", l.alt) + "</td>" +
      '<td class="wind">' + nlLeg(i, "wd", l.wd, "", "dir") + nlLeg(i, "wv", l.wv, "", "vel") +
        nlLeg(i, "temp", l.temp, "", "°C") + "</td>" +
      '<td class="two">' + nlLeg(i, "cas", l.cas, "", "CAS") + nlLeg(i, "tas", l.tas, "", "TAS") + "</td>" +
      '<td class="two">' + nlLeg(i, "tc", l.tc, "", "TC") + nlCalc(o.wca) + "</td>" +
      '<td class="two">' + nlCalc(o.th) +
        nlLeg(i, "vr", l.vr, "vr" + (String(l.vr || "").trim() && parseVar(l.vr, h.varEW) == null ? " bad" : ""),
              varLabel(parseVar(h.var_, h.varEW)) || "var") + "</td>" +
      '<td class="two">' + nlCalc(o.mh) + nlLeg(i, "dev", l.dev, "", "dev") + "</td>" +
      "<td>" + nlCalc(o.ch) + "</td>" +
      '<td class="two">' + nlLeg(i, "dist", l.dist, "", "NM") + nlCalc(o.distrem) + "</td>" +
      '<td class="two">' + nlCalc(o.gs) + nlLeg(i, "gsa", l.gsa) + "</td>" +
      '<td class="two">' + nlCalc(o.ete) + nlCalc(o.eta) + "</td>" +
      '<td class="two">' + nlLeg(i, "ate", l.ate) + nlLeg(i, "ata", l.ata) + "</td>" +
      '<td class="two">' + nlCalc(o.fuel) + nlCalc(o.frem) + "</td>" +
      '<td class="x no-print"><button data-del="' + i + '" title="Delete this line" aria-label="Delete line ' + (i + 1) + '">&times;</button></td>' +
      "</tr>";
  });
  x += '<tr class="tot"><td class="n"></td><td class="cp">Totals &rarr;</td>' +
    '<td colspan="9"></td>' +
    "<td>" + nlCalc(c.totalD) + "</td><td></td>" +
    '<td class="two">' + nlCalc(c.totalT ? c.totalT + " min" : "") + nlCalc(c.totalEta) + "</td><td></td>" +
    "<td>" + nlCalc(c.totalF) + "</td>" +
    '<td class="x no-print"></td></tr>';
  x += '<tr class="wxb"><td class="n"></td><td class="cp">Close your flight plan</td>' +
    '<td colspan="14">1&nbsp;800&nbsp;WX&nbsp;BRIEF &nbsp;&middot;&nbsp; 1&nbsp;800&nbsp;992&nbsp;7433 &nbsp;&middot;&nbsp; 1800wxbrief.com</td>' +
    '<td class="x no-print"></td></tr>';
  x += "</tbody></table></div>";

  /* ---------- side panels ---------- */
  var AD = [["atis", "ATIS Code"], ["cig", "Ceiling/Vis"], ["wind", "Wind"],
            ["alt", "Altimeter"], ["app", "Approach"], ["rwy", "Runway"]];
  x += '<div class="nl-side">';
  x += '<table class="nl-p"><tr><th class="nlbar" colspan="3">Airport &amp; ATIS Advisories</th></tr>' +
    '<tr><th class="sm">Departure</th><th></th><th class="sm">Destination</th></tr>' +
    AD.map(function (f) {
      return "<td>" + nlIn("adv.d_" + f[0], NAV.adv["d_" + f[0]]) + '</td><th class="mid">' + esc(f[1]) +
        "</th><td>" + nlIn("adv.a_" + f[0], NAV.adv["a_" + f[0]]) + "</td>";
    }).map(function (r) { return "<tr>" + r + "</tr>"; }).join("") +
    '<tr><td></td><th class="mid">Time Check</th><td>' + nlIn("adv.tcheck", NAV.adv.tcheck) + "</td></tr></table>";

  var FR = [["atis", "ATIS", "ATIS"], ["grnd", "Grnd", "Apch"], ["twr", "Tower/CTAF", "Tower/CTAF"],
            ["dep", "Dep.", "Grnd"], ["elev", "Fld Elev", "Fld Elev"]];
  x += '<table class="nl-p"><tr><th class="nlbar" colspan="4">Airport Frequencies</th></tr>' +
    FR.map(function (f) {
      return "<tr><th>" + esc(f[1]) + "</th><td>" + nlIn("freq.d_" + f[0], NAV.freq["d_" + f[0]]) +
        '</td><th class="r">' + esc(f[2]) + "</th><td>" + nlIn("freq.a_" + f[0], NAV.freq["a_" + f[0]]) + "</td></tr>";
    }).join("") + "</table>";

  x += '<table class="nl-p"><tr><th class="nlbar" colspan="3">Fuel Planning</th></tr>' +
    '<tr><th>Total Burn</th><td>' + nlCalc(c.totalF) + '</td><td class="hint">Start to shutdown</td></tr>' +
    '<tr><th>FAR Reserve</th><td>' + nlIn("fuel.far", NAV.fuel.far) + '</td><td class="hint">30 min day, 45 night</td></tr>' +
    '<tr><th>Personal Mins</th><td>' + nlIn("fuel.pers", NAV.fuel.pers) + '</td><td class="hint">Typically 1 hour</td></tr>' +
    '<tr><th>Total Required</th><td>' + nlCalc(c.reqd) + '</td><td class="hint">Sum of the above</td></tr>' +
    '<tr><th>Fuel On Board</th><td>' + nlIn("fob", h.fob) + '</td><td class="hint">Usually max</td></tr>' +
    "</table>";

  x += '<div class="nl-varbox no-print"><b>Variation for the flight</b>' +
    nlIn("var_", h.var_, "sm", "deg") +
    '<select data-nl="varEW"><option value="W"' + (h.varEW !== "E" ? " selected" : "") + '>W</option>' +
    '<option value="E"' + (h.varEW === "E" ? " selected" : "") + ">E</option></select>" +
    "<span>Read it off the dashed magenta isogonic line on the sectional. West is added to true, " +
    "east is subtracted. This is only the <b>default</b>: every line has its own <b>Var</b> box, so on a " +
    "long route that crosses an isogonic line, type the right value on the legs that need it \u2014 " +
    "<b>7W</b>, <b>3E</b>, or just <b>7</b> to use the hemisphere set here.</span></div>";
  x += '<div class="nl-varbox no-print"><b>Time off</b>' + nlIn("timeoff", h.timeoff, "sm", "1430") +
    "<span>Zulu, four digits. The ETA column works forward from it.</span></div>";
  x += "</div></div>";
  x += "</div>";

  x += '<div class="nl-actions no-print"><button class="btn" id="nlSample">Build a sample nav log</button>' +
    '<button class="btn ghost" id="nlAdd">Add a line</button>' +
    '<button class="btn ghost" id="nlPrint">Print or save as PDF</button>' +
    '<button class="btn ghost" id="nlE6B">Open the E6B</button>' +
    '<button class="btn ghost" id="nlClear">Clear it</button></div>';
  x += '<div id="nlVerdict">' + navVerdict(c) + "</div>";
  return x;
}

function navVerdict(c) {
  var x = "";
  if (NAV.sample) {
    x += '<div class="note gold no-print"><span class="lbl">This is the sample</span>' +
      "Every course and distance in it is computed from the real coordinates of KFXE, KPHK, KOBE, KSEF and " +
      "KLAL, so the geometry is honest. The <b>wind, the temperature, the variation and the compass " +
      "deviation card are example numbers</b> — in a real plan they come from the winds aloft forecast, " +
      "the sectional and the placard in the airplane. The frequency and ATIS boxes are left empty on purpose: " +
      "look them up in the Chart Supplement and fill them in, because that is the part a student has to " +
      "learn to do. The route is short enough that one variation covers it, so the <b>Var</b> boxes are " +
      "left showing the flight default \u2014 on a longer route you would type the value for each leg in.</div>";
  }
  if (c.landing != null) {
    var ok = (c.far == null && c.pers == null) ? null : c.landing >= (c.far || 0) + (c.pers || 0);
    x += '<div class="verdict ' + (ok === null ? "none" : (ok ? "ok" : "part")) + '" style="margin-top:16px">' +
      '<div class="v-hd"><b>' + (ok === null ? "Fuel"
        : (ok ? "Fuel plan covers the reserve and your personal minimum"
              : "Fuel plan does NOT cover the reserve and your personal minimum")) + "</b>" +
      '<span class="v-count mono">' + c.totalF + " gal burned</span></div>" +
      '<p class="v-note">Estimated fuel on landing: <b>' + c.landing + " gal</b>. " +
      "Total required is the burn plus the reserve plus whatever you set as a personal minimum: <b>" +
      c.reqd + " gal</b>. 14 CFR 91.151 requires enough fuel to fly to the first point of intended landing " +
      "and then, at normal cruising speed, for 30 minutes by day or 45 minutes at night. That is the legal " +
      "floor, not a plan.</p></div>";
  }
  return x;
}

/* ---- the example deviation card, rendered ---------------------------------- */
function devCardHtml() {
  var top = DEVCARD.slice(0, 6), bot = DEVCARD.slice(6);
  function lbl(v) { return v === 0 ? "N" : v === 90 ? "E" : v === 180 ? "S" : v === 270 ? "W" : v; }
  function row(cls, cells) { return "<tr>" + cells.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }
  var h = '<table class="devcard"><tbody>' +
    "<tr><th>FOR (MH)</th>" + top.map(function (d) { return "<td>" + lbl(d.mh) + "</td>"; }).join("") + "</tr>" +
    "<tr><th>STEER (CH)</th>" + top.map(function (d) { return "<td>" + d.ch + "</td>"; }).join("") + "</tr>" +
    '<tr class="gap"><th>FOR (MH)</th>' + bot.map(function (d) { return "<td>" + lbl(d.mh) + "</td>"; }).join("") + "</tr>" +
    "<tr><th>STEER (CH)</th>" + bot.map(function (d) { return "<td>" + d.ch + "</td>"; }).join("") + "</tr>" +
    "</tbody></table>";
  return h;
}

/* ---- wiring ---------------------------------------------------------------- */
function nlSet(path, v) {
  if (path.indexOf(".") > 0) {
    var p = path.split("."); NAV[p[0]] = NAV[p[0]] || {}; NAV[p[0]][p[1]] = v;
  } else NAV.hdr[path] = v;
}
function wireNav() {
  var host = el("nlHost"); if (!host) return;
  function redraw() { saveNav(); host.innerHTML = navlogHtml(); wireNav(); }

  var f = host.querySelectorAll("[data-nl]");
  for (var i = 0; i < f.length; i++) {
    f[i].addEventListener("input", function () { nlSet(this.getAttribute("data-nl"), this.value); saveNav(); refresh(); });
    f[i].addEventListener("change", function () { nlSet(this.getAttribute("data-nl"), this.value); saveNav(); refresh(); });
  }
  var g = host.querySelectorAll("[data-leg]");
  for (var j = 0; j < g.length; j++) g[j].addEventListener("input", function () {
    NAV.legs[+this.getAttribute("data-leg")][this.getAttribute("data-k")] = this.value;
    NAV.sample = false; saveNav(); refresh();
    if (this.getAttribute("data-k") === "vr") {
      var raw = String(this.value || "").trim();
      this.classList.toggle("bad", !!raw && parseVar(raw, NAV.hdr.varEW) == null);
    }
  });
  var d = host.querySelectorAll("[data-del]");
  for (var k = 0; k < d.length; k++) d[k].addEventListener("click", function () {
    if (NAV.legs.length <= 1) return;
    NAV.legs.splice(+this.getAttribute("data-del"), 1); redraw();
  });
  el("nlAdd").addEventListener("click", function () { NAV.legs.push({}); redraw(); });
  el("nlPrint").addEventListener("click", function () { window.print(); });
  el("nlE6B").addEventListener("click", openE6B);
  el("nlClear").addEventListener("click", function () {
    NAV = { hdr: {}, legs: [{}, {}, {}, {}, {}, {}], adv: {}, freq: {}, fuel: {}, sample: false };
    redraw();
  });
  el("nlSample").addEventListener("click", function () {
    if (buildSample()) { redraw(); host.scrollIntoView({ block: "start", behavior: "smooth" }); }
  });

  function refresh() {
    var c = navCalc();
    var rows = host.querySelectorAll("table.nl-main tbody tr");
    for (var r = 0; r < NAV.legs.length; r++) {
      if (!rows[r]) continue;
      var o = c.rows[r] || {}, sp = rows[r].querySelectorAll("span.nl-c");
      /* the placeholder is what tells the student which variation is being inherited */
      var vi = rows[r].querySelector("input.vr");
      if (vi) vi.placeholder = varLabel(parseVar(NAV.hdr.var_, NAV.hdr.varEW)) || "var";
      /* order matches navlogHtml: wca, th, var, mh, ch, distrem, gs, ete, eta, fuel, frem */
      var vals = [o.wca, o.th, o.mh, o.ch, o.distrem, o.gs, o.ete, o.eta, o.fuel, o.frem];
      for (var s = 0; s < sp.length && s < vals.length; s++) sp[s].textContent = vals[s] == null ? "" : vals[s];
    }
    var tot = host.querySelector("tr.tot");
    if (tot) {
      var ts = tot.querySelectorAll("span.nl-c");
      if (ts[0]) ts[0].textContent = c.totalD;
      if (ts[1]) ts[1].textContent = c.totalT ? c.totalT + " min" : "";
      if (ts[2]) ts[2].textContent = c.totalEta;
      if (ts[3]) ts[3].textContent = c.totalF;
    }
    var fp = host.querySelectorAll("table.nl-p span.nl-c");
    if (fp[0]) fp[0].textContent = c.totalF;
    if (fp[1]) fp[1].textContent = c.reqd;
    var vh = el("nlVerdict"); if (vh) vh.innerHTML = navVerdict(c);
  }
}


  /* ================= ICAO FLIGHT PLAN ================= */
  /* ============================================================================
   ICAO flight plan — FAA Form 7233-4.  Injected inside the app IIFE.

   This builds a real ICAO flight plan message, field by field, and explains
   every box as it goes. It is a TRAINING tool: it writes the string and hands
   you a file, it does not file anything. Filing happens with a Flight Service
   provider, and the page links to them.

   Every code table below is transcribed from the FAA ICAO Flight Plan Quick
   Reference Brochure, version 8, September 2022, cross-checked against
   AIM Appendix 4. Where the brochure and the AIM use different wording the
   brochure's is used, because that is the sheet a pilot actually holds.
   ========================================================================== */

var FPL_RULES = [
  ["I", "IFR the whole way"],
  ["V", "VFR the whole way"],
  ["Y", "IFR first, then VFR — say where it changes in the route"],
  ["Z", "VFR first, then IFR — say where it changes in the route"]
];
var FPL_TYPE = [
  ["G", "General aviation"], ["S", "Scheduled air service"],
  ["N", "Non-scheduled air transport"], ["M", "Military"], ["X", "Anything else"]
];
var FPL_WAKE = [
  ["L", "Light — 15,500 lb or less"],
  ["M", "Medium — more than 15,500 lb, less than 300,000 lb"],
  ["H", "Heavy — 300,000 lb or more"],
  ["J", "Super — the A380 and the AN-225"]
];

/* Item 10a — navigation, communication and approach aid capability.
   Grouped the way the brochure groups them so the page reads like the sheet. */
var FPL_10A = [
  { g: "The two that decide the shape of the rest", c: [
    ["N", "No capabilities at all — file N alone, nothing else in 10a"],
    ["S", "Standard: VHF radio, VOR and ILS. Filing S means you have all three"]
  ]},
  { g: "Navigation", c: [
    ["D", "DME"], ["F", "ADF"], ["G", "GNSS — a GPS you may navigate by"],
    ["I", "Inertial navigation"], ["O", "VOR"], ["T", "TACAN"],
    ["R", "PBN approved — you must then list the types in Item 18 PBN/"]
  ]},
  { g: "Approach capability", c: [
    ["A", "GBAS landing system"], ["B", "LPV — approach with vertical guidance using SBAS (WAAS)"],
    ["C", "LORAN C"], ["K", "MLS"], ["L", "ILS"]
  ]},
  { g: "Voice radio", c: [
    ["H", "HF radiotelephone"], ["U", "UHF radiotelephone"],
    ["V", "VHF radiotelephone"], ["Y", "VHF with 8.33 kHz channel spacing"]
  ]},
  { g: "Data and satellite", c: [
    ["E1", "ACARS FMC waypoint reporting"], ["E2", "ACARS D-FIS"], ["E3", "ACARS pre-departure clearance"],
    ["J1", "CPDLC ATN VDL Mode 2"], ["J2", "CPDLC FANS 1/A HF data link"],
    ["J3", "CPDLC FANS 1/A VDL Mode A"], ["J4", "CPDLC FANS 1/A VDL Mode 2"],
    ["J5", "CPDLC FANS 1/A satellite Inmarsat"], ["J6", "CPDLC FANS 1/A satellite MTSAT"],
    ["J7", "CPDLC FANS 1/A satellite Iridium"],
    ["M1", "ATC satellite voice, Inmarsat"], ["M2", "ATC satellite voice, MTSAT"],
    ["M3", "ATC satellite voice, Iridium"],
    ["P1", "RCP 400"], ["P2", "RCP 240"], ["P3", "RCP 400 satellite voice"]
  ]},
  { g: "Special", c: [
    ["W", "RVSM approved — file W only if you actually hold the authorisation"],
    ["Z", "Something else — you must then say what in Item 18 NAV/, COM/ or DAT/"]
  ]}
];

/* Item 10b — surveillance. */
var FPL_10B = [
  { g: "No equipment", c: [["N", "None — file N alone, nothing else in 10b"]] },
  { g: "Transponder — pick at most ONE", c: [
    ["A", "Mode A, no Mode C"], ["C", "Modes A and C"],
    ["E", "Mode S: ident, altitude and extended squitter"],
    ["H", "Mode S: ident, altitude, enhanced surveillance"],
    ["I", "Mode S: ident, no altitude"],
    ["L", "Mode S: ident, altitude, enhanced surveillance and extended squitter"],
    ["P", "Mode S: altitude, no ident"], ["S", "Mode S: ident and altitude"],
    ["X", "Mode S: no ident, no altitude"]
  ]},
  { g: "ADS-B — up to three", c: [
    ["B1", "1090 MHz ADS-B out"], ["B2", "1090 MHz ADS-B out and in"],
    ["U1", "UAT ADS-B out"], ["U2", "UAT ADS-B out and in"],
    ["V1", "VDL Mode 4 ADS-B out"], ["V2", "VDL Mode 4 ADS-B out and in"]
  ]},
  { g: "ADS-C", c: [["D1", "ADS-C FANS 1/A"], ["G1", "ADS-C ATN"]] }
];

/* Item 18 PBN/ — performance based navigation. At most 8; the rest go in NAV/. */
var FPL_PBN = [
  { g: "Oceanic and remote", c: [["A1", "RNAV 10 (RNP 10)"], ["L1", "RNP 4"]] },
  { g: "RNAV 5", c: [["B1", "All permitted sensors"], ["B2", "GNSS"], ["B3", "DME/DME"],
                     ["B4", "VOR/DME"], ["B5", "INS or IRS"]] },
  { g: "RNAV 2", c: [["C1", "All permitted sensors"], ["C2", "GNSS"], ["C4", "DME/DME/IRU"]] },
  { g: "RNAV 1", c: [["D1", "All permitted sensors"], ["D2", "GNSS"], ["D4", "DME/DME/IRU"]] },
  { g: "RNP 1", c: [["O1", "All permitted sensors"], ["O2", "GNSS"]] },
  { g: "RNP approach", c: [["S1", "RNP APCH"], ["S2", "RNP APCH with Baro-VNAV"]] },
  { g: "RNP AR approach", c: [["T1", "RNP AR APCH with RF required"],
                              ["T2", "RNP AR APCH without RF"]] }
];
/* Item 18 NAV/ — the extra PBN capabilities that have no PBN/ code. */
var FPL_NAV = [
  ["Z1", "Radius to fix (RF) legs"], ["Z2", "Fixed radius transitions (FRT)"],
  ["Z5", "Time of arrival control (TOAC)"], ["R1", "Helicopter RNP 0.3"],
  ["P1", "Advanced RNP (A-RNP)"], ["M1", "RNP 2 continental"], ["M2", "RNP 2 oceanic or remote"],
  ["GBAS", "GBAS equipped"], ["SBAS", "SBAS (WAAS) equipped"]
];
/* Item 18 STS/ — special handling. */
var FPL_STS = [
  ["ALTRV", "Operating on an altitude reservation"],
  ["ATFMX", "Exempt from air traffic flow management"],
  ["FLTCK", "Flight check of navigation aids"],
  ["HAZMAT", "Carrying hazardous material"],
  ["HEAD", "Head of state aboard"],
  ["HOSP", "Medical flight declared by a medical authority"],
  ["HUM", "Humanitarian mission"],
  ["MARSA", "Military assumes responsibility for separation"],
  ["MEDEVAC", "Life-critical medical evacuation"],
  ["NONRVSM", "Not RVSM capable but requesting RVSM airspace"],
  ["SAR", "Search and rescue"],
  ["FFR", "Fire fighting"]
];
/* Item 18 PER/ — approach category, from Vref or 1.3 Vso at max landing weight
   (14 CFR 97.3). A trainer is nearly always A. */
var FPL_PER = [
  ["A", "Less than 91 knots"], ["B", "91 up to 121 knots"], ["C", "121 up to 141 knots"],
  ["D", "141 up to 166 knots"], ["E", "166 up to 211 knots"], ["H", "Helicopter"]
];

/* Two worked examples. The first is the flight a student actually makes; the
   second is the brochure's own, kept verbatim so the page can be checked. */
var FPL_SAMPLES = {
  train: {
    name: "A training IFR cross-country",
    note: "A Piper Archer III on an IFR training flight, Fort Lauderdale Executive to " +
          "Orlando Executive. WAAS GPS, Mode S transponder with 1090 MHz ADS-B out. " +
          "This is the shape of flight plan most instrument students file.",
    v: { acid: "N4321P", rules: "I", type: "G", num: "", actype: "P28A", wake: "L",
         eq10a: ["S", "B", "D", "G", "O", "R", "Z"], eq10b: ["S", "B1"],
         dep: "KFXE", eobt: "1430", speed: "N0115", level: "A060",
         route: "DCT PBI DCT MLB DCT ORL", dest: "KORL", eet: "0125",
         alt1: "KSFB", alt2: "", pbn: ["D2", "O2", "S1"], nav: ["SBAS"],
         per: "A", reg: "N4321P", dof: "", opr: "", code: "", rmk: "TRAINING FLIGHT",
         endur: "0430", pob: "2", radio: ["V", "E"], surv: [], jackets: [],
         colour: "WHITE WITH BLUE AND GOLD STRIPES", pic: "SIMON", tel: "" }
  },
  brochure: {
    name: "The FAA brochure's example",
    note: "Printed in the FAA ICAO Flight Plan Quick Reference Brochure, version 8. " +
          "A Citation 550 from Portland, Maine to Jacksonville, with Orlando as the " +
          "alternate. Kept here exactly as the FAA prints it so you can check this " +
          "builder against the source.",
    raw: "(FPL-TTT123-IS\n-C550/L-SDE1E2GHIJ3J5RWZ/SB1D1\n-KPWM1225\n" +
         "-N0440F310 SSOXS5 SSOXS DCT BUZRD DCT SEY DCT HTO J174 ORF J121\n" +
         " CHS EESNT LUNNI1\n-KJAX0214 KMCO\n" +
         "-PBN/A1L1B1C1D1O1T1 NAV/Z1 GBAS DAT/1FANS2PDC SUR/260B RSP180\n" +
         " DOF/220501 REG/N123A SEL/BPAM CODE/A05ED7)"
  }
};

/* ---------------------------------------------------------------------------
   Assemble the message. ICAO field order, with "-" between fields, exactly as
   the form lays it out. Empty optional fields are dropped rather than left as
   blanks, because a blank field is a filing error, not an empty one.
   ------------------------------------------------------------------------ */
function fplValue() {
  function v(id) { var n = el(id); return n ? String(n.value || "").trim().toUpperCase() : ""; }
  function picked(name) {
    var out = [], ns = document.querySelectorAll('input[data-fpl="' + name + '"]:checked');
    for (var i = 0; i < ns.length; i++) out.push(ns[i].value);
    return out;
  }
  return {
    acid: v("fp_acid"), rules: v("fp_rules"), type: v("fp_type"),
    num: v("fp_num"), actype: v("fp_actype"), wake: v("fp_wake"),
    eq10a: picked("10a"), eq10b: picked("10b"),
    dep: v("fp_dep"), eobt: v("fp_eobt"),
    speed: v("fp_speed"), level: v("fp_level"), route: v("fp_route"),
    dest: v("fp_dest"), eet: v("fp_eet"), alt1: v("fp_alt1"), alt2: v("fp_alt2"),
    pbn: picked("pbn"), nav: picked("nav"), sts: picked("sts"),
    per: v("fp_per"), reg: v("fp_reg"), dof: v("fp_dof"), opr: v("fp_opr"),
    code: v("fp_code"), sel: v("fp_sel"), rmk: v("fp_rmk"), eet18: v("fp_eet18"),
    endur: v("fp_endur"), pob: v("fp_pob"), radio: picked("radio"),
    surv: picked("surv"), jackets: picked("jackets"),
    dnum: v("fp_dnum"), dcap: v("fp_dcap"), dcover: picked("dcover"), dcolour: v("fp_dcolour"),
    colour: v("fp_colour"), pic: v("fp_pic"), tel: v("fp_tel")
  };
}

/* Item 10a has a canonical order in the brochure's own example: the plain
   letters first, alphabetically, then the numbered data-link codes. Sorting it
   the same way makes a plan built here look like a plan printed by the FAA. */
function fplSortEq(list) {
  var plain = [], numbered = [];
  list.forEach(function (c) { (/\d/.test(c) ? numbered : plain).push(c); });
  plain.sort(); numbered.sort();
  return plain.concat(numbered).join("");
}

function fplBuild(d) {
  d = d || fplValue();
  var L = [];
  /* Item 7 aircraft identification, Item 8 flight rules and type of flight */
  L.push("(FPL-" + (d.acid || "????") + "-" + (d.rules || "?") + (d.type || "?"));
  /* Item 9 number / type / wake, Item 10 equipment */
  var nine = (d.num && d.num !== "1" ? d.num : "") + (d.actype || "ZZZZ") + "/" + (d.wake || "L");
  var ten = fplSortEq(d.eq10a) + "/" + fplSortEq(d.eq10b);
  L.push("-" + nine + "-" + ten);
  /* Item 13 departure aerodrome and off-block time */
  L.push("-" + (d.dep || "ZZZZ") + (d.eobt || "0000"));
  /* Item 15 speed, level, route */
  L.push("-" + (d.speed || "N0000") + (d.level || "VFR") + " " + (d.route || "DCT"));
  /* Item 16 destination, total EET, alternates */
  L.push("-" + (d.dest || "ZZZZ") + (d.eet || "0000") +
         (d.alt1 ? " " + d.alt1 : "") + (d.alt2 ? " " + d.alt2 : ""));
  /* Item 18 other information */
  var o = [];
  if (d.sts.length) o.push("STS/" + d.sts.join(" "));
  if (d.pbn.length) o.push("PBN/" + d.pbn.join(""));
  if (d.nav.length) o.push("NAV/" + d.nav.join(" "));
  if (d.eet18) o.push("EET/" + d.eet18);
  if (d.sel) o.push("SEL/" + d.sel);
  if (d.per) o.push("PER/" + d.per);
  if (d.code) o.push("CODE/" + d.code);
  if (d.dof) o.push("DOF/" + d.dof);
  if (d.reg) o.push("REG/" + d.reg);
  if (d.opr) o.push("OPR/" + d.opr);
  if (d.rmk) o.push("RMK/" + d.rmk);
  L.push("-" + (o.length ? o.join(" ") : "0"));
  /* Item 19 supplementary — never transmitted in the FPL message itself, but
     it is what search and rescue reads if you do not arrive. */
  var s = [];
  if (d.endur) s.push("E/" + d.endur);
  if (d.pob) s.push("P/" + d.pob);
  if (d.radio.length) s.push("R/" + d.radio.join(""));
  if (d.surv.length) s.push("S/" + d.surv.join(""));
  if (d.jackets.length) s.push("J/" + d.jackets.join(""));
  if (d.dnum || d.dcap) {
    s.push("D/" + (d.dnum || "") + " " + (d.dcap || "") + " " +
           (d.dcover.length ? "C" : "") + " " + (d.dcolour || ""));
  }
  if (d.colour) s.push("A/" + d.colour);
  if (d.rmk) s.push("N/" + d.rmk);
  if (d.pic) s.push("C/" + d.pic + (d.tel ? " " + d.tel : ""));
  var main = L.join("\n");
  return { fpl: main + ")", supp: s.join(" "), items: L };
}

/* ---------------------------------------------------------------------------
   Validation. These are the mistakes that get a plan rejected, or that get it
   accepted and then cause a problem in the air. Each one names the rule.
   ------------------------------------------------------------------------ */
function fplCheck(d) {
  var out = [];
  function bad(m, why) { out.push({ lvl: "bad", m: m, why: why }); }
  function warn(m, why) { out.push({ lvl: "warn", m: m, why: why }); }

  if (!/^[A-Z0-9]{1,7}$/.test(d.acid)) {
    bad("Item 7: the aircraft identification must be 1 to 7 letters or digits, no dash.",
        "N123AB, not N123-AB. A US registration is filed without the dash.");
  }
  if (!d.rules) bad("Item 8: pick the flight rules.", "");
  if (!d.type) bad("Item 8: pick the type of flight.", "A training flight is G, general aviation.");
  if (!/^[A-Z0-9]{2,4}$/.test(d.actype)) {
    bad("Item 9: the aircraft type must be the ICAO designator.",
        "A Piper Archer is P28A, a 172 is C172. If your type has no designator, file ZZZZ " +
        "and put TYP/ in Item 18.");
  }
  if (!d.wake) bad("Item 9: pick a wake turbulence category.", "A trainer is L, light.");

  var a = d.eq10a, b = d.eq10b;
  if (!a.length) bad("Item 10a: choose at least one capability.", "If you truly have none, file N.");
  if (a.indexOf("N") >= 0 && a.length > 1) {
    bad("Item 10a: N means no capability at all, so nothing else may be filed with it.", "");
  }
  if (!b.length) bad("Item 10b: choose at least one, or N.", "");
  if (b.indexOf("N") >= 0 && b.length > 1) {
    bad("Item 10b: N means no surveillance equipment, so nothing else may be filed with it.", "");
  }
  var xpdr = b.filter(function (x) { return /^[ACEHILPSX]$/.test(x); });
  if (xpdr.length > 1) {
    bad("Item 10b: only one transponder code may be filed. You have " + xpdr.join(", ") + ".",
        "Pick the single code that describes your transponder.");
  }
  var adsb = b.filter(function (x) { return /^(B|U|V)\d$/.test(x); });
  if (adsb.length > 3) bad("Item 10b: at most three ADS-B codes.", "");

  if (a.indexOf("R") >= 0 && !d.pbn.length) {
    bad("Item 10a has R (PBN approved) but Item 18 has no PBN/ entry.",
        "R is a promise that you will list which PBN types you are approved for. " +
        "This is the single most common ICAO filing error.");
  }
  if (d.pbn.length && a.indexOf("R") < 0) {
    bad("Item 18 has PBN/ but Item 10a does not have R.",
        "They go together. Add R to Item 10a.");
  }
  if (d.pbn.length > 8) {
    bad("Item 18 PBN/ takes at most 8 codes. You have " + d.pbn.length + ".",
        "File the 8 that matter for this flight and put the rest in NAV/.");
  }
  if (a.indexOf("Z") >= 0 && !d.nav.length && !d.sel) {
    warn("Item 10a has Z but Item 18 has no NAV/, COM/ or DAT/ entry.",
         "Z means “something else”, and the brochure requires you to say what it is.");
  }
  if (d.nav.length && a.indexOf("Z") < 0) {
    bad("Item 18 has NAV/ but Item 10a does not have Z.",
        "The brochure is explicit: when you file NAV/, COM/ or DAT/, include Z in Item 10a.");
  }
  var pbnNeedsG = d.pbn.filter(function (x) { return /^(B2|C2|D2|O2|A1|L1)$/.test(x); });
  if (pbnNeedsG.length && a.indexOf("G") < 0) {
    warn("Item 18 PBN/ claims a GNSS-based capability (" + pbnNeedsG.join(", ") +
         ") but Item 10a has no G.", "GNSS navigation capability is G in Item 10a.");
  }
  if (d.pbn.filter(function (x) { return /^S/.test(x); }).length && a.indexOf("B") < 0) {
    warn("You filed an RNP approach capability but not B (LPV) in Item 10a.",
         "If your GPS flies LPV minimums, B belongs in 10a. If it only does LNAV, this is fine.");
  }
  if (a.indexOf("W") >= 0) {
    warn("Item 10a has W, which claims RVSM authorisation.",
         "File W only if you actually hold it. A trainer does not.");
  }

  if (!/^[A-Z]{4}$/.test(d.dep)) bad("Item 13: departure aerodrome must be a 4-letter ICAO identifier.",
    "A US airport is K plus the three-letter identifier: KFXE, not FXE.");
  if (!/^([01]\d|2[0-3])[0-5]\d$/.test(d.eobt)) {
    bad("Item 13: the off-block time must be 4 digits, UTC, 0000 to 2359.",
        "This is the time you expect to MOVE, not the time you expect to be airborne. " +
        "And it is Zulu.");
  }
  if (!/^[A-Z]{4}$/.test(d.dest)) bad("Item 16: destination must be a 4-letter ICAO identifier.", "");
  if (!/^\d{4}$/.test(d.eet)) bad("Item 16: total estimated elapsed time must be 4 digits, HHMM.",
    "0125 is one hour twenty-five minutes.");
  if (d.alt1 && !/^[A-Z]{4}$/.test(d.alt1)) bad("Item 16: the alternate must be a 4-letter ICAO identifier.", "");
  if (d.alt2 && !d.alt1) bad("Item 16: you have a second alternate but no first one.", "");

  if (!/^[NMK]\d{4}$/.test(d.speed)) {
    bad("Item 15: cruising speed is a letter then 4 digits.",
        "N0115 is 115 knots true. N for knots, K for kilometres per hour, M for Mach.");
  }
  if (!/^(VFR|[AF]\d{3}|[SM]\d{4})$/.test(d.level)) {
    bad("Item 15: the level is A or F plus 3 digits, or VFR.",
        "A060 is 6,000 feet. F310 is flight level 310. Write VFR only on a VFR plan.");
  }
  if (d.level === "VFR" && d.rules === "I") {
    bad("Item 15 says VFR but Item 8 says the flight is IFR.", "");
  }
  if (!d.route.trim()) bad("Item 15: the route cannot be empty.", "DCT means direct.");
  if (/[^A-Z0-9 ./]/.test(d.route)) {
    warn("Item 15: the route has characters ATC will not accept.",
         "Use only letters, digits, spaces, slashes and full stops.");
  }
  if ((d.rules === "Y" || d.rules === "Z") && !/\b(VFR|IFR)\b/.test(d.route)) {
    bad("Flight rules " + d.rules + " means the rules change en route, so the route must " +
        "name the point where that happens.",
        "For example: ... DCT ORL VFR, or ... LUNNI IFR.");
  }
  if (d.dof && !/^\d{6}$/.test(d.dof)) bad("Item 18 DOF/ must be YYMMDD.", "260913 is 13 Sep 2026.");
  if (d.code && !/^[0-9A-F]{6}$/.test(d.code)) {
    bad("Item 18 CODE/ is the Mode S address in hexadecimal: six characters, 0-9 and A-F.", "");
  }
  if (d.reg && !/^[A-Z0-9]{1,7}$/.test(d.reg)) bad("Item 18 REG/ must be the registration with no dash.", "");
  if (d.endur && !/^\d{4}$/.test(d.endur)) bad("Item 19 E/ endurance must be 4 digits, HHMM.", "");
  if (d.pob && !/^\d{1,3}$/.test(d.pob) && d.pob !== "TBN") {
    bad("Item 19 P/ is the number of people on board, or TBN if not yet known.", "");
  }
  if (d.rules === "I" && !d.alt1) {
    warn("No alternate filed on an IFR plan.",
         "14 CFR 91.169 decides whether you need one. The 1-2-3 rule: from 1 hour before to " +
         "1 hour after your ETA, if the ceiling is below 2,000 feet or the visibility below " +
         "3 statute miles, an alternate is required.");
  }
  if (d.endur && d.eet && d.endur <= d.eet) {
    bad("Item 19: your endurance is not longer than the flight.",
        "Endurance is total fuel on board expressed as time. It has to exceed the elapsed " +
        "time plus your reserve — 14 CFR 91.167 wants 45 minutes at normal cruise for IFR.");
  }
  if (!d.pic) warn("Item 19 C/ : no pilot in command named.",
    "This is the name search and rescue will look for.");
  return out;
}

/* ---------------------------------------------------------------------------
   The page
   ------------------------------------------------------------------------ */
function fplSel(id, label, opts, val, hint) {
  return '<label class="fp-f"><span>' + esc(label) + "</span>" +
    '<select id="' + id + '">' + '<option value=""></option>' +
    opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? " selected" : "") + ">" +
        esc(o[0] + " — " + o[1]) + "</option>";
    }).join("") + "</select>" +
    (hint ? '<i class="fp-h">' + esc(hint) + "</i>" : "") + "</label>";
}
function fplIn(id, label, val, ph, hint, cls) {
  return '<label class="fp-f' + (cls ? " " + cls : "") + '"><span>' + esc(label) + "</span>" +
    '<input id="' + id + '" type="text" autocomplete="off" spellcheck="false" value="' +
    esc(val || "") + '" placeholder="' + esc(ph || "") + '">' +
    (hint ? '<i class="fp-h">' + esc(hint) + "</i>" : "") + "</label>";
}
function fplBoxes(name, groups, sel) {
  sel = sel || [];
  return groups.map(function (g) {
    return '<div class="fp-grp"><div class="fp-gh">' + esc(g.g) + "</div><div class=\"fp-bs\">" +
      g.c.map(function (c) {
        return '<label class="fp-b' + (sel.indexOf(c[0]) >= 0 ? " on" : "") + '" title="' + esc(c[1]) + '">' +
          '<input type="checkbox" data-fpl="' + name + '" value="' + esc(c[0]) + '"' +
          (sel.indexOf(c[0]) >= 0 ? " checked" : "") + '>' +
          '<b>' + esc(c[0]) + "</b><span>" + esc(c[1]) + "</span></label>";
      }).join("") + "</div></div>";
  }).join("");
}
function fplFlat(name, list, sel) {
  return fplBoxes(name, [{ g: "", c: list }], sel);
}

function pageFplan() {
  var v = FPL_SAMPLES.train.v;
  var items = [{ id: "fp-what", t: "What this is, and what it is not" },
               { id: "fp-form", t: "Build the flight plan" },
               { id: "fp-out", t: "The message" },
               { id: "fp-nav", t: "Where each box comes from on your nav log" },
               { id: "fp-sample", t: "A worked example" },
               { id: "fp-file", t: "Where you actually file it" }];
  var h = '<div class="crumb no-print"><a href="' + here("") + '">Start</a> <span>›</span> ' +
    '<a href="' + here("tools") + '">Useful resources</a> <span>›</span> <span>ICAO flight plan</span></div>' +
    '<div class="eyebrow no-print">FAA Form 7233-4</div>' +
    '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">ICAO flight plan</h1>' +
    '<p class="lede no-print">Fill it in here and watch the message assemble itself, box by box, ' +
    "with every code explained and the common filing errors caught before you send it. " +
    "The ICAO form is the only flight plan form the FAA accepts — the old domestic 7233-1 " +
    "was retired — so this is the one to learn.</p>" +
    '<div class="no-print">' + toc(items) + "</div>";

  h += '<section class="blk" id="fp-what"><h2>What this is, and what it is not</h2>' +
    '<div class="note flag"><span class="lbl">This does not file anything</span>' +
    "This builds the message and hands you a text file, for practice and for teaching. " +
    "<b>Nothing here is transmitted to anyone.</b> A real flight plan is filed with a Flight " +
    "Service provider — the links are at the bottom of this page — and until one of them " +
    "accepts it, you have not filed a flight plan. Filing also does not open it: a VFR plan has " +
    "to be activated with Flight Service after departure, and closed on arrival, or somebody " +
    "will come looking for you.</div>" +
    '<div class="note"><span class="lbl">Why the ICAO form, for a domestic training flight</span>' +
    "The FAA moved all flight plan filing to the ICAO format. Every field below is on " +
    "<b>FAA Form 7233-4</b>, and the code tables come from the FAA's own " +
    "<b>ICAO Flight Plan Quick Reference Brochure, version 8, September 2022</b>, " +
    "cross-checked against <b>AIM Appendix 4</b>. Learning it on a training cross-country is " +
    "much easier than learning it the first time you need an international plan.</div></section>";

  h += '<section class="blk" id="fp-form"><h2>Build the flight plan <span class="hint no-print">' +
    "Everything updates as you type</span></h2>" +
    '<div class="fp-actions no-print">' +
    '<button class="btn ghost" id="fpSample">Load the training example</button>' +
    '<button class="btn ghost" id="fpClear">Clear it</button></div>';

  /* ---- items 7, 8, 9 ---- */
  h += '<div class="fp-sec"><div class="fp-sh"><b>Items 7, 8 and 9</b>' +
    "<span>Who you are, how you are flying, and what you are flying</span></div>" +
    '<div class="fp-grid">' +
    fplIn("fp_acid", "Item 7 · Aircraft identification", v.acid, "N4321P",
          "Your registration, no dash. A call sign like NKS123 if you use one.") +
    fplSel("fp_rules", "Item 8 · Flight rules", FPL_RULES, v.rules,
           "Y and Z mean the rules change en route — then the route must say where.") +
    fplSel("fp_type", "Item 8 · Type of flight", FPL_TYPE, v.type, "A training flight is G.") +
    fplIn("fp_num", "Item 9 · Number of aircraft", v.num, "1",
          "Leave blank unless you are filing a formation.") +
    fplIn("fp_actype", "Item 9 · Aircraft type", v.actype, "P28A",
          "The ICAO designator. Archer P28A, Skyhawk C172, Seminole PA44.") +
    fplSel("fp_wake", "Item 9 · Wake turbulence category", FPL_WAKE, v.wake, "") +
    "</div></div>";

  /* ---- item 10 ---- */
  h += '<div class="fp-sec"><div class="fp-sh"><b>Item 10a · Navigation, communication and approach</b>' +
    "<span>What the airplane can actually do, and what you are authorised to use</span></div>" +
    fplBoxes("10a", FPL_10A, v.eq10a) + "</div>";
  h += '<div class="fp-sec"><div class="fp-sh"><b>Item 10b · Surveillance</b>' +
    "<span>One transponder code, plus up to three ADS-B codes</span></div>" +
    fplBoxes("10b", FPL_10B, v.eq10b) + "</div>";

  /* ---- items 13, 15, 16 ---- */
  h += '<div class="fp-sec"><div class="fp-sh"><b>Items 13, 15 and 16</b>' +
    "<span>Where from, how, and where to</span></div>" +
    '<div class="fp-grid">' +
    fplIn("fp_dep", "Item 13 · Departure aerodrome", v.dep, "KFXE",
          "Four letters. A US airport is K plus its three-letter identifier.") +
    fplIn("fp_eobt", "Item 13 · Off-block time (UTC)", v.eobt, "1430",
          "When the airplane MOVES, not when it lifts off. Zulu, four digits.") +
    fplIn("fp_speed", "Item 15 · Cruising speed", v.speed, "N0115",
          "N and four digits for knots true. N0115 is 115 KTAS.") +
    fplIn("fp_level", "Item 15 · Cruising level", v.level, "A060",
          "A060 is 6,000 ft. F310 is FL310. VFR only on a VFR plan.") +
    fplIn("fp_dest", "Item 16 · Destination", v.dest, "KORL", "") +
    fplIn("fp_eet", "Item 16 · Total elapsed time", v.eet, "0125",
          "HHMM, off-block to touchdown. 0125 is 1 h 25 min.") +
    fplIn("fp_alt1", "Item 16 · Alternate", v.alt1, "KSFB",
          "14 CFR 91.169 and the 1-2-3 rule decide whether you need one.") +
    fplIn("fp_alt2", "Item 16 · Second alternate", v.alt2, "", "") +
    "</div>" +
    fplIn("fp_route", "Item 15 · Route", v.route, "DCT PBI DCT MLB DCT ORL",
          "DCT means direct. Name airways, fixes and procedures the way the chart does. " +
          "Do not put the departure or destination airport in the route.", "wide") +
    "</div>";

  /* ---- item 18 ---- */
  h += '<div class="fp-sec"><div class="fp-sh"><b>Item 18 · Other information</b>' +
    "<span>The part that gets filings rejected. R in 10a needs PBN/ here; " +
    "NAV/ here needs Z in 10a.</span></div>" +
    '<div class="fp-sub">PBN/ — performance based navigation, at most 8</div>' +
    fplBoxes("pbn", FPL_PBN, v.pbn) +
    '<div class="fp-sub">NAV/ — other navigation capability</div>' +
    fplFlat("nav", FPL_NAV, v.nav) +
    '<div class="fp-sub">STS/ — special handling</div>' +
    fplFlat("sts", FPL_STS, v.sts || []) +
    '<div class="fp-grid" style="margin-top:14px">' +
    fplSel("fp_per", "PER/ · Approach category", FPL_PER, v.per,
           "From Vref, or 1.3 Vso at max landing weight (14 CFR 97.3). A trainer is A.") +
    fplIn("fp_reg", "REG/ · Registration", v.reg, "N4321P",
          "File this when the call sign is not the registration.") +
    fplIn("fp_dof", "DOF/ · Date of flight", v.dof, "260913",
          "YYMMDD. File it when the plan is for a later day.") +
    fplIn("fp_code", "CODE/ · Mode S address", v.code, "A05ED7",
          "Six hexadecimal characters. It is on your ADS-B paperwork.") +
    fplIn("fp_opr", "OPR/ · Operator", v.opr, "", "When it is not obvious from the call sign.") +
    fplIn("fp_sel", "SEL/ · SELCAL", v.sel, "", "Oceanic HF only.") +
    fplIn("fp_eet18", "EET/ · Boundary times", v.eet18, "",
          "Elapsed time to an FIR boundary, e.g. KZJX0035. International flights.") +
    fplIn("fp_rmk", "RMK/ · Remarks", v.rmk, "TRAINING FLIGHT", "") +
    "</div></div>";

  /* ---- item 19 ---- */
  h += '<div class="fp-sec"><div class="fp-sh"><b>Item 19 · Supplementary information</b>' +
    "<span>Never transmitted with the plan. This is what search and rescue reads if you " +
    "do not arrive — which is exactly why it is worth filling in properly.</span></div>" +
    '<div class="fp-grid">' +
    fplIn("fp_endur", "E/ · Fuel endurance", v.endur, "0430",
          "HHMM of fuel on board. It has to beat the flight time plus your reserve.") +
    fplIn("fp_pob", "P/ · People on board", v.pob, "2", "Or TBN if you do not know yet.") +
    fplIn("fp_colour", "A/ · Aircraft colour and markings", v.colour, "WHITE WITH BLUE STRIPES",
          "How somebody would recognise it from the air.") +
    fplIn("fp_pic", "C/ · Pilot in command", v.pic, "", "The name SAR will look for.") +
    fplIn("fp_tel", "C/ · Contact telephone", v.tel, "", "") +
    "</div>" +
    '<div class="fp-sub">R/ — emergency radio</div>' +
    fplFlat("radio", [["U", "UHF 243.0 MHz"], ["V", "VHF 121.5 MHz"], ["E", "ELT"]], v.radio) +
    '<div class="fp-sub">S/ — survival equipment</div>' +
    fplFlat("surv", [["P", "Polar"], ["D", "Desert"], ["M", "Maritime"], ["J", "Jungle"]], v.surv) +
    '<div class="fp-sub">J/ — life jackets</div>' +
    fplFlat("jackets", [["L", "With lights"], ["F", "Fluorescent"],
                        ["U", "With UHF radio"], ["V", "With VHF radio"]], v.jackets) +
    "</div></section>";

  /* ---- the assembled message ---- */
  h += '<section class="blk" id="fp-out"><h2>The message</h2>' +
    '<div id="fpCheck"></div>' +
    '<div class="fp-outbox"><div class="fp-obh"><b>Items 3 to 18 — the FPL message</b>' +
    '<span class="no-print"><button class="btn sm" id="fpCopy">' + I.copy + " Copy</button>" +
    '<button class="btn sm ghost" id="fpDl">Download</button></span></div>' +
    '<pre class="fp-msg" id="fpMsg"></pre></div>' +
    '<div class="fp-outbox"><div class="fp-obh"><b>Item 19 — supplementary, not transmitted</b></div>' +
    '<pre class="fp-msg sm" id="fpSupp"></pre></div>' +
    '<div id="fpBreak"></div></section>';

  /* ---- nav log correlation ---- */
  h += '<section class="blk" id="fp-nav"><h2>Where each box comes from on your nav log</h2>' +
    '<p class="lede">The flight plan is not extra work. Almost every box is a number you already ' +
    "worked out on the nav log — this is just where it goes. Build the log first, then the " +
    'plan writes itself. <a href="' + here("navlog") + '">Open the nav log</a>.</p>' +
    '<div class="tablewrap"><table class="corr"><thead><tr>' +
    "<th>Flight plan item</th><th>On the nav log</th><th>Watch out</th></tr></thead><tbody>" +
    FPL_CORR.map(function (r) {
      return "<tr><td data-l=\"Flight plan item\"><b>" + esc(r[0]) + "</b></td>" +
        '<td data-l="On the nav log">' + fmt(r[1]) + "</td>" +
        '<td data-l="Watch out">' + fmt(r[2]) + "</td></tr>";
    }).join("") + "</tbody></table></div></section>";

  /* ---- worked example ---- */
  var br = FPL_SAMPLES.brochure;
  h += '<section class="blk" id="fp-sample"><h2>A worked example</h2>' +
    "<p>" + esc(br.note) + "</p>" +
    '<pre class="fp-msg">' + esc(br.raw) + "</pre>" +
    '<div class="sh">Reading it line by line</div><ul class="errs">' +
    FPL_WALK.map(function (x) { return "<li>" + fmt(x) + "</li>"; }).join("") +
    "</ul></section>";

  /* ---- filing ---- */
  h += '<section class="blk" id="fp-file"><h2>Where you actually file it</h2>' +
    '<p class="lede">These are the real filing services. Everything above this line is practice; ' +
    "everything below it is the FAA system.</p>" +
    '<div class="linkgrid">' + FPL_LINKS.map(function (l) {
      return '<a class="lcard" href="' + esc(l[1]) + '" target="_blank" rel="noopener">' +
        "<b>" + esc(l[0]) + "</b><span>" + esc(l[2]) + "</span>" +
        '<i class="mono">' + esc(l[1].replace(/^https?:\/\//, "").split("/")[0]) + "</i></a>";
    }).join("") + "</div>" +
    '<div class="note gold" style="margin-top:18px"><span class="lbl">Filed is not opened</span>' +
    "An <b>IFR</b> flight plan is activated when you receive your clearance and depart. " +
    "A <b>VFR</b> flight plan does nothing at all until you call Flight Service and ask them " +
    "to open it, and it stays open until you close it — landing does not close it, and an " +
    "unclosed VFR plan starts search and rescue about 30 minutes after your ETA. " +
    "<b>Close it on the ground, every time.</b></div></section>";
  return h;
}

/* The correlation table. Left column is the flight plan item, middle is where
   that number already exists on the nav log, right is the mistake people make. */
var FPL_CORR = [
  ["Item 7 · Aircraft identification",
   "The registration in the header of the log.",
   "File it **without the dash**. N123AB, not N123-AB."],
  ["Item 9 · Aircraft type",
   "The type in the header.",
   "The plan wants the **ICAO designator** (P28A), not what you call it (Archer). " +
   "No designator? File **ZZZZ** and add **TYP/** in Item 18."],
  ["Item 13 · Departure and off-block time",
   "The departure airport, and your planned taxi time.",
   "Off-block is when you **start moving**, not when you rotate. Add your taxi estimate. " +
   "And it is **UTC**."],
  ["Item 15 · Cruising speed",
   "The **TAS** column of the log — the cruise TAS you computed from pressure altitude " +
   "and temperature, not the indicated airspeed.",
   "N0115 means 115 knots **true**. Filing your indicated airspeed makes every ATC estimate wrong."],
  ["Item 15 · Cruising level",
   "The planned cruise altitude at the top of the log.",
   "**A060**, not 6000. Three digits in hundreds of feet. Check it is a legal " +
   "IFR altitude for your direction — 14 CFR 91.179."],
  ["Item 15 · Route",
   "The checkpoint column, minus the departure and destination airports.",
   "Name the fixes and airways the way the **chart** names them. Every visual checkpoint " +
   "on your log that is not a real navigation fix comes **out** — ATC cannot use " +
   "“the water tower”."],
  ["Item 16 · Total elapsed time",
   "The **total time en route** at the bottom of the log.",
   "Off-block to touchdown, so add taxi at both ends. This is the number search and " +
   "rescue starts its clock from."],
  ["Item 16 · Alternate",
   "The alternate you planned, with its own leg on the log.",
   "The **1-2-3 rule** (14 CFR 91.169): from 1 hour before to 1 hour after your ETA, " +
   "if the ceiling is below 2,000 ft or visibility below 3 SM, you need one. And the " +
   "alternate has to meet its **own** weather minimums."],
  ["Item 18 · PBN/",
   "Not on the log — it comes from the airplane's equipment list and your own " +
   "operating authorisations.",
   "**R in Item 10a and PBN/ in Item 18 always travel together.** One without the other " +
   "is the most common ICAO filing error there is."],
  ["Item 19 · E/ endurance",
   "The **total fuel on board** converted to time at your planned burn — the fuel " +
   "block of the log.",
   "Endurance is **all** the fuel, including reserve, expressed as time. It must exceed " +
   "the elapsed time. 14 CFR 91.167 wants 45 minutes at normal cruise beyond the " +
   "alternate for IFR; 91.151 wants 30 minutes day VFR, 45 at night."],
  ["Item 19 · P/ people on board",
   "The weight and balance you already did.",
   "Count **yourself**. This is the number that tells SAR how many people to look for."]
];

var FPL_WALK = [
  "**(FPL-TTT123-IS** — message type FPL, call sign TTT123, **I**FR, **S**cheduled " +
  "air service. A training flight would read **-IG** or **-VG**.",
  "**-C550/L** — one Citation 550, wake category **L**ight.",
  "**-SDE1E2GHIJ3J5RWZ/SB1D1** — Item 10a then Item 10b, separated by the slash. " +
  "**S**tandard, **D**ME, ACARS, **G**NSS, **H**F, **I**NS, two CPDLC types, **R** for PBN " +
  "(so PBN/ must appear in Item 18 — and it does), **W** for RVSM, **Z** for other " +
  "(so NAV/ must appear — and it does). After the slash: Mode **S** transponder, " +
  "**B1** ADS-B out on 1090 MHz, **D1** ADS-C.",
  "**-KPWM1225** — off blocks at Portland at 1225 Zulu.",
  "**-N0440F310 SSOXS5 SSOXS DCT BUZRD …** — 440 knots true at FL310, then the " +
  "route: a departure procedure, its transition, then direct fixes and airways.",
  "**-KJAX0214 KMCO** — Jacksonville, 2 hours 14 minutes, alternate Orlando International.",
  "**-PBN/A1L1B1C1D1O1T1 NAV/Z1 GBAS …** — Item 18. Seven PBN types (the limit is 8), " +
  "then the capabilities that have no PBN code, then data link, surveillance, date of flight, " +
  "registration, SELCAL and the Mode S address.",
  "The closing **)** ends the message. Item 19 is not in it — supplementary information " +
  "is held by the filing service, not transmitted to ATC."
];

var FPL_LINKS = [
  ["Leidos Flight Service", "https://www.1800wxbrief.com/",
   "The FAA's contract Flight Service for the lower 48. File, brief, open and close here, or by calling 1-800-WX-BRIEF."],
  ["FAA flight plan filing guidance", "https://www.faa.gov/about/office_org/headquarters_offices/ato/service_units/air_traffic_services/flight_plan_filing",
   "The FAA's own page on how and where to file, and which service handles which airspace."],
  ["AIM Appendix 4 — FAA Form 7233-4 instructions", "https://www.faa.gov/air_traffic/publications/atpubs/aim_html/appendix_4.html",
   "The authority for every field on this page. If this page and the AIM disagree, the AIM is right."],
  ["FAA Form 7233-4 (the PDF form itself)", "https://www.faa.gov/documentLibrary/media/Form/FAA_Form_7233-4_International_Flight_Plan.pdf",
   "The paper form, laid out exactly as the boxes above."],
  ["ICAO flight plan quick reference brochure", "https://www.faa.gov/air_traffic/publications/media/faa_icao_flight_plan_brochure.pdf",
   "The FAA's own two-page code sheet. Worth printing and keeping in your flight bag."],
  ["Alaska — Flight Service", "https://www.faa.gov/air_traffic/flight_info/flight_service",
   "Alaska is served by FAA Flight Service stations rather than the Leidos contract."]
];

/* ---------------------------------------------------------------------------
   Wiring: recompute on any change, render the message, the field breakdown
   and the validation list.
   ------------------------------------------------------------------------ */
function fplRender() {
  var d = fplValue(), b = fplBuild(d), probs = fplCheck(d);
  var msg = el("fpMsg"); if (msg) msg.textContent = b.fpl;
  var sup = el("fpSupp");
  if (sup) sup.textContent = b.supp || "(nothing filled in yet)";

  var c = el("fpCheck");
  if (c) {
    if (!probs.length) {
      c.innerHTML = '<div class="note"><span class="lbl">Nothing obviously wrong</span>' +
        "Every field this page knows how to check looks right. That is not the same as " +
        "the plan being <b>correct</b> — only you can confirm the route, the altitude and " +
        "the alternate are the ones you actually want.</div>";
    } else {
      var bads = probs.filter(function (p) { return p.lvl === "bad"; });
      c.innerHTML = '<div class="note ' + (bads.length ? "flag" : "gold") + '"><span class="lbl">' +
        (bads.length ? bads.length + " thing" + (bads.length === 1 ? "" : "s") + " ATC would reject"
                     : "Worth a second look") + "</span>" +
        '<ul class="fp-probs">' + probs.map(function (p) {
          return '<li class="' + p.lvl + '"><b>' + esc(p.m) + "</b>" +
            (p.why ? "<span>" + fmt(p.why) + "</span>" : "") + "</li>";
        }).join("") + "</ul></div>";
    }
  }

  /* field-by-field breakdown of the line that was built */
  var bk = el("fpBreak");
  if (bk) {
    var names = ["Items 7 and 8 — identification, rules, type of flight",
                 "Items 9 and 10 — aircraft and equipment",
                 "Item 13 — departure and off-block time",
                 "Item 15 — speed, level, route",
                 "Item 16 — destination, elapsed time, alternates",
                 "Item 18 — other information"];
    bk.innerHTML = '<div class="sh">The message, field by field</div><div class="fp-break">' +
      b.items.map(function (line, i) {
        return '<div class="fp-br"><span class="fp-brn">' + esc(names[i] || "") + "</span>" +
          '<code>' + esc(line) + "</code></div>";
      }).join("") + "</div>";
  }
}

function fplFill(v) {
  function set(id, val) { var n = el(id); if (n) n.value = val == null ? "" : val; }
  set("fp_acid", v.acid); set("fp_rules", v.rules); set("fp_type", v.type);
  set("fp_num", v.num); set("fp_actype", v.actype); set("fp_wake", v.wake);
  set("fp_dep", v.dep); set("fp_eobt", v.eobt); set("fp_speed", v.speed);
  set("fp_level", v.level); set("fp_route", v.route); set("fp_dest", v.dest);
  set("fp_eet", v.eet); set("fp_alt1", v.alt1); set("fp_alt2", v.alt2);
  set("fp_per", v.per); set("fp_reg", v.reg); set("fp_dof", v.dof);
  set("fp_code", v.code); set("fp_opr", v.opr); set("fp_sel", v.sel);
  set("fp_rmk", v.rmk); set("fp_eet18", v.eet18);
  set("fp_endur", v.endur); set("fp_pob", v.pob); set("fp_colour", v.colour);
  set("fp_pic", v.pic); set("fp_tel", v.tel);
  [["10a", v.eq10a], ["10b", v.eq10b], ["pbn", v.pbn], ["nav", v.nav], ["sts", v.sts],
   ["radio", v.radio], ["surv", v.surv], ["jackets", v.jackets]].forEach(function (pair) {
    var want = pair[1] || [];
    var ns = document.querySelectorAll('input[data-fpl="' + pair[0] + '"]');
    for (var i = 0; i < ns.length; i++) {
      ns[i].checked = want.indexOf(ns[i].value) >= 0;
      ns[i].closest(".fp-b").classList.toggle("on", ns[i].checked);
    }
  });
  fplRender();
}

function wireFplan() {
  var host = el("main");
  if (!host || !el("fpMsg")) return;

  host.addEventListener("input", function (e) {
    if (e.target.closest("#fp-form")) fplRender();
  });
  host.addEventListener("change", function (e) {
    var b = e.target.closest(".fp-b");
    if (b) b.classList.toggle("on", e.target.checked);
    if (e.target.closest("#fp-form")) fplRender();
  });

  var s = el("fpSample");
  if (s) s.addEventListener("click", function () { fplFill(FPL_SAMPLES.train.v); });
  var cl = el("fpClear");
  if (cl) cl.addEventListener("click", function () {
    fplFill({ acid: "", rules: "", type: "", num: "", actype: "", wake: "",
              eq10a: [], eq10b: [], dep: "", eobt: "", speed: "", level: "", route: "",
              dest: "", eet: "", alt1: "", alt2: "", pbn: [], nav: [], sts: [],
              per: "", reg: "", dof: "", opr: "", code: "", sel: "", rmk: "", eet18: "",
              endur: "", pob: "", radio: [], surv: [], jackets: [],
              colour: "", pic: "", tel: "" });
  });
  var cp = el("fpCopy");
  if (cp) cp.addEventListener("click", function () {
    var b = fplBuild();
    copyText(b.fpl + (b.supp ? "\n\nItem 19 (supplementary, not transmitted)\n" + b.supp : ""), cp);
  });
  var dl = el("fpDl");
  if (dl) dl.addEventListener("click", function () {
    var d = fplValue(), b = fplBuild(d);
    var txt = "ICAO FLIGHT PLAN — FAA Form 7233-4\n" +
      "Built for practice with the ACS Reference site. NOT FILED WITH ANYONE.\n" +
      "Generated " + new Date().toISOString().slice(0, 16).replace("T", " ") + "Z\n\n" +
      "FPL MESSAGE (Items 3 to 18)\n" + b.fpl + "\n\n" +
      "ITEM 19 — SUPPLEMENTARY INFORMATION (not transmitted with the plan)\n" +
      (b.supp || "(empty)") + "\n\n" +
      "To actually file this, use a Flight Service provider:\n" +
      "  https://www.1800wxbrief.com/   or call 1-800-WX-BRIEF\n";
    var blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "flight-plan-" + ((d.dep || "ZZZZ") + "-" + (d.dest || "ZZZZ")).toLowerCase() + ".txt";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  });
  fplRender();
}


  /* ========== HOLDING AND CDI TRAINERS ========== */
  /* ============================================================================
   Two interactive trainers for the instrument material.  Injected in the IIFE.

     1. HOLDING  — draw the pattern for any fix, inbound course and heading,
                   and show which entry the 70/110 rule gives you and why.
     2. CDI      — a VOR head and an HSI side by side, showing what each one
                   does for a given radial, OBS setting and aircraft heading,
                   including reverse sensing.

   Both are drawn as inline SVG so they print, scale and work in both themes.
   The geometry is real: the entry sectors are computed from the inbound
   course, not hardcoded, so any combination the reader types is answered
   correctly rather than approximately.
   ========================================================================== */

function hdg360(x) { x = x % 360; return x < 0 ? x + 360 : x; }
/* the signed difference b - a, in (-180, 180] */
function angDiff(a, b) { var d = hdg360(b - a); return d > 180 ? d - 360 : d; }

/* ---------------------------------------------------------------------------
   HOLDING ENTRY

   The three sectors are defined off the INBOUND COURSE. Work in terms of the
   outbound direction of the holding radial, which is what the AIM's diagram is
   actually drawn around:

     inbound course  = the course you fly TO the fix
     radial/outbound = inbound course reversed

   Standard (right turns): looking at the fix with the inbound course pointing
   up, the pattern lies to the RIGHT.
     parallel  sector  110 degrees, on the holding side's opposite
     teardrop  sector   70 degrees
     direct    sector  180 degrees
   Non-standard mirrors it.
   ------------------------------------------------------------------------ */
function holdEntry(inbound, heading, right) {
  /* Work relative to the OUTBOUND direction, because that is the line the
     sectors are built around.

     Standard (right turns), worked with inbound course 360:
       - you cross the fix heading 360 and turn RIGHT, so the pattern lies
         EAST of the inbound track and SOUTH of the fix
       - outbound direction is 180
       - the TEARDROP is flown 30 degrees toward the holding side, which is a
         heading of 150 - anticlockwise of 180 in bearing terms
       - so the 70 degree teardrop sector runs 110 to 180, and the 110 degree
         parallel sector runs 180 to 290

     Derived rather than memorised: the holding side sits ANTICLOCKWISE of the
     outbound direction for right turns, clockwise for left. Getting this
     backwards sends a student confidently into unprotected airspace, so both
     turn directions are checked against worked cases before release. */
  var out = hdg360(inbound + 180);
  var d = angDiff(out, heading);      /* -180..180, + is clockwise of outbound */
  if (!right) d = -d;                 /* mirror the whole picture for left turns */

  var kind, why;
  if (d <= 0 && d >= -70) {
    kind = "Teardrop";
    why = "You are inside the 70\u00b0 teardrop sector, on the holding side of the " +
          "outbound course.";
  } else if (d > 0 && d <= 110) {
    kind = "Parallel";
    why = "You are inside the 110\u00b0 parallel sector, on the non-holding side of the " +
          "outbound course.";
  } else {
    kind = "Direct";
    why = "You are in the 180\u00b0 direct sector \u2014 the largest of the three, which is " +
          "why direct is the entry you fly most often.";
  }
  var edges = [0, -70, 110, 180, -180];
  var near = 999;
  edges.forEach(function (e) { near = Math.min(near, Math.abs(angDiff(e, d))); });
  return { kind: kind, why: why, rel: d, near: near };
}

function holdHow(kind, inbound, right) {
  var turn = right ? "right" : "left";
  var anti = right ? "left" : "right";
  var out = hdg360(inbound + 180);
  if (kind === "Direct") {
    return ["Cross the fix.",
            "Turn " + turn + " onto the outbound heading, roughly " + pad3(out) + "°.",
            "Fly outbound for the timed leg, then turn " + turn + " to intercept the inbound " +
            "course of " + pad3(inbound) + "°.",
            "You are established. Start timing the inbound leg over the fix."];
  }
  if (kind === "Parallel") {
    return ["Cross the fix.",
            "Turn to a heading of " + pad3(out) + "° — parallel to the inbound course, " +
            "on the NON-holding side.",
            "Fly that for one minute.",
            "Turn " + anti + " through more than 180° to intercept the inbound course of " +
            pad3(inbound) + "°, or return direct to the fix.",
            "Cross the fix and you are established in the pattern."];
  }
  /* 30 degrees toward the HOLDING side of outbound - anticlockwise in bearing
     terms for a right-turn pattern, clockwise for a left-turn one */
  var tear = hdg360(out + (right ? -30 : 30));
  return ["Cross the fix.",
          "Turn to a heading of about " + pad3(tear) + "\u00b0 \u2014 30\u00b0 from the " +
          "outbound course, on the holding side, inside the pattern.",
          "Fly that for one minute.",
          "Turn " + turn + " to intercept the inbound course of " + pad3(inbound) + "°.",
          "Cross the fix and you are established."];
}

/* --- the drawing ---------------------------------------------------------- */
function holdSvg(inbound, heading, right, kind) {
  var W = 440, H = 440, cx = W / 2, cy = H / 2;
  /* screen angle for a compass bearing: 0 deg = up, clockwise positive */
  function pt(bearing, r) {
    var a = (bearing - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function P(b, r) { var p = pt(b, r); return p[0].toFixed(1) + "," + p[1].toFixed(1); }

  var out = hdg360(inbound + 180);
  var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="hsvg" role="img" ' +
    'aria-label="Holding pattern diagram">';

  /* the three entry sectors, drawn as pie slices around the fix */
  function sector(from, to, cls) {
    /* from/to are bearings; the wedge sweeps CLOCKWISE from -> to */
    var r = 196;
    var sweep = hdg360(to - from);
    var large = sweep > 180 ? 1 : 0;
    s += '<path class="' + cls + '" d="M ' + cx + " " + cy + " L " + P(from, r) +
      " A " + r + " " + r + " 0 " + large + " 1 " + P(to, r) + ' Z"/>';
  }
  var side = right ? -1 : 1;   /* +x maps to bearing inbound-90 after rotation */

  /* The sectors are regions of AIRSPACE around the fix - where the aircraft
     comes FROM, which is its heading reversed. So they are built around the
     INBOUND course, with the same offsets holdEntry() uses around outbound. */
  if (right) {
    sector(hdg360(inbound - 70), hdg360(inbound), "sec-tear");
    sector(hdg360(inbound), hdg360(inbound + 110), "sec-par");
    sector(hdg360(inbound + 110), hdg360(inbound + 290), "sec-dir");
  } else {
    sector(hdg360(inbound), hdg360(inbound + 70), "sec-tear");
    sector(hdg360(inbound - 110), hdg360(inbound), "sec-par");
    sector(hdg360(inbound + 70), hdg360(inbound + 250), "sec-dir");
  }

  /* compass rose */
  s += '<circle class="rose" cx="' + cx + '" cy="' + cy + '" r="196"/>';
  for (var t = 0; t < 360; t += 30) {
    var a = pt(t, 196), b = pt(t, t % 90 === 0 ? 176 : 186);
    s += '<line class="tick" x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) +
      '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '"/>';
    if (t % 90 === 0) {
      var l = pt(t, 160);
      s += '<text class="rl" x="' + l[0].toFixed(1) + '" y="' + (l[1] + 4).toFixed(1) +
        '">' + ["N", "E", "S", "W"][t / 90] + "</text>";
    }
  }

  /* The racetrack, built with the inbound leg running straight down the page
     into the fix, then rotated so "down the page" becomes the inbound course.

     The INBOUND leg lies ON the holding course and ends AT the fix - that is
     what makes it the holding course. The OUTBOUND leg is the offset one. An
     earlier draft had these the other way round, which drew a pattern that
     looked plausible and was wrong. */
  var legLen = 104, radius = 32;
  var x0 = cx, y0 = cy;                       /* the fix */
  var xo = x0 + side * 2 * radius;            /* the offset outbound track */
  var sweep = right ? 1 : 0;
  var tr = "rotate(" + hdg360(inbound + 180).toFixed(1) + " " + cx + " " + cy + ")";
  var path =
    "M " + x0 + " " + (y0 - legLen) +
    " L " + x0 + " " + y0 +                                     /* inbound, to the fix */
    " A " + radius + " " + radius + " 0 0 " + sweep + " " + xo + " " + y0 +
    " L " + xo + " " + (y0 - legLen) +                           /* outbound */
    " A " + radius + " " + radius + " 0 0 " + sweep + " " + x0 + " " + (y0 - legLen) +
    " Z";
  s += '<g transform="' + tr + '">' +
    '<path class="track" d="' + path + '"/>' +
    /* the inbound leg picked out, because that is the holding course */
    '<path class="track-in" d="M ' + x0 + " " + (y0 - legLen) + " L " + x0 + " " + y0 + '"/>' +
    "</g>";

  /* the inbound course arrow, pointing at the fix */
  var tail = pt(hdg360(inbound + 180), 150);
  s += '<line class="inbound" x1="' + tail[0].toFixed(1) + '" y1="' + tail[1].toFixed(1) +
    '" x2="' + cx + '" y2="' + cy + '" marker-end="url(#hArrow)"/>';

  /* the aircraft, out on the rose, pointing along its heading */
  var ap = pt(hdg360(heading + 180), 150);
  s += '<g transform="translate(' + ap[0].toFixed(1) + " " + ap[1].toFixed(1) +
    ') rotate(' + heading.toFixed(1) + ')">' +
    '<path class="plane" d="M 0 -13 L 3.2 -3 L 15 4 L 15 7 L 3.2 4.4 L 3.2 11 L 7 14 L 7 16 ' +
    'L 0 14 L -7 16 L -7 14 L -3.2 11 L -3.2 4.4 L -15 7 L -15 4 L -3.2 -3 Z"/></g>';

  /* the fix */
  s += '<circle class="fix" cx="' + cx + '" cy="' + cy + '" r="6"/>';
  s += '<defs><marker id="hArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" ' +
    'markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" ' +
    'class="arrowhead"/></marker></defs>';
  s += "</svg>";
  return s;
}

/* ---------------------------------------------------------------------------
   CDI AND HSI

   Given where the airplane actually is (a radial from the station) and what the
   pilot has set, work out what each instrument shows. The point of drawing both
   is that the VOR head and the HSI disagree in exactly one situation - flying
   the course backwards - and that is the situation that kills people.
   ------------------------------------------------------------------------ */

/* deflection in degrees, positive = needle right of centre.
   A VOR CDI reads the angular difference between the SELECTED course and the
   radial you are on, with the TO/FROM flag resolving the ambiguity. */
function cdiState(radial, obs, heading, isLoc, locCourse) {
  var res = {};
  if (isLoc) {
    /* A localizer has no OBS function at all: the needle is driven by where
       you are relative to the published front course, full stop. Turning the
       knob changes nothing. */
    var off = angDiff(locCourse, radial);          /* radial here = your bearing from the antenna */
    res.dev = Math.max(-2.5, Math.min(2.5, off));  /* full scale 2.5 deg each side */
    res.scale = 2.5;
    res.dotDeg = 0.5;                              /* five dots each side */
    res.flag = "";
    /* Reverse sensing: flying the localizer in the opposite direction, the
       needle still points at the course, but the course is now behind you, so
       corrections must be made the other way. */
    res.reverse = Math.abs(angDiff(locCourse, heading)) > 90;
    res.hsiDev = res.dev;
    return res;
  }
  /* VOR: the needle shows the angle from the selected course to your position,
     limited to full scale at 10 degrees. */
  var diff = angDiff(obs, radial);
  var to = Math.abs(diff) > 90;
  res.flag = to ? "TO" : "FROM";
  var ang = to ? angDiff(hdg360(obs + 180), radial) : diff;
  res.dev = Math.max(-10, Math.min(10, ang));
  res.scale = 10;
  res.dotDeg = 2;                                  /* five dots each side */
  /* On a VOR head the needle is the same whichever way you point. On an HSI the
     card turns with the airplane, so the picture stays correct. */
  res.reverse = Math.abs(angDiff(obs, heading)) > 90;
  res.hsiDev = res.dev;
  return res;
}

function cdiSvg(st, obs, heading, kind) {
  var W = 230, H = 230, cx = W / 2, cy = H / 2, R = 96;
  function P(b, r) {
    var a = (b - 90) * Math.PI / 180;
    return (cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1);
  }
  var isHsi = kind === "hsi";
  /* On a VOR head the card rotates with the OBS and the airplane symbol is
     fixed. On an HSI the card shows HEADING and the course arrow sits on it. */
  var cardRot = isHsi ? -heading : -obs;
  var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="csvg" role="img" aria-label="' +
    (isHsi ? "HSI" : "VOR indicator") + '">';
  s += '<circle class="cface" cx="' + cx + '" cy="' + cy + '" r="' + (R + 12) + '"/>';
  s += '<g transform="rotate(' + cardRot.toFixed(1) + " " + cx + " " + cy + ')">';
  s += '<circle class="ccard" cx="' + cx + '" cy="' + cy + '" r="' + R + '"/>';
  for (var tt = 0; tt < 360; tt += 5) {
    var isBig = tt % 30 === 0;
    var a1 = P(tt, R).split(","), b1 = P(tt, isBig ? R - 13 : R - 7).split(",");
    s += '<line class="ctick' + (isBig ? " big" : "") + '" x1="' + a1[0] + '" y1="' + a1[1] +
      '" x2="' + b1[0] + '" y2="' + b1[1] + '"/>';
  }
  /* The numbers sit just inside the tick ring and are counter-rotated so they
     stay upright as the card turns, the way a real card is printed. */
  ["N", "3", "6", "E", "12", "15", "S", "21", "24", "W", "30", "33"].forEach(function (lbl, i) {
    var b = i * 30, p = P(b, R - 27).split(","), px = p[0], py = parseFloat(p[1]);
    s += '<text class="cnum" x="' + px + '" y="' + (py + 3.6).toFixed(1) +
      '" transform="rotate(' + (-cardRot).toFixed(1) + " " + px + " " + py.toFixed(1) + ')">' +
      lbl + "</text>";
  });
  if (isHsi) {
    /* the course arrow rides on the heading card */
    s += '<g transform="rotate(' + obs.toFixed(1) + " " + cx + " " + cy + ')">' +
      '<line class="carrow" x1="' + cx + '" y1="' + (cy - R + 8) + '" x2="' + cx + '" y2="' +
      (cy - 38) + '" marker-end="url(#cA)"/>' +
      '<line class="carrow tail" x1="' + cx + '" y1="' + (cy + 38) + '" x2="' + cx + '" y2="' +
      (cy + R - 8) + '"/>' + cdiDots(cx, cy) + cdiBar(st, cx, cy) + "</g>";
  }
  s += "</g>";
  if (!isHsi) s += cdiBar(st, cx, cy);

  if (!isHsi) s += cdiDots(cx, cy);
  /* the airplane symbol, fixed to the case */
  if (isHsi) {
    s += '<path class="cplane" d="M ' + cx + ' ' + (cy - 16) + ' L ' + (cx + 4) + ' ' + (cy - 4) +
      ' L ' + (cx + 20) + ' ' + (cy + 4) + ' L ' + (cx + 20) + ' ' + (cy + 8) + ' L ' + (cx + 4) +
      ' ' + (cy + 5) + ' L ' + (cx + 4) + ' ' + (cy + 14) + ' L ' + (cx + 9) + ' ' + (cy + 18) +
      ' L ' + (cx + 9) + ' ' + (cy + 21) + ' L ' + cx + ' ' + (cy + 18) + ' L ' + (cx - 9) + ' ' +
      (cy + 21) + ' L ' + (cx - 9) + ' ' + (cy + 18) + ' L ' + (cx - 4) + ' ' + (cy + 14) + ' L ' +
      (cx - 4) + ' ' + (cy + 5) + ' L ' + (cx - 20) + ' ' + (cy + 8) + ' L ' + (cx - 20) + ' ' +
      (cy + 4) + ' L ' + (cx - 4) + ' ' + (cy - 4) + ' Z"/>';
  }
  /* TO / FROM flag */
  /* A real indicator puts the TO/FROM triangle off to one side, clear of the
     needle. Pointing up is TO, down is FROM. */
  if (st.flag) {
    var fx = cx + 52, fy = cy - 6;
    s += '<path class="cflagtri" d="M ' + fx + " " + (fy - 9) + " l 7.5 13 l -15 0 Z\"" +
      (st.flag === "FROM" ? ' transform="rotate(180 ' + fx + " " + (fy - 3) + ')"' : "") + "/>";
    s += '<text class="cflag" x="' + fx + '" y="' + (fy + 22) + '">' + st.flag + "</text>";
  }
  /* the index at the top */
  s += '<path class="cindex" d="M ' + cx + ' ' + (cy - R - 12) + ' l 7 12 l -14 0 Z"/>';
  s += '<defs><marker id="cA" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" ' +
    'markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" ' +
    'class="arrowhead"/></marker></defs></svg>';
  return s;
}
/* Five dots each side, which is what a real course deviation indicator has.
   Full-scale deflection is the fifth dot, so one dot is a fifth of full scale:
   2 degrees on a VOR, half a degree on a localizer. */
var CDI_HALF = 55;
function cdiDots(cx, cy) {
  var out = "";
  for (var d = -5; d <= 5; d++) {
    if (!d) continue;
    out += '<circle class="cdot" cx="' + (cx + d * (CDI_HALF / 5)).toFixed(1) +
      '" cy="' + cy + '" r="2.6"/>';
  }
  return out;
}
function cdiBar(st, cx, cy) {
  var px = cx + (st.dev / st.scale) * CDI_HALF;
  return '<line class="cbar" x1="' + px.toFixed(1) + '" y1="' + (cy - 46) + '" x2="' +
    px.toFixed(1) + '" y2="' + (cy + 46) + '"/>';
}

/* ---------------------------------------------------------------------------
   The page
   ------------------------------------------------------------------------ */
/* Scenarios, not answers.
   These used to be NAMED for the entry they were supposed to produce, and every
   one of the five names was wrong: the data was written against an earlier,
   incorrect holdEntry() and never re-checked after the geometry was fixed. So
   the name is now the SITUATION and the entry on the button is computed by
   holdEntry() at render time. It cannot drift from the answer again, because it
   is the answer. */
var HOLD_PRESETS = [
  { n: "Already on the inbound course", ib: 270, hd: 270, r: true,
    t: "You are tracking 270 to the fix and the hold is on that same course. The simplest arrival there is." },
  { n: "Arriving from the right", ib: 360, hd: 270, r: true,
    t: "Inbound course 360, but you are heading 270 when you reach the fix. Standard right turns." },
  { n: "The same arrival, left turns", ib: 360, hd: 270, r: false,
    t: "Identical to the one before it except the turns are left. Compare the two: everything mirrors, including the entry." },
  { n: "Arriving from the left", ib: 360, hd: 130, r: true,
    t: "Same hold, but you reach the fix heading 130. Standard right turns." },
  { n: "Right on the 70-degree line", ib: 360, hd: 110, r: true,
    t: "Exactly on the boundary. The AIM allows about 5 degrees of judgement here, so either of the two neighbouring entries is defensible." }
];

var CDI_PRESETS = [
  { n: "On course, tracking", rad: 90,  obs: 270, hd: 270, loc: false,
    t: "Established inbound on the 090 radial with 270 set. Needle centred, TO flag." },
  { n: "Left of course",      rad: 95,  obs: 270, hd: 270, loc: false,
    t: "Five degrees off. The needle is right — fly toward it." },
  { n: "Reverse sensing",     rad: 95,  obs: 270, hd: 90,  loc: false,
    t: "Same position, but pointed the other way. The VOR head has not changed. " +
       "The HSI has. This is the whole argument for an HSI." },
  { n: "Localizer, front course", rad: 271, obs: 270, hd: 270, loc: true,
    t: "One degree right of the localizer. Note how much more sensitive it is." },
  { n: "Localizer, back course",  rad: 271, obs: 270, hd: 90,  loc: true,
    t: "Flying the back course with the front course set. Reverse sensing on the CDI." }
];

function pageInstr(which) {
  var isCdi = which === "cdi";
  var items = isCdi
    ? [{ id: "in-try", t: "Try it" }, { id: "in-read", t: "How to read it" },
       { id: "in-rev", t: "Reverse sensing" }, { id: "in-scale", t: "How much is a dot worth" }]
    : [{ id: "in-try", t: "Try it" }, { id: "in-rule", t: "The 70/110 rule" },
       { id: "in-fly", t: "Flying the entry" }, { id: "in-num", t: "The numbers" }];
  var h = '<div class="crumb no-print"><a href="' + here("") + '">Start</a> <span>›</span> ' +
    '<a href="' + here("tools") + '">Useful resources</a> <span>›</span> <span>' +
    (isCdi ? "CDI and HSI" : "Holding entries") + "</span></div>" +
    '<div class="eyebrow no-print">Instrument flying</div>' +
    "<h1 style=\"font-size:clamp(24px,4.4vw,34px);margin-bottom:12px\">" +
    (isCdi ? "What the needle is telling you" : "Holding pattern entries") + "</h1>" +
    '<p class="lede no-print">' + (isCdi
      ? "A VOR head and an HSI, side by side, fed the same situation. Change where you are, " +
        "what you have set and which way you are pointing, and watch what each instrument does " +
        "— including the one case where they disagree."
      : "Set the fix, the inbound course and your heading, and the diagram draws the pattern " +
        "and tells you which entry the rule gives you, and why. The sectors are computed, not " +
        "memorised, so any combination you type is answered properly.") + "</p>" +
    '<div class="no-print">' + toc(items) + "</div>";

  h += '<section class="blk" id="in-try"><h2>Try it</h2>';
  if (isCdi) {
    h += '<div class="in-ctl">' +
      inNum("c_rad", "Your radial FROM the station", 95, 0, 359) +
      inNum("c_obs", "Course selected (OBS)", 270, 0, 359) +
      inNum("c_hd", "Aircraft heading", 270, 0, 359) +
      '<label class="in-chk"><input type="checkbox" id="c_loc"> Localizer instead of a VOR</label>' +
      "</div>" +
      '<div class="in-presets">' + CDI_PRESETS.map(function (p, i) {
        return '<button class="pill" data-cpre="' + i + '">' + esc(p.n) + "</button>";
      }).join("") + "</div>" +
      '<div id="cdiOut"></div>';
  } else {
    h += '<div class="in-ctl">' +
      inNum("h_ib", "Inbound course to the fix", 270, 0, 359) +
      inNum("h_hd", "Your heading approaching the fix", 90, 0, 359) +
      '<label class="in-chk"><input type="checkbox" id="h_left"> Left turns (non-standard)</label>' +
      "</div>" +
      '<div class="in-presets">' + HOLD_PRESETS.map(function (p, i) {
        var k = holdEntry(p.ib, p.hd, p.r).kind;
        return '<button class="pill" data-hpre="' + i + '">' + esc(p.n) +
          '<i class="pk">' + esc(k) + "</i></button>";
      }).join("") + "</div>" +
      '<div id="holdOut"></div>';
  }
  h += "</section>";

  if (isCdi) {
    h += '<section class="blk" id="in-read"><h2>How to read it</h2><ul class="errs">' +
      ["**The needle is the course, not the airplane.** The bar shows you where the selected " +
       "course is relative to you. If it sits to the right, the course is to your right.",
       "**Fly toward the needle** — as long as you are pointed roughly along the course. " +
       "That qualifier is the whole of reverse sensing, and it is below.",
       "**TO and FROM is not about where you are going.** It tells you whether the course you " +
       "have selected would take you toward the station or away from it. You can be flying " +
       "away from a VOR with a TO flag showing — it just means you have the reciprocal set.",
       "**On an HSI the card turns with the airplane**, so the picture always matches what you " +
       "see out of the window. On a plain VOR head the card only turns when you turn the OBS.",
       "**A localizer ignores the OBS completely.** Turning the knob does nothing to the needle. " +
       "You set the front course on it only so that you, the pilot, can see which way is which."
      ].map(function (x) { return "<li>" + fmt(x) + "</li>"; }).join("") + "</ul></section>";
    h += '<section class="blk" id="in-rev"><h2>Reverse sensing</h2>' +
      '<div class="note flag"><span class="lbl">When the needle lies to you</span>' +
      "A course deviation needle shows where the course is <b>in space</b>. It does not know " +
      "which way the airplane is pointed. Fly along the selected course and left of course puts " +
      "the needle right, which is what you expect. Fly the <b>opposite</b> direction along the " +
      "same course and you are still left of it in space — but now your left is the other " +
      "way, so the needle appears on the wrong side.<br><br>" +
      "It bites in two places: flying a <b>back course</b> localizer with the front course set, " +
      "and flying a VOR radial <b>outbound</b> with the inbound course still in the window. " +
      "<b>The cure is the same for both: set the course you are actually flying.</b> " +
      "An HSI does it for you, because the course arrow sits on a card that turns with the " +
      "airplane — press the presets above and watch the two instruments disagree.</div></section>";
    h += '<section class="blk" id="in-scale"><h2>How much is a dot worth</h2>' +
      '<div class="tablewrap"><table class="corr"><thead><tr><th>Guidance</th>' +
      "<th>Full scale</th><th>One dot</th><th>At 10 NM, one dot is about</th></tr></thead><tbody>" +
      [["VOR", "10° each side", "2°", "2,100 ft"],
       ["Localizer", "2.5° each side", "0.5°", "530 ft"],
       ["Glideslope", "0.7° each side", "0.14°", "150 ft"],
       ["GPS en route", "5 NM each side", "1 NM", "1 NM — it is linear, not angular"],
       ["GPS terminal", "1 NM each side", "0.2 NM", "0.2 NM"],
       ["GPS approach (LNAV)", "0.3 NM each side", "0.06 NM", "0.06 NM"]
      ].map(function (r) {
        return "<tr>" + r.map(function (c, i) {
          return '<td data-l="' + ["Guidance", "Full scale", "One dot", "At 10 NM"][i] + '">' +
            (i === 0 ? "<b>" + esc(c) + "</b>" : esc(c)) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="v-note">The angular figures are from the Instrument Flying Handbook ' +
      "FAA-H-8083-15B chapter 9 and AIM 1-1-9. The distances are arithmetic from those angles, " +
      "shown so the scale is easier to feel — they are not FAA-published numbers. " +
      "GPS sensitivity is linear rather than angular, which is why a GPS needle does not get " +
      "more sensitive as you close in the way a localizer does; the receiver switches scales " +
      "instead.</p></section>";
  } else {
    h += '<section class="blk" id="in-rule"><h2>The 70/110 rule</h2>' +
      "<p>Stand at the fix and look along the <b>outbound</b> direction of the holding course. " +
      "The circle around you divides into three, and which third you arrive from decides the " +
      "entry:</p><ul class=\"errs\">" +
      ["**70 degrees** on the holding side is the **teardrop** sector — the narrow one.",
       "**110 degrees** on the non-holding side is the **parallel** sector.",
       "The remaining **180 degrees** is the **direct** sector, which is why direct is the " +
       "entry you fly most often.",
       "For a **left-turn** pattern the whole picture mirrors. Nothing else changes.",
       "Near a boundary, AIM 5-3-8 asks only that you enter *within allowable good operating " +
       "limits*. Either entry works; fly the one you can do cleanly rather than arguing with " +
       "yourself about five degrees."
      ].map(function (x) { return "<li>" + fmt(x) + "</li>"; }).join("") + "</ul>" +
      '<div class="note"><span class="lbl">A shortcut that actually works</span>' +
      "Point your thumb along the inbound course on the heading indicator. The parallel and " +
      "teardrop sectors are the two small ones behind the fix; everything in front is direct. " +
      "If you can picture which side the pattern is on, you can work out the entry without " +
      "any arithmetic at all — and the diagram above is there to build that picture.</div>" +
      "</section>";
    h += '<section class="blk" id="in-num"><h2>The numbers</h2><ul class="errs">' +
      ["**Inbound leg timing**: one minute at or below 14,000 ft MSL, one and a half minutes " +
       "above (AIM 5-3-8). The **inbound** leg is the one you time to; the outbound leg gets " +
       "adjusted to make the inbound come out right.",
       "**Outbound timing starts** over or abeam the fix, **whichever happens later**. If you " +
       "cannot tell when you are abeam, start timing when the turn to outbound is complete.",
       "**Maximum holding airspeed** (AIM 5-3-8): 200 KIAS up to 6,000 ft; 230 KIAS from 6,001 " +
       "to 14,000 ft; 265 KIAS above 14,000 ft. A trainer never gets near these — but you " +
       "will be asked.",
       "**DME and RNAV holds** are measured in distance, not time. The leg length is on the " +
       "chart or in the clearance, and there is nothing to time.",
       "**EFC** is the expect-further-clearance time. It is what you fly to if you lose " +
       "communications — hold until it, then continue. Without one, you have a problem " +
       "worth thinking about on the ground rather than in the air.",
       "**Standard is right turns.** If nothing says otherwise, turn right. A non-standard " +
       "pattern is charted, or ATC says “left turns” in the clearance."
      ].map(function (x) { return "<li>" + fmt(x) + "</li>"; }).join("") + "</ul></section>";
    h += '<section class="blk" id="in-fly"><h2>Flying the entry</h2><div id="holdSteps"></div>' +
      '<div class="note gold"><span class="lbl">What the evaluator is actually watching</span>' +
      "Not whether you picked the textbook entry. They are watching whether you <b>end up " +
      "established in the correct pattern at the correct altitude</b>, and whether you knew " +
      "what you were doing while you got there. A tidy direct entry flown from the parallel " +
      "sector is a discussion. A pattern flown on the wrong side of the fix is a failure, " +
      "because it is where the protected airspace is not.</div></section>";
  }
  return h;
}
function inNum(id, label, val, min, max) {
  return '<label class="in-f"><span>' + esc(label) + "</span>" +
    '<input id="' + id + '" type="number" inputmode="numeric" min="' + min + '" max="' + max +
    '" step="1" value="' + val + '"></label>';
}

/* ---- rendering and wiring ------------------------------------------------ */
function renderHold() {
  var ib = hdg360(parseInt(num0("h_ib"), 10)), hd = hdg360(parseInt(num0("h_hd"), 10));
  var right = !(el("h_left") || {}).checked;
  var e = holdEntry(ib, hd, right);
  var box = el("holdOut"); if (!box) return;
  box.innerHTML =
    '<div class="in-split"><div class="in-dia">' + holdSvg(ib, hd, right, e.kind) +
    '<div class="in-key"><span class="k-tear">Teardrop 70°</span>' +
    '<span class="k-par">Parallel 110°</span><span class="k-dir">Direct 180°</span></div>' +
    "</div>" +
    '<div class="in-ans"><div class="in-big ' + e.kind.toLowerCase() + '">' + esc(e.kind) +
    " entry</div>" +
    "<p>" + esc(e.why) + "</p>" +
    '<div class="in-facts">' +
    inFact("Inbound course", pad3(ib) + "°") +
    inFact("Outbound heading", pad3(hdg360(ib + 180)) + "°") +
    inFact("Turns", right ? "Right — standard" : "Left — non-standard") +
    inFact("Your heading", pad3(hd) + "°") +
    "</div>" +
    (e.near <= 5
      ? '<div class="note gold" style="margin-top:12px"><span class="lbl">You are on a boundary</span>' +
        "This is within " + r0(e.near) + "° of the edge of the sector. AIM 5-3-8 asks only " +
        "that the entry be made <i>within allowable good operating limits</i>, so either " +
        "adjacent entry is acceptable. Fly the one you can do cleanly.</div>"
      : "") +
    "</div></div>";
  var st = el("holdSteps");
  if (st) {
    st.innerHTML = "<p>For the situation set above — a <b>" + esc(e.kind.toLowerCase()) +
      "</b> entry:</p><ol class=\"flow\">" +
      holdHow(e.kind, ib, right).map(function (x) { return "<li>" + fmt(x) + "</li>"; }).join("") +
      "</ol>";
  }
}
function inFact(k, v) {
  return '<div class="in-fact"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>";
}
function num0(id) { var n = el(id); var v = parseInt((n || {}).value, 10); return isNaN(v) ? 0 : v; }

function renderCdi() {
  var rad = hdg360(num0("c_rad")), obs = hdg360(num0("c_obs")), hd = hdg360(num0("c_hd"));
  var loc = !!(el("c_loc") || {}).checked;
  var st = cdiState(rad, obs, hd, loc, obs);
  var box = el("cdiOut"); if (!box) return;
  var dots = Math.abs(st.dev) / st.dotDeg;
  var side = Math.abs(st.dev) < 0.05 ? "centred"
    : (st.dev > 0 ? "right of centre" : "left of centre");
  var advice;
  if (Math.abs(st.dev) < 0.05) {
    advice = "You are on the course. Hold what you have.";
  } else if (st.reverse) {
    advice = "The needle is " + side + ", but you are flying this course <b>backwards</b>, " +
      "so on the VOR head you must turn <b>away</b> from the needle. On the HSI the picture " +
      "is already correct — turn toward the bar.";
  } else {
    advice = "The course is to your " + (st.dev > 0 ? "right" : "left") +
      ". Turn toward the needle.";
  }
  box.innerHTML =
    '<div class="in-cdis">' +
    '<figure class="in-inst"><figcaption>VOR indicator</figcaption>' + cdiSvg(st, obs, hd, "vor") +
    "</figure>" +
    '<figure class="in-inst"><figcaption>HSI</figcaption>' + cdiSvg(st, obs, hd, "hsi") +
    "</figure></div>" +
    '<div class="in-facts">' +
    inFact(loc ? "Bearing from the antenna" : "Radial you are on", pad3(rad) + "°") +
    inFact(loc ? "Front course" : "Course selected", pad3(obs) + "°") +
    inFact("Heading", pad3(hd) + "°") +
    inFact("Deflection", r1(Math.abs(st.dev)) + "° " + side) +
    inFact("In dots", r1(dots) + (dots >= 4.99 ? " — full scale" : "") +
      "  (1 dot = " + st.dotDeg + "°)") +
    (st.flag ? inFact("Flag", st.flag) : "") +
    "</div>" +
    '<div class="note' + (st.reverse ? " flag" : "") + '" style="margin-top:14px">' +
    '<span class="lbl">' + (st.reverse ? "Reverse sensing" : "What to do about it") + "</span>" +
    advice + (loc ? "<br><br>This is a <b>localizer</b>: the course knob does nothing to the " +
      "needle at all. Setting the front course is purely so you can see which way is which." : "") +
    "</div>";
}

function wireInstr(which) {
  var host = el("main"); if (!host) return;
  if (which === "cdi") {
    if (!el("cdiOut")) return;
    host.addEventListener("input", function (e) {
      if (e.target.closest(".in-ctl")) renderCdi();
    });
    host.addEventListener("change", function (e) {
      if (e.target.closest(".in-ctl")) renderCdi();
    });
    host.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cpre]");
      if (!b) return;
      var p = CDI_PRESETS[parseInt(b.getAttribute("data-cpre"), 10)];
      el("c_rad").value = p.rad; el("c_obs").value = p.obs;
      el("c_hd").value = p.hd; el("c_loc").checked = p.loc;
      renderCdi();
      var n = el("cdiOut");
      if (n) n.insertAdjacentHTML("afterbegin", '<div class="note" style="margin-bottom:14px">' +
        '<span class="lbl">' + esc(p.n) + "</span>" + esc(p.t) + "</div>");
    });
    renderCdi();
    return;
  }
  if (!el("holdOut")) return;
  host.addEventListener("input", function (e) { if (e.target.closest(".in-ctl")) renderHold(); });
  host.addEventListener("change", function (e) { if (e.target.closest(".in-ctl")) renderHold(); });
  host.addEventListener("click", function (e) {
    var b = e.target.closest("[data-hpre]");
    if (!b) return;
    var p = HOLD_PRESETS[parseInt(b.getAttribute("data-hpre"), 10)];
    el("h_ib").value = p.ib; el("h_hd").value = p.hd; el("h_left").checked = !p.r;
    renderHold();
    var n = el("holdOut");
    if (n) n.insertAdjacentHTML("afterbegin", '<div class="note" style="margin-bottom:14px">' +
      '<span class="lbl">' + esc(p.n) + "</span>" + esc(p.t) + "</div>");
  });
  renderHold();
}


  /* ============================================================================
   INSTRUMENT PROFICIENCY CHECK

   Two things live here and they are deliberately separate:

     1. A reference page for 14 CFR 61.57(c) and (d) - what keeps you current,
        what happens when it lapses, and who may give the check.
     2. A CHECKLIST built from the IPC table in FAA-S-ACS-8C Appendix 2, meant
        to be ticked WHILE the check is being flown, on a phone or a tablet.
        Progress is kept in localStorage so a check split across two flights
        picks up where it stopped.

   The checklist is generated from the ACS itself rather than typed out, so if
   the parsed ACS changes the checklist changes with it. The one hand-written
   part is the note explaining that Area VII tasks B and C are multiengine
   tasks and do not apply to a single-engine airplane check.
   ========================================================================== */

var IPC_KEY = "acs.ipc.v1";
var IPC = {};
try { IPC = JSON.parse(localStorage.getItem(IPC_KEY) || "{}"); } catch (e) { IPC = {}; }
function ipcSave() { try { localStorage.setItem(IPC_KEY, JSON.stringify(IPC)); } catch (e) { } }

/* Which tasks the IPC covers, read out of the guide's own rating tables so it
   cannot drift away from the document. Returns [{roman, title, tasks:[...]}]. */
function ipcSpec() {
  var tbl = (G && G.ratings || []).filter(function (t) {
    return /instrument proficiency check/i.test(t.title || "");
  })[0];
  if (!tbl) return null;
  var out = [];
  tbl.rows.forEach(function (r) {
    var a = areaOf(r.area); if (!a) return;
    var req = (r.req || []).join(",").trim();
    if (!req || /^none$/i.test(req)) return;
    var letters;
    if (/^all$/i.test(req)) letters = a.tasks.map(function (t) { return t.letter; });
    else letters = req.split(/[,\s]+/).filter(Boolean);
    var tasks = [];
    letters.forEach(function (L) {
      var t = a.tasks.filter(function (x) { return x.letter === L; })[0];
      /* A letter in the table with no task in THIS guide is a task that belongs
         to another class - VII.B and VII.C are AMEL and AMES. Carry it through
         as a flagged row rather than dropping it silently, because a reader
         comparing this list against the ACS page must be able to see why the
         two differ. */
      tasks.push(t ? { letter: L, title: t.title, here: true }
                   : { letter: L, title: ipcOtherTask(r.area, L), here: false });
    });
    out.push({ roman: r.area, title: a.title, tasks: tasks, raw: req });
  });
  return out;
}
/* The two Area VII tasks that exist in FAA-S-ACS-8C but not in an ASEL guide. */
var IPC_OTHER = {
  "VII.B": "One Engine Inoperative (Simulated) during Straight-and-Level Flight and Turns",
  "VII.C": "Instrument Approach and Landing with an Inoperative Engine (Simulated)"
};
function ipcOtherTask(roman, L) { return IPC_OTHER[roman + "." + L] || "Task " + L; }

function ipcRows(spec) {
  var out = [];
  spec.forEach(function (a) {
    a.tasks.forEach(function (t) {
      if (t.here) out.push(a.roman + "." + t.letter);
    });
  });
  return out;
}
function ipcCount(spec) {
  var ids = ipcRows(spec), done = 0;
  ids.forEach(function (id) { if (IPC[id]) done++; });
  return { done: done, total: ids.length };
}

/* ---------------------------------------------------------------- the page */
function pageIpc() {
  var m = guideMeta(G.slug) || {}, spec = ipcSpec();
  var items = [
    { id: "when", t: "When do I need one?" },
    { id: "current", t: "61.57(c) — what keeps you current" },
    { id: "check", t: "61.57(d) — the check itself" },
    { id: "list", t: "The checklist — tick it as you fly" },
    { id: "endo", t: "The endorsement, word for word" },
    { id: "after", t: "After the check" }
  ];

  var h = '<div class="crumb"><a href="' + here("") + '">' + esc(m.short) +
    '</a> <span>›</span> <span>Instrument proficiency check</span></div>' +
    '<div class="eyebrow">14 CFR 61.57(c) and (d) · FAA-S-ACS-8C Appendix 2</div>' +
    '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Instrument proficiency check</h1>' +
    '<p class="lede">An IPC is not a punishment and it is not a checkride. It is the way back to legal ' +
    'instrument currency once too much time has passed, and the standard it is flown to is this ACS — ' +
    'the same document the rating was earned against. The tasks are fixed by ' +
    '<b>Appendix 2</b>, and they are listed further down as a checklist you can tick off in the airplane.</p>' +
    toc(items);

  /* ------------------------------------------------------------ when ---- */
  h += '<section class="blk" id="when"><h2>When do I need one? <span class="hint">' +
    'Six months, then six more, then the check</span></h2>' +
    '<div class="ipc-line">' +
    '<div class="ipc-step ok"><b>Months 1–6</b><span>You performed the 61.57(c) tasks. You are current ' +
    'and may act as pilot in command under IFR.</span></div>' +
    '<div class="ipc-step warn"><b>Months 7–12</b><span>Currency has lapsed. You may not act as pilot in ' +
    'command under IFR — but you may still regain currency by performing the 61.57(c) tasks, in simulated ' +
    'conditions with a safety pilot or in an approved device. No IPC is required yet.</span></div>' +
    '<div class="ipc-step bad"><b>After 12 months</b><span>61.57(d): a person who has failed to meet the ' +
    '61.57(c) requirements for more than six calendar months may reestablish instrument currency ' +
    '<b>only</b> by completing an instrument proficiency check.</span></div>' +
    "</div>" + ipcCalcHtml() +
    '<div class="note"><span class="lbl">Read the two paragraphs together</span>' +
    '61.57(c) is the currency requirement. 61.57(d) is what happens when you miss it by more than six ' +
    'calendar months. Neither one is a flight review — <b>61.56</b> is separate, and passing an IPC does ' +
    'not satisfy it. A pilot can be perfectly instrument current and not legal to fly at all.</div></section>';

  /* --------------------------------------------------------- currency --- */
  h += '<section class="blk" id="current"><h2>61.57(c) — what keeps you current ' +
    '<span class="hint">Within the preceding 6 calendar months</span></h2>' +
    '<p class="lede" style="font-size:15px">Performed and logged in the preceding 6 calendar months, ' +
    'in the category of aircraft, in actual or simulated instrument conditions, or in a full flight ' +
    'simulator, flight training device or aviation training device:</p>' +
    '<div class="grid g3 ipc-cur">' +
    '<div class="ipcc"><b>Six</b><span>instrument approaches</span></div>' +
    '<div class="ipcc"><b>Holding</b><span>procedures and tasks</span></div>' +
    '<div class="ipcc"><b>Intercepting<br>and tracking</b><span>courses through the use of navigational ' +
    'electronic systems</span></div></div>' +
    '<div class="note gold"><span class="lbl">The part people get wrong</span>' +
    'It is <b>six approaches, holding, and intercepting and tracking</b> — all three, not six approaches ' +
    'alone. And it is six <i>calendar</i> months, so an approach flown on 3 March counts through ' +
    '30 September. Read 61.57(c) for what may be done in a device and what the safety-pilot and ' +
    'view-limiting-device rules are; those conditions are where most logbook disputes start.</div></section>';

  /* ------------------------------------------------------------ check --- */
  h += '<section class="blk" id="check"><h2>61.57(d) — the check itself ' +
    '<span class="hint">Three numbered paragraphs, and you should know all three</span></h2>' +
    '<div class="cblk"><div class="top"><h3>What it must consist of</h3></div>' +
    '<div class="ref">14 CFR 61.57(d)(1)</div><ul>' +
    '<li>The areas of operation and instrument tasks required in the <b>instrument rating airman ' +
    'certification standards</b> — this document, not a locally invented syllabus.</li>' +
    '<li>Which tasks those are is set by <b>Appendix 2</b> of the ACS, reproduced as the checklist below ' +
    'and on the <a href="' + here("addrating") + '">Adding this rating</a> page.</li>' +
    '<li>There is <b>no six-approach requirement</b> in an IPC. That number belongs to 61.57(c). An IPC is ' +
    'a task list, and the tasks are flown to ACS standards.</li></ul></div>' +
    '<div class="cblk"><div class="top"><h3>Where it may be flown</h3></div>' +
    '<div class="ref">14 CFR 61.57(d)(2)</div><ul>' +
    '<li>In an aircraft, full flight simulator, flight training device or aviation training device that is ' +
    'appropriate to the aircraft category — read the paragraph for which combinations are allowed and ' +
    'what an instructor must be present for.</li></ul></div>' +
    '<div class="cblk"><div class="top"><h3>Who may give it</h3></div>' +
    '<div class="ref">14 CFR 61.57(d)(3)</div><ul>' +
    '<li><b>(i)</b> An examiner.</li>' +
    '<li><b>(ii)</b> A person authorized by the U.S. Armed Forces, if the person taking the check is a ' +
    'member of the U.S. Armed Forces.</li>' +
    '<li><b>(iii)</b> A company check pilot authorized to conduct the check under Part 121, 125 or 135, ' +
    'where the pilot is employed by that operator.</li>' +
    '<li><b>(iv)</b> An <b>authorized instructor</b> — which is how almost every IPC is actually given.</li>' +
    '<li><b>(v)</b> A person approved by the Administrator to conduct the check.</li></ul>' +
    '<details class="more"><summary>More detail</summary><div class="bd">' +
    '<p>An instructor giving an IPC in an airplane needs the instrument-airplane rating on the flight ' +
    'instructor certificate to give instrument training generally — see <b>61.195(c)</b> and read it ' +
    'against 61.57(d)(3)(iv) rather than taking anyone’s summary for it, including this one.</p>' +
    '<p>There is no such thing as a failed IPC in the way a practical test is failed. There is no ' +
    'disapproval notice and no retest window. The instructor either logs it or does not, and the ' +
    'logbook entry is the record.</p></div></details></div></section>';

  /* --------------------------------------------------------- checklist -- */
  h += ipcChecklistHtml(spec);

  /* ------------------------------------------------------------- endo --- */
  h += ipcEndoHtml();

  /* ------------------------------------------------------------ after --- */
  h += '<section class="blk" id="after"><h2>After the check <span class="hint">' +
    'What goes in the logbook, and what it does and does not reset</span></h2>' +
    '<div class="cblk"><div class="top"><h3>What the entry should say</h3></div><ul>' +
    '<li>The date, the aircraft make, model and identification, and the total time.</li>' +
    '<li>That an <b>instrument proficiency check</b> under <b>14 CFR 61.57(d)</b> was completed, and the ' +
    'tasks covered.</li>' +
    '<li>The instructor’s signature, certificate number and expiration date.</li>' +
    '<li>The AC 61-65K wording is <a href="#endo">a section up this page</a> — use it rather than writing your own.</li>' +
    '</ul></div>' +
    '<div class="note flag"><span class="lbl">What it does not do</span>' +
    'An IPC does not satisfy the <b>flight review</b> in 61.56, it does not renew a medical, and it does ' +
    'not by itself make you legal for a particular flight — 61.57(a) and (b) passenger-carrying recency ' +
    'and the aircraft’s own inspection and equipment requirements are still separate questions. Check ' +
    'each one on its own before the flight.</div></section>';

  h += '<div class="note"><span class="lbl">This is a study aid</span>' +
    'This page is written from 14 CFR 61.57 and FAA-S-ACS-8C to help you prepare and to keep track ' +
    'during a check. It is <b>not the authority</b>. Before you rely on any of it, read ' +
    '<a href="' + here("resources") + '">the regulation and the ACS</a> themselves — they are the ' +
    'documents your instructor and the FAA will use.</div>';
  return h;
}


/* The AC 61-65K sample endorsement, quoted from the AC rather than paraphrased.
   ENDO is site-wide now, so this works on any guide; if the library is somehow
   not loaded the section still says what the entry has to carry. */
function ipcEndo() {
  var m = (ENDO || []).filter(function (e) { return e.id === "A.71"; });
  return m.length ? m[0] : null;
}
function ipcEndoHtml() {
  var e = ipcEndo();
  var h = '<section class="blk" id="endo"><h2>The endorsement, word for word ' +
    '<span class="hint">AC 61-65K, dated 14 November 2025</span></h2>' +
    '<p class="lede" style="font-size:15px">This is what goes in the logbook when the check is ' +
    'satisfactory. Use the AC\u2019s wording rather than writing your own \u2014 an entry that does ' +
    'not cite <b>61.57(d)</b> is the one an inspector asks about.</p>';

  if (e) {
    h += '<details class="endo" open id="e-A-71">' +
      '<summary><span class="aid mono">' + esc(e.id) + '</span>' +
      '<span class="et">' + esc(e.title) + '</span>' +
      (e.reg ? '<span class="ereg mono">' + esc(e.reg) + '</span>' : '') + '</summary>' +
      '<div class="ebody">' +
      (e.note ? '<div class="enote">' + esc(e.note) + '</div>' : '') +
      '<div class="etext" id="etIpc">' + esc(e.text) + '</div>' +
      '<div class="erow"><button class="btn sm" data-copy="etIpc">' + I.copy +
      ' Copy</button></div></div></details>';
  } else {
    h += '<div class="note gold"><span class="lbl">Endorsement library not loaded</span>' +
      'The A.71 endorsement is in AC 61-65K under <b>Completion of an instrument proficiency ' +
      'check (IPC): 14 CFR 61.57(d)</b>. Read it there.</div>';
  }

  h += '<div class="grid g2" style="margin-top:16px">' +
    '<div class="cblk"><div class="top"><h3>What the entry must carry</h3></div><ul>' +
    '<li>The pilot\u2019s <b>name, grade of certificate and certificate number</b>.</li>' +
    '<li>That the <b>instrument proficiency check of 14 CFR 61.57(d)</b> was satisfactorily ' +
    'completed.</li>' +
    '<li>The <b>make and model</b> of aircraft, and the <b>date</b>.</li>' +
    '<li>The instructor\u2019s <b>signature, certificate number and expiration date</b>.</li>' +
    '</ul></div>' +
    '<div class="cblk"><div class="top"><h3>Two things the AC says that surprise people</h3></div><ul>' +
    '<li><b>An unsatisfactory IPC needs no logbook entry.</b> AC 61-65K says so under A.71. ' +
    'There is no disapproval notice and no retest window \u2014 the instructor either signs it or ' +
    'does not.</li>' +
    '<li><b>The English language standard applies.</b> AC 61-65K paragraph 11.4.2: if the pilot ' +
    'does not meet the FAA Aviation English Language Standard during a flight review or an IPC, ' +
    'do not endorse the logbook as complete \u2014 log the training received, advise the pilot, and ' +
    'contact the responsible Flight Standards District Office.</li>' +
    '</ul></div></div>' +
    '<p class="muted sm" style="margin-top:12px">The full library of ' +
    ((ENDO || []).length || '') + ' AC 61-65K endorsements is on the ' +
    '<a href="' + here('endorsements') + '">endorsements page</a>.</p></section>';
  return h;
}

/* The little date tool: last qualifying instrument experience in, dates out. */
function ipcCalcHtml() {
  return '<div class="ipc-calc"><label for="ipcDate"><b>Work out my dates</b>' +
    '<span>The date of the last flight on which you performed the 61.57(c) tasks</span></label>' +
    '<input type="date" id="ipcDate"><div id="ipcOut" class="ipc-out"></div>' +
    '<p class="muted sm">Calendar months, counted the way 61.57 counts them: the month of the flight ' +
    'is not counted, and currency runs to the last day of the sixth month after it. Your logbook is ' +
    'the record — this only does the arithmetic.</p></div>';
}
function ipcCalc() {
  var inp = el("ipcDate"), out = el("ipcOut"); if (!inp || !out) return;
  var v = inp.value; if (!v) { out.innerHTML = ""; return; }
  var p = v.split("-"), y = +p[0], mo = +p[1], d = +p[2];
  if (!y || !mo || !d) { out.innerHTML = ""; return; }
  /* end of the Nth calendar month after the month of the flight */
  function endOf(n) {
    var t = new Date(Date.UTC(y, mo - 1 + n + 1, 0));   // day 0 = last day of prev month
    return t;
  }
  var fmt6 = endOf(6), fmt12 = endOf(12);
  var today = new Date();
  var now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  var state, cls;
  if (now <= fmt6.getTime()) { state = "Current"; cls = "ok"; }
  else if (now <= fmt12.getTime()) { state = "Lapsed — but no IPC needed yet"; cls = "warn"; }
  else { state = "IPC required"; cls = "bad"; }
  function ds(t) {
    return t.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  }
  out.innerHTML = '<div class="ipc-res ' + cls + '"><b>' + esc(state) + "</b>" +
    "<ul><li>Instrument current through <b>" + esc(ds(fmt6)) + "</b> — 61.57(c).</li>" +
    "<li>Until <b>" + esc(ds(fmt12)) + "</b> you may regain currency by performing the 61.57(c) tasks " +
    "with a safety pilot or in an approved device.</li>" +
    "<li>From <b>" + esc(ds(new Date(fmt12.getTime() + 86400000))) + "</b> only an instrument " +
    "proficiency check will do it — 61.57(d).</li></ul></div>";
}

function ipcChecklistHtml(spec) {
  if (!spec) {
    return '<section class="blk" id="list"><h2>The checklist</h2>' +
      '<div class="note gold"><span class="lbl">Not available for this guide</span>' +
      "The IPC task table comes from Appendix 2 of the instrument ACS, which this guide does not " +
      "carry.</div></section>";
  }
  var c = ipcCount(spec);
  var h = '<section class="blk" id="list"><h2>The checklist <span class="hint">' +
    "Tick tasks as they are completed — it saves in this browser</span></h2>" +
    '<p class="lede" style="font-size:15px">Straight out of <b>Appendix 2 of FAA-S-ACS-8C</b>, the ' +
    "Instrument Proficiency Check table. Areas I and II carry no required tasks, so they are not listed. " +
    "Open a task name to read what the ACS asks for.</p>" +
    '<div class="ipc-bar"><div class="ipc-prog"><span id="ipcFill" style="width:' +
    (c.total ? Math.round((c.done / c.total) * 100) : 0) + '%"></span></div>' +
    '<div class="ipc-n mono" id="ipcN">' + c.done + " / " + c.total + " tasks</div>" +
    '<button class="btn ghost sm" id="ipcReset">Reset</button>' +
    '<button class="btn ghost sm" id="ipcPrint">Print</button></div>';

  h += '<div class="ipc-list">';
  spec.forEach(function (a) {
    h += '<div class="ipc-area"><div class="ipc-ah"><span class="rn">' + esc(a.roman) + "</span>" +
      "<b>" + esc(a.title) + "</b><i class=\"mono\">" + esc(a.raw) + "</i></div>";
    a.tasks.forEach(function (t) {
      var id = a.roman + "." + t.letter;
      if (!t.here) {
        h += '<div class="ipc-row na"><span class="ipc-c">' + esc(t.letter) + "</span>" +
          '<span class="ipc-t">' + esc(t.title) +
          '<i>Multiengine task — AMEL and AMES only, so it is not part of a single-engine airplane ' +
          'check. It is listed because the ACS table names it.</i></span></div>';
        return;
      }
      h += '<label class="ipc-row' + (IPC[id] ? " done" : "") + '" data-ipc="' + esc(id) + '">' +
        '<input type="checkbox"' + (IPC[id] ? " checked" : "") + ' data-ipc="' + esc(id) + '">' +
        '<span class="ipc-c">' + esc(t.letter) + "</span>" +
        '<span class="ipc-t">' + esc(t.title) + "</span>" +
        '<a class="ipc-go" href="' + here("t/" + id) + '" title="Open this task">' + I.chev + "</a></label>";
    });
    h += "</div>";
  });
  h += "</div>";

  h += '<div class="note"><span class="lbl">How to use it in the airplane</span>' +
    "Open this page on a phone or tablet before you start, tick each task as it is completed, and the " +
    "progress bar shows what is left. It keeps its state if you close the page, so a check split across " +
    "two flights carries over. It is a memory aid for you and your instructor — the logbook entry your " +
    "instructor signs is the legal record of the check, not this list.</div></section>";
  return h;
}

function wireIpc() {
  var d = el("ipcDate");
  if (d) { d.addEventListener("change", ipcCalc); d.addEventListener("input", ipcCalc); }
  var boxes = document.querySelectorAll("input[data-ipc]");
  for (var i = 0; i < boxes.length; i++) boxes[i].addEventListener("change", function () {
    var id = this.getAttribute("data-ipc");
    if (this.checked) IPC[id] = 1; else delete IPC[id];
    ipcSave();
    var row = this.closest(".ipc-row"); if (row) row.classList.toggle("done", this.checked);
    ipcRefresh();
  });
  var r = el("ipcReset");
  if (r) r.addEventListener("click", function () {
    IPC = {}; ipcSave();
    var bs = document.querySelectorAll("input[data-ipc]");
    for (var k = 0; k < bs.length; k++) {
      bs[k].checked = false;
      var row = bs[k].closest(".ipc-row"); if (row) row.classList.remove("done");
    }
    ipcRefresh();
  });
  var pr = el("ipcPrint");
  if (pr) pr.addEventListener("click", function () { window.print(); });
}
function ipcRefresh() {
  var spec = ipcSpec(); if (!spec) return;
  var c = ipcCount(spec), f = el("ipcFill"), n = el("ipcN");
  if (f) f.style.width = (c.total ? Math.round((c.done / c.total) * 100) : 0) + "%";
  if (n) n.textContent = c.done + " / " + c.total + " tasks";
}


  /* ---------- eligibility ---------- */
  /* ---------- eligibility, per guide ----------
     Every guide has its own certificate and its own subpart of Part 61, so
     this reads `elig:<slug>` and `check:<slug>` rather than the CFI's. A guide
     with neither still gets a usable page: the cross-country validator and a
     pointer at the regulation. */
  function eligDef() { return C["elig:" + G.slug] || null; }
  function eligCheckKey() {
    return checkDef("check:" + G.slug) ? "check:" + G.slug : null;
  }
  /* the other checkers this guide is willing to show as extra tabs, because a
     commercial applicant still cares what a private certificate required */
  function eligTabs() {
    var order = CK_ORDER, mine = eligCheckKey();
    return order.filter(function (k) { return !!checkDef(k); })
                .sort(function (x, y) {
                  if (x === mine) return -1;
                  if (y === mine) return 1;
                  return order.indexOf(x) - order.indexOf(y);
                });
  }

  function pageEligibility(jump) {
    var g = G, m = guideMeta(g.slug) || {};
    var e = eligDef() || {};
    var tabs = eligTabs(), first = eligCheckKey() || tabs[0] || null;

    var items = [];
    if (first) items.push({ id: "checker", t: "Check your eligibility" });
    items.push({ id: "xc", t: "Does this flight count as a cross-country?" });
    (e.sections || []).forEach(function (s) { items.push({ id: "e-" + slug(s.h), t: s.h, lv: 2 }); });

    var h = '<div class="crumb"><a href="' + here("") + '">' + esc(m.short) +
      "</a> <span>›</span> <span>Am I eligible?</span></div>" +
      '<div class="eyebrow">' + esc(m.cert || g.title) + "</div>" +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Am I eligible?</h1>' +
      '<p class="lede">' + fmt(e.intro || eligFallbackIntro()) + "</p>" + toc(items);

    if (first) {
      h += '<section class="blk" id="checker"><h2>Check your eligibility <span class="hint">' +
        "Tick what is true. Nothing leaves your browser.</span></h2>";
      if (tabs.length > 1) {
        h += '<div class="tabs">' + tabs.map(function (k, i) {
          return '<button class="tab' + (k === first ? " on" : "") + '" data-tab="' + esc(k) + '">' +
            esc(ckShort(k)) + "</button>";
        }).join("") + "</div>";
      }
      h += '<div id="ckHost">' + checkerHtml(first) + "</div></section>";
    } else {
      h += '<div class="note gold"><span class="lbl">No checklist for this one yet</span>' +
        "The requirements for " + esc(m.cert) + " are in " + esc(eligReg()) +
        ". The interactive checklist is being written; read the regulation itself in the " +
        'meantime — the link is on the <a href="' + here("resources") + '">official resources' +
        "</a> page.</div>";
    }

    /* The cross-country definition is NOT the same for every certificate, which
       is exactly why this belongs on each guide's own page rather than in one
       shared place. */
    h += '<section class="blk" id="xc"><h2>Does this flight count as a cross-country?' +
      '<span class="hint">The answer depends on which certificate you are working toward</span></h2>' +
      '<p class="lede" style="font-size:15px">14 CFR 61.1(b) defines cross-country time once, ' +
      "and then each certificate's own paragraph adds a distance. Put a flight in and it tells " +
      "you which requirements it satisfies and which it does not.</p>" +
      xcToolHtml() + "</section>";

    if (e.sections && e.sections.length) {
      h += '<section class="blk"><h2>The requirements in full</h2>' + e.sections.map(function (s) {
        var x = '<div class="cblk" id="e-' + slug(s.h) + '"><div class="top"><h3>' + esc(s.h) +
          "</h3></div>" + (s.sub ? '<div class="sub">' + fmt(s.sub) + "</div>" : "") +
          (s.ref ? '<div class="ref">' + esc(s.ref) + "</div>" : "");
        if (s.bullets && s.bullets.length) {
          x += "<ul>" + s.bullets.map(function (bb) { return "<li>" + fmt(bb) + "</li>"; }).join("") + "</ul>";
        }
        (s.groups || []).forEach(function (gr) {
          x += '<div class="sh">' + esc(gr.h) + "</div><ul>" +
            gr.b.map(function (bb) { return "<li>" + fmt(bb) + "</li>"; }).join("") + "</ul>";
        });
        if (s.more) x += '<details class="more"><summary>More detail</summary><div class="bd"><p>' +
          s.more.split("\n").filter(Boolean).map(fmt).join("</p><p>") + "</p></div></details>";
        return x + "</div>";
      }).join("") + "</section>";
    }

    h += '<div class="note flag"><span class="lbl">What this tool is and is not</span>' +
      "This follows " + esc(eligReg()) + " and is a <b>study aid</b>. It does not determine your " +
      "eligibility. Your instructor signs the endorsements, the evaluator checks your logbook, and " +
      "the regulation in force on the day of the test is what counts. Read " +
      '<a href="' + here("resources") + '">Part 61 itself</a> before you rely on any of it.</div>';
    return h;
  }
  /* which subpart governs this certificate */
  var ELIG_REG = {
    private: "14 CFR 61.103 and 61.109",
    instrument: "14 CFR 61.65",
    commercial: "14 CFR 61.123 and 61.129",
    "commercial-me": "14 CFR 61.63(c), or 61.129(b) if the certificate is initial",
    cfi: "14 CFR 61.183",
    "cfi-instrument": "14 CFR 61.183, 61.191 and 61.195(c)"
  };
  function eligReg() { return ELIG_REG[G.slug] || "14 CFR part 61"; }
  function eligFallbackIntro() {
    var m = guideMeta(G.slug) || {};
    return "What Part 61 asks for before you can take the " + esc(m.cert || "practical test") +
      " test — the age, the certificates and endorsements, the knowledge test, and the " +
      "flight time, written out so you can check yourself against " + esc(eligReg()) +
      " rather than hoping.";
  }

  /* ======================================================================
     Weather — the decoder itself is wx.js, injected here at build time.
     ====================================================================== */
  /* ============================================================================
   Weather decoder — METAR, TAF and PIREP.  Runs entirely offline.
   Injected inside the app IIFE, so it can use esc(), fmt(), el(), findApt().
   ============================================================================ */

var WX_WX = {
  DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals",
  PL: "ice pellets", GR: "hail", GS: "small hail or snow pellets", UP: "unknown precipitation",
  BR: "mist", FG: "fog", FU: "smoke", VA: "volcanic ash", DU: "widespread dust",
  SA: "sand", HZ: "haze", PY: "spray", PO: "dust or sand whirls", SQ: "squalls",
  FC: "funnel cloud", SS: "sandstorm", DS: "duststorm"
};
var WX_DESC = {
  MI: "shallow", BC: "patches of", PR: "partial", DR: "low drifting", BL: "blowing",
  SH: "showers of", TS: "thunderstorm with", FZ: "freezing"
};
var WX_SKY = {
  SKC: ["Sky clear", 0], CLR: ["Clear below 12,000 ft (automated station)", 0],
  NSC: ["No significant cloud", 0], NCD: ["No cloud detected", 0],
  FEW: ["Few", 2], SCT: ["Scattered", 4], BKN: ["Broken", 6], OVC: ["Overcast", 8],
  VV: ["Vertical visibility (sky obscured)", 8]
};
var WX_RMK = {
  AO1: "Automated station without a precipitation discriminator - it cannot tell rain from snow",
  AO2: "Automated station with a precipitation discriminator - it can tell rain from snow",
  TSNO: "Thunderstorm information is not available",
  PWINO: "Precipitation identifier is not operating",
  PNO: "Precipitation amount is not available",
  FZRANO: "Freezing rain sensor is not operating",
  RVRNO: "RVR is not available",
  $: "The station needs maintenance",
  NOSPECI: "No SPECI reports are taken at this station",
  "SLPNO": "Sea level pressure is not available",
  CLRTOP: "Cloud tops observed",
  LTG: "Lightning"
};

function wxPad(n) { return (n < 10 ? "0" : "") + n; }
function wxCloudFt(g) { return (parseInt(g, 10) * 100).toLocaleString() + " ft AGL"; }
/* a PIREP reports altitude MSL, not AGL */
function wxMsl(g) { return (parseInt(g, 10) * 100).toLocaleString() + " ft MSL"; }

/* one decoded line: the raw token, what it means, and an optional teaching note */
function wxRow(tok, mean, note, kind) {
  return { t: tok, m: mean, n: note || "", k: kind || "" };
}

function wxWind(tok) {
  var m = tok.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/);
  if (!m) return null;
  var unit = m[4] === "KT" ? "knots" : (m[4] === "MPS" ? "metres per second" : "km/h");
  var dir = m[1] === "VRB" ? "Variable in direction" : "From " + parseInt(m[1], 10) + " degrees true";
  var spd = parseInt(m[2], 10);
  var s = dir + " at " + spd + " " + unit;
  if (m[3]) s += ", gusting to " + parseInt(m[3], 10) + " " + unit;
  var note = "";
  if (spd === 0) note = "Calm.";
  else if (m[1] === "VRB" && spd <= 6) note = "Variable is only reported for 6 knots or less, or when the direction really is undetermined.";
  if (m[3]) note += (note ? " " : "") + "Gusts are reported when the peak is at least 10 knots above the lull. Use the gust for your crosswind check.";
  if (m[1] !== "VRB") note += (note ? " " : "") + "Wind in a METAR or a TAF is referenced to TRUE north. The tower, the ATIS and the AWOS give you MAGNETIC.";
  return wxRow(tok, s, note, "wind");
}

function wxVis(tok) {
  if (tok === "CAVOK") return wxRow(tok, "Ceiling and visibility OK", "Visibility 10 km or more, no cloud below 5,000 ft or below the highest minimum sector altitude, no CB or TCU, and no significant weather. Not used in US reports.", "vis");
  var m = tok.match(/^(M)?(\d+)?\s?(\d\/\d)?SM$/);
  if (m && (m[2] || m[3])) {
    var v = (m[2] ? m[2] : "") + (m[2] && m[3] ? " " : "") + (m[3] ? m[3] : "");
    var vnum = wxVisNum(tok) ;
    var s = "Visibility " + (m[1] ? "less than " : "") + v + " statute mile" + (vnum !== null && vnum <= 1 ? "" : "s");
    var note = "";
    if (m[2] === "10") note = "10SM means 10 miles or more. It is the top of the scale, not an exact value.";
    if (m[1]) note = "M means 'less than'. M1/4SM is below one quarter of a mile.";
    return wxRow(tok, s, note, "vis");
  }
  if (/^\d{4}$/.test(tok)) {
    var mtr = parseInt(tok, 10);
    return wxRow(tok, "Visibility " + (mtr === 9999 ? "10 km or more" : mtr.toLocaleString() + " metres"),
      "Metric visibility. Outside the United States.", "vis");
  }
  if (tok === "P6SM") return wxRow(tok, "Visibility greater than 6 statute miles",
    "P means 'more than'. In a TAF, P6SM is the way of saying unrestricted.", "vis");
  return null;
}

function wxWeather(tok) {
  var m = tok.match(/^([-+]|VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ))?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)?$/);
  if (!m || (!m[2] && !m[3])) return null;
  if (!m[3] && !/^(SH|TS)$/.test(m[2])) return null;
  var PRECIP = /^(DZ|RA|SN|SG|IC|PL|GR|GS|UP)/;
  var isPrecip = !!(m[3] && PRECIP.test(m[3])) || m[2] === "SH";
  var parts = [];
  if (m[1] === "-") parts.push("Light");
  else if (m[1] === "+") parts.push(m[3] === "FC" ? "Well-developed" : "Heavy");
  else if (m[1] === "VC") parts.push("In the vicinity (5 to 10 statute miles from the station):");
  else if (isPrecip) parts.push("Moderate");
  if (m[2] && m[3]) parts.push(WX_DESC[m[2]]);
  if (m[3]) {
    var ph = [];
    for (var i = 0; i < m[3].length; i += 2) ph.push(WX_WX[m[3].substr(i, 2)] || m[3].substr(i, 2));
    parts.push(ph.join(" and "));
  } else if (m[2] === "TS") parts.push("thunderstorm, no precipitation at the station");
  else if (m[2] === "SH") parts.push("showers");
  else if (m[2]) parts.push(WX_DESC[m[2]]);
  var note = "";
  if (m[1] === "VC") note = "Vicinity is 5 to 10 miles out. Inside 5 miles it would be reported as at the station.";
  else if (!m[1] && isPrecip) note = "No sign in front means moderate intensity.";
  else if (!m[1] && !isPrecip) note = "Obscurations such as mist, fog, haze and smoke carry no intensity sign.";
  if (m[2] === "TS") note += (note ? " " : "") + "A thunderstorm at the field. Think wind shear, microburst, and the 20 NM avoidance rule.";
  if (m[2] === "FZ") note += (note ? " " : "") + "Freezing. This is structural icing on the airframe, and a no-go in a light single.";
  if (m[3] === "BR") note += (note ? " " : "") + "Mist is visibility 5/8 to 6 statute miles. Below 5/8 the same thing is reported as fog.";
  if (m[3] === "FG") note += (note ? " " : "") + "Fog is visibility below 5/8 of a mile.";
  var phrase = parts.join(" ").replace(/\s+/g, " ").trim();
  return wxRow(tok, phrase.charAt(0).toUpperCase() + phrase.slice(1), note, "wx");
}

function wxSky(tok) {
  var m = tok.match(/^(SKC|CLR|NSC|NCD|FEW|SCT|BKN|OVC|VV)(\d{3}|\/{3})?(CB|TCU)?$/);
  if (!m) return null;
  var base = WX_SKY[m[1]];
  var s = base[0];
  if (m[2] && m[2] !== "///") s += " at " + wxCloudFt(m[2]);
  else if (m[2]) s += " at an unknown height";
  if (m[3] === "CB") s += ", cumulonimbus";
  if (m[3] === "TCU") s += ", towering cumulus";
  var note = "";
  if (m[1] === "BKN" || m[1] === "OVC" || m[1] === "VV") {
    note = "This is a CEILING - the lowest broken, overcast or vertical-visibility layer. " +
      (m[2] && m[2] !== "///" ? "Ceiling " + wxCloudFt(m[2]) + "." : "");
  }
  if (m[1] === "FEW") note = "Few is 1 to 2 eighths of the sky. Never a ceiling.";
  if (m[1] === "SCT") note = "Scattered is 3 to 4 eighths. Never a ceiling.";
  if (m[1] === "CLR") note = "An automated station reporting no cloud below 12,000 ft. It cannot see above that.";
  if (m[3] === "CB") note += " Cumulonimbus. Thunderstorm - avoid it by 20 NM.";
  if (m[3] === "TCU") note += " Towering cumulus. A thunderstorm in the making.";
  return wxRow(tok, s, note.trim(), "sky");
}

function wxTemp(tok) {
  var m = tok.match(/^(M?)(\d{2})\/(M?)(\d{2})$/);
  if (!m) return null;
  var t = (m[1] ? -1 : 1) * parseInt(m[2], 10);
  var d = (m[3] ? -1 : 1) * parseInt(m[4], 10);
  var spread = t - d;
  var note = "Spread is " + spread + " C. ";
  note += "Estimated cumulus base about " + Math.round(spread / 2.5 * 1000).toLocaleString() + " ft AGL. ";
  if (spread <= 2) note += "A spread this small means fog or low cloud is likely.";
  if (t <= 0) note += " At or below freezing - carburettor icing and structural icing are live concerns.";
  else if (t <= 20 && spread <= 12) note += " This is inside the carburettor icing range.";
  return wxRow(tok, "Temperature " + t + " C, dew point " + d + " C  (" +
    Math.round(t * 9 / 5 + 32) + " F / " + Math.round(d * 9 / 5 + 32) + " F)", note.trim(), "temp");
}

function wxAlt(tok) {
  var m = tok.match(/^A(\d{4})$/);
  if (m) {
    var inHg = (parseInt(m[1], 10) / 100).toFixed(2);
    var pa = Math.round((29.92 - parseFloat(inHg)) * 1000);
    return wxRow(tok, "Altimeter setting " + inHg + " inches of mercury",
      "Pressure altitude at the field is about " + (pa >= 0 ? "+" : "") + pa.toLocaleString() +
      " ft relative to the field elevation.", "alt");
  }
  m = tok.match(/^Q(\d{4})$/);
  if (m) return wxRow(tok, "Altimeter setting " + parseInt(m[1], 10) + " hectopascals",
    "Metric pressure. Outside the United States. About " + (parseInt(m[1], 10) * 0.02953).toFixed(2) + " inHg.", "alt");
  return null;
}

function wxTime(tok) {
  var m = tok.match(/^(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return wxRow(tok, "Day " + parseInt(m[1], 10) + " of the month at " + m[2] + ":" + m[3] + " Zulu",
    "All aviation weather is in UTC. A METAR is normally issued about 55 minutes past the hour.", "time");
}

var WX_DIR = { N:"north", NE:"north-east", E:"east", SE:"south-east", S:"south",
  SW:"south-west", W:"west", NW:"north-west", ALQDS:"all quadrants", OHD:"overhead" };
var WX_WORD = {
  DSNT: "distant - more than 10 statute miles from the station",
  VC: "in the vicinity - 5 to 10 statute miles out",
  OHD: "overhead the station",
  ALQDS: "in all quadrants",
  MOV: "moving",
  MOVG: "moving",
  STNRY: "stationary",
  OCNL: "occasional",
  FRQ: "frequent - more than 6 flashes a minute",
  CONS: "continuous",
  ALL: "all",
  QUAD: "quadrant",
  AND: "and",
  SFC: "surface",
  TWR: "reported by the tower",
  VIS: "visibility",
  CIG: "ceiling",
  RWY: "runway",
  LAST: "the last observation from this station",
  FIRST: "the first observation from this station",
  CB: "cumulonimbus",
  TCU: "towering cumulus",
  APRNT: "apparent",
  TS: "thunderstorm",
  RA: "rain", SN: "snow", FG: "fog", BR: "mist", SH: "showers",
  DSIPTD: "dissipated",
  BLDU: "blowing dust", BLSN: "blowing snow",
  LTGICCCCG: "lightning in cloud, cloud to cloud and cloud to ground",
  UNKN: "unknown",
  NW: "to the north-west", NE: "to the north-east", SW: "to the south-west", SE: "to the south-east",
  N: "to the north", S: "to the south", E: "to the east", W: "to the west"
};
var WX_LTG = { IC: "in cloud", CC: "cloud to cloud", CG: "cloud to ground", CA: "cloud to air" };

function wxRemark(tok, rest) {
  if (WX_RMK[tok]) return wxRow(tok, WX_RMK[tok], "", "rmk");
  var m;
  if ((m = tok.match(/^SLP(\d{3})$/))) {
    var v = parseInt(m[1], 10);
    var slp = (v >= 500 ? 900 + v / 10 : 1000 + v / 10).toFixed(1);
    return wxRow(tok, "Sea level pressure " + slp + " hPa",
      "Not the altimeter setting. Sea level pressure is corrected to sea level using the actual temperature; the altimeter setting uses the standard atmosphere.", "rmk");
  }
  if ((m = tok.match(/^T(\d)(\d{3})(\d)(\d{3})$/))) {
    var t = (m[1] === "1" ? -1 : 1) * parseInt(m[2], 10) / 10;
    var d = (m[3] === "1" ? -1 : 1) * parseInt(m[4], 10) / 10;
    return wxRow(tok, "Precise temperature " + t.toFixed(1) + " C, dew point " + d.toFixed(1) + " C",
      "The tenth-of-a-degree values. The body of the report is rounded to whole degrees. A leading 1 means minus.", "rmk");
  }
  if ((m = tok.match(/^PKWND(\d{3})(\d{2,3})\/(\d{2,4})$/))) {
    return wxRow(tok, "Peak wind from " + parseInt(m[1], 10) + " degrees at " + parseInt(m[2], 10) +
      " knots, at " + (m[3].length === 4 ? m[3].slice(0, 2) + ":" + m[3].slice(2) : ":" + m[3]) + " Zulu",
      "Reported when the peak reaches 25 knots or more. Use it, not the two-minute average, when you judge a crosswind.", "rmk");
  }
  if ((m = tok.match(/^WSHFT(\d{2,4})(FROPA)?$/))) {
    return wxRow(tok, "Wind shift at " + (m[1].length === 4 ? m[1].slice(0, 2) + ":" + m[1].slice(2) : ":" + m[1]) +
      " Zulu" + (m[2] ? ", with a frontal passage" : ""),
      "A wind shift is 45 degrees or more in under 15 minutes with sustained wind of 10 knots or more.", "rmk");
  }
  if ((m = tok.match(/^SFCVIS(\d+)?(\d\/\d)?$/))) {
    return wxRow(tok, "Surface visibility " + [m[1], m[2]].filter(Boolean).join(" ") + " statute miles",
      "The human observer's visibility, given when it differs from the automated sensor.", "rmk");
  }
  if ((m = tok.match(/^TWRVIS(\d+)?(\d\/\d)?$/))) {
    return wxRow(tok, "Tower visibility " + [m[1], m[2]].filter(Boolean).join(" ") + " statute miles", "", "rmk");
  }
  if ((m = tok.match(/^VIS(\d+)?(\d\/\d)?V(\d+)?(\d\/\d)?$/))) {
    return wxRow(tok, "Visibility variable between " + [m[1], m[2]].filter(Boolean).join(" ") +
      " and " + [m[3], m[4]].filter(Boolean).join(" ") + " statute miles", "", "rmk");
  }
  if ((m = tok.match(/^LTG([A-Z]*)$/)) && m[1].length % 2 === 0) {
    var kinds = [];
    for (var li = 0; li < m[1].length; li += 2) kinds.push(WX_LTG[m[1].substr(li, 2)] || m[1].substr(li, 2));
    return wxRow(tok, "Lightning" + (kinds.length ? ", " + kinds.join(" and ") : ""),
      "Lightning within 5 miles is reported as at the station, 5 to 10 as VC, beyond 10 as DSNT.", "rmk");
  }
  if ((m = tok.match(/^P(\d{4})$/))) return wxRow(tok, "Precipitation of " + (parseInt(m[1], 10) / 100).toFixed(2) + " inches in the last hour", "", "rmk");
  if ((m = tok.match(/^6(\d{4}|\/{4})$/))) return wxRow(tok, m[1] === "////" ? "3 or 6 hour precipitation not available" :
    "Precipitation of " + (parseInt(m[1], 10) / 100).toFixed(2) + " inches in the last 3 or 6 hours", "", "rmk");
  if ((m = tok.match(/^7(\d{4})$/))) return wxRow(tok, "24-hour precipitation " + (parseInt(m[1], 10) / 100).toFixed(2) + " inches", "", "rmk");
  if ((m = tok.match(/^4\/(\d{3})$/))) return wxRow(tok, "Snow depth " + parseInt(m[1], 10) + " inches on the ground", "", "rmk");
  if ((m = tok.match(/^5(\d)(\d{3})$/))) {
    var TEND = ["increasing then decreasing", "increasing then steady", "increasing steadily",
      "decreasing or steady then increasing", "steady", "decreasing then increasing",
      "decreasing then steady", "decreasing steadily", "steady or increasing then decreasing"];
    return wxRow(tok, "3-hour pressure tendency: " + (TEND[+m[1]] || "") + ", change " +
      (parseInt(m[2], 10) / 10).toFixed(1) + " hPa", "Reported at the main synoptic hours: 00, 06, 12 and 18 Zulu.", "rmk");
  }
  if ((m = tok.match(/^1(\d{4})$/))) return wxRow(tok, "6-hour maximum temperature " +
    ((m[1][0] === "1" ? -1 : 1) * parseInt(m[1].slice(1), 10) / 10).toFixed(1) + " C", "", "rmk");
  if ((m = tok.match(/^2(\d{4})$/))) return wxRow(tok, "6-hour minimum temperature " +
    ((m[1][0] === "1" ? -1 : 1) * parseInt(m[1].slice(1), 10) / 10).toFixed(1) + " C", "", "rmk");
  if (/^((RA|SN|TS|DZ|GR|GS|PL|FG|SH|UP)[BE]\d{2,4})+$/.test(tok)) {
    var W2 = { RA: "Rain", SN: "Snow", TS: "Thunderstorm", DZ: "Drizzle", GR: "Hail",
      GS: "Small hail", PL: "Ice pellets", FG: "Fog", SH: "Showers", UP: "Unknown precipitation" };
    var out2 = [], re2 = /(RA|SN|TS|DZ|GR|GS|PL|FG|SH|UP)([BE])(\d{2,4})/g, g;
    while ((g = re2.exec(tok))) {
      out2.push(W2[g[1]] + (g[2] === "B" ? " began" : " ended") + " at " +
        (g[3].length === 4 ? g[3].slice(0, 2) + ":" + g[3].slice(2) : ":" + g[3]));
    }
    return wxRow(tok, out2.join(", "), "Minutes past the hour when only two digits are given.", "rmk");
  }
  if ((m = tok.match(/^CIG(\d{3})V(\d{3})$/))) return wxRow(tok, "Ceiling variable between " + wxCloudFt(m[1]) + " and " + wxCloudFt(m[2]), "", "rmk");
  if ((m = tok.match(/^CIG(\d{3})(RWY\d{2}[LCR]?)?$/))) return wxRow(tok, "Ceiling " + wxCloudFt(m[1]) + (m[2] ? " measured at " + m[2] : ""), "", "rmk");
  if ((m = tok.match(/^(FEW|SCT|BKN|OVC)(\d{3})V(FEW|SCT|BKN|OVC)$/))) return wxRow(tok, "The layer at " + wxCloudFt(m[2]) + " varies between " + m[1] + " and " + m[3], "", "rmk");
  if ((m = tok.match(/^(FEW|SCT|BKN|OVC|CB|TCU)(\d{3})$/))) return wxRow(tok, m[1] + " layer at " + wxCloudFt(m[2]), "", "rmk");
  if (WX_WORD[tok]) return wxRow(tok, WX_WORD[tok].charAt(0).toUpperCase() + WX_WORD[tok].slice(1), "", "rmk");
  if ((m = tok.match(/^(\d{2})(\d{3})$/))) return null;
  return null;
}

/* ---------- flight category, AIM 7-1-7 and FAA-H-8083-2A fig 2-1 ---------- */
function wxCat(ceilFt, visSM) {
  var c = (ceilFt === null || ceilFt === undefined) ? Infinity : ceilFt;
  var v = (visSM === null || visSM === undefined) ? Infinity : visSM;
  if (c === Infinity && v === Infinity) return null;
  var why = [];
  var cat;
  if (c < 500 || v < 1) cat = "LIFR";
  else if (c < 1000 || v < 3) cat = "IFR";
  else if (c <= 3000 || v <= 5) cat = "MVFR";
  else cat = "VFR";
  if (c !== Infinity) why.push("ceiling " + c.toLocaleString() + " ft");
  else why.push("no ceiling");
  if (v !== Infinity) why.push("visibility " + (v >= 10 ? "10+" : v) + " SM");
  return { cat: cat, why: why.join(", ") };
}
var WX_CAT_NOTE = {
  VFR:  "Ceiling greater than 3,000 ft and visibility greater than 5 SM.",
  MVFR: "Ceiling 1,000 to 3,000 ft and/or visibility 3 to 5 SM.",
  IFR:  "Ceiling 500 to less than 1,000 ft and/or visibility 1 to less than 3 SM.",
  LIFR: "Ceiling less than 500 ft and/or visibility less than 1 SM."
};

/* numeric visibility in statute miles, for the category */
function wxVisNum(tok) {
  var m = tok.match(/^(M|P)?(\d+)?\s?(\d)\/(\d)?SM$/);
  if (m) {
    var whole = m[2] ? parseInt(m[2], 10) : 0;
    var frac = m[4] ? parseInt(m[3], 10) / parseInt(m[4], 10) : 0;
    var v = whole + frac;
    return m[1] === "M" ? Math.max(0, v - 0.01) : v;
  }
  m = tok.match(/^(M|P)?(\d+)SM$/);
  if (m) {
    var n = parseInt(m[2], 10);
    return m[1] === "M" ? Math.max(0, n - 0.01) : (m[1] === "P" ? n + 0.5 : n);
  }
  if (/^\d{4}$/.test(tok)) return parseInt(tok, 10) / 1609.34;
  if (tok === "CAVOK") return 10;
  return null;
}

/* ---------- the METAR / SPECI decoder ---------- */
function decodeMetar(raw) {
  var out = [], toks = raw.trim().toUpperCase().replace(/=+$/, "").split(/\s+/).filter(Boolean);
  var inRmk = false, i = 0;
  var summary = { station: "", place: "", time: "", ceiling: null, ceilFt: null,
                  vis: null, visSM: null, wind: null, temp: null, alt: null };

  while (i < toks.length) {
    var tk = toks[i], row = null;

    if (tk === "RMK") {
      out.push(wxRow(tk, "Remarks section begins",
        "Everything after RMK is extra detail. Some of it is coded, some is plain language typed by an observer.", "hdr"));
      inRmk = true; i++; continue;
    }

    if (!inRmk) {
      if (i === 0 && (tk === "METAR" || tk === "SPECI")) {
        row = wxRow(tk, tk === "METAR" ? "Routine aviation weather report" :
          "Special report, issued off-schedule when something changed enough to matter",
          tk === "METAR" ? "Taken once an hour, usually between 55 and 59 past." :
          "A SPECI is your cue that the weather moved. Read it before the hourly.", "hdr");
      } else if (i <= 1 && /^[A-Z][A-Z0-9]{3}$/.test(tk) && !WX_SKY[tk]) {
        var ap = (typeof findApt === "function") ? findApt(tk) : null;
        summary.station = tk;
        summary.place = ap ? ap.name + (ap.city ? ", " + ap.city + " " + ap.st : "") : "";
        row = wxRow(tk, "Station " + tk + (summary.place ? " — " + summary.place : ""),
          "The ICAO identifier of the reporting station.", "hdr");
      } else if (tk === "AUTO") {
        row = wxRow(tk, "Fully automated report, no human observer",
          "An automated station cannot see everything. It has no tornado, no volcanic ash, no ice crystals, and it only sees cloud up to 12,000 ft. Look for AO1 or AO2 in the remarks.", "hdr");
      } else if (tk === "COR") {
        row = wxRow(tk, "Corrected report", "Something in the earlier report was wrong. This one replaces it.", "hdr");
      } else if (tk === "NIL") {
        row = wxRow(tk, "Report is missing", "", "hdr");
      } else if ((row = wxTime(tk))) { summary.time = row.m; }
      else if ((row = wxWind(tk))) { summary.wind = row.m; }
      else if (/^\d{3}V\d{3}$/.test(tk)) {
        row = wxRow(tk, "Wind direction varying between " + parseInt(tk.slice(0, 3), 10) + " and " + parseInt(tk.slice(4), 10) + " degrees",
          "Reported when the variation is 60 degrees or more and the speed is above 6 knots. Brief your student on which runway that really favours.", "wind");
      } else if (/^\d$/.test(tk) && i + 1 < toks.length && /^\d\/\dSM$/.test(toks[i + 1])) {
        var joinedVis = tk + " " + toks[i + 1];
        row = wxVis(joinedVis);
        if (row) { row.t = joinedVis; summary.vis = row.m; summary.visSM = wxVisNum(joinedVis); i++; }
      } else if ((row = wxVis(tk))) { summary.vis = row.m; summary.visSM = wxVisNum(tk); }
      else if (/^R\d{2}[LCR]?\/[MP]?\d{4}(V[MP]?\d{4})?(FT|U|D|N)?$/.test(tk)) {
        row = wxRow(tk, "Runway visual range for runway " + tk.slice(1).split("/")[0] + ": " + tk.split("/")[1].replace("FT", " ft").replace("V", " varying to "),
          "RVR is measured along the runway in feet. It appears when the visibility is 1 mile or less, or the RVR is 6,000 ft or less. M means less than, P means more than.", "vis");
      } else if ((row = wxWeather(tk))) { /* weather */ }
      else if ((row = wxSky(tk))) {
        var cm = tk.match(/^(BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
        if (cm && summary.ceilFt === null) { summary.ceilFt = parseInt(cm[2], 10) * 100; summary.ceiling = row.m; }
      }
      else if ((row = wxTemp(tk))) { summary.temp = row.m; }
      else if ((row = wxAlt(tk))) { summary.alt = row.m; }
      else if (/^WS\d{3}\//.test(tk) || tk === "WS") row = wxRow(tk, "Wind shear", "", "wx");
    } else {
      /* remarks: some are written as two or three separate tokens */
      var joined = tk, eat = 0;
      if (/^(PK|SFC|TWR|CIG|VIS|WSHFT|SNINCR|PRESRR|PRESFR)$/.test(tk) && i + 1 < toks.length) {
        joined = tk + " " + toks[i + 1]; eat = 1;
        if (/^(PK WND|SFC VIS|TWR VIS)$/.test(joined) && i + 2 < toks.length) { joined += " " + toks[i + 2]; eat = 2; }
      }
      row = wxRemark(joined.replace(/\s+/g, ""), "");
      if (row && eat) { row.t = joined; i += eat; }
      if (!row && eat) { row = wxRemark(tk, ""); eat = 0; }
      if (!row) row = wxRow(tk, "", "Not decoded. Remarks can carry plain-language text an observer typed in.", "rmk-unknown");
    }
    if (!row) row = wxRow(tk, "", "Not recognised. Check for a typo, or it may be a group this decoder does not carry.", "unknown");
    out.push(row);
    i++;
  }
  summary.category = wxCat(summary.ceilFt, summary.visSM);
  return { rows: out, summary: summary, kind: "METAR" };
}

/* ---------- TAF ---------- */
function decodeTaf(raw) {
  var clean = raw.trim().toUpperCase().replace(/=+$/, "").replace(/\s+/g, " ");
  var toks = clean.split(" ").filter(Boolean);
  var out = [], i = 0, seenValid = false;
  var summary = { station: "", place: "", time: "", valid: "" };
  while (i < toks.length) {
    var tk = toks[i], row = null, m;
    if (tk === "TAF") row = wxRow(tk, "Terminal Aerodrome Forecast",
      "A TAF covers a 5 statute mile radius around the airport. It is somebody's forecast, not an observation. The METAR is what is happening.", "hdr");
    else if (tk === "AMD") row = wxRow(tk, "Amended forecast", "Issued when the original no longer represents what is expected. Always use the latest.", "hdr");
    else if (tk === "COR") row = wxRow(tk, "Corrected forecast", "", "hdr");
    else if (tk === "RTD") row = wxRow(tk, "Delayed forecast", "", "hdr");
    else if (i <= 2 && /^[A-Z][A-Z0-9]{3}$/.test(tk) && !WX_SKY[tk]) {
      var ap = (typeof findApt === "function") ? findApt(tk) : null;
      summary.station = tk;
      summary.place = ap ? ap.name + (ap.city ? ", " + ap.city + " " + ap.st : "") : "";
      row = wxRow(tk, "Station " + tk + (summary.place ? " — " + summary.place : ""),
        "Only about 700 US airports get a TAF. If yours does not, use the nearest one and add your own judgement.", "hdr");
    }
    else if ((m = tk.match(/^(\d{2})(\d{2})(\d{2})Z$/))) {
      summary.time = "Day " + parseInt(m[1], 10) + " at " + m[2] + ":" + m[3] + "Z";
      row = wxRow(tk, "Issued on day " + parseInt(m[1], 10) + " at " + m[2] + ":" + m[3] + " Zulu",
        "Routine TAFs come out four times a day: about 00, 06, 12 and 18 Zulu.", "time");
    }
    else if ((m = tk.match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/))) {
      if (!seenValid) {
        seenValid = true;
        summary.valid = "Day " + parseInt(m[1], 10) + " " + m[2] + "00Z to day " + parseInt(m[3], 10) + " " + m[4] + "00Z";
        row = wxRow(tk, "Valid from day " + parseInt(m[1], 10) + " at " + m[2] + "00Z until day " + parseInt(m[3], 10) + " at " + m[4] + "00Z",
          "Most TAFs run 24 hours, the busier fields 30. Check that your whole flight, plus the alternate, sits inside this window.", "time");
      } else {
        row = wxRow(tk, "Applies from day " + parseInt(m[1], 10) + " at " + m[2] + "00Z to day " + parseInt(m[3], 10) + " at " + m[4] + "00Z",
          "The window for the group in front of it.", "time");
      }
    }
    else if ((m = tk.match(/^FM(\d{2})(\d{2})(\d{2})$/))) {
      row = wxRow(tk, "FROM day " + parseInt(m[1], 10) + " at " + m[2] + ":" + m[3] + "Z — a rapid, permanent change",
        "FM wipes out everything before it. Every element is restated from this point on, so read the FM group on its own.", "grp");
    }
    else if (tk === "BECMG") row = wxRow(tk, "BECOMING — a gradual change across the window that follows",
      "The change happens somewhere inside the stated window, usually 2 hours. Only the elements listed change; everything else carries over.", "grp");
    else if (tk === "TEMPO") row = wxRow(tk, "TEMPORARY — expected for less than an hour at a time, and for less than half the window",
      "TEMPO conditions come and go. Plan for them; do not count on them being gone when you arrive.", "grp");
    else if ((m = tk.match(/^PROB(\d{2})$/))) row = wxRow(tk, "PROBABILITY — a " + m[1] + " percent chance of what follows",
      "Only PROB30 and PROB40 are used. Above that the forecaster states it outright. Below 30 it is not worth forecasting.", "grp");
    else if ((m = tk.match(/^WS(\d{3})\/(\d{3})(\d{2,3})KT$/))) {
      row = wxRow(tk, "Non-convective low-level wind shear at " + (parseInt(m[1], 10) * 100).toLocaleString() +
        " ft AGL, wind from " + parseInt(m[2], 10) + " degrees at " + parseInt(m[3], 10) + " knots",
        "Non-convective, and only used at or below 2,000 ft. The height is where the shear sits; the wind quoted is the wind ABOVE that height. Expect an airspeed excursion on the approach and carry a little extra.", "wx");
    }
    else if (tk === "NSW") row = wxRow(tk, "No significant weather — the weather forecast earlier has ended", "Only appears inside a TEMPO or BECMG group.", "wx");
    else if (tk === "AUTO") row = wxRow(tk, "Automated", "", "hdr");
    else if ((row = wxWind(tk))) { /* wind */ }
    else if (/^\d$/.test(tk) && i + 1 < toks.length && /^\d\/\dSM$/.test(toks[i + 1])) {
      row = wxVis(tk + " " + toks[i + 1]); if (row) { row.t = tk + " " + toks[i + 1]; i++; }
    }
    else if ((row = wxVis(tk))) { /* vis */ }
    else if ((row = wxWeather(tk))) { /* weather */ }
    else if ((row = wxSky(tk))) { /* sky */ }
    else if ((m = tk.match(/^(TX|TN)(M?\d{2})\/(\d{2})(\d{2})Z$/))) {
      row = wxRow(tk, (m[1] === "TX" ? "Maximum" : "Minimum") + " temperature " +
        (m[2].charAt(0) === "M" ? "-" + m[2].slice(1) : m[2]) + " C on day " + m[3] + " at " + m[4] + "00Z",
        "Only in the last line. Useful for density altitude and for frost.", "temp");
    }
    else if (tk === "RMK") row = wxRow(tk, "Remarks", "", "hdr");
    if (!row) row = wxRow(tk, "", "Not recognised. Check for a typo, or it may be a group this decoder does not carry.", "unknown");
    out.push(row);
    i++;
  }
  return { rows: out, summary: summary, kind: "TAF" };
}

/* ---------- PIREP ---------- */
var PIREP_F = {
  UA: ["Routine pilot report", "UA is routine. UUA is urgent."],
  UUA: ["URGENT pilot report", "Urgent means severe turbulence or icing, hail, a tornado, low-level wind shear, volcanic ash, or anything the pilot judges hazardous."],
  OV: ["Location", "Given in relation to a VOR: identifier, then radial and distance. LAL180010 is 10 NM out on the 180 radial from LAL. A route is written as two points joined by a dash."],
  TM: ["Time (Zulu)", "Four digits, UTC."],
  FL: ["Altitude or flight level", "In hundreds of feet. FL085 is 8,500 ft. DURC is during climb, DURD during descent, UNKN unknown."],
  TP: ["Aircraft type", "Needed to judge the report: moderate turbulence in a Cub is not moderate in a 737."],
  SK: ["Sky condition", "Cloud bases and tops. 041 TOP070 means base 4,100 ft, tops 7,000 ft."],
  WX: ["Flight visibility and weather", "Flight visibility in statute miles, then the weather using the same codes as a METAR."],
  TA: ["Outside air temperature", "Degrees Celsius. M means minus."],
  WV: ["Wind", "Direction in degrees MAGNETIC north and speed in knots (AIM Table 7-1-7). This is the one wind in aviation weather that is not true - a METAR and a TAF are true, a PIREP is magnetic."],
  TB: ["Turbulence", "Intensity, then type. LGT, MOD, SEV, EXTRM (AIM Table 7-1-10). CAT is clear air turbulence, normally above 15,000 ft and not associated with cumuliform cloud. CHOP is rapid rhythmic bumpiness without an appreciable change in altitude or attitude. OCNL is less than a third of the time, INTMT a third to two thirds, CONS more than two thirds."],
  IC: ["Icing", "Intensity then type: RIME, CLR (clear), MX (mixed). TRACE, LGT, MOD, SEV (AIM 7-1-21). Expect ice in visible moisture between +2 and -10 degrees Celsius."],
  RM: ["Remarks", "Anything in plain language the pilot wanted to add."]
};
function wxPirepVal(f, v) {
  var m;
  if (!v) return "";
  if (f === "OV") {
    if ((m = v.match(/^([A-Z]{3,4})(\d{3})(\d{2,3})$/)))
      return "on the " + parseInt(m[2], 10) + " degree radial, " + parseInt(m[3], 10) + " NM from " + m[1];
    if (/^[A-Z]{3,4}$/.test(v)) return "over " + v;
    return "";
  }
  if (f === "TM" && /^\d{4}$/.test(v)) return v.slice(0, 2) + ":" + v.slice(2) + " Zulu";
  if (f === "FL") {
    if (/^\d{3}$/.test(v)) return (parseInt(v, 10) * 100).toLocaleString() + " ft";
    if (v === "DURC") return "during the climb";
    if (v === "DURD") return "during the descent";
    if (v === "UNKN") return "the pilot did not give an altitude";
    return "";
  }
  if (f === "SK") {
    var out = [], re = /(SKC|CLR|FEW|SCT|BKN|OVC)(\d{3})?(?:-?TOPS?(\d{3}))?/g, g;
    while ((g = re.exec(v))) {
      var t = (WX_SKY[g[1]] ? WX_SKY[g[1]][0] : g[1]);
      if (g[2]) t += " base " + wxMsl(g[2]);
      if (g[3]) t += ", tops " + wxMsl(g[3]);
      out.push(t);
    }
    if (/^\d{3}$/.test(v)) out.push("base " + wxMsl(v));
    return out.join("; ");
  }
  if (f === "WX") {
    var p2 = [], fv = v.match(/FV(\d{2,3})SM/);
    if (fv) p2.push("flight visibility " + parseInt(fv[1], 10) + " SM");
    v.replace(/FV\d{2,3}SM/g, "").trim().split(/\s+/).forEach(function (w) {
      if (!w) return; var r = wxWeather(w); if (r) p2.push(r.m.toLowerCase());
    });
    return p2.join(", ");
  }
  if (f === "TA") { if (/^M?\d{1,2}$/.test(v)) return (v.charAt(0) === "M" ? "-" + v.slice(1) : v) + " C"; return ""; }
  if (f === "WV") {
    if ((m = v.match(/^(\d{3})(\d{2,3})(KT)?$/)))
      return "from " + parseInt(m[1], 10) + " degrees magnetic at " + parseInt(m[2], 10) + " knots";
    return "";
  }
  if (f === "TB" || f === "IC") {
    var lv = [];
    if (/EXTRM/.test(v)) lv.push("extreme");
    if (/SEV/.test(v)) lv.push("severe");
    if (/MOD/.test(v)) lv.push("moderate");
    if (/LGT|LT\b/.test(v)) lv.push("light");
    if (/TRACE|TRC/.test(v)) lv.push("trace");
    if (/NEG/.test(v)) lv.push("none reported");
    var kind = [];
    if (f === "TB") {
      if (/CAT/.test(v)) kind.push("clear air turbulence - normally above 15,000 ft, not associated with cumuliform cloud");
      if (/CHOP/.test(v)) kind.push("chop — rhythmic bumpiness, no appreciable change in altitude or attitude");
      if (/OCNL/.test(v)) kind.push("occasional - less than a third of the time");
      if (/INTMT/.test(v)) kind.push("intermittent - a third to two thirds of the time");
      if (/CONS/.test(v)) kind.push("continuous - more than two thirds of the time");
    } else {
      if (/RIME/.test(v)) kind.push("rime — rough, milky, opaque; it forms on the leading edges");
      if (/\bCLR\b|CLEAR/.test(v)) kind.push("clear — glossy and hard; it runs back before it freezes");
      if (/\bMX\b|MIXED/.test(v)) kind.push("mixed");
    }
    var band = v.match(/(\d{3})-(\d{3})/);
    var blw = v.match(/BLW\s?(\d{3})/), abv = v.match(/ABV\s?(\d{3})/);
    var where = band ? "between " + wxMsl(band[1]) + " and " + wxMsl(band[2]) :
      (blw ? "below " + wxMsl(blw[1]) : (abv ? "above " + wxMsl(abv[1]) : ""));
    return [lv.length ? lv.reverse().join(" to ") : "", kind.join(", "), where].filter(Boolean).join(", ");
  }
  return "";
}

function decodePirep(raw) {
  var clean = raw.trim().toUpperCase().replace(/\s+/g, " ").replace(/=+$/, "");
  var out = [], urgent = false;
  var summary = { station: "", urgent: false };
  var head = clean.match(/^([A-Z0-9]{3,4})\s+(UUA|UA)\b/);
  if (head) {
    var ap = (typeof findApt === "function") ? findApt(head[1]) : null;
    summary.station = head[1];
    out.push(wxRow(head[1], "Reported near " + head[1] + (ap ? " — " + ap.name : ""),
      "The nearest weather-reporting location, not necessarily where the aircraft was. The real position is in /OV.", "hdr"));
    urgent = head[2] === "UUA";
    summary.urgent = urgent;
    out.push(wxRow(head[2], PIREP_F[head[2]][0], PIREP_F[head[2]][1], urgent ? "urgent" : "hdr"));
    clean = clean.slice(head[0].length);
  }
  clean.split(/\s*\/\s*/).filter(function (x) { return x.trim(); }).forEach(function (p) {
    var m = p.match(/^([A-Z]{2})\s*(.*)$/);
    if (m && PIREP_F[m[1]]) {
      var f = m[1], val = m[2].trim();
      var plain = wxPirepVal(f, val);
      var mean = PIREP_F[f][0] + (val ? ": " + val : "") + (plain ? " — " + plain : "");
      out.push(wxRow("/" + f + " " + val, mean, PIREP_F[f][1],
        (f === "TB" || f === "IC") ? "wx" : (f === "OV" || f === "TM" ? "hdr" : "")));
    } else out.push(wxRow(p, "", "Not a standard PIREP field.", "unknown"));
  });
  return { rows: out, summary: summary, kind: "PIREP" };
}

function wxDetect(raw) {
  var s = raw.trim().toUpperCase();
  if (/^TAF\b/.test(s) || /\d{4}\/\d{4}/.test(s.split(/\s+/).slice(0, 4).join(" "))) return "TAF";
  if (/\bU{1,2}A\b/.test(s) && /\/(OV|TM|FL|TP|SK|TA|TB|IC|RM)\b/.test(s)) return "PIREP";
  return "METAR";
}
function wxDecode(raw, force) {
  var k = force && force !== "auto" ? force : wxDetect(raw);
  if (k === "TAF") return decodeTaf(raw);
  if (k === "PIREP") return decodePirep(raw);
  return decodeMetar(raw);
}


  var WX_SAMPLES = [
    { k: "METAR", n: "A quiet day",
      v: "METAR KFXE 061653Z VRB05KT 10SM SCT040 32/23 A2992 RMK AO2 SLP133 T03220233" },
    { k: "METAR", n: "Thunderstorm at the field",
      v: "METAR KMIA 121853Z 09014G22KT 060V120 1 1/2SM +TSRA BR BKN008CB OVC020 25/24 A2985 RMK AO2 PK WND 09028/1832 WSHFT 1815 TSB18RAB18 OCNL LTGICCG OHD P0018 SLP103 T02500239" },
    { k: "METAR", n: "Freezing rain and fog",
      v: "METAR KDEN 121553Z 36018G28KT 1/2SM R35L/1800V4000FT -FZRA FG VV004 M02/M03 A2968 RMK AO2 SFC VIS 3/4 P0002 SLP041 T10171028" },
    { k: "TAF", n: "A TAF with every group in it",
      v: "TAF KPIT 091730Z 0918/1024 15005KT 5SM HZ FEW020 WS010/31022KT FM091930 30015G25KT 3SM SHRA OVC015 TEMPO 0920/0922 1/2SM +TSRA OVC008CB FM100100 27008KT 5SM SHRA BKN020 OVC040 PROB30 1004/1007 1SM -RA BR FM101015 18005KT 6SM -SHRA OVC020 BECMG 1013/1015 P6SM NSW SKC" },
    { k: "PIREP", n: "A routine report",
      v: "KCMH UA /OV APE230010 /TM 1516 /FL085 /TP BE20 /SK BKN065 /WX FV03SM HZ FU /TA 20 /TB LGT" },
    { k: "PIREP", n: "An urgent one",
      v: "KDEN UUA /OV DEN270020 /TM 2015 /FL120 /TP B738 /SK BKN050-TOP090 /TB SEV CAT /IC MOD RIME 080-120 /RM DURD" }
  ];

  var WX_TABLES = [
    { h: "Intensity and proximity", d: "Goes in front of the weather group.",
      rows: [["-", "Light"], ["", "Moderate — nothing in front means moderate"],
             ["+", "Heavy, or well-developed in the case of a funnel cloud"],
             ["VC", "In the vicinity — 5 to 10 statute miles from the station, not at it"]] },
    { h: "Descriptors", d: "One only, and it comes before the phenomenon.", dict: "desc" },
    { h: "Precipitation", d: "These take an intensity sign.", dict: "precip" },
    { h: "Obscurations and other phenomena", d: "These do not take an intensity sign.", dict: "obsc" },
    { h: "Sky cover", d: "Coverage is in eighths of the sky. Only BKN, OVC and VV are ceilings.", dict: "sky" },
    { h: "Remarks you will actually see", d: "Everything after RMK.", dict: "rmk" }
  ];
  var WX_PRECIP = ["DZ", "RA", "SN", "SG", "IC", "PL", "GR", "GS", "UP"];

  function wxTableRows(which) {
    var out = [];
    if (which === "desc") {
      ["MI", "BC", "PR", "DR", "BL", "SH", "TS", "FZ"].forEach(function (k) { out.push([k, cap(WX_DESC[k])]); });
    } else if (which === "precip") {
      WX_PRECIP.forEach(function (k) { out.push([k, cap(WX_WX[k])]); });
    } else if (which === "obsc") {
      ["BR", "FG", "FU", "VA", "DU", "SA", "HZ", "PY", "PO", "SQ", "FC", "SS", "DS"].forEach(function (k) { out.push([k, cap(WX_WX[k])]); });
    } else if (which === "sky") {
      out = [["SKC", "Sky clear — 0 eighths"], ["CLR", "Clear below 12,000 ft — an automated station only"],
             ["FEW", "Few — more than 0 up to 2 eighths. Never a ceiling"],
             ["SCT", "Scattered — 3 to 4 eighths. Never a ceiling"],
             ["BKN", "Broken — 5 to 7 eighths. This is a ceiling"],
             ["OVC", "Overcast — 8 eighths. This is a ceiling"],
             ["VV", "Vertical visibility — the sky is obscured. This is a ceiling"],
             ["CB", "Cumulonimbus, appended to the layer"], ["TCU", "Towering cumulus, appended to the layer"]];
    } else if (which === "rmk") {
      out = [["AO1", "Automated, cannot tell rain from snow"], ["AO2", "Automated, can tell rain from snow"],
             ["SLP132", "Sea level pressure 1013.2 hPa — not the altimeter setting"],
             ["T01820159", "Temperature 18.2 C, dew point 15.9 C. A leading 1 means minus"],
             ["PK WND 09028/1832", "Peak wind 090 at 28 kt at 1832Z"],
             ["WSHFT 1815", "Wind shift at 1815Z"], ["FROPA", "A front went through"],
             ["RAB18E42", "Rain began at :18, ended at :42"],
             ["LTGICCG", "Lightning, in cloud and cloud to ground"],
             ["DSNT", "More than 10 SM away"], ["VC", "5 to 10 SM away"], ["OHD", "Overhead"],
             ["P0018", "0.18 inches of precipitation in the last hour"],
             ["CIG 008V012", "Ceiling varying between 800 and 1,200 ft"],
             ["TSNO", "No thunderstorm information available"], ["$", "The station needs maintenance"]];
    }
    return out;
  }
  function cap(s) { return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1); }

  var WX_CAT_ROWS = [
    ["VFR", "Greater than 3,000 ft", "and", "Greater than 5 SM"],
    ["MVFR", "1,000 to 3,000 ft", "and/or", "3 to 5 SM"],
    ["IFR", "500 to below 1,000 ft", "and/or", "1 SM to less than 3 SM"],
    ["LIFR", "Below 500 ft", "and/or", "Less than 1 SM"]
  ];

  /* ---- rendering a decoded report ---- */
  function wxRowsHtml(res) {
    if (!res || !res.rows.length) return '<div class="wx-empty">Nothing to decode yet.</div>';
    return '<div class="wx-rows">' + res.rows.map(function (r) {
      var unk = r.k.indexOf("unknown") >= 0;
      return '<div class="wx-r' + (unk ? " unk" : "") + (r.k === "urgent" ? " urg" : "") + '">' +
        '<div class="tk mono">' + esc(r.t) + "</div>" +
        '<div class="mn">' + (r.m ? esc(r.m) : '<i class="und">not decoded</i>') +
        (r.n ? '<div class="nt">' + esc(r.n) + "</div>" : "") + "</div></div>";
    }).join("") + "</div>";
  }
  function wxSumHtml(res) {
    var s = res.summary || {};
    if (res.kind === "METAR") {
      var c = s.category;
      var h = '<div class="wx-sum">';
      if (c) h += '<div class="wx-cat c' + c.cat + '"><b>' + c.cat + "</b><span>" + esc(c.why) + "</span></div>";
      [["Station", s.station + (s.place ? " · " + s.place : "")], ["Time", s.time],
       ["Wind", s.wind], ["Visibility", s.vis], ["Ceiling", s.ceiling || "No ceiling reported"],
       ["Temp / dew point", s.temp], ["Altimeter", s.alt]].forEach(function (p) {
        if (p[1]) h += '<div class="wx-s"><span>' + esc(p[0]) + "</span><b>" + esc(p[1]) + "</b></div>";
      });
      return h + "</div>";
    }
    if (res.kind === "TAF") {
      var h2 = '<div class="wx-sum">';
      [["Station", s.station + (s.place ? " · " + s.place : "")], ["Issued", s.time], ["Valid", s.valid]].forEach(function (p) {
        if (p[1]) h2 += '<div class="wx-s"><span>' + esc(p[0]) + "</span><b>" + esc(p[1]) + "</b></div>";
      });
      return h2 + "</div>";
    }
    if (res.kind === "PIREP" && s.urgent) {
      return '<div class="wx-sum"><div class="wx-cat cLIFR"><b>UUA</b><span>Urgent pilot report</span></div></div>';
    }
    return "";
  }
  function wxResultHtml(raw, force) {
    if (!String(raw || "").trim()) return '<div class="wx-empty">Paste a report above, or press one of the examples.</div>';
    var res;
    try { res = wxDecode(raw, force); }
    catch (e) { return '<div class="wx-empty">That could not be read as a weather report.</div>'; }
    return '<div class="wx-kind"><span class="chip k">' + esc(res.kind) + "</span>" +
      '<span class="muted sm">' + (res.kind === "METAR" ? "An observation — what was measured at the field." :
        res.kind === "TAF" ? "A forecast — what is expected in a 5 SM circle around the field." :
        "A pilot report — what an aircraft actually found.") + "</span></div>" +
      wxSumHtml(res) + wxRowsHtml(res);
  }

  /* ---- live fetch from the Aviation Weather Center ---- */
  function wxUrl(kind, id) {
    return "https://aviationweather.gov/api/data/" + kind +
      "?ids=" + encodeURIComponent(id) + "&format=raw" + (kind === "metar" ? "&taf=false" : "");
  }
  function wxGet(kind, id) {
    var ctl = (typeof AbortController === "function") ? new AbortController() : null;
    var tm = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(wxUrl(kind, id), ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(tm);
      if (!r.ok) throw new Error("The Aviation Weather Center answered " + r.status + ".");
      return r.text();
    });
  }
  function wxLiveBox(kind, id, text) {
    var t = String(text || "").trim();
    var label = kind === "metar" ? "METAR" : "TAF";
    if (!t) return '<div class="wx-live-box"><div class="h">' + label + "</div>" +
      '<p class="muted sm">Nothing published for ' + esc(id) + '. Only about 700 US airports get a TAF; ' +
      "for the rest, use the nearest one that does and add your own judgement.</p></div>";
    return '<div class="wx-live-box"><div class="h">' + label +
      '<button class="btn sm ghost" data-wxuse="' + esc(t.replace(/"/g, "&quot;")) + '">Decode this</button></div>' +
      '<pre class="wx-raw mono">' + esc(t) + "</pre>" +
      wxResultHtml(t, label) + "</div>";
  }

  function pageWx() {
    var W = SC("weather") || {};
    var items = [{ id: "wx-live", t: (W.live && W.live.h) || "Get the current METAR and TAF" },
                 { id: "wx-dec", t: (W.dec && W.dec.h) || "Decode a report" },
                 { id: "wx-cat", t: (W.cat && W.cat.h) || "Flight categories" },
                 { id: "wx-tab", t: "The code tables" },
                 { id: "wx-teach", t: "Teaching it" }];
    var h = '<div class="crumb"><a href="#/">Start</a> <span>\u203a</span> <a href="#/tools">Useful resources</a> ' +
      '<span>\u203a</span> <span>Weather</span></div>' +
      '<div class="eyebrow">Useful resources</div>' +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">METAR, TAF and PIREP decoder</h1>' +
      '<p class="lede">' + fmt(W.intro || "") + "</p>" +
      '<div class="erow" style="margin:14px 0 4px"><a class="btn ghost sm" href="' + here("t/III.C") + '">' + I.book +
      " ACS Task III.C &mdash; Weather Information</a>" +
      '<span class="muted sm">AI.III.C.K2a, K2c and R2b are the elements this page serves.</span></div>' +
      toc(items);

    /* live */
    h += '<section class="blk" id="wx-live"><h2>' + esc((W.live && W.live.h) || "") + "</h2>" +
      '<p class="lede" style="font-size:15px;margin-bottom:16px">' + fmt((W.live && W.live.d) || "") + "</p>" +
      '<div class="xc-in"><label for="wxSta">Station identifier</label>' +
      '<input id="wxSta" type="text" maxlength="8" placeholder="KFXE" autocomplete="off" spellcheck="false"></div>' +
      '<div class="xc-btns"><button class="btn" id="wxGet">' + I.search + " Get the weather</button>" +
      ["KFXE", "KMIA", "KDEN", "KORD"].map(function (c) {
        return '<button class="pill" data-wxsta="' + c + '">' + c + "</button>";
      }).join("") + "</div>" +
      '<div id="wxLive"></div>' +
      '<div class="note" id="wxNote"><span class="lbl">Why there are two ways to do this</span>' +
      "A page saved on your own computer is not allowed to reach out to the internet on its own \u2014 that is a " +
      "browser security rule, not a fault in the page. So the button does two things: it <b>tries</b> to fetch " +
      "the reports directly, and it always gives you one-click links that open them at the Aviation Weather " +
      "Center. Copy what you see there, paste it in below, and it decodes instantly. " +
      "<b>The decoder never needs a connection at all.</b></div>" +
      "</section>";

    /* decoder */
    h += '<section class="blk" id="wx-dec"><h2>' + esc((W.dec && W.dec.h) || "") + "</h2>" +
      '<p class="lede" style="font-size:15px;margin-bottom:14px">' + fmt((W.dec && W.dec.d) || "") + "</p>" +
      '<div class="tabs" id="wxKind">' +
      [["auto", "Work it out"], ["METAR", "METAR"], ["TAF", "TAF"], ["PIREP", "PIREP"]].map(function (t, i) {
        return '<button class="tab' + (i === 0 ? " on" : "") + '" data-wxk="' + t[0] + '">' + t[1] + "</button>";
      }).join("") + "</div>" +
      '<textarea id="wxIn" class="wx-in mono" rows="4" spellcheck="false" ' +
      'placeholder="METAR KFXE 061653Z VRB05KT 10SM SCT040 32/23 A2992 RMK AO2"></textarea>' +
      '<div class="xc-btns"><button class="btn" id="wxGo">' + I.check + " Decode</button>" +
      '<button class="btn ghost sm" id="wxClr">Clear</button></div>' +
      '<div class="wx-ex"><span class="muted sm">Examples:</span>' +
      WX_SAMPLES.map(function (s, i) {
        return '<button class="pill" data-wxex="' + i + '"><b>' + s.k + "</b> " + esc(s.n) + "</button>";
      }).join("") + "</div>" +
      '<div id="wxOut">' + wxResultHtml("", "auto") + "</div></section>";

    /* categories */
    h += '<section class="blk" id="wx-cat"><h2>' + esc((W.cat && W.cat.h) || "") + "</h2>" +
      '<p class="lede" style="font-size:15px;margin-bottom:16px">' + fmt((W.cat && W.cat.d) || "") + "</p>" +
      '<div class="tablewrap"><table class="wx-cattab"><thead><tr><th>Category</th><th>Ceiling</th><th></th><th>Visibility</th></tr></thead><tbody>' +
      WX_CAT_ROWS.map(function (r) {
        return '<tr><td><span class="wx-badge c' + r[0] + '">' + r[0] + "</span></td>" +
          "<td>" + esc(r[1]) + '</td><td class="jn">' + esc(r[2]) + "</td><td>" + esc(r[3]) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<div class="note gold"><span class="lbl">A category is not a legal minimum</span>' +
      fmt((W.cat && W.cat.note) || "") + "</div></section>";

    /* code tables */
    h += '<section class="blk" id="wx-tab"><h2>The code tables <span class="hint">Open the one you need</span></h2>' +
      WX_TABLES.map(function (t) {
        var rows = t.rows || wxTableRows(t.dict);
        return '<details class="fx"><summary><span class="fn">' + esc(t.h) + "</span>" +
          '<span class="ff mono">' + rows.length + " codes</span></summary><div class=\"fx-b\">" +
          '<p class="fwhy">' + esc(t.d) + "</p>" +
          '<div class="wx-codes">' + rows.map(function (r) {
            return '<div class="wx-c"><b class="mono">' + esc(r[0] || "\u2014") + "</b><span>" + esc(r[1]) + "</span></div>";
          }).join("") + "</div></div></details>";
      }).join("") + "</section>";

    /* teaching */
    if (W.teach && W.teach.length) {
      h += '<section class="blk" id="wx-teach"><h2>Teaching it <span class="hint">' +
        "What students get wrong, and how to catch it</span></h2>" +
        W.teach.map(function (t) {
          return '<div class="cblk"><div class="top"><h3>' + esc(t.h) + "</h3></div>" +
            "<p>" + fmt(t.d) + "</p></div>";
        }).join("") + "</section>";
    }
    if (W.refs && W.refs.length) {
      h += '<section class="blk"><h2>Where this comes from</h2><div class="rlist">' +
        W.refs.map(function (r) {
          return '<a class="rl" href="' + esc(r.u) + '" target="_blank" rel="noopener"><span class="ic">' +
            I.book + "</span><span><b>" + esc(r.t) + "</b></span></a>";
        }).join("") + "</div></section>";
    }
    h += '<div class="note flag"><span class="lbl">Use it to learn, not to dispatch</span>' +
      "This decoder is a teaching aid written for this site. It carries the groups you meet in normal training, " +
      "not every group in the manual, and an unusual remark may come back undecoded. The report itself is the " +
      "authority; when it matters, read it against the Aviation Weather Handbook and get a real briefing.</div>";
    return h;
  }

  function wxDecodeNow() {
    var k = document.querySelector("#wxKind .tab.on");
    el("wxOut").innerHTML = wxResultHtml(el("wxIn").value, k ? k.getAttribute("data-wxk") : "auto");
  }
  function wxUse(text) {
    el("wxIn").value = text;
    var tabs = document.querySelectorAll("#wxKind .tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-wxk") === "auto");
    wxDecodeNow();
    var n = el("wx-dec"); if (n) n.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  function wxFetchStation() {
    var id = (el("wxSta").value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    var host = el("wxLive");
    if (!id) { host.innerHTML = '<div class="wx-empty">Type an identifier first \u2014 KFXE, or just FXE.</div>'; return; }
    if (id.length === 3) id = "K" + id;
    var ap = findApt(id);
    var head = '<div class="wx-station"><b>' + esc(id) + "</b>" +
      (ap ? "<span>" + esc(ap.name + (ap.city ? " \u00b7 " + ap.city + " " + ap.st : "")) + "</span>" :
            '<span class="muted">Not in the airport list \u2014 the lookup will still try.</span>') + "</div>";
    host.innerHTML = head + wxManual(id, true);
    if (typeof fetch !== "function") return;
    Promise.all([wxGet("metar", id).catch(function () { return null; }),
                 wxGet("taf", id).catch(function () { return null; })])
      .then(function (r) {
        var m = r[0], t = r[1];
        if (m == null && t == null) return;                 /* manual panel stays */
        host.innerHTML = head +
          '<div class="wx-live">' + wxLiveBox("metar", id, m || "") + wxLiveBox("taf", id, t || "") + "</div>" +
          wxManual(id, false);
      })
      .catch(function () { });
  }
  /* the panel that always works: open the report, then paste it in */
  function wxManual(id, primary) {
    return '<div class="wx-manual' + (primary ? " lead" : " quiet") + '">' +
      '<div class="h">' + (primary ? "Get it in two clicks" : "Or fetch it yourself") + "</div>" +
      '<ol class="wx-steps"><li>Open the report \u2014 it comes back as one line of plain text.<div class="wx-open">' +
      '<a class="btn sm" href="' + esc(wxUrl("metar", id)) + '" target="_blank" rel="noopener">METAR for ' + esc(id) + "</a>" +
      '<a class="btn sm ghost" href="' + esc(wxUrl("taf", id)) + '" target="_blank" rel="noopener">TAF for ' + esc(id) + "</a>" +
      '<a class="btn sm ghost" href="https://aviationweather.gov/" target="_blank" rel="noopener">aviationweather.gov</a>' +
      "</div></li>" +
      "<li>Select it and copy it.</li>" +
      '<li>Paste it into the box below and it decodes as you let go. <button class="btn sm ghost" data-wxjump>Take me to the box</button></li>' +
      "</ol></div>";
  }

  function wireWx() {
    if (!el("wxGo")) return;
    el("wxGo").addEventListener("click", wxDecodeNow);
    el("wxClr").addEventListener("click", function () { el("wxIn").value = ""; wxDecodeNow(); el("wxIn").focus(); });
    el("wxIn").addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") wxDecodeNow();
    });
    var tabs = document.querySelectorAll("#wxKind .tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", function () {
      var all = document.querySelectorAll("#wxKind .tab");
      for (var j = 0; j < all.length; j++) all[j].classList.toggle("on", all[j] === this);
      wxDecodeNow();
    });
    var ex = document.querySelectorAll("[data-wxex]");
    for (var e2 = 0; e2 < ex.length; e2++) ex[e2].addEventListener("click", function () {
      var s = WX_SAMPLES[+this.getAttribute("data-wxex")];
      el("wxIn").value = s.v;
      var all = document.querySelectorAll("#wxKind .tab");
      for (var j = 0; j < all.length; j++) all[j].classList.toggle("on", all[j].getAttribute("data-wxk") === "auto");
      wxDecodeNow();
    });
    el("wxGet").addEventListener("click", wxFetchStation);
    el("wxSta").addEventListener("keydown", function (e) { if (e.key === "Enter") wxFetchStation(); });
    var st = document.querySelectorAll("[data-wxsta]");
    for (var s2 = 0; s2 < st.length; s2++) st[s2].addEventListener("click", function () {
      el("wxSta").value = this.getAttribute("data-wxsta"); wxFetchStation();
    });
    el("wxLive").addEventListener("click", function (e) {
      var b = e.target.closest("[data-wxuse]");
      if (b) { wxUse(b.getAttribute("data-wxuse")); return; }
      if (e.target.closest("[data-wxjump]")) {
        var n = el("wx-dec"); if (n) n.scrollIntoView({ block: "start", behavior: "smooth" });
        setTimeout(function () { el("wxIn").focus(); }, 350);
      }
    });
    /* decoding the moment something is pasted is the whole point of the manual route */
    el("wxIn").addEventListener("paste", function () { setTimeout(wxDecodeNow, 0); });
  }

  /* ---------- useful resources hub ---------- */
  function pageTools() {
    var h = '<div class="eyebrow">Useful resources</div>' +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Tools and other resources</h1>' +
      '<p class="lede">The working end of the site. The formulas you are expected to know, a flight computer ' +
      "that runs in the page, a weather decoder, and a cross-country nav log you can fill in and print.</p>";
    h += '<div class="grid g2" style="margin-top:24px">' +
      tool(here("formulas"), I.calc, "Formulas and worked examples",
        "Pressure and density altitude, wind, load factor, weight and balance, descent planning and more - each with the units and a worked example.") +
      tool(here("navlog"), I.grid, "Cross-country nav log",
        "An interactive nav log that does the arithmetic. Written for somebody who has never filled one in, and it prints.") +
      tool(here("wx"), I.cloud, "METAR, TAF and PIREP decoder",
        "Paste any report and get it group by group, with a note on what each one is telling you \u2014 and pull the current METAR and TAF for any station.") +
      tool(here("holding"), I.grid, "Holding entries, drawn",
        "Set the inbound course and your heading and the diagram draws the pattern, names the entry and shows you the sector you came from.") +
      tool(here("cdi"), I.badge, "What the needle is telling you",
        "A VOR head and an HSI side by side on the same situation \u2014 including the one case where they disagree, which is reverse sensing.") +
      tool(here("fplan"), I.sign, "ICAO flight plan builder",
        "Fill in FAA Form 7233-4 box by box, with every code explained and the usual filing errors caught. Download it, and see which nav log number feeds which item.") +
      "</div>";
    h += '<section class="blk"><h2>E6B flight computer</h2>' +
      '<p class="lede" style="font-size:15.5px">Eleven calculators in a pop-up, on any page of this site: wind and ' +
      "heading, runway crosswind, pressure and density altitude, time-speed-distance, fuel, weight and balance, " +
      "turns and load factor, pivotal altitude, climb gradient, descent planning, and conversions. It runs " +
      "entirely in your " +
      "browser.</p>" +
      '<div class="erow" style="margin:16px 0 22px"><button class="btn" data-open-e6b>' + I.calc +
      " Open the E6B</button><span class=\"muted sm\">Or press <b>E</b> from anywhere on the site.</span></div>" +
      '<div class="note"><span class="lbl">On a phone or in the cockpit</span>' +
      "A web page is fine for planning at a desk. In the airplane, use a real one. Sporty\u2019s E6B is the " +
      "standard app and it is what most students end up with:<br><br>" +
      '<a href="https://apps.apple.com/us/app/sportys-e6b-flight-computer/id371817955" target="_blank" rel="noopener">Sporty\u2019s E6B Flight Computer &mdash; App Store (iOS)</a><br>' +
      '<a href="https://play.google.com/store/apps/details?id=com.sportys.android.e6b&hl=en_US" target="_blank" rel="noopener">Sporty\u2019s E6B &mdash; Google Play (Android)</a><br><br>' +
      "And learn the manual E6B too. It is on the ground portion of the checkride, the battery never dies, " +
      "and turning the wheel teaches you what the numbers mean in a way that typing does not.</div></section>";
    return h;
  }

  function pageFormulas() {
    var F = SC("formulas") || {};
    var items = (F.groups || []).map(function (g) { return { id: "fg-" + slug(g.h), t: g.h }; });
    var h = '<div class="crumb"><a href="#/">Start</a> <span>\u203a</span> <a href="#/tools">Useful resources</a> ' +
      '<span>\u203a</span> <span>Formulas</span></div>' +
      '<div class="eyebrow">Useful resources</div>' +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">Formulas and worked examples</h1>' +
      '<p class="lede">' + fmt(F.intro || "") + "</p>" +
      '<div class="erow" style="margin:16px 0"><button class="btn" data-open-e6b>' + I.calc +
      " Open the E6B</button><span class=\"muted sm\">Try any of these with your own numbers.</span></div>" +
      (F.note ? '<div class="note gold"><span class="lbl">Before you use any of it</span>' + fmt(F.note) + "</div>" : "") +
      toc(items);
    (F.groups || []).forEach(function (g) {
      h += '<section class="blk" id="fg-' + slug(g.h) + '"><h2>' + esc(g.h) + "</h2>" +
        (g.d ? '<p class="lede" style="font-size:15px;margin-bottom:16px">' + fmt(g.d) + "</p>" : "");
      (g.items || []).forEach(function (it) {
        h += '<details class="fx"><summary><span class="fn">' + esc(it.n) + "</span>" +
          '<span class="ff mono">' + esc(it.f.split("      ")[0]) + "</span></summary>" +
          '<div class="fx-b"><div class="fbig mono">' + esc(it.f) + "</div>" +
          (it.why ? '<p class="fwhy">' + fmt(it.why) + "</p>" : "") +
          (it.vars && it.vars.length ? '<dl class="fvars">' + it.vars.map(function (v) {
            return "<dt class=\"mono\">" + esc(v[0]) + "</dt><dd>" + esc(v[1]) + "</dd>";
          }).join("") + "</dl>" : "") +
          '<div class="fex"><div class="fex-h">Worked example</div>' +
          it.ex.map(function (line) { return "<div>" + fmt(line) + "</div>"; }).join("") + "</div>" +
          (it.tip ? '<div class="ftip">' + fmt(it.tip) + "</div>" : "") +
          (it.ref ? '<div class="ref">' + esc(it.ref) + "</div>" : "") +
          "</div></details>";
      });
      h += "</section>";
    });
    return h;
  }

  function pageNavlog() {
    var N = SC("navlog") || {};
    var items = [{ id: "nl-brief", t: (N.brief && N.brief.h) || "Get the briefing first" },
                 { id: "nl-steps", t: "Before you touch the log" },
                 { id: "nl-log", t: "The nav log" },
                 { id: "nl-dev", t: "The compass deviation card" },
                 { id: "nl-fields", t: "What every box means" },
                 { id: "nl-after", t: "In the airplane" }];
    var h = '<div class="crumb no-print"><a href="#/">Start</a> <span>›</span> ' +
      '<a href="#/tools">Useful resources</a> <span>›</span> <span>Nav log</span></div>' +
      '<div class="eyebrow no-print">Cross-country flight planning</div>' +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">Navigation log</h1>' +
      '<p class="lede no-print">' + fmt(N.intro || "") + "</p>" +
      '<div class="no-print">' + toc(items) + "</div>";

    if (N.brief) {
      h += '<section class="blk no-print" id="nl-brief"><h2>' + esc(N.brief.h) + "</h2>" +
        '<div class="note flag"><span class="lbl">AC 91-92 &middot; Pilot’s Guide to a Preflight Briefing</span>' +
        (N.brief.body || "").split("\n").filter(Boolean).map(fmt).join("<br><br>") +
        '<br><br><a href="https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_91-92.pdf" target="_blank" rel="noopener">Read AC 91-92 (PDF)</a></div>' +
        (N.brief.points ? '<div class="sh">Look at these, in this order</div><ul class="errs">' +
          N.brief.points.map(function (b) { return "<li>" + fmt(b) + "</li>"; }).join("") + "</ul>" : "") +
        "</section>";
    }
    if (N.steps) {
      h += '<section class="blk no-print" id="nl-steps"><h2>Before you touch the log</h2><ol class="flow">' +
        N.steps.map(function (s) { return "<li><b>" + esc(s.n) + ".</b> " + fmt(s.d) + "</li>"; }).join("") +
        "</ol></section>";
    }
    h += '<section class="blk" id="nl-log"><h2>The nav log <span class="hint no-print">' +
      "White boxes are yours. Grey ones work themselves out.</span></h2>" +
      '<p class="lede no-print" style="font-size:15px;margin-bottom:14px">' +
      "Never filled one in? Press <b>Build a sample nav log</b> underneath and read a finished one first, " +
      "then clear it and do your own.</p>" +
      '<div id="nlHost">' + navlogHtml() + "</div></section>";

    h += '<section class="blk no-print" id="nl-dev"><h2>The compass deviation card</h2>' +
      '<p class="lede" style="font-size:15px;margin-bottom:14px">' +
      "The last step of the chain is <b>MH + deviation = CH</b>, and deviation comes off a small card " +
      "screwed to the panel near the magnetic compass. The card is made by <b>swinging the compass</b> on a " +
      "compass rose: the airplane is lined up on known magnetic headings and the error is written down, so " +
      "the card belongs to <b>that airframe with that equipment</b>. Add a radio, a strobe, or anything " +
      "electrical and the card has to be made again.</p>" +
      '<div class="note gold"><span class="lbl">This one is an example</span>' +
      "The card below is here so the sample nav log has something to work from. <b>It is not your " +
      "airplane’s card.</b> Read the real one off the panel before every flight you plan for real. " +
      "Read it as: for the magnetic heading in the top line, steer the compass heading underneath it.</div>" +
      '<div class="devwrap">' + devCardHtml() + "</div>" +
      '<div class="sh">How to use it</div><ul class="errs">' +
      "<li>Work out MH first: true course, plus or minus wind correction, plus or minus variation.</li>" +
      "<li>Find that MH in a <b>FOR</b> row. If it falls between two of them, split the difference.</li>" +
      "<li>The number under it is what you actually steer on the compass — that is CH.</li>" +
      "<li>Deviation is small, usually only a few degrees, and it changes with heading. It is not one number " +
      "for the whole flight, which is exactly why the nav log has a Dev box on every line.</li>" +
      "<li><b>TVMDC:</b> True → Variation → Magnetic → Deviation → Compass. " +
      "Going that way you <i>add</i> west. Coming back the other way you add east.</li>" +
      "</ul></section>";

    if (N.fields) {
      h += '<section class="blk no-print" id="nl-fields"><h2>What every box means <span class="hint">' +
        "Open the one you are stuck on</span></h2>" +
        (function () {
          var out = "", seen = "";
          N.fields.forEach(function (f) {
            if (f.g && f.g !== seen) { seen = f.g; out += '<div class="sh">' + esc(f.g) + "</div>"; }
            out += '<details class="fx"><summary><span class="fn">' + esc(f.h) + "</span>" +
              '<span class="ff mono">' + esc(f.k) + "</span></summary><div class=\"fx-b\">" +
              "<p class=\"fwhy\">" + fmt(f.d) + "</p>" +
              (f.how ? '<div class="fex"><div class="fex-h">How to fill it in</div><div>' + fmt(f.how) + "</div></div>" : "") +
              (f.tip ? '<div class="ftip">' + fmt(f.tip) + "</div>" : "") + "</div></details>";
          });
          return out;
        })() + "</section>";
    }
    if (N.after) {
      h += '<section class="blk no-print" id="nl-after"><h2>In the airplane</h2><ul class="errs">' +
        N.after.map(function (b) { return "<li>" + fmt(b) + "</li>"; }).join("") + "</ul></section>";
    }
    if (N.refs) {
      h += '<section class="blk no-print"><h2>Where this comes from</h2><div class="rlist">' +
        N.refs.map(function (r) {
          return '<a class="rl" href="' + esc(r.u) + '" target="_blank" rel="noopener"><span class="ic">' +
            I.book + "</span><span><b>" + esc(r.t) + "</b></span></a>";
        }).join("") + "</div></section>";
    }
    return h;
  }

  /* ---------- FOI mnemonics ---------- */
  function mnemCard(m, open) {
    var dag = false;
    var rows = m.items.map(function (it) {
      if (it[4]) dag = true;
      return "<tr><td class=\"l mono\">" + esc(it[0]) + "</td>" +
        '<td class="w">' + esc(it[1]) + "</td>" +
        '<td class="m">' + esc(it[2]) + "</td>" +
        '<td class="p mono' + (it[4] ? " dag" : "") + '">' + esc(it[3] || "—") +
        (it[4] ? "†" : "") + "</td></tr>";
    }).join("");
    return '<details class="mn"' + (open ? " open" : "") + ' data-k="' +
      esc((m.n + " " + m.t + " " + m.codes.join(" ") + " " +
           m.items.map(function (i) { return i[1] + " " + i[2]; }).join(" ")).toLowerCase()) + '">' +
      "<summary><b>" + esc(m.n) + "</b><span>" + esc(m.t) + "</span>" +
      m.codes.map(function (c) { return '<i class="mono">' + esc(c) + "</i>"; }).join("") + "</summary>" +
      '<div class="mn-b"><table class="mn-t"><thead><tr><th></th><th>Stands for</th>' +
      "<th>What it means</th><th>AIH page</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      (m.src ? '<div class="mn-s">Source: ' + esc(m.src) + "</div>" : "") +
      (m.note ? '<div class="mn-n">† ' + esc(m.note) + "</div>" :
        (dag ? '<div class="mn-n">† That page is not printed in FAA-H-8083-9B.</div>' : "")) +
      "</div></details>";
  }
  function pageMnemonics(q) {
    var M = SC("mnemonics") || {}, groups = M.groups || [];
    var n = groups.reduce(function (a, g) { return a + g.m.length; }, 0);
    var w = groups.reduce(function (a, g) {
      return a + g.m.reduce(function (b, m) { return b + m.items.length; }, 0); }, 0);
    var items = groups.map(function (g) { return { id: "mn-" + slug(g.task), t: g.task + " — " + g.title }; });
    items.push({ id: "mn-tab", t: "Tab list — every page to flag" });

    var h = '<div class="crumb"><a href="#/">Start</a> <span>›</span> ' +
      '<a href="' + here("a/I") + '">Area I</a> <span>›</span> <span>Mnemonics</span></div>' +
      '<div class="eyebrow">Area I · Fundamentals of Instructing</div>' +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">FOI mnemonics</h1>' +
      '<p class="lede">' + fmt(M.intro || "") + "</p>" +
      '<div class="mn-stats"><div><b>' + n + "</b><span>mnemonics</span></div>" +
      "<div><b>" + w + "</b><span>words defined</span></div>" +
      "<div><b>FAA-H-8083-9B</b><span>every page verified</span></div></div>" +
      '<div class="bigsearch small"><span class="ic">' + I.search + "</span>" +
      '<input id="mq" type="search" placeholder="Filter — a mnemonic, a word, or an ACS code" ' +
      'autocomplete="off" value="' + esc(q || "") + '"></div>' +
      '<div class="erow" style="margin:6px 0 4px"><button class="btn ghost sm" id="mnOpen">Open all</button>' +
      '<button class="btn ghost sm" id="mnShut">Close all</button>' +
      '<span class="muted sm" id="mnCount"></span></div>';

    if (M.howto) h += '<div class="note"><span class="lbl">How to use this</span><ul class="errs" style="margin:6px 0 0">' +
      M.howto.map(function (b) { return "<li>" + fmt(b) + "</li>"; }).join("") + "</ul></div>";
    h += toc(items);

    groups.forEach(function (g) {
      h += '<section class="blk mn-g" id="mn-' + slug(g.task) + '"><h2>' +
        '<a href="' + here("t/" + esc(g.task)) + '">' + esc(g.task) + "</a> — " + esc(g.title) +
        ' <span class="hint">' + g.m.length + " mnemonics</span></h2>" +
        g.m.map(function (m) { return mnemCard(m, false); }).join("") + "</section>";
    });

    if (M.tab && M.tab.length) {
      h += '<section class="blk" id="mn-tab"><h2>Tab list <span class="hint">' +
        "Work down it once and the whole handbook is tabbed</span></h2>" +
        '<p class="lede" style="font-size:15px;margin-bottom:16px">Every printed page of FAA-H-8083-9B ' +
        "that carries a mnemonic, in order, with what is on it. Put a tab on each one.</p>";
      M.tab.forEach(function (ch) {
        h += '<div class="sh">' + esc(ch.ch) + '</div><div class="mn-tab">' +
          ch.rows.map(function (r) {
            return '<div class="mn-tr"><b class="mono">' + esc(r[0]) + "</b><span>" + esc(r[1]) + "</span></div>";
          }).join("") + "</div>";
      });
      h += "</section>";
    }
    if (M.src) h += '<div class="note flag"><span class="lbl">Where every page number comes from</span>' +
      esc(M.src) + " Page numbers are the printed numbers in the book, not PDF page numbers.</div>";
    return h;
  }
  function wireMnem() {
    var q = el("mq"); if (!q) return;
    function run() {
      var v = q.value.trim().toLowerCase();
      var ds = document.querySelectorAll("details.mn"), shown = 0;
      for (var i = 0; i < ds.length; i++) {
        var ok = !v || ds[i].getAttribute("data-k").indexOf(v) >= 0;
        ds[i].hidden = !ok;
        if (ok) shown++;
        if (v && ok) ds[i].open = true;
        if (!v) ds[i].open = false;
      }
      var secs = document.querySelectorAll("section.mn-g");
      for (var j = 0; j < secs.length; j++) secs[j].hidden = !secs[j].querySelector("details.mn:not([hidden])");
      el("mnCount").textContent = v ? shown + " of " + ds.length + " shown" : "";
    }
    q.addEventListener("input", run);
    el("mnOpen").addEventListener("click", function () { setMn(true); });
    el("mnShut").addEventListener("click", function () { setMn(false); });
    function setMn(o) {
      var ds = document.querySelectorAll("details.mn");
      for (var i = 0; i < ds.length; i++) if (!ds[i].hidden) ds[i].open = o;
    }
    if (q.value) run();
  }

  /* ---------- found something wrong? ---------- */
  var CONTACT = "CFIProject2026@gmail.com";
  function mailto(subject, body) {
    return "mailto:" + CONTACT + "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
  }
  function pageContact() {
    var K = SC("contact") || {};
    var h = '<div class="eyebrow">Help make it better</div>' +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Found something wrong?</h1>' +
      '<p class="lede">' + fmt(K.intro || "") + "</p>";

    h += '<section class="blk" id="report"><h2>Tell me about it</h2>' +
      '<p class="lede" style="font-size:15px;margin-bottom:18px">' + fmt(K.formIntro || "") + "</p>" +
      '<div class="cform">' +
      '<label><span>What kind of thing is it?</span><select id="ctKind">' +
      ["Something is factually wrong", "A link is dead", "A number, tolerance or citation looks off",
       "A video is gone or is the wrong one", "Something is confusing or badly explained",
       "Something is missing", "A tool is not working", "Just saying thank you",
       "Something else"].map(function (o) { return "<option>" + esc(o) + "</option>"; }).join("") +
      "</select></label>" +
      '<label><span>Where on the site? <i>Page, Area, Task or ACS code</i></span>' +
      '<input id="ctWhere" type="text" placeholder="' +
      esc("Task " + (flat()[0] ? flat()[0].code : "I.A") + ", or the nav log, or " +
          (codeEg()[0] || "an ACS code")) + '"></label>' +
      '<label class="wide"><span>What is wrong, and what should it say?</span>' +
      '<textarea id="ctWhat" rows="5" placeholder="Quote the line if you can, and tell me the source that says otherwise — the handbook, the AC or the regulation. That is what makes a correction quick to act on."></textarea></label>' +
      '<label><span>Your name <i>optional</i></span><input id="ctWho" type="text" placeholder="So I can thank you properly"></label>' +
      '<label><span>Your email <i>optional</i></span><input id="ctMail" type="text" placeholder="Only if you want an answer"></label>' +
      "</div>" +
      '<div class="erow" style="margin-top:18px"><button class="btn" id="ctSend">' + I.mail +
      " Open it in my email</button>" +
      '<button class="btn ghost" id="ctCopy">' + I.copy + " Copy the message instead</button>" +
      '<a class="btn ghost" href="mailto:' + CONTACT + '">' + esc(CONTACT) + "</a></div>" +
      '<div class="note" style="margin-top:18px"><span class="lbl">How this works</span>' +
      "Nothing is sent from this page and nothing is stored anywhere. The button just opens a message in " +
      "whatever email program you use, already filled in, and you press send. If your computer has no email " +
      "program set up, use <b>Copy the message instead</b> and paste it into webmail." +
      "</div></section>";

    (K.sections || []).forEach(function (s) {
      h += '<section class="blk"><h2>' + esc(s.h) + "</h2>" +
        (s.body ? '<p class="lede" style="font-size:15.5px">' + fmt(s.body) + "</p>" : "") +
        (s.bullets ? '<ul class="errs">' + s.bullets.map(function (b) { return "<li>" + fmt(b) + "</li>"; }).join("") + "</ul>" : "") +
        "</section>";
    });

    h += '<div class="note gold"><span class="lbl">Thank you</span>' + fmt(K.thanks || "") + "</div>";
    return h;
  }
  function wireContact() {
    if (!el("ctSend")) return;
    function msg() {
      var kind = el("ctKind").value, where = el("ctWhere").value.trim();
      var what = el("ctWhat").value.trim(), who = el("ctWho").value.trim(), mail = el("ctMail").value.trim();
      var body = [
        "Kind: " + kind,
        "Where: " + (where || "(not given)"),
        "",
        what || "(nothing written yet)",
        "",
        "---",
        "From: " + (who || "(anonymous)") + (mail ? "  <" + mail + ">" : ""),
        "Sent from the CFI ACS Reference site."
      ].join("\n");
      return { subject: "CFI ACS Reference — " + kind + (where ? " — " + where : ""), body: body };
    }
    el("ctSend").addEventListener("click", function () {
      var m = msg();
      window.location.href = mailto(m.subject, m.body);
    });
    el("ctCopy").addEventListener("click", function () {
      var m = msg();
      copyText("To: " + CONTACT + "\nSubject: " + m.subject + "\n\n" + m.body, this);
    });
  }

  /* ---------- appendices ---------- */
  /* ---------- ACS appendices ----------
     Two layers. `G.acsappx` is the appendix text extracted verbatim from the
     document itself, and every guide built from an ACS has it. `C["appx:N"]`
     is hand-written commentary on top, which so far only the CFI guide has.
     The page shows the commentary when it exists and the source text always,
     because the source text is the part that has to be right. */
  function acsAppx(n) { return (G && G.acsappx && G.acsappx["appx:" + n]) || null; }
  function hasAppx() { return !!(acsAppx(1) || C["appx:1"]); }
  /* Only the instrument guide carries an IPC table, but test for the table
     rather than for the slug so a future guide that has one gets the page. */
  function hasIpc() {
    return (G && G.ratings || []).some(function (t) {
      return /instrument proficiency check/i.test(t.title || "");
    });
  }

  function pageAppxIndex() {
    var meta = C["appx:intro"] || {};
    var intro = meta.intro ||
      ("The three appendices of " + esc(G ? G.doc : "the ACS") + " are the rules of the " +
       "practical test itself — who may test you, what they must test, what makes a Task " +
       "unsatisfactory, and what the airplane has to have on the day. They are quoted here " +
       "from the document, word for word.");
    var h = '<div class="eyebrow">The rules of the test itself</div>' +
      '<h1 style="font-size:30px;margin-bottom:12px">ACS appendices</h1>' +
      '<p class="lede">' + fmt(intro) + "</p>";
    h += '<div class="grid g2" style="margin-top:22px">';
    [1, 2, 3].forEach(function (n) {
      var src = acsAppx(n), a = C["appx:" + n] || {};
      if (!src && !a.title) return;
      var nSec = (src && src.sections ? src.sections.length : (a.sections || []).length);
      h += '<a class="acard" href="' + here("appx/" + n) + '"><div class="rn">APPENDIX ' + n + "</div>" +
        "<h3>" + esc(a.title || (src && src.title) || "") + "</h3>" +
        "<p>" + esc(a.oneLine || APPX_BLURB[n] || "") + "</p>" +
        '<div class="meta"><span class="chip">' + nSec + " sections</span>" +
        (a.keypoints && a.keypoints.length
          ? '<span class="chip gold">' + a.keypoints.length + " key points</span>" : "") +
        "</div></a>";
    });
    return h + "</div>";
  }
  var APPX_BLURB = {
    1: "Who may test you, what they must test, what they may choose, and the three ways the " +
       "day can end.",
    2: "The safety rules that sit above every Task — clearing turns, checklists, exchanging " +
       "the controls, and distractions.",
    3: "What the airplane must have, what a simulator may stand in for, and the limits that " +
       "apply to particular Tasks."
  };

  function pageAppx(n, jump) {
    var src = acsAppx(n), a = C["appx:" + n];
    if (!src && !a) return pageAppxIndex();
    a = a || {};
    var title = a.title || (src && src.title) || "Appendix " + n;
    var items = [];
    if (a.why) items.push({ id: "why", t: "Why this appendix matters" });
    if (a.keypoints && a.keypoints.length) items.push({ id: "keys", t: "Key points" });
    (a.sections || []).forEach(function (x) { items.push({ id: "s-" + slug(x.h), t: x.h, lv: 2 }); });
    if (src) {
      items.push({ id: "verbatim", t: "The appendix, word for word" });
      (src.sections || []).forEach(function (x) {
        items.push({ id: "v-" + slug(x.h), t: x.h, lv: 2 });
      });
    }

    var h = '<div class="crumb"><a href="' + here("") + '">Start</a> <span>›</span> ' +
      '<a href="' + here("appx") + '">Appendices</a> ' +
      "<span>›</span> <span>Appendix " + n + "</span></div>" +
      '<div class="eyebrow">' + esc(G ? G.doc : "") + " · Appendix " + n + "</div>" +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">' + esc(title) + "</h1>" +
      '<p class="lede">' + fmt(a.oneLine || APPX_BLURB[n] || "") + "</p>" + toc(items);

    if (a.why) h += '<div class="note flag" id="why"><span class="lbl">Why this matters</span>' +
      fmt(a.why) + "</div>";
    if (a.keypoints && a.keypoints.length) {
      h += '<section class="blk" id="keys"><h2>Key points <span class="hint">' +
        "If you remember nothing else</span></h2>" +
        '<ul class="errs keys">' + a.keypoints.map(function (k) {
          return "<li>" + fmt(k) + "</li>"; }).join("") + "</ul></section>";
    }
    if (a.sections && a.sections.length) {
      h += '<section class="blk"><h2>In detail</h2>' + a.sections.map(function (x) {
        var y = '<div class="cblk" id="s-' + slug(x.h) + '"><div class="top"><h3>' + esc(x.h) +
          "</h3></div>" + (x.sub ? '<div class="sub">' + fmt(x.sub) + "</div>" : "");
        if (x.bullets && x.bullets.length) {
          y += "<ul>" + x.bullets.map(function (bb) { return "<li>" + fmt(bb) + "</li>"; }).join("") + "</ul>";
        }
        if (x.quote) y += '<blockquote class="q">' + fmt(x.quote) + "<cite>" +
          esc(G ? G.doc : "") + ", Appendix " + n + "</cite></blockquote>";
        if (x.more) y += '<details class="more"><summary>More detail</summary><div class="bd"><p>' +
          x.more.split("\n").filter(Boolean).map(fmt).join("</p><p>") + "</p></div></details>";
        return y + "</div>";
      }).join("") + "</section>";
    }

    if (src) {
      h += '<section class="blk" id="verbatim"><h2>The appendix, word for word ' +
        '<span class="hint">Quoted from ' + esc(G.doc) + "</span></h2>";
      if (src.tests && src.tests.length) h += testTable(src.tests);
      h += (src.sections || []).map(function (x) {
        var y = '<div class="cblk src" id="v-' + slug(x.h) + '"><div class="top"><h3>' +
          esc(x.h) + "</h3></div>";
        (x.paras || []).forEach(function (p) { y += "<p>" + esc(p) + "</p>"; });
        if (x.bullets && x.bullets.length) {
          y += "<ul>" + x.bullets.map(function (bb) { return "<li>" + esc(bb) + "</li>"; }).join("") + "</ul>";
        }
        (x.notes || []).forEach(function (nt) {
          y += '<div class="acsnote"><b>Note:</b> ' + esc(nt) + "</div>";
        });
        return y + "</div>";
      }).join("");
      h += '<p class="v-note">Quoted from ' + esc(G.doc) + ", Appendix " + n +
        ". The tables in Appendix 1 are on the " +
        '<a href="' + here("addrating") + '">adding this rating</a> page, because they are ' +
        "easier to read there than as running text.</p></section>";
    }
    return h;
  }

  /* the knowledge test table, which is per certificate */
  function testTable(tests) {
    return '<div class="tablewrap"><table class="corr"><thead><tr><th>Test code</th>' +
      "<th>Test name</th><th>Questions</th><th>Minimum age</th><th>Time allowed</th>" +
      "<th>Passing score</th></tr></thead><tbody>" +
      tests.map(function (t) {
        return '<tr><td data-l="Test code"><b class="mono">' + esc(t.code) +
          (t.footnote ? "*" : "") + "</b></td>" +
          '<td data-l="Test name">' + esc(t.name) + "</td>" +
          '<td data-l="Questions">' + esc(t.questions) + "</td>" +
          '<td data-l="Minimum age">' + esc(t.age) + "</td>" +
          '<td data-l="Time allowed">' + esc(t.hours) + " hours</td>" +
          '<td data-l="Passing score">' + esc(t["pass"]) + "%</td></tr>";
      }).join("") + "</tbody></table></div>" +
      (tests.some(function (t) { return t.footnote; })
        ? '<p class="v-note">* The FOI knowledge test applies unless the applicant meets the ' +
          "criteria in 14 CFR 61.183(e).</p>" : "");
  }

  /* ---------- endorsements ---------- */
  function pageEndorsements(jump) {
    var groups = [], byGroup = {};
    ENDO.forEach(function (e) {
      if (!byGroup[e.group]) { byGroup[e.group] = []; groups.push(e.group); }
      byGroup[e.group].push(e);
    });
    var h = '<div class="eyebrow">AC 61-65K · Appendix A</div>' +
      '<h1 style="font-size:30px;margin-bottom:12px">Sample endorsements</h1>' +
      '<p class="lede">All ' + ENDO.length + " sample endorsements from AC 61-65K, dated 14 November 2025, " +
      "word for word. Open one to see the exact wording. The bracketed parts are what you fill in. " +
      "Copy it, then adapt it — the AC says the samples may be modified, but the substance must stay.</p>" +
      '<div class="note gold"><span class="lbl">Two things to get right</span>' +
      "<b>AC 61-65K renumbered the appendix.</b> Numbers in older handouts run four lower in the ranges that " +
      "matter — what used to be A.32 is now <b>A.36</b>. And a flight instructor certificate issued now carries " +
      "<b>no expiration date</b>; 14 CFR 61.197 recent experience within the preceding 24 calendar months is what " +
      "keeps the privileges alive.</div>" +
      (IMG["endo_board"] ? '<section class="blk"><h2>The whole board on one page ' +
        '<span class="hint">Click it to open, then zoom in</span></h2>' +
        '<button class="cheat" data-lb-zoom="endo_board" aria-label="Open the endorsements cheat sheet full size">' +
        '<img src="' + imgSrc("endo_board") + '" alt="Endorsements memory board: student pilot, additional endorsements, ' +
        'practical test prerequisites, private and commercial, the clocks, and category versus class">' +
        '<span class="cheat-ov"><span class="cheat-btn">' + I.zoom + " Open and zoom</span></span></button>" +
        '<p class="muted sm" style="margin-top:10px">A one-page memory board for the whole endorsement set, ' +
        "built from AC 61-65K. Every A-number below is on it. Opens full size - scroll to zoom, drag to move " +
        "around.</p></section>" : "") +
      '<div class="bigsearch small"><span class="ic">' + I.search + "</span>" +
      '<input id="eq" type="search" placeholder="Filter — try &ldquo;solo&rdquo;, &ldquo;61.87&rdquo;, &ldquo;flight review&rdquo;" aria-label="Filter endorsements"></div>' +
      '<div id="elist">';
    groups.forEach(function (g) {
      h += '<section class="blk egroup"><h2>' + esc(g) + ' <span class="hint">' + byGroup[g].length + " endorsements</span></h2>";
      byGroup[g].forEach(function (e) {
        var open = jump && jump.toUpperCase() === e.id.toUpperCase();
        h += '<details class="endo" id="e-' + e.id.replace(".", "-") + '" data-k="' +
          esc((e.id + " " + e.title + " " + e.reg + " " + e.text).toLowerCase()) + '"' + (open ? " open" : "") + ">" +
          "<summary><span class=\"aid mono\">" + esc(e.id) + '</span><span class="et">' + esc(e.title) + "</span>" +
          (e.reg ? '<span class="ereg mono">' + esc(e.reg) + "</span>" : "") + "</summary>" +
          '<div class="ebody">' + (e.note ? '<div class="enote">' + esc(e.note) + "</div>" : "") +
          '<div class="etext" id="et-' + e.id.replace(".", "-") + '">' + esc(e.text) + "</div>" +
          '<div class="erow"><span class="sigline mono">/s/ [date] [Name] [Certificate number] CFI [REED or Exp. date]</span>' +
          '<button class="btn sm" data-copy="et-' + e.id.replace(".", "-") + '">' + I.copy + " Copy</button></div></div></details>";
      });
      h += "</section>";
    });
    return h + "</div>";
  }

  /* ---------- pre-solo exam ---------- */
  function pagePresolo() {
    var p = SC("presolo") || {};
    var items = (p.sections || []).map(function (s) { return { id: "ps-" + slug(s.h), t: s.h, lv: 2 }; });
    var h = '<div class="eyebrow">14 CFR 61.87(b)</div>' +
      '<h1 style="font-size:30px;margin-bottom:12px">Pre-solo written exam</h1>' +
      '<p class="lede">' + fmt(p.intro || "") + "</p>";
    if (p.rule) h += '<div class="note flag"><span class="lbl">What the regulation actually requires</span>' + fmt(p.rule) + "</div>";
    h += '<div class="erow" style="margin:18px 0"><button class="btn" id="copyExam">' + I.copy +
      " Copy the whole exam</button><span class=\"muted sm\">Pastes into a document as plain text, ready to print.</span></div>";
    h += toc(items);
    h += '<div id="examBody">' + (p.sections || []).map(function (s) {
      return '<section class="blk" id="ps-' + slug(s.h) + '"><h2>' + esc(s.h) + "</h2>" +
        (s.note ? '<p class="lede" style="font-size:15px;margin-bottom:14px">' + fmt(s.note) + "</p>" : "") +
        '<ol class="exam">' + (s.q || []).map(function (q) { return "<li>" + fmt(q) + "</li>"; }).join("") + "</ol></section>";
    }).join("") + "</div>";
    if (p.notes && p.notes.length) {
      h += '<section class="blk"><h2>Notes for the instructor giving this test</h2><ul class="errs">' +
        p.notes.map(function (n) { return "<li>" + fmt(n) + "</li>"; }).join("") + "</ul></section>";
    }
    return h;
  }

  /* ---------- missed-code study table ---------- */
  function pageCodes() {
    return '<div class="eyebrow">After the knowledge test</div>' +
      '<h1 style="font-size:30px;margin-bottom:12px">Missed-code study table</h1>' +
      '<p class="lede">Your Airman Knowledge Test Report lists the ACS codes for every question you missed. ' +
      "Paste them here and this builds the study table: the code, the area to study in the ACS's own words, and " +
      "where to go and read it. Then copy the table into a document and work through it.</p>" +
      '<div class="note"><span class="lbl">How to use it</span>Paste or type the codes exactly as they appear ' +
      "on your report — " + codeEgHtml() + " — separated by commas, " +
      "spaces or new lines. Codes are also accepted without the " + prefixEgHtml() + " prefix.</div>" +
      '<div class="codetool">' +
      '<textarea id="codeIn" rows="5" placeholder="' + esc(codeEg().join(", ")) + '"></textarea>' +
      '<div class="erow"><button class="btn" id="buildTable">Build the table</button>' +
      '<button class="btn ghost" id="sampleCodes">Use an example</button>' +
      '<button class="btn ghost" id="clearCodes">Clear</button></div></div>' +
      '<div id="codeOut"></div>';
  }
  /* eight real codes from THIS guide, spread across its Areas, so the sample
     button demonstrates the tool with codes that will actually resolve */
  function sampleMissedCodes() {
    var picks = [], fs = flat();
    if (!fs.length) return "";
    var step = Math.max(1, Math.floor(fs.length / 8));
    for (var i = 0; i < fs.length && picks.length < 8; i += step) {
      var t = fs[i].t;
      var arr = (t.K && t.K.length ? t.K : t.R && t.R.length ? t.R : t.S) || [];
      var live = arr.filter(function (e) { return !e.archived && !e.na; });
      if (live.length) picks.push(live[0].code);
    }
    return picks.slice(0, 4).join(", ") + "\n" + picks.slice(4).join(", ");
  }

  function first(list) { return (list && list.length) ? list[0] : null; }
  /* the element-code prefixes the CURRENT guide actually uses - read off its
     own data rather than hardcoded, so a new document needs no edit here */
  /* Worked examples of THIS guide's own element codes. The missed-code tool and
     the correction form both used to print "FI.I.B.K5, AI.II.C.K4" - the CFI
     document's prefixes - on every guide, so a Commercial reader was shown a
     code shape that can never appear on a CA knowledge test report. */
  function codeEg(n) {
    var out = [];
    flat().forEach(function (f) {
      if (out.length >= (n || 3)) return;
      var arr = (f.t.K && f.t.K.length ? f.t.K : f.t.R && f.t.R.length ? f.t.R : f.t.S) || [];
      var live = arr.filter(function (e) { return e.code && !e.archived && !e.na; });
      if (live.length) out.push(live[0].code);
    });
    return out;
  }
  function codeEgHtml() {
    return codeEg(2).map(function (c) { return '<b class="mono">' + esc(c) + "</b>"; }).join(", ");
  }
  function prefixEgHtml() {
    var p = codePrefixes();
    if (!p.length) return '<span class="mono">document</span>';
    return p.map(function (x) { return '<span class="mono">' + esc(x) + '.</span>'; })
            .join(" or ");
  }
  function codePrefixes() {
    var seen = {}, out = [];
    ACS.forEach(function (a) {
      (a.tasks || []).forEach(function (t) {
        "KRS".split("").forEach(function (k) {
          var arr = t[k] || [];
          if (arr.length) {
            var p = arr[0].code.split(".")[0];
            if (!seen[p]) { seen[p] = 1; out.push(p); }
          }
        });
      });
    });
    return out;
  }

  function buildCodeTable() {
    var raw = el("codeIn").value || "", out = el("codeOut");
    var toks = raw.toUpperCase().split(/[^A-Z0-9.]+/).filter(function (s) { return s.length > 3; });
    if (!toks.length) { out.innerHTML = '<p class="muted">No codes found. Paste the codes from your test report above.</p>'; return; }
    var rows = [], bad = [], seen = {};
    toks.forEach(function (tk) {
      var code = tk.replace(/\.$/, "");
      if (seen[code]) return; seen[code] = 1;
      /* A report prints the code with its document prefix, but people retype
         them without. Try it as given, then with each prefix this guide uses. */
      var f = first(findElement(code));
      if (!f) {
        var pres = codePrefixes();
        for (var pi = 0; pi < pres.length && !f; pi++) f = first(findElement(pres[pi] + "." + code));
      }
      if (!f) { if (/\d/.test(code)) bad.push(code); return; }
      rows.push(f);
    });
    var looksPlt = bad.some(function (c) { return /^(?:PLT|P)?0*\d{1,3}$/.test(c); });
    if (!rows.length) {
      out.innerHTML = '<div class="note flag"><span class="lbl">No codes matched</span>' +
        "None of those codes are in the " + esc(ratingWords()) + " set of " + esc(G ? G.doc : "this document") + ": " +
        '<span class="mono">' + esc(bad.join(", ")) + "</span>. Check for typing errors, or the code may belong to " +
        "an ACS for a different certificate." +
        (looksPlt ? ' Those look like <b>PLT learning statement codes</b>, which a test written against a ' +
          'PTS reports \u2014 decode them on the <a href="#/codes">missed-code page</a>, which handles both ' +
          'systems.' : "") + "</div>";
      return;
    }
    var h = '<div class="erow" style="margin:22px 0 12px"><button class="btn" id="copyTable">' + I.copy +
      " Copy the table</button><span class=\"muted sm\">Pastes into Word, Google Docs or Pages as a real table.</span>" +
      '<span class="chip">' + rows.length + " code" + (rows.length === 1 ? "" : "s") + "</span></div>";
    if (bad.length) h += '<div class="note flag"><span class="lbl">Not recognised</span><span class="mono">' +
      esc(bad.join(", ")) + "</span> \u2014 not in this ACS." +
      (looksPlt ? ' Those look like PLT learning statement codes; the <a href="#/codes">missed-code page</a> ' +
        'decodes those too.' : "") + "</div>";
    h += '<div class="tablewrap"><table class="studytable" id="studyTable"><thead><tr>' +
      "<th>Missed code</th><th>Area to study</th><th>Resources</th></tr></thead><tbody>";
    rows.forEach(function (f) {
      var refs = refsFor(f.task);
      h += '<tr><td class="mono nw" data-l="Missed code">' + esc(f.el.code) + "</td>" +
        '<td data-l="Area to study"><b>' + esc(f.area.roman + "." + f.task.letter + " " + f.task.title) +
        "</b><br>" + esc(f.el.text) + "</td>" +
        '<td data-l="Resources">' + refs.map(function (r) {
          return r[2] ? '<a href="' + esc(r[2]) + '" target="_blank" rel="noopener">' + esc(r[1]) + "</a>" : esc(r[1]);
        }).join("<br>") + "<br><i>This site: " + esc(f.area.roman + "." + f.task.letter) + "</i></td></tr>";
    });
    h += "</tbody></table></div>";
    out.innerHTML = h;
    el("copyTable").addEventListener("click", function () { copyTable(this); });
  }

  /* ---------- about ---------- */
  function pageAbout() {
    var h = '<div class="eyebrow">About</div>' +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:14px">Why I built this</h1>' +
      '<p class="lede">I am an aviation-obsessed person who moved to another country to chase this. ' +
      "That is really the whole story. Everything on this site is what I wish somebody had handed me when " +
      "I started, so I am leaving it here for whoever shows up next.</p>";

    h += objectives(
      "Three things drive every page on this site, and they are in priority order. When two of " +
      "them ever pull against each other, the one nearer the top wins.");

    h += '<section class="blk"><h2>How I got here</h2><ol class="flow">' +
      "<li><b>I moved countries for it.</b> The training was here, so I came here. That was the decision that " +
      "made everything after it possible.</li>" +
      "<li><b>Frontier Airlines, flight attendant.</b> A certificate holder under Part 121. Two years of " +
      "watching a real airline operation from the inside, which turns out to be an unfair advantage when you " +
      "start learning why the rules are written the way they are.</li>" +
      "<li><b>Flight school at ATP.</b> Private, Instrument, Commercial Single-Engine, Commercial Multiengine. " +
      "Head down, one rating at a time.</li>" +
      "<li><b>Now: the CFI, under Part 61.</b> Which is exactly what this site was built for.</li>" +
      "</ol></section>";

    h += '<section class="blk"><h2>The extra pieces</h2>' +
      '<p class="lede" style="margin-bottom:18px">None of these were required. I went after them because ' +
      "I think that is what taking the job seriously looks like.</p><div class=\"grid g3\">" +
      cred("AGI", "Advanced Ground Instructor", "Certificated to give and endorse ground training.") +
      cred("IGI", "Instrument Ground Instructor", "The instrument side of the ground instructor privileges.") +
      cred("Part 107", "Remote Pilot", "Small unmanned aircraft systems.") +
      cred("WINGS", "FAA WINGS Program", "The FAA's proficiency program. Continuing education, on purpose.") +
      cred("IVAO", "16+ years", "International Virtual Aviation Organisation. This is where it actually started, long before it was a career.") +
      cred("LPA", "Latino Pilots in Aerospace", "Community and mentorship, and the people who make the path easier for whoever is behind you.") +
      "</div></section>";

    h += '<section class="blk"><h2>This site is my graduation project</h2>' +
      '<p class="lede" style="margin-bottom:0">Nobody asked me for it. There is no requirement anywhere ' +
      "that says a CFI applicant has to build a reference site for the certificate they are chasing. " +
      "I wanted to do it anyway. I think a good work ethic and continuing education are the two things that " +
      "separate somebody who passed a checkride from somebody you would actually want teaching your kid to " +
      "fly, and building this was how I proved that to myself. If it also helps you, even better.</p></section>";

    h += '<div class="note gold" style="margin-top:26px"><span class="lbl">Where this is going</span>' +
      "IVAO gave me sixteen years of confidence in this before I was old enough to do anything about it. " +
      "Everything since has been the same idea at a bigger scale. <b>The goal is the right seat, and then the " +
      "left seat, at a Part 121 carrier</b> \u2014 and teaching is not a detour on the way there, it is the part " +
      "where you find out whether you actually understand what you think you know.<br><br>" +
      "<b>I am a true believer that dreams come true.</b> I also think the point of having resources is to " +
      "build something that helps people rather than harms them. That is why this site is free, why every " +
      "claim on it is cited, and why anyone can have it.</div>";

    h += '<div class="note" style="margin-top:16px"><span class="lbl">One honest caveat</span>' +
      "This is study material written by a CFI applicant. It is not FAA guidance. The ACS element wording " +
      "quoted here is exact; everything around it is my understanding, cited so you can check it yourself. " +
      "If something here disagrees with the FAA source, the FAA source is right \u2014 go to the " +
      '<a href="#/resources">official resources</a> and read it. Building that habit is honestly half the job.</div>';
    return h;
  }
  function cred(tag, title, desc) {
    return '<div class="cred"><span class="tg">' + esc(tag) + "</span><b>" + esc(title) + "</b><span>" + esc(desc) + "</span></div>";
  }

  function pagePlan() {
    var h = '<div class="eyebrow">Before you go</div><h1 style="font-size:30px;margin-bottom:12px">What actually gets tested</h1>' +
      '<p class="lede">The evaluator does not test every task. Each Area of Operation carries its own selection ' +
      "rule, quoted below word for word from " + esc(G ? G.doc : "the ACS") +
      ". Some tasks are guaranteed \u2014 those are worth knowing cold.</p>";
    h += '<div class="note gold"><span class="lbl">Guaranteed on an initial CFI checkride</span>' +
      reqSpec().required.map(function (c) {
        var t = taskOf(c);
        return "<b>" + c + "</b> " + esc(t ? t.title : "");
      }).join(" &nbsp;·&nbsp; ") +
      "<br><br>Eleven Tasks you can count on. Everything else in each Area is the evaluator's choice, " +
      "so know these cold and be ready for the rest.</div>";
    h += '<section class="blk"><h2>Selection rule, area by area</h2>' + ACS.map(function (a) {
      return '<div class="cblk"><div class="top"><h3><a href="' + here("a/" + a.roman) + '">Area ' + a.roman + " — " + esc(a.title) + "</a></h3></div>" +
        '<ul><li>' + esc(a.note || "No selection note published for this Area.") + "</li></ul></div>";
    }).join("") + "</section>";
    return h;
  }

  function pageResources() {
    var h = '<div class="eyebrow">Go to the source</div><h1 style="font-size:30px;margin-bottom:12px">Official resources</h1>' +
      '<p class="lede">Everything on this site is built from these. When a fact here matters — a number, a ' +
      "tolerance, a regulation — check it here, because the FAA revises them and this page does not update itself.</p>";
    RES.forEach(function (sec) {
      h += '<div class="rsec"><h3>' + esc(sec.h) + "</h3>" +
        (sec.p ? "<p>" + esc(sec.p) + "</p>" : "") + '<div class="rlist">' +
        sec.items.map(function (it) {
          return '<a class="rl" href="' + esc(it.u) + '" target="_blank" rel="noopener">' +
            '<span class="ic">' + I.book + "</span><span><b>" + esc(it.t) + "</b><span>" + esc(it.d || "") + "</span>" +
            (it.c ? "<code>" + esc(it.c) + "</code>" : "") + "</span></a>";
        }).join("") + "</div></div>";
    });
    return h;
  }

  function pageArea(roman) {
    var a = areaOf(roman); if (!a) return pageGuideHome();
    var c = C["area:" + roman] || {};
    var h = '<div class="crumb"><a href="#/">Start</a> <span>›</span> <span>Area ' + roman + "</span></div>" +
      '<div class="eyebrow">Area of Operation ' + roman + "</div>" +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">' + esc(a.title) + "</h1>" +
      (c.intro ? '<p class="lede">' + fmt(c.intro) + "</p>" : "");
    /* task index — click to jump straight to a task */
    h += '<details class="toc" open><summary><span>Tasks in this Area</span><span class="n">' +
      a.tasks.length + "</span></summary><ol class=\"tix\">" +
      a.tasks.map(function (t) {
        return '<li><a href="' + here("t/" + roman + "." + t.letter) + '"><span class="c mono">' + t.letter + "</span>" +
          esc(t.title) + (mandatory(a, t) ? ' <span class="chip flag sm">must select</span>' : "") + "</a></li>";
      }).join("") + "</ol></details>";
    if (a.note) h += '<div class="note"><span class="lbl">' + STD() + ' selection rule — quoted</span>' + esc(a.note) + "</div>";
    if (c.order) h += '<div class="note gold"><span class="lbl">Teaching order</span>' + fmt(c.order) + "</div>";
    h += '<section class="blk"><h2>Tasks <span class="hint">' + a.tasks.length + " in this area</span></h2>" +
      '<div class="tlist">' + a.tasks.map(function (t) {
        var tc = C[roman + "." + t.letter] || {};
        return '<a class="trow" href="' + here("t/" + roman + "." + t.letter) + '">' +
          '<span class="code">' + roman + "." + t.letter + "</span>" +
          '<span class="bd"><h3>' + esc(t.title) + "</h3>" +
          "<p>" + esc(tc.oneLine || t.objective) + "</p>" +
          '<span class="meta">' +
          '<span class="chip k">K ' + t.K.filter(nosub).length + "</span>" +
          '<span class="chip r">R ' + t.R.filter(nosub).length + "</span>" +
          '<span class="chip s">S ' + t.S.filter(nosub).length + "</span>" +
          (t.ratings ? '<span class="chip">' + esc(t.ratings) + "</span>" : "") +
          (mandatory(a, t) ? '<span class="chip flag">Evaluator must select</span>' : "") +
          "</span></span></a>";
      }).join("") + "</div></section>";
    return h;
  }
  function nosub(e) { return !/[a-z]$/.test(e.code); }

  function pageTask(code, jump) {
    var t = taskOf(code); if (!t) return pageGuideHome();
    var roman = code.split(".")[0], a = areaOf(roman), c = C[code] || {};
    var idx = -1; flat().forEach(function (f, i) { if (f.code === code) idx = i; });
    var prev = flat()[idx - 1], next = flat()[idx + 1];
    var hlEl = jump && /^(AI|FI)\./i.test(jump) ? jump : null;

    var h = '<div class="crumb"><a href="' + here("") + '">Start</a> <span>›</span> <a href="' + here("a/" + roman) + '">Area ' + roman +
      "</a> <span>›</span> <span>Task " + t.letter + "</span></div>";

    h += '<div class="thead"><div class="eyebrow">Area ' + roman + " · " + esc(a.title) + "</div>" +
      "<h1>" + esc(t.title) + "</h1>" +
      '<div class="tmeta"><span class="chip k">' + esc(code) + "</span>" +
      '<span class="chip">' + esc(t.prefix) + "." + esc(roman) + "." + esc(t.letter) + ".*</span>" +
      (t.ratings ? '<span class="chip">' + esc(t.ratings) + "</span>" : "") +
      (mandatory(a, t) ? '<span class="chip flag">Evaluator must select this task</span>' : "") +
      "</div>" +
      (c.oneLine ? '<p class="lede">' + fmt(c.oneLine) + "</p>" : "") +
      (isAnchor("weather", code) ? '<div class="erow" style="margin-top:14px">' +
        '<a class="btn ghost sm" href="#/wx">' + I.cloud + " Open the METAR, TAF and PIREP decoder</a>" +
        '<span class="muted sm">Decode any report group by group, or pull the current weather for a station.</span></div>' : "") +
      "</div>";

    /* ---- build the on-page index as we build the body ---- */
    var items = [];
    if (c.why) items.push({ id: "why", t: "Why this matters" });
    if (c.mnem && c.mnem.length) items.push({ id: "mnem", t: "Mnemonics" });
    if (c.memory && c.memory.length) items.push({ id: "memory", t: "Memory aids" });
    if (c.flow && c.flow.length) items.push({ id: "flow", t: W("flow") });
    if (c.cards && c.cards.length) {
      items.push({ id: "material", t: "The material" });
      c.cards.forEach(function (k) { items.push({ id: "c-" + slug(k.h || ""), t: k.h || "Block", lv: 2 }); });
    }
    if (c.examples && c.examples.length) items.push({ id: "examples", t: W("examples") });
    if (placeFigs(c).loose.length) items.push({ id: "figures", t: "More figures" });
    if (VID[code] && VID[code].length) items.push({ id: "watch", t: "Watch" });
    if (c.errors && c.errors.length) items.push({ id: "errors", t: "Common errors" });
    items.push({ id: "acs", t: STD() + " elements — exact wording" });

    var side = '<div class="side">' +
      '<div class="sbox"><h4>Objective — ' + STD() + ' wording</h4><p>' + esc(t.objective) + "</p></div>" +
      '<div class="sbox"><h4>References</h4><div class="refs">' + refChips(t.references) + "</div></div>" +
      (c.numbers && c.numbers.length ? '<div class="sbox"><h4>Numbers to know</h4><ul>' +
        c.numbers.map(function (n) { return "<li>" + fmt(n) + "</li>"; }).join("") + "</ul></div>" : "") +
      (t.notes && t.notes.length ? '<div class="sbox"><h4>' + STD() + ' note</h4><p>' + t.notes.map(esc).join("</p><p>") + "</p></div>" : "") +
      /* A page footnote in the PTS. Small, but it is a testable condition and
         the applicant should see it against the Task it is anchored in. */
      (t.footnotes && t.footnotes.length ? '<div class="sbox"><h4>' + STD() + ' footnote</h4><p>' +
        t.footnotes.map(esc).join("</p><p>") + "</p></div>" : "") +
      "</div>";

    var body = toc(items);
    if (c.why) body += '<div class="note flag" id="why"><span class="lbl">Why this matters — safety first</span>' + fmt(c.why) + "</div>";

    if (c.mnem && c.mnem.length) {
      body += '<section class="blk" id="mnem"><h2>Mnemonics <span class="hint">' +
        c.mnem.length + " for this task &middot; every word, and the handbook page</span></h2>" +
        '<div class="bigsearch small no-print"><span class="ic">' + I.search + "</span>" +
        '<input id="mq" type="search" placeholder="Filter these mnemonics" autocomplete="off"></div>' +
        '<div class="erow" style="margin:6px 0 14px"><button class="btn ghost sm" id="mnOpen">Open all</button>' +
        '<button class="btn ghost sm" id="mnShut">Close all</button>' +
        '<span class="muted sm" id="mnCount"></span></div>' +
        c.mnem.map(function (m) { return mnemCard(m, false); }).join("") +
        '<div class="erow" style="margin-top:14px"><a class="btn ghost sm" href="' + here("mnemonics") + '">' +
        I.quiz + " All 56 FOI mnemonics, and the tab list</a></div></section>";
    }
    if (c.memory && c.memory.length) {
      body += '<section class="blk" id="memory"><h2>Memory aids <span class="hint">Say these out loud until they are automatic</span></h2>' +
        '<div class="mems">' + c.memory.map(function (m) {
          return '<div class="mem"><b>' + esc(m.tag) + "</b>" +
            (m.ex ? '<div class="ex">' + fmt(m.ex) + "</div>" : "") +
            (m.note ? '<div class="nt">' + fmt(m.note) + "</div>" : "") + "</div>";
        }).join("") + "</div></section>";
    }
    if (c.flow && c.flow.length) {
      body += '<section class="blk" id="flow"><h2>' + esc(W("flow")) + '</h2><ol class="flow">' +
        c.flow.map(function (f) { return "<li>" + fmt(f) + "</li>"; }).join("") + "</ol></section>";
    }
    if (c.cards && c.cards.length) {
      var FP = placeFigs(c);
      body += '<section class="blk" id="material"><h2>The material</h2>' + c.cards.map(function (k, ki) {
        var s = '<div class="cblk" id="c-' + slug(k.h || "") + '"><div class="top"><h3>' + esc(k.h) + "</h3>" +
          codeChips(k.code) + "</div>" +
          (k.sub ? '<div class="sub">' + fmt(k.sub) + "</div>" : "") +
          (k.ref ? '<div class="ref">' + esc(k.ref) + "</div>" : "");
        if (k.bullets && k.bullets.length) {
          s += "<ul>" + k.bullets.map(function (b) {
            return typeof b === "string" ? "<li>" + fmt(b) + "</li>" : "";
          }).join("") + "</ul>";
        }
        if (k.groups) {
          k.groups.forEach(function (g) {
            s += '<div class="sh">' + esc(g.h) + "</div><ul>" +
              g.b.map(function (b) { return "<li>" + fmt(b) + "</li>"; }).join("") + "</ul>";
          });
        }
        /* Figures belong beside the thing they illustrate, not in a pile at
           the bottom of the page. `img` is the original single-figure form;
           `figs` is a list, and a task-level figure tagged with this card's
           code or heading is pulled in here too. */
        if (k.img) s += figure(k.img, k.imgcap);
        (k.figs || []).forEach(function (ff) { s += figure(ff.id, ff.cap); });
        (FP.byCard[ki] || []).forEach(function (ff) { s += figure(ff.id, ff.cap); });
        if (k.more) s += '<details class="more"><summary>' + esc(W("more")) + '</summary><div class="bd"><p>' +
          k.more.split("\n").filter(Boolean).map(fmt).join("</p><p>") + "</p></div></details>";
        return s + "</div>";
      }).join("") + "</section>";
    }
    /* Task II.K carries the endorsement library inline */
    if (isAnchor("endorse", code) && ENDO.length) {
      var pick = ["A.1", "A.2", "A.3", "A.4", "A.5", "A.6", "A.7", "A.8", "A.9", "A.10", "A.11", "A.12", "A.13",
                  "A.36", "A.37", "A.38", "A.39", "A.45", "A.46", "A.47", "A.49", "A.69", "A.71",
                  "A.72", "A.73", "A.74", "A.75", "A.76", "A.77", "A.78", "A.86"];
      var sel = ENDO.filter(function (e) { return pick.indexOf(e.id) >= 0; });
      items.splice(items.length - 1, 0, { id: "endo", t: "Sample endorsements" });
      body += '<section class="blk" id="endo"><h2>Sample endorsements <span class="hint">' +
        "AC 61-65K, word for word — open one to read it</span></h2>" +
        '<p class="lede" style="font-size:15px;margin-bottom:14px">The ones you are most likely to be asked for. ' +
        'All ' + ENDO.length + ' are on the <a href="' + here("endorsements") + '">endorsements page</a>.</p>' +
        sel.map(function (e) {
          return '<details class="endo" id="e-' + e.id.replace(".", "-") + '">' +
            '<summary><span class="aid mono">' + esc(e.id) + '</span><span class="et">' + esc(e.title) + "</span>" +
            (e.reg ? '<span class="ereg mono">' + esc(e.reg) + "</span>" : "") + "</summary>" +
            '<div class="ebody">' + (e.note ? '<div class="enote">' + esc(e.note) + "</div>" : "") +
            '<div class="etext" id="et2-' + e.id.replace(".", "-") + '">' + esc(e.text) + "</div>" +
            '<div class="erow"><button class="btn sm" data-copy="et2-' + e.id.replace(".", "-") + '">' +
            I.copy + " Copy</button></div></div></details>";
        }).join("") +
        '<div class="note" style="margin-top:16px"><span class="lbl">Also useful here</span>' +
        'The <a href="' + here("presolo") + '">pre-solo written exam</a> on this site is a ready-made test covering the three ' +
        "areas 14 CFR 61.87(b) requires, for the A.3 endorsement.</div></section>";
    }
    /* The Pilot Qualifications Task carries the certificate checkers and the
       cross-country validator - III.A on the CFI, I.A on the pilot guides. */
    if (isAnchor("pilotqual", code)) {
      items.splice(items.length - 1, 0, { id: "checkers", t: "Check eligibility by certificate" });
      items.splice(items.length - 1, 0, { id: "xc", t: "Cross-country validator" });
      body += '<section class="blk" id="checkers"><h2>Check eligibility by certificate <span class="hint">' +
        "Tick what is true &mdash; it tells you what is still missing</span></h2>" +
        '<div class="tabs" id="ckTabs">' +
        CK_ORDER.filter(function (k) { return !!checkDef(k); }).map(function (k) {
          return '<button class="tab' + (k === ckSelf() ? " on" : "") + '" data-tab="' + k + '">' +
            esc(ckShort(k)) + "</button>";
        }).join("") + "</div>" +
        '<div id="ckHost">' + checkerHtml(ckSelf()) + "</div>" +
        '<p class="muted sm" style="margin-top:12px">The ' + esc(ckShort(ckSelf()).toLowerCase()) +
        ' checklist also has its own page, with the privileges and limitations in full: ' +
        '<a href="' + here("eligibility") + '">Am I eligible?</a></p></section>';

      body += '<section class="blk" id="xc"><h2>Cross-country validator <span class="hint">' +
        "Does this flight count for the certificate?</span></h2>" +
        '<p class="lede" style="font-size:15px;margin-bottom:16px">Type the airports you landed at, in order. ' +
        "This works out every leg, the total distance, the longest segment and the farthest point from where " +
        "you departed, then checks that against each cross-country requirement in Part 61.</p>" +
        xcToolHtml() + "</section>";
    }

    if (c.examples && c.examples.length) {
      body += '<section class="blk" id="examples"><h2>' + esc(W("examples")) + ' <span class="hint">' +
        esc(W("exHint")) + "</span></h2><div class=\"exs\">" +
        c.examples.map(function (e) {
          return '<div class="ex"><div class="q">' + fmt(e.q) + '</div><div class="a">' + fmt(e.a) + "</div></div>";
        }).join("") + "</div></section>";
    }
    var loose = placeFigs(c).loose;
    if (loose.length) {
      body += '<section class="blk" id="figures"><h2>More figures <span class="hint">' +
        "These belong to the task as a whole rather than to one block above</span></h2>" +
        loose.map(function (f) { return figure(f.id, f.cap); }).join("") + "</section>";
    }
    var vl = VID[code];
    if (vl && vl.length) body += '<section class="blk" id="watch"><h2>Watch <span class="hint">Opens on YouTube inside the page</span></h2>' + videos(vl) + "</section>";

    if (c.errors && c.errors.length) {
      body += '<section class="blk" id="errors"><h2>Common errors <span class="hint">' + esc(W("errHint")) + "</span></h2>" +
        '<ul class="errs">' + c.errors.map(function (e) { return "<li>" + fmt(e) + "</li>"; }).join("") + "</ul></section>";
    }
    body += '<section class="blk" id="acs"><h2>' + STD() + ' elements — exact wording <span class="hint">' +
      "Quoted from " + esc(G ? G.doc : "the source document") +
      " so you can cross-check anything above</span></h2>" +
      acsTable(t, "K", hlEl) + acsTable(t, "R", hlEl) + acsTable(t, "S", hlEl) + "</section>";

    /* re-render the TOC now that late sections (endorsements) are known */
    body = body.replace(/^<details class="toc"[\s\S]*?<\/details>/, toc(items));

    h += '<div class="tcols"><div>' + body + "</div>" + side + "</div>";

    h += '<div class="pn">' +
      (prev ? '<a href="' + here("t/" + prev.code) + '"><span class="l">Previous · ' + prev.code + "</span><b>" + esc(prev.t.title) + "</b></a>" : "<span></span>") +
      (next ? '<a class="nx" href="' + here("t/" + next.code) + '"><span class="l">Next · ' + next.code + "</span><b>" + esc(next.t.title) + "</b></a>" : "") +
      "</div>";
    return h;
  }

  /* ---------- router ---------- */
  /* =============== knowledge tests, and which codes they report =============== */
  var TESTS = [
    { id: "PAR", name: "Private Pilot Airplane", guide: "private",    kind: "acs" },
    { id: "IRA", name: "Instrument Rating Airplane", guide: "instrument", kind: "acs" },
    { id: "CAX", name: "Commercial Pilot Airplane", guide: "commercial", kind: "acs" },
    { id: "FOI", name: "Fundamentals of Instructing", guide: "cfi",    kind: "acs" },
    { id: "FIA", name: "Flight Instructor Airplane", guide: "cfi",     kind: "acs" },
    { id: "FII", name: "Flight Instructor Instrument Airplane", guide: "cfi-instrument", kind: "plt" }
  ];
  function testById(id) {
    for (var i = 0; i < TESTS.length; i++) if (TESTS[i].id === id) return TESTS[i];
    return null;
  }

  /* the study table, opened from the portal: ask which test first */
  function pageCodesGlobal(sel) {
    var h = '<div class="crumb"><a href="#/">All guides</a> <span>›</span> <span>Missed codes</span></div>' +
      '<div class="eyebrow">Turn a test report into a study plan</div>' +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Missed-code study table</h1>' +
      '<p class="lede">Type in the codes printed on an Airman Knowledge Test Report and get a table ' +
      "you can copy straight into a document: the code, what the FAA says it covers, and where to go " +
      "and study it.</p>";
    h += '<section class="blk"><h2>Which test was it?</h2>' +
      '<p class="lede" style="font-size:15px;margin-bottom:16px">The code on your report tells you. ' +
      "A test written against an ACS reports <b>ACS codes</b> like <span class=\"mono\">PA.I.B.K1</span>. " +
      "A test written against a PTS reports <b>PLT learning statement codes</b> like " +
      "<span class=\"mono\">PLT097</span>.</p>" +
      '<div class="testgrid">' + TESTS.map(function (t) {
        var g = guideMeta(t.guide) || {};
        return '<a class="tsel a-' + esc(g.accent || "k") + '" href="#/codes/' + t.id + '">' +
          '<b class="mono">' + t.id + "</b><span>" + esc(t.name) + "</span>" +
          '<i>' + (t.kind === "plt" ? "PLT codes" : "ACS codes") + " · " + esc(g.short || "") + "</i></a>";
      }).join("") + "</div></section>";
    h += '<div class="note"><span class="lbl">Why the examiner asks about these</span>' +
      "Your instructor has to give you instruction on every area of deficiency on the report and " +
      "endorse that it happened, you have to bring the report to the practical test, and the examiner " +
      "is required to evaluate those areas during the oral. That is what this table is for.</div>";
    return h;
  }

  /* The decoder for one test, opened from the picker above. This is the only
     place on the site that handles BOTH code systems in one box: an ACS code
     like PA.I.B.K1 and a PLT learning statement code like PLT097 decode side by
     side, because a CFI candidate holds reports of both kinds. */
  function pageCodesTest(id) {
    var t = testById(id);
    if (!t) return pageCodesGlobal();
    var g = guideMeta(t.guide) || {}, payload = LOADED[t.guide];

    var h = '<div class="crumb"><a href="#/">All guides</a> <span>\u203a</span> ' +
      '<a href="#/codes">Missed codes</a> <span>\u203a</span> <span>' + esc(t.id) + "</span></div>" +
      '<div class="eyebrow">' + esc(t.id) + " &middot; " + esc(t.name) + "</div>" +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Missed-code study table</h1>';

    if (!payload) {
      return h + '<div class="note"><span class="lbl">Loading ' + esc(g.short || t.guide) + "</span>" +
        "Fetching the " + esc(g.cert || t.guide) + " data so the codes can be looked up\u2026</div>";
    }

    h += '<p class="lede">Paste the codes printed on your <b>' + esc(t.id) + "</b> Airman Knowledge " +
      "Test Report. This builds the table you can copy straight into a document: the code, what the " +
      "FAA says it covers, and where to go and study it.</p>";

    h += '<div class="note"><span class="lbl">Both code systems work here</span>' +
      "An <b>ACS code</b> looks like <span class=\"mono\">" + esc(sampleCodeFor(t.guide)) + "</span> and " +
      "points at one element of " + esc(payload.doc) + ". A <b>PLT learning statement code</b> looks like " +
      "<span class=\"mono\">PLT097</span> and comes from the FAA Learning Statement Reference Guide, " +
      "which is what a test written against a PTS reports. Paste either, or both \u2014 separated by " +
      "commas, spaces or new lines. The " + esc(t.id) + " report normally uses <b>" +
      (t.kind === "plt" ? "PLT codes" : "ACS codes") + "</b>.</div>";

    h += '<div class="codetool">' +
      '<textarea id="gcodeIn" rows="5" data-test="' + esc(t.id) + '" placeholder="' +
      esc(sampleCodeFor(t.guide)) + ', PLT097"></textarea>' +
      '<div class="erow"><button class="btn" id="gBuild">Build the table</button>' +
      '<button class="btn ghost" id="gSample">Use an example</button>' +
      '<button class="btn ghost" id="gClear">Clear</button></div></div>' +
      '<div id="gcodeOut"></div>';

    h += '<div class="note flag" style="margin-top:20px"><span class="lbl">Bring the report</span>' +
      "14 CFR 61.39(a)(6)(ii): if your report shows deficient subject areas, your instructor gives you " +
      "instruction in each one and endorses that it happened, and you bring the report to the practical " +
      "test. The evaluator is required to cover those areas in the oral.</div>";
    return h;
  }

  /* A real code from that guide, so the placeholder and the example are never
     a made-up string the reader then tries to look up. */
  function sampleCodeFor(slug) {
    var p = LOADED[slug]; if (!p) return "PA.I.B.K1";
    var a = (p.acs || [])[0]; if (!a) return "PA.I.B.K1";
    var t = (a.tasks || [])[0]; if (!t) return "PA.I.B.K1";
    var e = (t.K || t.R || t.S || [])[0];
    return e ? e.code : "PA.I.B.K1";
  }
  function sampleCodesFor(slug) {
    var p = LOADED[slug], out = [];
    if (p) {
      (p.acs || []).forEach(function (a) {
        if (out.length >= 5) return;
        var t = (a.tasks || [])[0]; if (!t) return;
        var arr = (t.K && t.K.length ? t.K : t.R && t.R.length ? t.R : t.S) || [];
        var live = arr.filter(function (e) { return !e.archived && !e.na; });
        if (live.length) out.push(live[0].code);
      });
    }
    var plt = Object.keys(PLT).slice(96, 99);
    return out.join(", ") + (plt.length ? "\n" + plt.join(", ") : "");
  }

  /* PLT001 / plt 1 / P097 / 097 all mean the same row of the Learning
     Statement Reference Guide. Returns the canonical code or null. */
  function normPlt(tok) {
    var m = /^(?:PLT|P)?0*(\d{1,3})$/.exec(tok);
    if (!m) return null;
    var code = "PLT" + ("000" + m[1]).slice(-3);
    return PLT[code] ? code : null;
  }

  function buildGlobalCodeTable() {
    var box = el("gcodeIn"), out = el("gcodeOut"); if (!box || !out) return;
    var testId = box.getAttribute("data-test") || "";
    var t = testById(testId) || {};
    /* "PLT 097" and "PLT-097" are the same code as "PLT097"; join them before
       splitting, or the box turns one code into a stray "PLT" and a stray
       number. Then drop a bare PLT/P with no digits behind it. */
    var raw = (box.value || "").toUpperCase().replace(/\b(PLT|P)[\s\-]+(\d)/g, "$1$2");
    var toks = raw.split(/[^A-Z0-9.]+/).filter(function (x) {
      return x.length > 2 && !/^(PLT|P)$/.test(x);
    });
    if (!toks.length) {
      out.innerHTML = '<p class="muted">No codes found. Paste the codes from your test report above.</p>';
      return;
    }
    /* Dedupe on what a token RESOLVES to, not on how it was typed: PLT097,
       P097 and 097 are one code, and PA.I.B.K1 and I.B.K1 are one element. */
    var acsRows = [], pltRows = [], bad = [], seen = {}, done = {};
    toks.forEach(function (tk) {
      var code = tk.replace(/\.$/, "");
      if (seen[code]) return; seen[code] = 1;
      var pl = normPlt(code);
      if (pl) {
        if (done["plt:" + pl]) return; done["plt:" + pl] = 1;
        pltRows.push([pl, PLT[pl]]); return;
      }
      var f = first(findElement(code));
      if (!f) {
        prefixesOf(LOADED[t.guide]).forEach(function (p) {
          if (!f) f = first(findElement(p + "." + code));
        });
      }
      /* a plain run of 4+ digits is a date or a score off the report header,
         not a code in either system */
      if (!f) { if (/\d/.test(code) && !/^\d{4,}$/.test(code)) bad.push(code); return; }
      if (done["acs:" + f.el.code]) return; done["acs:" + f.el.code] = 1;
      acsRows.push(f);
    });

    if (!acsRows.length && !pltRows.length) {
      out.innerHTML = '<div class="note flag"><span class="lbl">No codes matched</span>' +
        '<span class="mono">' + esc(bad.join(", ")) + "</span> \u2014 none of those are an element of " +
        esc((LOADED[t.guide] || {}).doc || "that document") + " or a PLT learning statement code. " +
        "Check for typing errors, and check you picked the right test above.</div>";
      return;
    }

    var n = acsRows.length + pltRows.length;
    var h = '<div class="erow" style="margin:22px 0 12px"><button class="btn" id="gCopy">' + I.copy +
      " Copy the table</button><span class=\"muted sm\">Pastes into Word, Google Docs or Pages as a " +
      "real table.</span><span class=\"chip\">" + n + " code" + (n === 1 ? "" : "s") + "</span></div>";
    if (bad.length) h += '<div class="note flag"><span class="lbl">Not recognised</span><span class="mono">' +
      esc(bad.join(", ")) + "</span> \u2014 not an element of " +
      esc((LOADED[t.guide] || {}).doc || "that document") + " and not a PLT code.</div>";

    h += '<div class="tablewrap"><table class="studytable" id="gTable"><thead><tr>' +
      "<th>Missed code</th><th>Area to study</th><th>Resources</th></tr></thead><tbody>";
    acsRows.forEach(function (f) {
      var refs = refsFor(f.task);
      h += '<tr><td class="mono nw" data-l="Missed code">' + esc(f.el.code) + "</td>" +
        '<td data-l="Area to study"><b>' + esc(f.area.roman + "." + f.task.letter + " " + f.task.title) +
        "</b><br>" + esc(f.el.text) + "</td>" +
        '<td data-l="Resources">' + refs.map(function (r) {
          return r[2] ? '<a href="' + esc(r[2]) + '" target="_blank" rel="noopener">' + esc(r[1]) + "</a>" : esc(r[1]);
        }).join("<br>") + '<br><i>This site: <a href="' + guideHref(t.guide, "t/" + f.area.roman + "." + f.task.letter) +
        '">' + esc(f.area.roman + "." + f.task.letter) + "</a></i></td></tr>";
    });
    pltRows.forEach(function (r) {
      h += '<tr><td class="mono nw" data-l="Missed code">' + esc(r[0]) + "</td>" +
        '<td data-l="Area to study"><b>Learning statement</b><br>' + esc(r[1]) + "</td>" +
        '<td data-l="Resources">FAA Learning Statement Reference Guide<br>' +
        '<i>Search this subject: <a href="#/search/' + encodeURIComponent(r[1].slice(0, 40)) +
        '">across every guide</a></i></td></tr>';
    });
    h += "</tbody></table></div>";
    if (pltRows.length) {
      h += '<div class="note"><span class="lbl">About the PLT rows</span>' +
        "A learning statement names a <b>subject</b>, not a single element, so there is no one Task to " +
        "send you to. Close it by studying the subject and having your instructor sign that you did. " +
        "The link searches every guide on this site for that wording.</div>";
    }
    out.innerHTML = h;
    if (el("gCopy")) el("gCopy").addEventListener("click", function () { copyTable(this, el("gTable")); });
  }

  /* the element-code prefixes a LOADED payload uses, without touching `G` */
  function prefixesOf(p) {
    var seen = {}, out = [];
    ((p && p.acs) || []).forEach(function (a) {
      (a.tasks || []).forEach(function (t) {
        "KRS".split("").forEach(function (k) {
          var arr = t[k] || [];
          if (arr.length) {
            var pre = arr[0].code.split(".")[0];
            if (!seen[pre]) { seen[pre] = 1; out.push(pre); }
          }
        });
      });
    });
    return out;
  }

  /* ================= MOCK CHECKRIDE ================= */
  /* ============================================================================
   MOCK CHECKRIDE — a practice oral, run the way an evaluator runs one.
   Injected inside the app IIFE.

   The question bank is not a separate file. Every Task in every guide already
   carries scenario questions written against its own ACS elements, and every
   element carries the FAA's own wording. So the bank is assembled from the
   guide itself, which means it grows as the guides grow and can never drift
   out of step with the ACS.

   Selection is deliberately NOT uniform random. The ACS says what an evaluator
   must cover, so the mock does too:

     1. every element the applicant missed on the knowledge test  (Appendix 1)
     2. every Task the document says the evaluator MUST select
     3. at least one question from every Area of Operation
     4. the rest spread at random, so it is never the same test twice
   ========================================================================== */

var MOCK = null;          /* the run in progress */
var MOCK_KEY = "acs.mock.v1";

/* ---- lengths, in questions. About a minute and a half to two minutes each,
   which is how a real oral actually paces. -------------------------------- */
function mockLengths(g) {
  var long = g.slug === "cfi";
  return long
    ? [{ id: "s", n: 30, t: "Short", d: "About 50 minutes — one Area at a time" },
       { id: "m", n: 60, t: "Standard", d: "About 1 hour 45 — a realistic practice run" },
       { id: "l", n: 95, t: "Full length", d: "About 3 hours — the real thing" }]
    : [{ id: "s", n: 22, t: "Short", d: "About 40 minutes — a warm-up" },
       { id: "m", n: 45, t: "Standard", d: "About 1 hour 20 — a realistic practice run" },
       { id: "l", n: 62, t: "Full length", d: "About 2 hours — the real thing" }];
}

/* ---- the bank ------------------------------------------------------------ */
/* An element-derived question is the fallback for a Task with no authored
   scenario yet. It is phrased the way an evaluator phrases it, and it carries
   the element's exact ACS wording as the answer, so it is never wrong - it
   just is not as good as a written scenario. */
function elementQuestion(kind, text) {
  var t = String(text).replace(/^[a-z]\.\s*/, "").replace(/\s*\.$/, "");
  if (kind === "K") return "Tell me about " + t.charAt(0).toLowerCase() + t.slice(1) + ".";
  if (kind === "R") return "What is the risk associated with " +
    t.charAt(0).toLowerCase() + t.slice(1) + ", and how would you manage it?";
  return "Talk me through how you would " + t.charAt(0).toLowerCase() + t.slice(1) + ".";
}

function mockBank(g) {
  var pool = [];
  (g.acs || []).forEach(function (a) {
    (a.tasks || []).forEach(function (t) {
      var code = a.roman + "." + t.letter;
      var v = (g.content || {})[code] || {};
      var live = [];
      "KRS".split("").forEach(function (k) {
        (t[k] || []).forEach(function (e) {
          if (!e.archived && !e.na) live.push({ kind: k, el: e });
        });
      });
      /* authored scenarios first - they are the good ones */
      (v.examples || []).forEach(function (ex, i) {
        pool.push({ area: a.roman, areaTitle: a.title, code: code, task: t.title,
                    q: ex.q, a: ex.a, src: "scenario", id: code + ":x" + i,
                    els: live.slice(0, 3).map(function (x) { return x.el.code; }) });
      });
      /* then one question per element, so every element is reachable */
      live.forEach(function (x) {
        pool.push({ area: a.roman, areaTitle: a.title, code: code, task: t.title,
                    q: elementQuestion(x.kind, x.el.text),
                    a: "The ACS element reads: “" + x.el.text + "”\n\n" +
                       "A complete answer covers what it is, why it matters for safety, and how " +
                       "it applies to the flight you are planning.",
                    src: "element", id: x.el.code, els: [x.el.code], kind: x.kind });
      });
    });
  });
  return pool;
}

/* deterministic shuffle from a seed, so a run can be reproduced from its id */
function mockRng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function shuffle(arr, rnd) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}


/* ---- the opening question -------------------------------------------------
   Every practical test starts the same way, and it is not a maneuver: the
   evaluator establishes that the applicant, the paperwork and the aircraft are
   all legal before anything else happens. 14 CFR 61.39 is the prerequisite
   list and 61.45 is the aircraft. So every mock opens on it, pinned to
   position 1, whatever else the draw produces.

   Each guide gets its own version, because the certificate decides which
   subpart of Part 61 the applicant has to be able to talk through. Where the
   guide has a Pilot Qualifications Task the question is anchored to it, so the
   study link and the element list point somewhere real. */
var MOCK_OPEN = {
  private: {
    code: "I.A",
    q: "Before we start: what makes you qualified to take this checkride today? " +
       "Walk me through it, and show me as you go.",
    a: "Take it in three parts, in this order, and hand the evaluator each item as you name it.\n\n" +
       "**Me.** Photo identification. My student pilot certificate, which 61.103(j) requires me to " +
       "hold. My third class medical certificate, 61.23(a)(3), still valid. I am 17, which is " +
       "61.103(a). I read, speak, write and understand English, 61.103(c).\n\n" +
       "**The paperwork.** My knowledge test report, passed and still valid, 61.103(e) - and if it " +
       "shows deficient subject areas, my instructor gave me instruction in each one and endorsed " +
       "it, which is 61.39(a)(6)(ii). My logbook, with the 61.109(a) experience and the endorsements: " +
       "the A.36 knowledge test endorsement, the A.37 practical test endorsement for the 61.107(b)(1) " +
       "areas of operation, and the A.1 endorsement saying I received and logged training within the " +
       "2 calendar months before this month, which is 61.39(a)(6)(i). My IACRA application, signed " +
       "by my instructor.\n\n" +
       "**The airplane.** 61.45 says I have to furnish it, and that it has to have an airworthiness " +
       "certificate, the equipment for every task, and no operating limitation that gets in the way. " +
       "So: airworthiness certificate, registration, radio station licence if we were going " +
       "international, operating limitations and POH, weight and balance - ARROW - plus the " +
       "maintenance records showing the annual, the 100-hour if it is required, the transponder, the " +
       "static system and the ELT battery.\n\n" +
       "Then stop talking and let the evaluator ask. Volunteering more than was asked is how a " +
       "five-minute opener becomes a thirty-minute one."
  },
  instrument: {
    code: "I.A",
    q: "Start me off: what makes you eligible for this instrument checkride today, and what did " +
       "you bring?",
    a: "Everything for the rating is in one section, so answer out of 61.65 and you cannot get lost.\n\n" +
       "**Me.** Photo ID. My private pilot certificate with an airplane rating - 61.65(a)(1). My " +
       "medical certificate, valid today, because I am acting as pilot in command on this flight. " +
       "English language, 61.65(a)(2).\n\n" +
       "**The paperwork.** The IRA knowledge test report, still valid, 61.65(a)(7), with any " +
       "deficient areas retrained and endorsed under 61.39(a)(6)(ii). My logbook showing 61.65(d): " +
       "50 hours of cross-country pilot in command with at least 10 in an airplane; 40 hours of " +
       "actual or simulated instrument time with 15 from an instrument-airplane instructor; the " +
       "3 hours within the 2 calendar months before the test; and the long IFR cross-country - " +
       "250 NM along airways or ATC routing, an approach at each airport, three different kinds of " +
       "approach. The endorsements are A.42 for the knowledge test, A.43 for the practical test, " +
       "and A.44 for the 61.39 prerequisite.\n\n" +
       "**The airplane.** 61.45. Airworthy, with the equipment for every task in this ACS - and for " +
       "an instrument ride that means the 91.205(d) list, plus a current 91.411 static and altimeter " +
       "check and a 91.413 transponder check, and a VOR check under 91.171 if we are going to use " +
       "one. Charts current for the approaches we will fly.\n\n" +
       "Point at each one as you say it. The evaluator is checking a list, not testing your memory."
  },
  commercial: {
    code: "I.A",
    q: "Tell me what makes you qualified to sit this commercial checkride today, and what you had " +
       "to bring with you.",
    a: "**Me.** Photo ID. My private pilot certificate, 61.123(h). My **second class** medical, " +
       "61.23(a)(2) - a third class would let me hold a commercial certificate but not exercise its " +
       "privileges, and the evaluator may well ask me that. I am 18, 61.123(a). English, 61.123(b).\n\n" +
       "**The paperwork.** The CAX knowledge test report, valid, 61.123(d), with deficient areas " +
       "retrained and endorsed. My logbook showing 61.129(a): the 250 hours and what sits inside " +
       "them, the 20 hours of training including 10 instrument with 5 of those in a single-engine " +
       "airplane, 10 in a complex, turbine or technically advanced airplane, the two 2-hour " +
       "cross-countries more than 100 NM straight-line, 3 hours of test prep within the 2 calendar " +
       "months, and the 10 hours solo or performing PIC duties including the 300 NM cross-country " +
       "with a 250 NM straight-line leg and the 5 hours of night with 10 takeoffs and landings at a " +
       "towered field. Endorsements A.38, A.39 and A.1.\n\n" +
       "**The airplane.** 61.45 - and for this ride it has to be capable of the commercial maneuvers, " +
       "so if we are flying the power-off 180 and the performance maneuvers it needs the flaps, the " +
       "speeds and the documents to back that up. ARROW plus the maintenance records.\n\n" +
       "Expect the follow-up straight away: what can I now do that I could not do yesterday? That " +
       "is 61.133, and Part 119 is the other half of the answer."
  },
  "commercial-me": {
    code: null,
    q: "Before we go anywhere: what makes you eligible to add this multiengine class rating today?",
    a: "This is an **additional class rating**, so the governing paragraph is **61.63(c)**, and the " +
       "short answer is that it asks for very little - which is exactly why the evaluator asks.\n\n" +
       "**Me.** Photo ID. My commercial pilot certificate with an airplane single-engine land " +
       "rating - that is what makes this an add-on rather than an initial certificate. My second " +
       "class medical, 61.23(a)(2).\n\n" +
       "**What 61.63(c) asks.** A logbook endorsement from an authorized instructor saying I am " +
       "competent in the aeronautical knowledge areas and proficient in the areas of operation for " +
       "the rating - AC 61-65K A.78. And the practical test. That is it.\n\n" +
       "**What it does not ask, and I should say so out loud.** No additional knowledge test - " +
       "61.63(c)(4), because I already hold an airplane rating at this certificate level. And no " +
       "specified training times - **61.63(c)(3)**. That sentence is the one most applicants have " +
       "never read.\n\n" +
       "**Still required.** The 61.39(a)(6) endorsement, the A.1, because 61.39 applies to a " +
       "practical test for an added rating exactly as it does to an initial certificate. And 61.45: " +
       "I furnish an airworthy multiengine airplane whose AFM does not prohibit the in-flight " +
       "feathering we have to do.\n\n" +
       "Which tasks I am tested on comes from **Appendix 1** of the commercial ACS, the Additional " +
       "Rating Task Table - a short list, which is why every task on it gets examined hard."
  },
  cfi: {
    code: "III.A",
    q: "Let's start where every checkride starts. What makes you qualified to take this flight " +
       "instructor practical test today?",
    a: "**Me.** Photo ID. My commercial pilot certificate with an airplane single-engine land rating " +
       "and an instrument rating, 61.183(c). My second class medical. I am 18, 61.183(a). English, " +
       "61.183(b). At least 15 hours as pilot in command in an airplane single-engine, 61.183(j).\n\n" +
       "**The knowledge tests.** Two of them. The FOI, 61.183(e) - unless one of the three " +
       "exceptions applies: I hold a flight or ground instructor certificate, I hold a state " +
       "teaching certificate for grade 7 or above, or I am employed as a teacher at an accredited " +
       "college or university. And the FIA, 61.183(f), on the 61.185(a)(2) and (a)(3) knowledge " +
       "areas. Both reports with me, both still valid, deficient areas retrained and endorsed.\n\n" +
       "**The endorsements.** A.45 for the FOI test, A.46 for the FIA test, A.47 for the practical " +
       "test on the 61.187(b) areas of operation, A.49 for spin training under 61.183(i), and the " +
       "A.1 and A.2 endorsements for 61.39. The A.47 heading says it plainly: it is required **in " +
       "addition to** the 61.39 endorsements, which is what catches people.\n\n" +
       "**The airplane.** 61.45, and this one has a wrinkle: the evaluator will expect me to have " +
       "thought about which seat I will be in and what that does to the sight picture, because from " +
       "today I teach from the right.\n\n" +
       "The follow-up is always the same, so have it ready: what may I now do, and what may I not? " +
       "That is 61.193 and 61.195, and 61.197 is what keeps it alive."
  },
  "cfi-instrument": {
    code: null,
    q: "Before anything else: what makes you eligible for this instrument instructor practical test?",
    a: "There is no separate subpart for this rating. **61.191** sends me back to **61.183** and " +
       "changes one thing, so answer it that way.\n\n" +
       "**Me.** Photo ID. My commercial or ATP certificate with an airplane category and " +
       "single-engine class rating **and the instrument-airplane rating** - 61.183(c). I cannot " +
       "teach a rating I do not hold. My second class medical. 18 years old, English language, " +
       "15 hours pilot in command in the category and class, 61.183(j).\n\n" +
       "**What 61.191 changes.** 61.191(a) says I meet the 61.183 requirements that apply to the " +
       "rating sought. 61.191(b) says I am not required to pass the knowledge test on the " +
       "61.185(a)(1) areas - the fundamentals of instructing. And if I already hold a flight " +
       "instructor certificate, 61.183(e)(1) would have excused me from that test anyway.\n\n" +
       "**The paperwork.** The FII knowledge test report - and note that this one reports **PLT " +
       "learning statement codes**, not ACS codes, because the test is written against a PTS. My " +
       "logbook with the **A.48** endorsement for the 61.187(b)(7) areas of operation, plus the " +
       "**A.1 and A.2** endorsements for 61.39. A.48 says in its own heading that it is required in " +
       "addition to those.\n\n" +
       "**The airplane.** 61.45, equipped for instrument flight, plus the view-limiting device - " +
       "61.45(d)(2) makes that mine to provide, and the PTS names the two tasks that need it.\n\n" +
       "Then be ready for the question this rating exists for: **61.195(c)**. Know it by number."
  }
};

/* Where the opener sits in the bank, so a drawn question never duplicates it. */
function mockOpener(g) {
  var o = MOCK_OPEN[g.slug]; if (!o) return null;
  var a = null, t = null;
  if (o.code) {
    (g.acs || []).forEach(function (ar) {
      (ar.tasks || []).forEach(function (tk) {
        if (ar.roman + "." + tk.letter === o.code) { a = ar; t = tk; }
      });
    });
  }
  return {
    area: a ? a.roman : "", areaTitle: a ? a.title : "Before the test begins",
    code: o.code || "", task: t ? t.title : "Pilot qualifications",
    q: o.q, a: o.a, src: "opener", id: "opener:" + g.slug,
    els: t ? ((t.K || []).slice(0, 3).map(function (e) { return e.code; })) : []
  };
}

/* ---- selection ----------------------------------------------------------- */
function mockSelect(g, n, deficient, seed) {
  var rnd = mockRng(seed);
  var pool = mockBank(g);
  var byId = {};
  pool.forEach(function (q) { byId[q.id] = q; });

  var chosen = [], taken = {};
  function take(q, why) {
    if (!q || taken[q.id]) return false;
    taken[q.id] = 1;
    chosen.push(Object.assign({}, q, { why: why }));
    return true;
  }

  /* 0. the opener. Every practical test starts by establishing that the
        applicant, the paperwork and the aircraft are legal, so every mock does
        too. It is taken first and pinned to position 1 after the sort. */
  var opener = mockOpener(g);
  if (opener) {
    take(opener, "Every checkride starts here");
    /* Questions from the qualifications Task itself are NOT blocked. The
       opener asks the opening question; the Task's own elements - currency,
       privileges, how long a medical lasts - are still worth drawing, and in
       document order they land right after it, which is how the real
       conversation goes. */
  }

  /* 1. the knowledge test deficiencies. Appendix 1 is explicit that these
        must be covered, so they go in first and are labelled. */
  var defTasks = {};
  (deficient || []).forEach(function (code) {
    var hit = pool.filter(function (q) { return q.els.indexOf(code) >= 0; });
    if (hit.length) {
      take(hit[Math.floor(rnd() * hit.length)], "Missed on the knowledge test");
      defTasks[hit[0].code] = 1;
    }
  });

  /* 2. Tasks the document says the evaluator must select */
  var req = (g.required && g.required.required) || [];
  req.forEach(function (code) {
    var hit = shuffle(pool.filter(function (q) { return q.code === code; }), rnd);
    if (hit.length) take(hit[0], "This Task is always tested");
  });

  /* 3. at least one from every Area of Operation */
  (g.acs || []).forEach(function (a) {
    if (chosen.some(function (q) { return q.area === a.roman; })) return;
    var hit = shuffle(pool.filter(function (q) { return q.area === a.roman; }), rnd);
    if (hit.length) take(hit[0], "Area " + a.roman + " has to appear");
  });

  /* 4. fill the rest, preferring written scenarios and spreading across Areas */
  var rest = shuffle(pool.filter(function (q) { return !taken[q.id]; }), rnd);
  rest.sort(function (x, y) {
    /* scenarios first, then keep the shuffled order within each group */
    if (x.src !== y.src) return x.src === "scenario" ? -1 : 1;
    return 0;
  });
  var perArea = {};
  chosen.forEach(function (q) { perArea[q.area] = (perArea[q.area] || 0) + 1; });
  var guard = 0;
  while (chosen.length < n && guard++ < 9999) {
    /* pick the least-covered Area that still has questions left */
    var best = null, bestN = 1e9;
    rest.forEach(function (q) {
      if (taken[q.id]) return;
      var c = perArea[q.area] || 0;
      if (c < bestN) { bestN = c; best = q; }
    });
    if (!best) break;
    take(best, "");
    perArea[best.area] = (perArea[best.area] || 0) + 1;
  }

  /* Present them in document order, which is also the order an oral actually
     runs: who you are, then is the aircraft legal, then the weather and the
     plan, then the airspace and the systems, then the flight tasks in the
     order you would fly them. The opener is pinned in front of all of it. */
  var order = {};
  var i = 0;
  (g.acs || []).forEach(function (a) {
    (a.tasks || []).forEach(function (t) { order[a.roman + "." + t.letter] = i++; });
  });
  chosen.sort(function (x, y) {
    if (x.src === "opener") return -1;
    if (y.src === "opener") return 1;
    var ox = order[x.code], oy = order[y.code];
    if (ox === undefined) ox = 1e6;
    if (oy === undefined) oy = 1e6;
    return ox - oy;
  });
  return chosen.slice(0, n);
}

/* ---- the run ------------------------------------------------------------- */
function mockStart(g, lenId, deficient) {
  var lens = mockLengths(g);
  var L = lens.filter(function (x) { return x.id === lenId; })[0] || lens[1];
  var seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
  MOCK = {
    slug: g.slug, doc: g.doc, cert: (guideMeta(g.slug) || {}).cert || g.title,
    seed: seed, len: L.id, started: Date.now(), finished: null, i: 0,
    deficient: deficient || [],
    qs: mockSelect(g, L.n, deficient, seed).map(function (q) {
      return Object.assign({}, q, { mark: null, shown: false });
    })
  };
  mockSave();
}
function mockSave() {
  try { localStorage.setItem(MOCK_KEY, JSON.stringify(MOCK)); } catch (e) { /* private mode */ }
}
function mockLoad() {
  if (MOCK) return MOCK;
  try {
    var raw = localStorage.getItem(MOCK_KEY);
    if (raw) MOCK = JSON.parse(raw);
  } catch (e) { MOCK = null; }
  return MOCK;
}
function mockClear() {
  MOCK = null;
  try { localStorage.removeItem(MOCK_KEY); } catch (e) { /* nothing to do */ }
}
function mockScore() {
  var m = MOCK, pts = 0, done = 0;
  m.qs.forEach(function (q) {
    if (q.mark === null) return;
    done++;
    pts += q.mark === "ok" ? 1 : q.mark === "part" ? 0.5 : 0;
  });
  return { pts: pts, done: done, total: m.qs.length,
           pct: done ? Math.round(pts / done * 100) : 0 };
}

/* ---------------------------------------------------------------------------
   The pages: set up, run, results.
   ------------------------------------------------------------------------ */
function pageMock() {
  var g = G, m = guideMeta(g.slug) || {};
  var run = mockLoad();
  if (run && run.slug === g.slug && !run.finished) return mockRunning();
  if (run && run.slug === g.slug && run.finished) return mockResults();
  return mockSetup();
}

function mockSetup() {
  var g = G, m = guideMeta(g.slug) || {};
  var lens = mockLengths(g);
  var bank = mockBank(g);
  var nScen = bank.filter(function (q) { return q.src === "scenario"; }).length;
  var req = (g.required && g.required.required) || [];

  var h = '<div class="crumb"><a href="' + here("") + '">' + esc(m.short) +
    "</a> <span>›</span> <span>Mock checkride</span></div>" +
    '<div class="eyebrow">Practise the oral</div>' +
    '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">Mock checkride — ' +
    esc(m.cert) + "</h1>" +
    '<p class="lede">Run it the way an evaluator runs one. Questions are drawn fresh every time, ' +
    "so it is never the same test twice, and the draw follows the ACS's own rules about what has " +
    "to be covered. Mark each answer as you go; at the end you get a score out of 100 and a study " +
    "table of everything that was missed.</p>";

  var hasKT = !!(g.test);
  h += '<div class="note"><span class="lbl">How the questions are chosen</span>' +
    "<ol class=\"flow\" style=\"margin-top:8px\">" +
    (hasKT
      ? "<li>Every element the applicant <b>missed on the knowledge test</b> — " +
        esc(g.doc) + " Appendix 1 says the evaluator must cover those. Paste the codes below.</li>"
      : "") +
    (req.length
      ? "<li>The <b>" + req.length + " Tasks this document says the evaluator must select</b>.</li>"
      : "<li>On an initial test there is no short required-Task list, so every Area is fair game.</li>") +
    "<li><b>At least one question from every Area of Operation</b>.</li>" +
    "<li>The rest at random, spread evenly, written scenarios first.</li>" +
    "</ol></div>";

  if (hasKT) {
    h += '<section class="blk"><h2>1. The applicant’s knowledge test <span class="hint">' +
      "Optional, but this is the part an evaluator is obliged to check</span></h2>" +
      '<p class="lede" style="font-size:15px">Paste the ' + esc(g.test) + ' codes from the Airman ' +
      "Knowledge Test Report. Each one gets a guaranteed question, labelled so you know why it is there.</p>" +
      '<textarea id="mkDef" class="codein" rows="3" placeholder="' +
      esc(mockSampleCodes()) + '"></textarea>' +
      '<div class="erow" style="margin-top:9px"><button class="btn ghost sm" id="mkDefSample">' +
      "Use an example</button>" +
      '<span class="muted sm">Leave it empty if the applicant passed clean.</span></div></section>';
  }

  h += '<section class="blk"><h2>' + (hasKT ? "2" : "1") + '. How long</h2><div class="testgrid">' +
    lens.map(function (L) {
      return '<button class="tsel a-' + esc(m.accent || "k") + '" data-mklen="' + L.id + '">' +
        "<b>" + L.n + " questions</b><span>" + esc(L.t) + "</span><i>" + esc(L.d) + "</i></button>";
    }).join("") + "</div></section>";

  h += '<div class="note gold"><span class="lbl">What this is worth, and what it is not</span>' +
    "This is a practice tool. A score here is not a prediction and it is certainly not a " +
    "qualification — only an FAA evaluator can say whether somebody meets the standard. " +
    "What it is good for is finding the holes while there is still time to fill them.<br><br>" +
    "The bank for " + esc(m.cert) + " currently holds <b>" + nScen + " written scenario " +
    "questions</b> and a question for every one of the <b>" + bank.filter(function (q) {
      return q.src === "element"; }).length + " testable elements</b> in " + esc(g.doc) + ".</div>";
  return h;
}
function mockSampleCodes() {
  var p = codePrefixes()[0] || "PA", fs = flat();
  var out = [];
  for (var i = 0; i < fs.length && out.length < 3; i += Math.max(1, Math.floor(fs.length / 3))) {
    var t = fs[i].t, arr = (t.K || []).filter(function (e) { return !e.archived && !e.na; });
    if (arr.length) out.push(arr[0].code);
  }
  return out.join(", ");
}

/* ---- running ------------------------------------------------------------- */
function mockRunning() {
  var m = MOCK, q = m.qs[m.i], sc = mockScore();
  var pct = Math.round(m.i / m.qs.length * 100);
  var mins = Math.round((Date.now() - m.started) / 60000);

  var h = '<div class="mk-bar"><div class="mk-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="mk-top">' +
    '<div class="mk-count"><b>' + (m.i + 1) + "</b> of " + m.qs.length + "</div>" +
    '<div class="mk-meta"><span>' + esc(m.cert) + "</span>" +
    "<span>" + mins + " min elapsed</span>" +
    "<span>" + sc.done + " marked</span></div>" +
    '<button class="btn ghost sm" id="mkQuit">End the test</button></div>';

  if (!q) return mockResults();

  /* The opener on a guide with no Pilot Qualifications Task has no code, so it
     points at that guide's eligibility page instead of at a dead t/ link. */
  h += '<div class="mk-q">' +
    '<div class="mk-tag">' +
    (q.code ? '<a class="chip" href="' + here("t/" + q.code) + '">' + esc(q.code) + "</a>"
            : '<a class="chip" href="' + here("eligibility") + '">Am I eligible?</a>') +
    "<span>" + esc(q.task) + "</span>" +
    '<i>' + (q.area ? "Area " + esc(q.area) + " · " : "") + esc(q.areaTitle) + "</i></div>" +
    (q.why ? '<div class="mk-why">' + esc(q.why) + "</div>" : "") +
    "<h2>" + esc(q.q) + "</h2>";

  if (q.shown) {
    h += '<div class="mk-ans"><div class="lbl">What a complete answer covers</div>' +
      q.a.split("\n").filter(Boolean).map(function (p) { return "<p>" + fmt(p) + "</p>"; }).join("") +
      (q.els && q.els.length
        ? '<div class="mk-els">Elements: ' + q.els.map(function (c) {
            return '<a class="chip" href="' + here("t/" + q.code + "/" + encodeURIComponent(c)) +
              '">' + esc(c) + "</a>"; }).join("") + "</div>"
        : "") + "</div>";
    h += '<div class="mk-marks"><span>How did they do?</span>' +
      '<button class="btn ok" data-mkmark="ok">Correct</button>' +
      '<button class="btn warn" data-mkmark="part">Partly</button>' +
      '<button class="btn bad" data-mkmark="no">Missed</button></div>';
  } else {
    h += '<div class="mk-marks"><button class="btn" id="mkShow">Show what a good answer covers' +
      "</button><span class=\"muted sm\">Let them answer first.</span></div>";
  }
  h += "</div>";

  h += '<div class="mk-nav">' +
    (m.i > 0 ? '<button class="btn ghost sm" id="mkBack">Back</button>' : "<span></span>") +
    '<button class="btn ghost sm" id="mkSkip">Skip this one</button></div>';
  return h;
}

/* ---- results ------------------------------------------------------------- */
function mockResults() {
  var m = MOCK, sc = mockScore();
  var pass = sc.pct >= 70;
  var missed = m.qs.filter(function (q) { return q.mark === "no" || q.mark === "part"; });
  var mins = Math.round(((m.finished || Date.now()) - m.started) / 60000);

  var h = '<div class="crumb"><a href="' + here("") + '">' + esc((guideMeta(m.slug) || {}).short) +
    "</a> <span>›</span> <span>Mock checkride result</span></div>";

  h += '<div class="mk-result ' + (pass ? "pass" : "fail") + '">' +
    '<div class="mk-score"><b>' + sc.pct + "</b><span>out of 100</span></div>" +
    "<div><h1>" + (pass ? "Passed the mock" : "Did not meet the standard") + "</h1>" +
    "<p>" + esc(m.cert) + " · " + sc.done + " of " + sc.total + " questions marked · " +
    mins + " minutes · 70 is the pass mark</p></div></div>";

  h += '<div class="note ' + (pass ? "" : "flag") + '"><span class="lbl">What this score means</span>' +
    (pass
      ? "On this sample, on this day, the applicant covered enough. That is worth something — " +
        "but a real evaluator picks different questions, asks follow-ups, and watches how the " +
        "applicant thinks, not just what they know. <b>Treat a pass here as permission to keep " +
        "practising, not as a prediction.</b>"
      : "That is what practice is for. Nothing here goes on any record. Work through the study " +
        "table below, then run it again — the questions will be different.") +
    (m.deficient && m.deficient.length
      ? "<br><br><b>Knowledge test deficiencies:</b> " + m.deficient.length + " code" +
        (m.deficient.length === 1 ? " was" : "s were") + " entered and " +
        (m.qs.filter(function (q) { return q.why === "Missed on the knowledge test" &&
           q.mark === "ok"; }).length) + " of them answered correctly here."
      : "") + "</div>";

  h += '<div class="erow" style="margin:20px 0"><button class="btn" id="mkAgain">' +
    "Run it again</button>" +
    (missed.length ? '<button class="btn ghost" id="mkCopy">' + I.copy + " Copy the study table</button>" : "") +
    '<button class="btn ghost" id="mkPrint">Print</button></div>';

  /* the score by Area, so a pattern shows up */
  var byArea = {};
  m.qs.forEach(function (q) {
    if (q.mark === null) return;
    var a = byArea[q.area] || (byArea[q.area] = { t: q.areaTitle, n: 0, p: 0 });
    a.n++; a.p += q.mark === "ok" ? 1 : q.mark === "part" ? 0.5 : 0;
  });
  var areas = Object.keys(byArea);
  if (areas.length) {
    h += '<section class="blk"><h2>Where the marks went</h2><div class="mk-areas">' +
      areas.map(function (r) {
        var a = byArea[r], p = Math.round(a.p / a.n * 100);
        return '<div class="mk-area"><div class="mk-ah"><b class="mono">' + esc(r) + "</b>" +
          "<span>" + esc(a.t) + "</span><i>" + p + "%</i></div>" +
          '<div class="mk-abar"><div class="' + (p >= 70 ? "ok" : "bad") +
          '" style="width:' + p + '%"></div></div></div>';
      }).join("") + "</div></section>";
  }

  if (!missed.length) {
    h += '<div class="note"><span class="lbl">Nothing missed</span>' +
      "Every question marked was answered. Run it again for a different draw — the bank is " +
      "much larger than one test.</div>";
    return h;
  }

  h += '<section class="blk" id="mkStudy"><h2>What to study <span class="hint">' +
    missed.length + " question" + (missed.length === 1 ? "" : "s") +
    " missed or partly answered</span></h2>" +
    '<div class="tablewrap"><table class="studytable" id="mkTable"><thead><tr>' +
    "<th>Code</th><th>What the ACS says</th><th>Where to study it</th></tr></thead><tbody>";
  missed.forEach(function (q) {
    var refs = refsFor(taskOf(q.code) || {});
    var elText = q.els.map(function (c) {
      var f = first(findElement(c));
      return f ? { code: c, text: f.el.text } : { code: c, text: "" };
    });
    h += '<tr><td class="mono nw" data-l="Code">' +
      elText.map(function (e) { return esc(e.code); }).join("<br>") +
      '<div class="mk-mk ' + q.mark + '">' + (q.mark === "no" ? "missed" : "partly") + "</div></td>" +
      '<td data-l="What the ACS says"><b>' + esc(q.code + " " + q.task) + "</b>" +
      elText.map(function (e) {
        return e.text ? "<br>" + esc(e.text) : ""; }).join("") +
      '<div class="mk-qq">Asked: ' + esc(q.q) + "</div></td>" +
      '<td data-l="Where to study it"><a href="' + here("t/" + q.code) + '">This site: ' +
      esc(q.code) + "</a>" +
      (refs.length ? "<br>" + refs.map(function (r) {
        return r[2] ? '<a href="' + esc(r[2]) + '" target="_blank" rel="noopener">' +
          esc(r[1]) + "</a>" : esc(r[1]); }).join("<br>") : "") +
      "</td></tr>";
  });
  h += "</tbody></table></div>" +
    '<p class="v-note">Every code above is the FAA’s own, and the wording beside it is quoted ' +
    "from " + esc(m.doc) + ". Take this table to the next lesson.</p></section>";
  return h;
}

/* ---- wiring -------------------------------------------------------------- */
function wireMock() {
  var host = el("main"); if (!host) return;

  /* #main is NOT replaced between renders - only #view inside it is - and the
     router calls wireMock() on every render of the mock route. Without this
     guard a second visit to the page left TWO delegated click handlers on
     #main, a third left three, and every one of them ran advance(): the
     question counter jumped 1, 3, 5 on a second visit and 1, 4, 7 on a third.
     The keyboard handler below was already guarded this way; the click handler
     was not. Attach once, and let the handler read the live MOCK state. */
  if (wireMock._click) return;
  wireMock._click = true;

  host.addEventListener("click", function (e) {
    var t = e.target;

    var len = t.closest("[data-mklen]");
    if (len) {
      var raw = (el("mkDef") || {}).value || "";
      mockStart(G, len.getAttribute("data-mklen"), parseCodes(raw));
      redrawMock();
      return;
    }
    if (t.closest("#mkDefSample")) {
      if (el("mkDef")) el("mkDef").value = mockSampleCodes();
      return;
    }
    if (t.closest("#mkShow")) {
      MOCK.qs[MOCK.i].shown = true; mockSave(); redrawMock(); return;
    }
    var mk = t.closest("[data-mkmark]");
    if (mk) {
      MOCK.qs[MOCK.i].mark = mk.getAttribute("data-mkmark");
      advance(); return;
    }
    if (t.closest("#mkSkip")) { advance(); return; }
    if (t.closest("#mkBack")) {
      if (MOCK.i > 0) MOCK.i--;
      mockSave(); redrawMock(); return;
    }
    if (t.closest("#mkQuit")) {
      MOCK.finished = Date.now(); mockSave(); redrawMock(); return;
    }
    if (t.closest("#mkAgain")) { mockClear(); redrawMock(); return; }
    if (t.closest("#mkPrint")) { window.print(); return; }
    if (t.closest("#mkCopy")) {
      var tbl = el("mkTable");
      if (tbl) copyTable(t.closest("#mkCopy"), tbl);
      return;
    }
  });

  /* an evaluator has a clipboard in one hand - keys are faster than clicking */
  {
    document.addEventListener("keydown", function (e) {
      if (!MOCK || MOCK.finished) return;
      if (!/\/mock$/.test(location.hash)) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || "").toUpperCase())) return;
      var q = MOCK.qs[MOCK.i]; if (!q) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!q.shown) { q.shown = true; mockSave(); redrawMock(); }
        return;
      }
      if (!q.shown) return;
      var map = { "1": "ok", "2": "part", "3": "no",
                  y: "ok", p: "part", n: "no" };
      var m = map[e.key.toLowerCase()];
      if (m) { e.preventDefault(); q.mark = m; advance(); }
    });
  }
}
function advance() {
  MOCK.i++;
  if (MOCK.i >= MOCK.qs.length) { MOCK.finished = Date.now(); MOCK.i = MOCK.qs.length - 1; }
  mockSave();
  redrawMock();
}
function redrawMock() {
  /* #view, not #main. renderPage() writes the page into #view, which carries
     the content padding and max width; replacing #main threw that away and the
     mock ran edge to edge with its percentages clipped off the right. The
     click handlers are delegated from #main, which is #view's parent, so they
     survive this. */
  var n = el("view"); if (!n) return;
  n.innerHTML = pageMock() + footer();
  window.scrollTo(0, 0);
}
/* "PA.I.A.K1, PA.I.B.K3" or a whole pasted test report - pull out the codes */
function parseCodes(raw) {
  var out = [], seen = {};
  String(raw || "").toUpperCase().split(/[^A-Z0-9.]+/).forEach(function (tk) {
    var c = tk.replace(/\.$/, "");
    if (!c || c.length < 4 || seen[c]) return;
    if (first(findElement(c))) { seen[c] = 1; out.push(c); return; }
    codePrefixes().forEach(function (p) {
      var full = p + "." + c;
      if (!seen[full] && first(findElement(full))) { seen[full] = 1; out.push(full); }
    });
  });
  return out;
}


  /* =============== mock checkride picker =============== */
  function pageMockPicker() {
    var h = '<div class="crumb"><a href="#/">All guides</a> <span>›</span> <span>Mock checkrides</span></div>' +
      '<div class="eyebrow">Practise the oral</div>' +
      '<h1 style="font-size:clamp(26px,4.6vw,36px);margin-bottom:12px">Mock checkrides</h1>' +
      '<p class="lede">Run a practice oral the way an evaluator would. Scenario questions drawn fresh ' +
      "each time so it is never the same test twice, marked as you go, scored out of 100, and at the " +
      "end it hands back a study list of everything that was missed.</p>";
    h += '<h2 class="sect">Which certificate?</h2><div class="gcards">' +
      GUIDES.map(function (g) {
        return '<a class="gcard a-' + esc(g.accent) + '" href="' + guideHref(g.slug, "mock") + '">' +
          '<div class="gc-top"><span class="gc-doc mono">' + esc(g.doc) + "</span></div>" +
          "<h3>" + esc(g.cert) + "</h3>" +
          '<p>About ' + (g.slug === "cfi" ? "three hours" : "an hour and a half to two hours") +
          ', the way the real oral runs.</p>' +
          '<span class="gc-go">Start ' + I.chev + "</span></a>";
      }).join("") + "</div>";
    return h;
  }

  /* =============== adding a rating to a certificate you already hold =============== */
  function pageAddRating() {
    var g = G, m = guideMeta(g.slug) || {};
    var tables = (g.ratings || []).filter(function (t) {
      return !/Instrument Proficiency Check/i.test(t.title);
    });
    var ipc = (g.ratings || []).filter(function (t) {
      return /Instrument Proficiency Check/i.test(t.title);
    });
    var h = '<div class="crumb"><a href="' + here("") + '">' + esc(m.short) +
      "</a> <span>›</span> <span>Adding this rating</span></div>" +
      '<div class="eyebrow">' + esc(g.doc) + " &middot; Appendix 1</div>" +
      '<h1 style="font-size:clamp(24px,4.4vw,34px);margin-bottom:12px">' +
      "Adding this rating to a certificate you already hold</h1>" +
      '<p class="lede">If you already hold a pilot certificate at this level in another category ' +
      "or class, you are not tested on everything. " + esc(g.doc) + " publishes a table of the " +
      "Tasks that are required, and which ones they are depends on what you already hold. " +
      "Find your existing rating in the column headings and read down.</p>";

    h += '<div class="note flag"><span class="lbl">Read the rule with the table</span>' +
      "If you hold two or more category or class ratings and the table gives different " +
      "requirements for them, the <b>least restrictive</b> entry applies. And the table is a " +
      "<b>floor, not a ceiling</b> — the evaluator may still choose to evaluate you on the " +
      "remaining Areas of Operation and Tasks.</div>";

    if (!tables.length) {
      h += '<div class="note gold"><span class="lbl">No table in this document</span>' +
        esc(g.doc) + " does not publish an Additional Rating Task Table. " +
        (g.is_pts ? "It is a Practical Test Standard, and the add-on rules sit in 14 CFR 61.63 " +
                    "instead." : "Check Appendix 1 of the document itself.") + "</div>";
      return h;
    }

    tables.forEach(function (t, i) {
      h += ratingTable(t, i);
    });
    if (ipc.length) {
      h += '<h2 class="sect">Instrument proficiency check</h2>' +
        '<p class="lede">Not an added rating — but it lives in the same appendix, and it is ' +
        "the table that says what an IPC has to cover. 14 CFR 61.57(d) is the rule; this is the " +
        "minimum the person giving the check must see. The " +
        '<a href="' + here("ipc") + '">instrument proficiency check page</a> turns this table into ' +
        "a checklist you can tick off while the check is being flown, and explains when 61.57 says " +
        "you need one.</p>";
      ipc.forEach(function (t, i) { h += ratingTable(t, 900 + i); });
    }
    h += '<p class="v-note">Tables quoted from ' + esc(g.doc) + ", Appendix 1. " +
      "A cell reading <b>None</b> means no Task in that Area is required; <b>All</b> means every " +
      "Task in it is.</p>";
    return h;
  }

  /* One Additional Rating Task Table. Rows are Areas of Operation and each
     column is a rating the applicant might ALREADY hold, so the reader finds
     their own column first - which is why the header is sticky on a phone and
     the Area code is repeated on every row of the stacked layout. */
  function ratingTable(t, i) {
    var short = t.title.replace(/^Addition of an?\s+/i, "")
                       .replace(/\s+to an existing\s+/i, " ← ")
                       .replace(/\s*Certificate$/i, "");
    var h = '<section class="blk" id="rt-' + i + '"><h2>' + esc(t.title) + "</h2>";
    if (t.legend && Object.keys(t.legend).length) {
      h += '<div class="rt-legend">' + Object.keys(t.legend).map(function (k) {
        return "<span><b>" + esc(k) + "</b> " + esc(t.legend[k]) + "</span>";
      }).join("") + "</div>";
    }
    if (t.cols.length > 4) {
      h += '<p class="rt-hint">' + t.cols.length + " columns \u2014 scroll the table " +
        "sideways to find the rating you already hold. The Area column stays put.</p>";
    }
    h += '<div class="tablewrap rtw"><table class="rt"><thead><tr>' +
      "<th>Area of Operation</th>" +
      t.cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
      t.rows.map(function (r) {
        var ttl = areaTitleOf(r.area);
        return '<tr><th scope="row"><span class="mono">' + esc(r.area) + "</span>" +
          (ttl ? "<span>" + esc(ttl) + "</span>" : "") + "</th>" +
          r.req.map(function (v, j) {
            var none = /^none$/i.test(v), all = /^all$/i.test(v);
            return '<td data-l="' + esc(t.cols[j] || "") + '" class="' +
              (none ? "rt-none" : all ? "rt-all" : (/ or /i.test(v) ? "rt-or" : "")) + '">' +
              rtCell(v) + "</td>";
          }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";

    /* Some cells read "A or B,C or D,E" — three requirements, two of them a
       choice, all run together. The table prints it as the FAA wrote it, and
       this note says how to read it, because on first sight it looks like a
       typo. */
    if (tableHasOtherArea(t)) {
      /* On an add-on guide this note fires under the table that governs THAT
         guide, where the missing Areas are required Tasks the reader must still
         fly - they are simply written up on the parent guide rather than here.
         Telling that reader the Tasks "belong to another rating" is the wrong
         way round and could cost him a Task he was meant to prepare. */
      h += '<p class="rt-hint">This table is printed from the whole of ' + esc(G.doc) +
        ", so it lists Areas of Operation that this guide does not carry. Those rows are here " +
        "because the FAA's table has them. If a row applies to you, the Task is still part of " +
        "your test &mdash; it is written up on the guide for the rating you already hold, not " +
        "reproduced here.</p>";
    }
    if (tableHasChoice(t)) {
      h += '<div class="note gold"><span class="lbl">How to read a cell like ' +
        '<span class="mono">A or B,C or D,E</span></span>' +
        "The commas separate requirements and the <b>or</b> is a choice inside one of them. " +
        'That cell means <b>three</b> Tasks: <b>A or B</b>, then <b>C or D</b>, then <b>E</b>. ' +
        "The evaluator picks which side of each <i>or</i> you fly, so be ready for both — " +
        "turning up having practised only the chandelle is how an applicant discovers the " +
        "evaluator wanted the lazy eight.</div>";
    }
    return h + "</section>";
  }
  /* Bold the choice word so the eye can find the break in "A or B,C or D,E". */
  function rtCell(v) {
    if (!v) return "\u2014";
    return esc(v).replace(/\bor\b/g, '<b class="rt-orx">or</b>');
  }
  function tableHasChoice(t) {
    return (t.rows || []).some(function (r) {
      return (r.req || []).some(function (v) { return / or /i.test(v || ""); });
    });
  }

  /* The rating tables are printed from the FULL document, so they carry rows
     for Areas this guide does not have - Area X, Multiengine Operations, in an
     ASEL guide. Naming it from `dropped` beats printing a bare roman numeral
     that looks like a parsing failure. */
  /* Work out, once per render, which task-level figure goes under which card.
     A figure names its card with `card` - the card's ACS code, or its heading.
     Returns { byCard: {cardIndex: [fig]}, loose: [fig] }. Nothing is written
     back onto the guide payload: that survives the render, and mutating it
     meant a second visit to the same task showed no figures at all. */
  function placeFigs(task) {
    var figs = task.figs || [], cards = task.cards || [];
    var byCard = {}, taken = {};
    cards.forEach(function (k, i) {
      var codes = (k.code || "").split(",").map(function (x) { return x.trim(); });
      var head = (k.h || "").trim().toLowerCase();
      figs.forEach(function (f, fi) {
        if (taken[fi] || !f.card) return;
        var want = String(f.card).trim();
        if (codes.indexOf(want) >= 0 || want.toLowerCase() === head) {
          taken[fi] = 1; (byCard[i] = byCard[i] || []).push(f);
        }
      });
    });
    return { byCard: byCard, loose: figs.filter(function (f, fi) { return !taken[fi]; }) };
  }

  function areaTitleOf(roman) {
    var out = "";
    ACS.forEach(function (a) { if (a.roman === roman) out = a.title; });
    if (!out) {
      ((G && G.dropped) || []).forEach(function (a) { if (a.roman === roman) out = a.title; });
    }
    return out;
  }
  function tableHasOtherArea(t) {
    return (t.rows || []).some(function (r) {
      return !ACS.some(function (a) { return a.roman === r.area; });
    });
  }

  /* ======================= THE PORTAL ======================= */
  var TOOLCARDS = [
    { href: "#/search",    icon: "search", t: "Advanced search",
      d: "Search every word in every guide at once — teaching notes, common errors and the ACS wording itself — and see which certificate each result belongs to." },
    { href: "#/codes",     icon: "grid",   t: "Missed-code study table",
      d: "Type the codes off an Airman Knowledge Test Report and get a table you can paste straight into a document: the code, what the FAA says it covers, and where to study it." },
    { href: "#/mock",      icon: "badge",  t: "Mock checkrides",
      d: "Run a practice oral as the evaluator. Scenario questions drawn fresh each time, scored out of 100, and it hands back a study list of everything that was missed." },
    { href: "#/tools",     icon: "calc",   t: "Useful resources",
      d: "An E6B that runs in the page, the formulas worth knowing, a printable nav log, and a METAR, TAF and PIREP decoder." },
    { href: "#/resources", icon: "link",   t: "Official resources",
      d: "The handbooks, advisory circulars and regulations themselves — every link checked." }
  ];

  function pagePortal() {
    var h = '<section class="hero">' +
      '<div class="hero-in">' +
      '<div class="eyebrow">Airman Certification Standards &middot; Part 61 &middot; Airplane</div>' +
      "<h1>Every checkride, one place.</h1>" +
      '<p class="lede">Pick the certificate you are working on. Every task, every Knowledge, Risk ' +
      "Management and Skills element quoted from the ACS itself, with the FAA reference beside it " +
      "and the tools to actually study from.</p>" +
      '<div class="hero-stats">' +
      statCard(GUIDES.length, "study guides") +
      statCard(GUIDES.reduce(function (a, g) { return a + g.tasks; }, 0), "tasks") +
      statCard(GUIDES.reduce(function (a, g) { return a + g.elements; }, 0).toLocaleString(), "ACS elements") +
      "</div></div></section>";

    h += '<h2 class="sect">Choose your guide</h2>' +
      '<div class="gcards">' + GUIDES.map(gcard).join("") + "</div>";

    h += objectives(null);

    h += '<h2 class="sect">Or go straight to a tool</h2>' +
      '<div class="tcards">' + TOOLCARDS.map(function (t) {
        return '<a class="tcard" href="' + t.href + '"><span class="ti">' + (I[t.icon] || "") + "</span>" +
          "<div><h3>" + esc(t.t) + "</h3><p>" + esc(t.d) + "</p></div>" +
          '<span class="go" aria-hidden="true">' + I.chev + "</span></a>";
      }).join("") + "</div>";

    h += '<div class="note flag" style="margin-top:34px"><span class="lbl">' +
      "What this is, and what it is not</span>" +
      "This is a <b>study guide</b>, written to help you prepare. It is <b>not</b> the authority. " +
      "The Airman Certification Standards, the Practical Test Standards, 14 CFR and the FAA " +
      "handbooks are the authority, and the version in force on the day of your checkride is the " +
      "one that counts. Everything here names its source so you can go and check it — please do. " +
      'If you find a mistake, <a href="#/contact">tell me</a> and it gets fixed.</div>';
    return h;
  }
  /* ============ THE THREE OBJECTIVES ============
     These are the reason the site exists. They appear on the portal, on every
     guide's front page and on the About page, in that order of priority -
     safety first, always. Do not reorder them. */
  var OBJECTIVES = [
    { n: "01", t: "Safety, before anything else",
      d: "Every page here is written so that the safe answer is the obvious one. A checkride is " +
         "passed once; the habits are carried for a career. If something on this site ever makes " +
         "the unsafe choice look easier, that is a bug and it gets fixed." },
    { n: "02", t: "Excellence in every pilot who comes next",
      d: "Not the minimum that squeaks past a practical test — the standard you would want in " +
         "the other seat on the worst day of your flying life. Knowing the number is passing. " +
         "Knowing why the number is the number is the goal." },
    { n: "03", t: "The best guide a CFI applicant or a student pilot could ask for",
      d: "Complete, cited line by line, in plain language, and free. Every element quoted from the " +
         "source document itself, every claim pointing back at the handbook it came from, so you " +
         "never have to take my word for any of it." }
  ];

  function objectives(scopeLine) {
    var h = '<section class="obj"><h2 class="sect">Why this exists</h2>' +
      '<p class="ob-why">' + (scopeLine ||
        "I am a CFI applicant. I built this because it is what I wish somebody had handed me when " +
        "I started, and because I think building it is part of taking the job seriously. " +
        "Nobody asked for it. It is free, and it always will be.") + "</p>" +
      '<div class="ob-grid">' + OBJECTIVES.map(function (o) {
        return '<div class="obcard"><span class="ob-n mono">' + o.n + "</span>" +
          "<h3>" + esc(o.t) + "</h3><p>" + esc(o.d) + "</p></div>";
      }).join("") + "</div>" +
      '<p class="ob-foot">Read more on the <a href="#/about">about page</a>, ' +
      'or <a href="#/contact">tell me what is wrong</a> so objective three keeps being true.</p>' +
      "</section>";
    return h;
  }

  function statCard(n, label) {
    return '<div class="hstat"><b>' + esc(String(n)) + "</b><span>" + esc(label) + "</span></div>";
  }
  function gcard(g) {
    var ready = g.written > 0;
    return '<a class="gcard a-' + esc(g.accent) + (ready ? "" : " soon") + '" href="' +
      guideHref(g.slug) + '">' +
      '<div class="gc-top"><span class="gc-doc mono">' + esc(g.doc) + "</span>" +
      (g.teaching ? '<span class="gc-tag">teaching format</span>' : "") +
      (g.is_pts ? '<span class="gc-tag pts">PTS</span>' : "") + "</div>" +
      "<h3>" + esc(g.cert) + "</h3>" +
      '<div class="gc-sub">' + esc(g.title.replace(/^.*?—\s*/, "")) + "</div>" +
      "<p>" + esc(g.blurb) + "</p>" +
      '<div class="gc-meta"><span>' + g.areas + " areas</span><span>" + g.tasks +
      " tasks</span><span>" + g.elements.toLocaleString() + " elements</span></div>" +
      (ready ? '<span class="gc-go">Open ' + I.chev + "</span>"
             : '<span class="gc-go soon">ACS loaded · study notes in progress</span>') +
      "</a>";
  }

  /* ======================= ONE GUIDE'S FRONT PAGE ======================= */
  function pageGuideHome() {
    var g = G, m = guideMeta(g.slug) || {};
    var req = reqSpec();
    var h = '<div class="crumb"><a href="#/">All guides</a> <span>›</span> <span>' +
      esc(m.cert || g.title) + "</span></div>" +
      '<div class="ghead a-' + esc(m.accent || "k") + '">' +
      '<div class="eyebrow">' + esc(g.doc) + (g.is_pts ? " · Practical Test Standards" : " · Airman Certification Standards") + "</div>" +
      "<h1>" + esc(g.title) + "</h1>" +
      '<div class="gh-meta"><span class="chip">' + ACS.length + " Areas of Operation</span>" +
      '<span class="chip">' + flat().length + " Tasks</span>" +
      '<span class="chip">' + elementCount().toLocaleString() + " elements</span>" +
      (m.test ? '<span class="chip gold">Knowledge test: ' + esc(m.test) + "</span>" : "") +
      "</div></div>";

    if (g.is_pts) {
      h += '<div class="note gold"><span class="lbl">This one is a PTS, not an ACS</span>' +
        "FAA-S-8081-9E is a Practical Test Standard. It has no Knowledge, Risk Management and Skills " +
        "element codes — it has Objectives and numbered elements instead. The reference numbers " +
        "shown on these pages (like <b>FII.I.A.1a</b>) are <b>this site's own numbering</b> of the " +
        "PTS elements so the study table and the mock have something to point at. " +
        "<b>They are not FAA ACS codes.</b> The knowledge test for this rating reports " +
        "<b>PLT learning statement codes</b> instead.</div>";
    }
    if (req.required && req.required.length) {
      h += '<div class="note"><span class="lbl">Tasks the evaluator must select</span>' +
        "These " + req.required.length + " are guaranteed to be on the test. " +
        "Everything else is selected at the evaluator's discretion.<br><br>" +
        '<div class="reqrow">' + req.required.map(function (c) {
          var t = taskOf(c);
          return '<a class="chip flag" href="' + here("t/" + c) + '" title="' +
            esc(mustWhy(c)) + '">' + esc(c) + (t ? " · " + esc(t.title) : "") + "</a>";
        }).join("") + "</div>" +
        (req.excluded && req.excluded.length ?
          '<div class="sh">Not tested in a single-engine airplane</div><div class="reqrow">' +
          req.excluded.map(function (c) { return '<span class="chip">' + esc(c) + "</span>"; }).join("") +
          "</div>" + (req.excluded_why ? '<p class="v-note">' + esc(req.excluded_why) + "</p>" : "") : "") +
        "</div>";
    } else if (req.note) {
      h += '<div class="note"><span class="lbl">How the evaluator picks Tasks</span>' + fmt(req.note) + "</div>";
    }

    h += '<h2 class="sect">Areas of Operation</h2>' + areaGapNote() + '<div class="arows">' +
      ACS.map(function (a) {
        var done = a.tasks.filter(function (t) { return C[a.roman + "." + t.letter]; }).length;
        return '<a class="arow" href="' + here("a/" + a.roman) + '">' +
          '<span class="rn">' + esc(a.roman) + "</span>" +
          "<span class=\"at\"><b>" + esc(a.title) + "</b>" +
          "<span>" + a.tasks.length + " task" + (a.tasks.length === 1 ? "" : "s") +
          (done ? " · " + done + " with study notes" : "") + "</span></span>" +
          '<span class="go">' + I.chev + "</span></a>";
      }).join("") + "</div>";

    h += '<h2 class="sect">Tools for this guide</h2><div class="tcards">' +
      guideTools().map(function (t) {
        return '<a class="tcard" href="' + t.href + '"><span class="ti">' + (I[t.icon] || "") + "</span>" +
          "<div><h3>" + esc(t.t) + "</h3><p>" + esc(t.d) + "</p></div>" +
          '<span class="go" aria-hidden="true">' + I.chev + "</span></a>";
      }).join("") + "</div>";

    h += objectives(
      "This guide covers <b>" + esc(m.cert || g.title) + "</b> against " + esc(g.doc) +
      ". It is here for the same three reasons the rest of the site is, and they are worth " +
      "saying out loud before you start studying.");
    return h;
  }

  /* A guide for one rating drops the Areas written for the others, so the roman
     numerals can skip - Private runs ... IX, XI, XII with no X, because Area X
     is Multiengine Operations. The numbering is the FAA's, and it has to stay
     the FAA's so the element codes match, so the gap gets named rather than
     renumbered. An add-on guide is the mirror image: almost everything is
     missing, because the applicant already holds it. */
  function areaGapNote() {
    var d = (G && G.dropped) || [];
    if (!d.length) return "";
    var addon = /add-on/i.test(G.title || "");
    var list = '<ul class="gaplist">' + d.map(function (a) {
      return "<li><b>" + esc(a.roman) + "</b> " + esc(a.title) + "</li>";
    }).join("") + "</ul>";
    var lead = addon
      ? "This is an <b>add-on</b> guide, so it carries only what is new with a second " +
        "engine. " + esc(G.doc) + " has " + d.length + " more Areas of Operation; you were " +
        "tested on them for the certificate you already hold, and they are not repeated here:"
      : esc(G.doc) + " covers every airplane rating in one book. " +
        (d.length > 1 ? "These Areas are" : "This Area is") +
        " written for a rating this guide does not cover, so " +
        (d.length > 1 ? "they are" : "it is") + " not listed \u2014 which is why the numbering " +
        "skips. The numbering is the FAA's own and is left alone so every element code still " +
        "matches the document:";
    var head = addon
      ? "What this add-on does not repeat"
      : d.length > 1
        ? "Why " + d.length + " Area numbers are missing"
        : "Why the numbering skips Area " + esc(d[0].roman);
    return '<details class="gapnote"><summary>' + head + "</summary>" +
      "<p>" + lead + "</p>" + list + "</details>";
  }

  function elementCount() {
    var n = 0;
    ACS.forEach(function (a) { a.tasks.forEach(function (t) { n += t.K.length + t.R.length + t.S.length; }); });
    return n;
  }
  function guideTools() {
    var g = G, m = guideMeta(g.slug) || {}, out = [];
    out.push({ href: here("search"), icon: "search", t: "Search this guide",
      d: "Every word in " + esc(m.short || g.title) + ", with the sentence each hit sits in." });
    out.push({ href: here("eligibility"), icon: "badge", t: "Am I eligible?",
      d: "The requirements for the " + esc(m.cert || "certificate") + " under Part 61, with a checklist that tells you what is still missing." });
    out.push({ href: here("mock"), icon: "quiz", t: "Mock checkride",
      d: "A practice oral for this certificate, scored, with a study list at the end." });
    /* A class add-on takes no additional knowledge test (61.63(c)(4)), so there
       is no report to turn into a study plan and no test code to name. */
    if (m.test) out.push({ href: here("codes"), icon: "grid", t: "Missed-code study table",
      d: "Turn a " + esc(m.test) + " report into a study plan." });
    if (hasIpc()) out.push({ href: here("ipc"), icon: "check", t: "Instrument proficiency check",
      d: "When 61.57 says you need one, who may give it, and the Appendix 2 task list as a checklist you tick as you fly." });
    if (hasAppx()) out.push({ href: here("appx"), icon: "book", t: "Appendices",
      d: "The rules of the game: roles and responsibilities, safety of flight, and the equipment requirements." });
    if (!g.is_pts && !g.teaching) out.push({ href: here("addrating"), icon: "check", t: "Adding this rating",
      d: "Already hold another category or class? This is the shorter list of Tasks you are tested on." });
    /* Same rule as the sidebar rail above: the FOI mnemonics are for someone who
       has to TEACH the fundamentals of instructing, which is Area I of the CFI
       document only. The rail already gated on g.teaching; this card did not,
       so the Commercial guide home offered FOI mnemonics. */
    if (g.teaching && SC("mnemonics")) out.push({ href: here("mnemonics"), icon: "quiz", t: "FOI mnemonics",
      d: "All 56, letter by letter, with the handbook page for every word." });
    if (ENDO.length) out.push({ href: here("endorsements"), icon: "sign", t: "Sample endorsements",
      d: ENDO.length + " endorsements quoted from AC 61-65K, plus the cheat sheet." });
    out.push({ href: "#/tools", icon: "calc", t: "Useful resources",
      d: "E6B, formulas, nav log and the weather decoder — shared across every guide." });
    return out;
  }

  /* ---------------------------------------------------------------
     Routing.  #/                      the portal
               #/g/<slug>/...          inside one guide
               #/search #/codes #/mock #/tools #/resources #/about
               #/contact               site-wide
     --------------------------------------------------------------- */
  function guideHref(slug, rest) { return "#/g/" + slug + (rest ? "/" + rest : ""); }
  function here(rest) { return G ? guideHref(G.slug, rest) : "#/" + (rest || ""); }

  function route() {
    var p = (location.hash || "#/").slice(1);
    if (!p.indexOf("//")) p = p.slice(1);
    var parts = p.split("/").filter(Boolean).map(decodeURIComponent);

    /* a guide route loads its data first, then renders */
    if (parts[0] === "g" && parts[1]) {
      var slug = parts[1];
      if (!guideMeta(slug)) { renderPage(pageMissing(slug), "Not found"); return; }
      if (G && G.slug === slug && LOADED[slug]) { syncRail(slug); drawGuide(slug, parts.slice(2), p); return; }
      renderPage(pageLoading(slug), "Loading");
      loadGuide(slug, function (err) {
        if (err) { renderPage(pageLoadError(slug, err), "Could not load"); return; }
        RAILFOR = null; syncRail(slug); drawGuide(slug, parts.slice(2), p);
      });
      return;
    }
    if (G) { G = null; ACS = []; C = {}; IMG = {}; VID = {};
             ENDO = SITE.endorsements || []; FLAT = null; ANCHOR = null; }
    syncRail(null);
    drawSite(parts, p);
  }

  function drawSite(parts, p) {
    var h, title = "ACS Reference";
    if (parts[0] === "search") { h = pageSearch(parts[1], true); title = "Search — ACS Reference"; }
    else if (parts[0] === "codes" && parts[1]) {
      /* The picker links to #/codes/<TEST>. That guide's payload has to be
         fetched before any code can be resolved, so render a placeholder, load
         it, then re-render in place. Without this the click changed the hash
         and nothing else happened. */
      var tsel = testById(parts[1]);
      if (!tsel) { h = pageCodesGlobal(); title = "Missed-code study table — ACS Reference"; }
      else {
        h = pageCodesTest(tsel.id);
        title = tsel.id + " missed codes — ACS Reference";
        if (!LOADED[tsel.guide]) {
          fetchGuide(tsel.guide, function () {
            if (!/^#\/codes\//.test(location.hash)) return;   /* they moved on */
            var v = el("view"); if (!v) return;
            v.innerHTML = pageCodesTest(tsel.id) + footer();
            wireGlobalCodes();
          });
        }
      }
    }
    else if (parts[0] === "codes") { h = pageCodesGlobal(parts[1]); title = "Missed-code study table — ACS Reference"; }
    else if (parts[0] === "mock") { h = pageMockPicker(); title = "Mock checkrides — ACS Reference"; }
    else if (parts[0] === "tools") { h = pageTools(); title = "Useful resources — ACS Reference"; }
    else if (parts[0] === "formulas") { h = pageFormulas(); title = "Formulas — ACS Reference"; }
    else if (parts[0] === "navlog") { h = pageNavlog(); title = "Navigation log — ACS Reference"; }
    else if (parts[0] === "fplan") { h = pageFplan(); title = "ICAO flight plan — ACS Reference"; }
    else if (parts[0] === "holding") { h = pageInstr("hold"); title = "Holding entries — ACS Reference"; }
    else if (parts[0] === "cdi") { h = pageInstr("cdi"); title = "CDI and HSI — ACS Reference"; }
    else if (parts[0] === "ipc") { h = pageIpc(); title = "Instrument proficiency check — ACS Reference"; }
    else if (parts[0] === "wx") { h = pageWx(); title = "Weather decoder — ACS Reference"; }
    else if (parts[0] === "endorsements") { h = pageEndorsements(parts[1]); title = "Sample endorsements — ACS Reference"; }
    else if (parts[0] === "presolo") { h = pagePresolo(); title = "Pre-solo written exam — ACS Reference"; }
    else if (parts[0] === "mnemonics") { h = pageMnemonics(parts[1]); title = "FOI mnemonics — ACS Reference"; }
    else if (parts[0] === "resources") { h = pageResources(); title = "Official resources — ACS Reference"; }
    else if (parts[0] === "about") { h = pageAbout(); title = "About — ACS Reference"; }
    else if (parts[0] === "contact") { h = pageContact(); title = "Found something wrong? — ACS Reference"; }
    else { h = pagePortal(); title = "ACS Reference — study guides for every Part 61 certificate"; }
    renderPage(h, title, parts, p);
  }

  function drawGuide(slug, parts, p) {
    var h, g = G, gt = " — " + g.short;
    if (parts[0] === "a" && parts[1]) { h = pageArea(parts[1]); }
    else if (parts[0] === "t" && parts[1]) { h = pageTask(parts[1], parts[2]); }
    else if (parts[0] === "appx" && parts[1]) { h = pageAppx(parts[1], parts[2]); }
    else if (parts[0] === "appx") { h = pageAppxIndex(); }
    else if (parts[0] === "endorsements") { h = pageEndorsements(parts[1]); }
    else if (parts[0] === "presolo") { h = pagePresolo(); }
    else if (parts[0] === "codes") { h = pageCodes(); }
    else if (parts[0] === "search") { h = pageSearch(parts[1], false); }
    else if (parts[0] === "mock") { h = pageMock(); }
    else if (parts[0] === "mnemonics") { h = pageMnemonics(parts[1]); }
    else if (parts[0] === "eligibility") { h = pageEligibility(parts[1]); }
    else if (parts[0] === "addrating") { h = pageAddRating(); }
    else if (parts[0] === "plan") { h = pagePlan(); }
    else if (parts[0] === "tools") { h = pageTools(); }
    else if (parts[0] === "formulas") { h = pageFormulas(); }
    else if (parts[0] === "navlog") { h = pageNavlog(); }
    else if (parts[0] === "fplan") { h = pageFplan(); }
    else if (parts[0] === "holding") { h = pageInstr("hold"); }
    else if (parts[0] === "cdi") { h = pageInstr("cdi"); }
    else if (parts[0] === "ipc") { h = pageIpc(); }
    else if (parts[0] === "wx") { h = pageWx(); }
    else if (parts[0] === "resources") { h = pageResources(); }
    else if (parts[0] === "about") { h = pageAbout(); }
    else if (parts[0] === "contact") { h = pageContact(); }
    else { h = pageGuideHome(); }
    var t = parts[0] === "t" && parts[1] ? taskOf(parts[1]) : null;
    renderPage(h, (t ? parts[1] + " " + t.title : g.title) + gt + " — ACS Reference", parts, p);
  }

  function pageLoading(slug) {
    var m = guideMeta(slug) || {};
    return '<div class="loading"><div class="spin"></div><p>Opening ' +
      esc(m.title || slug) + "&hellip;</p></div>";
  }
  function pageLoadError(slug, err) {
    return '<div class="note flag"><span class="lbl">That guide did not load</span>' +
      esc(String(err && err.message || err)) +
      '<br><br>Try reloading the page. If it keeps happening, <a href="#/contact">tell me</a> ' +
      'and say which guide.<br><br><a href="#/">Back to the start</a></div>';
  }
  function pageMissing(slug) {
    return '<div class="note flag"><span class="lbl">No such guide</span>' +
      "There is no guide called <b>" + esc(slug) + '</b>. <a href="#/">Start from the beginning</a>.</div>';
  }

  function renderPage(h, title, parts, p) {
    parts = parts || [];
    p = p == null ? "" : p;
    el("view").innerHTML = h + footer();
    markRail(p === "" ? "/" : "/" + p.replace(/^\/+/, ""));
    document.body.classList.remove("nav");
    document.title = title;

    /* page-specific wiring */
    if (parts[0] === "search" && el("bq")) {
      var bq = el("bq");
      /* a fresh visit starts unfiltered - a filter left over from last time
         would silently hide results and read as a broken search */
      SF.guides = null; SF.sections = null;
      wireSearchFilters();
      var deb = null;
      bq.addEventListener("input", function () {
        clearTimeout(deb);
        var v = bq.value;
        deb = setTimeout(function () { runSearch(v); }, 140);
      });
      bq.addEventListener("keydown", function (e) { if (e.key === "Escape") { bq.value = ""; runSearch(""); } });
      var pills = document.querySelectorAll(".hintrow .pill");
      for (var i = 0; i < pills.length; i++) pills[i].addEventListener("click", function () {
        bq.value = this.getAttribute("data-q"); runSearch(bq.value); bq.focus();
      });
      if (parts[1]) runSearch(parts[1]); else bq.focus();
    }
    if (parts[0] === "codes" && parts[1]) wireGlobalCodes();
    if (parts[0] === "codes" && el("buildTable")) {
      el("buildTable").addEventListener("click", buildCodeTable);
      el("clearCodes").addEventListener("click", function () { el("codeIn").value = ""; el("codeOut").innerHTML = ""; });
      el("sampleCodes").addEventListener("click", function () {
        el("codeIn").value = sampleMissedCodes();
        buildCodeTable();
      });
      el("codeIn").addEventListener("keydown", function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") buildCodeTable();
      });
    }
    if (parts[0] === "endorsements" && el("eq")) {
      var eq = el("eq");
      eq.addEventListener("input", function () {
        var v = eq.value.trim().toLowerCase();
        var ds = document.querySelectorAll("#elist details.endo"), shown = {};
        for (var i = 0; i < ds.length; i++) {
          var ok = !v || ds[i].getAttribute("data-k").indexOf(v) >= 0;
          ds[i].hidden = !ok;
          if (ok) shown[ds[i].closest("section").id || i] = 1;
        }
        var secs = document.querySelectorAll("#elist section.egroup");
        for (var j = 0; j < secs.length; j++) {
          secs[j].hidden = !secs[j].querySelector("details.endo:not([hidden])");
        }
      });
    }
    if (parts[0] === "presolo" && el("copyExam")) {
      el("copyExam").addEventListener("click", function () {
        var p2 = SC("presolo") || {}, lines = ["PRE-SOLO WRITTEN EXAM", ""];
        lines.push("Student: ______________________________   Date: ____________");
        lines.push("Aircraft make and model: ____________________   Airport: __________");
        lines.push("");
        (p2.sections || []).forEach(function (s) {
          lines.push(s.h.toUpperCase()); lines.push("");
          (s.q || []).forEach(function (q, i) { lines.push((i + 1) + ". " + q.replace(/\*\*/g, "")); lines.push(""); });
          lines.push("");
        });
        copyText(lines.join("\n"), this);
      });
    }

    if (parts[0] === "navlog") wireNav();
    if (parts[0] === "fplan") wireFplan();
    if (parts[0] === "mock" && G) wireMock();
    if (parts[0] === "holding") wireInstr("hold");
    if (parts[0] === "cdi") wireInstr("cdi");
    if (parts[0] === "ipc") wireIpc();
    if (parts[0] === "wx") wireWx();
    if (parts[0] === "mnemonics") wireMnem();
    if (parts[0] === "contact") wireContact();
    if (parts[0] === "t" && isFoiArea(parts[1])) wireMnem();
    /* Both the eligibility page and the Pilot Qualifications Task carry the
       checker, its tab row and the cross-country validator, so they wire
       identically. The Task differs per guide, hence anchorFor. */
    if (parts[0] === "eligibility" ||
        (parts[0] === "t" && isAnchor("pilotqual", parts[1]))) {
      wireChecker(el("view")); wireXC(); wireCkTabs();
    }

    /* anchor jump, after render */
    var target = null;
    if (parts[0] === "t" && parts[2]) target = /^(AI|FI)\./i.test(parts[2]) ? "el-" + parts[2] : parts[2];
    if (parts[0] === "appx" && parts[2]) target = parts[2];
    if (target) {
      setTimeout(function () {
        var n = document.getElementById(target);
        if (n) {
          n.scrollIntoView({ block: "center", behavior: "auto" });
          n.classList.add("flash");
          setTimeout(function () { n.classList.remove("flash"); }, 2400);
        } else window.scrollTo(0, 0);
      }, 30);
    } else window.scrollTo(0, 0);
    var tt = el("toTop"); if (tt) tt.classList.remove("on");
  }

  /* The checker tab row. Both hosts render their tabs into a `.tabs` element
     that sits immediately before `#ckHost`, so one handler serves both. */
  function wireCkTabs() {
    var host = el("ckHost"); if (!host) return;
    var row = host.parentNode.querySelector(".tabs"); if (!row) return;
    var tabs = row.querySelectorAll(".tab");
    for (var ti = 0; ti < tabs.length; ti++) tabs[ti].addEventListener("click", function () {
      var all = row.querySelectorAll(".tab");
      for (var k = 0; k < all.length; k++) all[k].classList.toggle("on", all[k] === this);
      host.innerHTML = checkerHtml(this.getAttribute("data-tab"));
      wireChecker(host);
    });
  }

  function footer() {
    var h = '<div class="foot"><b>Source of authority.</b> ';
    if (G) {
      /* inside a guide, name that guide's own controlling document */
      h += (G.is_pts ? "The Practical Test Standards, " : "The Airman Certification Standards, ") +
        "<b>" + esc(G.doc) + "</b>, is the controlling document for this practical test. " +
        (G.is_pts
          ? "Task objectives and elements on these pages are quoted from it. The reference numbers " +
            "shown here are this site's own numbering of those elements, not FAA codes. "
          : "Element codes and element wording on these pages are quoted from it. ") +
        (ENDO.length ? "Sample endorsements are quoted from AC 61-65K. " : "");
    } else {
      h += "The Airman Certification Standards, and the Practical Test Standards where an ACS has " +
        "not yet replaced one, are the controlling documents for these practical tests. Each guide " +
        "names its own and quotes from it. ";
    }
    h += "Everything else on this site — the study notes, the memory aids, the examples, the " +
      "mock checkrides — is study material, not regulation, and is written to help you get to " +
      "the FAA source faster. Regulations, handbooks and weather products change; check anything " +
      'that matters against the <a href="#/resources">official resources</a> before you rely on it. ' +
      'Spotted a mistake? <a href="#/contact">Tell me about it</a> — it gets fixed and you get a thank you.<br><br>' +
      'Built for student pilots and instructors. <a href="#/about">About this site</a>. ' +
      "Not affiliated with, or endorsed by, the Federal Aviation Administration.</div>";
    return h;
  }

  /* ---------- quick search in the header ----------
     Inside a guide this searches that guide's tasks. On the portal there is no
     current guide, so it searches the compact cross-guide task index that
     ships in site.js - task codes and titles for all six documents, a few KB,
     no guide payload needed. */
  function quickSearch(q) {
    var box = el("res"); q = q.trim();
    if (!box) return;
    if (!q) { box.innerHTML = ""; return; }
    var lq = q.toLowerCase(), hits = [];

    if (G) {
      flat().forEach(function (f) {
        var c = C[f.code] || {};
        var hay = (f.code + " " + f.t.title + " " + (c.oneLine || "") + " " +
                   (c.keywords || "") + " " + f.a.title).toLowerCase();
        if (hay.indexOf(lq) >= 0) {
          hits.push({ href: here("t/" + f.code), code: f.code, t: f.t.title, g: "",
                      s: f.code.toLowerCase().indexOf(lq) === 0 ? 0
                         : f.t.title.toLowerCase().indexOf(lq) === 0 ? 1 : 2 });
        }
      });
    } else {
      (SITE.index || []).forEach(function (row) {
        var sl = row[0], code = row[1], title = row[2];
        var gm = guideMeta(sl) || {};
        var hay = (code + " " + title + " " + (gm.cert || "") + " " + (gm.short || "")).toLowerCase();
        if (hay.indexOf(lq) >= 0) {
          hits.push({ href: guideHref(sl, "t/" + code), code: code, t: title,
                      g: gm.short || sl,
                      s: code.toLowerCase().indexOf(lq) === 0 ? 0
                         : title.toLowerCase().indexOf(lq) === 0 ? 1 : 2 });
        }
      });
    }
    hits.sort(function (x, y) { return x.s - y.s; });
    var h = hits.slice(0, 8).map(function (o) {
      return '<a href="' + o.href + '"><span class="c">' + esc(o.code) + '</span><span class="t">' +
        esc(o.t) + (o.g ? ' <i class="gq">' + esc(o.g) + "</i>" : "") + "</span></a>";
    }).join("");
    h += '<a class="all" href="' + (G ? here("search/") : "#/search/") + encodeURIComponent(q) +
      '"><span class="c">' + I.search + '</span><span class="t">Search every word' +
      (G ? " in this guide" : " on the site") + " for \u201c" + esc(q) + "\u201d</span></a>";
    box.innerHTML = h;
  }

  /* ---------- clipboard ---------- */
  function flash(btn, msg) {
    if (!btn) return;
    var old = btn.innerHTML; btn.innerHTML = msg || "Copied"; btn.classList.add("ok");
    setTimeout(function () { btn.innerHTML = old; btn.classList.remove("ok"); }, 1600);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); flash(btn); } catch (e) { flash(btn, "Press Ctrl+C"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash(btn); }, fallback);
    } else fallback();
  }
  /* `tbl` is optional - it used to look up #studyTable itself, which meant the
     mock checkride could not reuse it for its own results table. */
  function wireGlobalCodes() {
    var b = el("gBuild"); if (!b) return;
    b.addEventListener("click", buildGlobalCodeTable);
    var box = el("gcodeIn");
    var sm = el("gSample");
    if (sm) sm.addEventListener("click", function () {
      var t = testById((box && box.getAttribute("data-test")) || "") || {};
      if (box) box.value = sampleCodesFor(t.guide);
      buildGlobalCodeTable();
    });
    var cl = el("gClear");
    if (cl) cl.addEventListener("click", function () {
      if (box) box.value = "";
      if (el("gcodeOut")) el("gcodeOut").innerHTML = "";
    });
  }

  function copyTable(btn, tbl) {
    tbl = tbl || el("studyTable"); if (!tbl) return;
    var html = tbl.outerHTML;
    var plain = [];
    var rows = tbl.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll("th,td"), line = [];
      for (var j = 0; j < cells.length; j++) line.push(cells[j].innerText.replace(/\s*\n\s*/g, " ").trim());
      plain.push(line.join("\t"));
    }
    var text = plain.join("\n");
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" })
        })]).then(function () { flash(btn); }, function () { selectAndCopy(tbl, btn, text); });
        return;
      } catch (e) { /* fall through */ }
    }
    selectAndCopy(tbl, btn, text);
  }
  function selectAndCopy(node, btn, fallbackText) {
    try {
      var r = document.createRange(); r.selectNode(node);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      var ok = document.execCommand("copy");
      sel.removeAllRanges();
      if (ok) { flash(btn); return; }
    } catch (e) { /* ignore */ }
    copyText(fallbackText, btn);
  }

  /* ---------- lightbox with zoom and pan ---------- */
  var lbS = 1, lbX = 0, lbY = 0, lbFit = 1, lbDragged = false;
  function lbApply() {
    var img = el("lbImg");
    img.style.transform = "translate(" + lbX + "px," + lbY + "px) scale(" + lbS + ")";
    img.style.cursor = lbS > lbFit + 0.01 ? "grab" : "zoom-in";
    var z = el("lbZoom"); if (z) z.textContent = Math.round(lbS / lbFit * 100) + "%";
    /* the caption gets out of the way once you are reading the detail */
    el("lb").classList.toggle("zoomed", lbS > lbFit * 1.05);
  }
  function lbClamp() {
    var box = el("lb").getBoundingClientRect(), img = el("lbImg");
    var w = img.naturalWidth * lbS, h = img.naturalHeight * lbS;
    var mx = Math.max(0, (w - box.width) / 2), my = Math.max(0, (h - box.height) / 2);
    lbX = Math.max(-mx, Math.min(mx, lbX));
    lbY = Math.max(-my, Math.min(my, lbY));
  }
  function lbFitNow() {
    var box = el("lb").getBoundingClientRect(), img = el("lbImg");
    if (!img.naturalWidth) return;
    lbFit = Math.min((box.width - 40) / img.naturalWidth, (box.height - 110) / img.naturalHeight);
    lbFit = Math.min(lbFit, 1);
    lbS = lbFit; lbX = 0; lbY = 0; lbApply();
  }
  function lbZoomTo(mult, cx, cy) {
    var box = el("lb").getBoundingClientRect();
    var px = (cx == null ? box.width / 2 : cx) - box.width / 2 - lbX;
    var py = (cy == null ? box.height / 2 : cy) - box.height / 2 - lbY;
    var ns = Math.max(lbFit, Math.min(lbFit * 8, lbS * mult));
    var f = ns / lbS;
    lbX -= px * (f - 1); lbY -= py * (f - 1);
    lbS = ns; lbClamp(); lbApply();
  }
  function openLb(src, cap, source) {
    var lb = el("lb");
    el("lbImg").src = src;
    el("lbCap").innerHTML = esc(cap) + (source ? '<span class="s">' + esc(source) + "</span>" : "");
    lb.classList.add("on");
    document.body.style.overflow = "hidden";
    var img = el("lbImg");
    if (img.complete && img.naturalWidth) lbFitNow();
    else img.onload = lbFitNow;
  }
  function closeLb() { el("lb").classList.remove("on"); document.body.style.overflow = ""; }
  function wireLb() {
    var lb = el("lb"), img = el("lbImg");
    lb.addEventListener("wheel", function (e) {
      if (!lb.classList.contains("on")) return;
      e.preventDefault();
      lbZoomTo(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
    }, { passive: false });

    var down = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = 0;
    img.addEventListener("pointerdown", function (e) {
      down = true; moved = 0; sx = e.clientX; sy = e.clientY; ox = lbX; oy = lbY;
      lbDragged = false;
      try { img.setPointerCapture(e.pointerId); } catch (err) { }
      img.style.cursor = "grabbing";
    });
    img.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      if (lbS > lbFit + 0.01) { lbX = ox + dx; lbY = oy + dy; lbClamp(); lbApply(); }
    });
    img.addEventListener("pointerup", function (e) {
      down = false; img.style.cursor = lbS > lbFit + 0.01 ? "grab" : "zoom-in";
      if (moved < 6) {
        if (lbS > lbFit + 0.01) { lbS = lbFit; lbX = 0; lbY = 0; lbApply(); }
        else lbZoomTo(2.6, e.clientX, e.clientY);
      } else lbDragged = true;
      setTimeout(function () { lbDragged = false; }, 60);
    });
    var pts = {}, pd = 0;
    lb.addEventListener("pointerdown", function (e) { pts[e.pointerId] = e; });
    lb.addEventListener("pointermove", function (e) {
      if (!(e.pointerId in pts)) return;
      pts[e.pointerId] = e;
      var k = Object.keys(pts);
      if (k.length === 2) {
        var a = pts[k[0]], b = pts[k[1]];
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pd) lbZoomTo(d / pd, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        pd = d;
      }
    });
    function clearPt(e) { delete pts[e.pointerId]; if (Object.keys(pts).length < 2) pd = 0; }
    lb.addEventListener("pointerup", clearPt);
    lb.addEventListener("pointercancel", clearPt);

    el("lbIn").addEventListener("click", function () { lbZoomTo(1.5); });
    el("lbOut").addEventListener("click", function () { lbZoomTo(1 / 1.5); });
    el("lbReset").addEventListener("click", lbFitNow);
    lb.querySelector(".x").addEventListener("click", closeLb);
    window.addEventListener("resize", function () { if (lb.classList.contains("on")) lbFitNow(); });
  }

  /* ---------- boot ---------- */
  function boot() {
    ENDO = SITE.endorsements || [];      /* site-wide, available before any guide */
    el("hdIcons").innerHTML = '<button class="iconbtn" id="menuBtn" aria-label="Menu">' + I.menu + "</button>";
    el("logoMark").innerHTML = I.plane;
    el("searchIcon").innerHTML = I.search;
    el("themeBtn").innerHTML = I.sun;

    wireLb();
    route();                 /* route() builds the rail for whatever context it lands in */
    window.addEventListener("hashchange", route);

    el("menuBtn").addEventListener("click", function () { document.body.classList.toggle("nav"); });
    el("scrim").addEventListener("click", function () { document.body.classList.remove("nav"); });

    var si = el("q");
    si.addEventListener("input", function () { quickSearch(si.value); });
    si.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { si.value = ""; quickSearch(""); si.blur(); }
      if (e.key === "Enter") {
        e.preventDefault();
        var v = si.value.trim(); if (!v) return;
        location.hash = "#/search/" + encodeURIComponent(v);
        si.value = ""; el("res").innerHTML = ""; si.blur();
      }
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".searchwrap")) el("res").innerHTML = "";

      var jump = e.target.closest("[data-jump]");
      if (jump) {
        e.preventDefault();
        var n = document.getElementById(jump.getAttribute("data-jump"));
        if (n) {
          n.scrollIntoView({ behavior: "smooth", block: "start" });
          n.classList.add("flash");
          setTimeout(function () { n.classList.remove("flash"); }, 2000);
        }
        return;
      }
      if (e.target.closest("[data-open-e6b]")) { openE6B(); return; }
      if (e.target.id === "e6b") { closeE6B(); return; }

      var cp = e.target.closest("[data-copy]");
      if (cp) { var src = document.getElementById(cp.getAttribute("data-copy")); if (src) copyText(src.innerText, cp); return; }

      var yt = e.target.closest("[data-yt]");
      if (yt) {
        var f = document.createElement("iframe");
        f.src = "https://www.youtube-nocookie.com/embed/" + yt.getAttribute("data-yt") + "?autoplay=1&rel=0";
        f.title = "Video"; f.allow = "accelerometer; autoplay; encrypted-media; picture-in-picture";
        f.setAttribute("allowfullscreen", ""); f.loading = "lazy";
        yt.replaceWith(f);
        return;
      }
      var cz = e.target.closest("[data-lb-zoom]");
      if (cz) {
        var k = cz.getAttribute("data-lb-zoom");
        openLb(imgSrc(k), (DATA.figcap && DATA.figcap[k]) || "", (DATA.figsrc && DATA.figsrc[k]) || "");
        return;
      }
      var im = e.target.closest("img[data-lb]");
      if (im) { openLb(im.src, im.getAttribute("data-lb") || "", ""); return; }
      if (e.target.closest("#lb") && !e.target.closest("#lbImg") && !e.target.closest(".lb-tools") && !lbDragged)
        closeLb();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeLb(); closeE6B(); }
      if (el("lb").classList.contains("on")) {
        if (e.key === "+" || e.key === "=") { e.preventDefault(); lbZoomTo(1.5); }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); lbZoomTo(1 / 1.5); }
        if (e.key === "0") { e.preventDefault(); lbFitNow(); }
      }
      if ((e.key === "e" || e.key === "E") && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); openE6B();
      }
      if (e.key === "/" && document.activeElement !== si && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); si.focus();
      }
    });

    /* back to top */
    var top = el("toTop");
    function toggleTop() { top.classList.toggle("on", window.scrollY > 420); }
    window.addEventListener("scroll", toggleTop, { passive: true });
    toggleTop();
    top.addEventListener("click", function () {
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      top.blur();
    });

    var saved = null;
    try { saved = localStorage.getItem("cfi-theme"); } catch (err) { }
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    function isDark() {
      var a = document.documentElement.getAttribute("data-theme");
      return a ? a === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    function paint() { el("themeBtn").innerHTML = isDark() ? I.sun : I.moon; }
    paint();
    el("themeBtn").addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("cfi-theme", next); } catch (err) { }
      paint();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
