/* pdf-import.js — admin-only "Import questions from a scanned PDF".
 *
 * Browser renders the PDF pages with pdf.js and sends page images to the
 * `import-pdf` Edge Function, which asks Claude to read them into structured
 * questions. The admin reviews/edits a table, then commits: rows go to the
 * `questions` table and each figure is cropped from its page and saved as an
 * SVG data-URI via the existing `replace_diagram` action.
 *
 * Nothing is written to the database until the admin clicks "Import selected".
 */
(function () {
  "use strict";

  var FUNCTIONS_BASE = "https://nuiftmqtcqdcjytwowta.supabase.co/functions/v1";
  var ADMIN_KEY = "physicsQuizAdminSecret";
  var MAX_PAGES = 50;
  var BATCH = 3;
  var RENDER_TARGET_W = 1600;

  var pdfjsLib = window.pdfjsLib || null;
  if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  var pdfDoc = null;
  var reviewState = [];
  var chaptersList = [];
  var els = {};

  // ---------- helpers ----------
  function getSecret() {
    try { return localStorage.getItem(ADMIN_KEY) || ""; } catch (e) { return ""; }
  }

  function getPaperType() {
    var checked = document.querySelector('input[name="import-paper-type"]:checked');
    return checked ? checked.value : "";
  }

  // Match Claude's free-text chapter guess against the real chapter list.
  function bestChapterId(hint) {
    if (!hint) return "";
    var want = String(hint).trim().toLowerCase();
    var exact = chaptersList.find(function (c) { return c.name.toLowerCase() === want; });
    if (exact) return exact.id;
    var partial = chaptersList.find(function (c) {
      var n = c.name.toLowerCase();
      return n.indexOf(want) >= 0 || want.indexOf(n) >= 0;
    });
    return partial ? partial.id : "";
  }

  async function callFn(fn, payload) {
    var secret = getSecret();
    if (!secret) throw new Error("Turn on Admin mode first (enter the passphrase).");
    var res = await fetch(FUNCTIONS_BASE + "/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 401) throw new Error("Admin passphrase rejected — re-enter Admin mode.");
    if (!res.ok) throw new Error((data && data.error) || ("Server error " + res.status));
    return data;
  }

  function svgToDataUri(svg) {
    var bytes = new TextEncoder().encode(svg);
    var binary = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return "data:image/svg+xml;base64," + btoa(binary);
  }

  async function renderPage(n) {
    var page = await pdfDoc.getPage(n);
    var base = page.getViewport({ scale: 1 });
    var scale = Math.min(3, RENDER_TARGET_W / base.width);
    var vp = page.getViewport({ scale: scale });
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return canvas;
  }

  // Crop [x,y,w,h] (page fractions) from a page canvas -> { svgDataUri, preview }.
  function cropToSvg(canvas, bbox) {
    if (!Array.isArray(bbox) || bbox.length < 4) return null;
    var sx = Math.max(0, Math.round(bbox[0] * canvas.width));
    var sy = Math.max(0, Math.round(bbox[1] * canvas.height));
    var sw = Math.min(canvas.width - sx, Math.round(bbox[2] * canvas.width));
    var sh = Math.min(canvas.height - sy, Math.round(bbox[3] * canvas.height));
    if (sw < 12 || sh < 12) return null;
    var c = document.createElement("canvas");
    c.width = sw; c.height = sh;
    c.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    var raster = c.toDataURL("image/jpeg", 0.82);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' +
      sw + " " + sh + '"><image href="' + raster + '" xlink:href="' + raster +
      '" width="' + sw + '" height="' + sh + '"/></svg>';
    return { svgDataUri: svgToDataUri(svg), preview: raster };
  }

  function setStatus(msg) { if (els.status) els.status.textContent = msg || ""; }

  // ---------- extraction ----------
  async function extractAll(onProgress) {
    var total = Math.min(pdfDoc.numPages, MAX_PAGES);
    var merged = new Map();
    for (var start = 1; start <= total; start += BATCH) {
      var nums = [];
      var imgs = [];
      for (var n = start; n < start + BATCH && n <= total; n++) {
        onProgress("Rendering page " + n + " / " + total + "…");
        var canvas = await renderPage(n);
        imgs.push(canvas.toDataURL("image/jpeg", 0.8));
        nums.push(n);
      }
      onProgress("Reading pages " + nums[0] + "–" + nums[nums.length - 1] + " of " + total + " with Claude…");
      var r = await callFn("import-pdf", {
        action: "extract",
        pages: imgs,
        page_numbers: nums,
        chapters: chaptersList.map(function (c) { return { id: c.id, name: c.name, subject: c.subject }; }),
      });
      (r.questions || []).forEach(function (q) {
        var num = Number(q.question_number);
        if (Number.isFinite(num)) merged.set(num, q);
      });
    }
    return Array.from(merged.values()).sort(function (a, b) {
      return Number(a.question_number) - Number(b.question_number);
    });
  }

  // ---------- review table ----------
  async function buildReview(questions) {
    els.review.innerHTML = "";
    reviewState = [];
    if (!questions.length) {
      els.review.innerHTML = "<p class='muted'>No questions were extracted.</p>";
      els.foot.hidden = true;
      return;
    }

    var pageCache = new Map();
    async function pageCanvas(n) {
      if (!Number.isFinite(n)) return null;
      if (!pageCache.has(n)) pageCache.set(n, await renderPage(n).catch(function () { return null; }));
      return pageCache.get(n);
    }

    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      var idx = qi;

      var wrap = document.createElement("div");
      wrap.className = "rev-q";

      var top = document.createElement("div");
      top.className = "rev-top";
      var include = document.createElement("input");
      include.type = "checkbox"; include.checked = true; include.className = "rev-include";
      var incLabel = document.createElement("label");
      incLabel.appendChild(include); incLabel.appendChild(document.createTextNode(" include"));

      var numInput = document.createElement("input");
      numInput.className = "rev-num"; numInput.value = q.question_number; numInput.size = 3;

      var diffSel = document.createElement("select");
      diffSel.className = "rev-diff";
      ["", "easy", "medium", "hard"].forEach(function (v) {
        var o = document.createElement("option");
        o.value = v; o.textContent = v || "difficulty —";
        diffSel.appendChild(o);
      });
      diffSel.value = ["easy", "medium", "hard"].indexOf(q.difficulty) >= 0 ? q.difficulty : "";

      var chapSel = document.createElement("select");
      chapSel.className = "rev-chapter";
      var ph = document.createElement("option");
      ph.value = ""; ph.textContent = "chapter — pick one";
      chapSel.appendChild(ph);
      chaptersList.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c.id;
        o.textContent = (c.subject ? c.subject + " · " : "") + c.name;
        chapSel.appendChild(o);
      });
      chapSel.value = bestChapterId(q.chapter);

      var solvedAnswer = q.correct_label && q.answer_from !== "printed_key";
      if (solvedAnswer) wrap.classList.add("needs-verify");

      top.appendChild(incLabel);
      top.appendChild(document.createTextNode("Q"));
      top.appendChild(numInput);
      top.appendChild(document.createTextNode(" · page " + (q.source_page ?? "?") + " "));
      top.appendChild(diffSel);
      top.appendChild(chapSel);
      if (solvedAnswer) {
        var flag = document.createElement("span");
        flag.className = "rev-answer-flag";
        flag.textContent = "AI-solved answer · verify";
        top.appendChild(flag);
      } else if (q.correct_label) {
        var keyFlag = document.createElement("span");
        keyFlag.className = "rev-answer-flag is-key";
        keyFlag.textContent = "from answer key";
        top.appendChild(keyFlag);
      }
      wrap.appendChild(top);

      var stem = document.createElement("textarea");
      stem.className = "rev-stem"; stem.rows = 2; stem.value = q.stem || "";
      wrap.appendChild(stem);

      var optsWrap = document.createElement("div");
      optsWrap.className = "rev-opts";
      var byLabel = {};
      (q.options || []).forEach(function (o) { byLabel[String(o.label || "").toLowerCase()] = o.text || ""; });
      ["a", "b", "c", "d"].forEach(function (lab) {
        var row = document.createElement("label");
        row.className = "rev-opt-row";
        var radio = document.createElement("input");
        radio.type = "radio"; radio.name = "rev-correct-" + idx; radio.value = lab;
        if (String(q.correct_label || "").toLowerCase() === lab) radio.checked = true;
        var tag = document.createElement("span");
        tag.className = "rev-opt-label"; tag.textContent = lab + ")";
        var txt = document.createElement("input");
        txt.type = "text"; txt.className = "rev-opt"; txt.dataset.label = lab;
        txt.value = byLabel[lab] || "";
        row.appendChild(radio); row.appendChild(tag); row.appendChild(txt);
        optsWrap.appendChild(row);
      });
      var noneRow = document.createElement("label");
      noneRow.className = "rev-opt-row";
      var noneRadio = document.createElement("input");
      noneRadio.type = "radio"; noneRadio.name = "rev-correct-" + idx; noneRadio.value = "";
      if (!q.correct_label) noneRadio.checked = true;
      noneRow.appendChild(noneRadio);
      noneRow.appendChild(document.createTextNode(" answer unknown"));
      optsWrap.appendChild(noneRow);
      wrap.appendChild(optsWrap);

      var state = { idx: idx, q: q, node: wrap, els: { include: include, num: numInput, stem: stem, diff: diffSel, chapter: chapSel }, fig: null, keepFig: null };

      if (q.has_diagram && Array.isArray(q.diagram_bbox)) {
        var figWrap = document.createElement("div");
        figWrap.className = "rev-fig";
        var keep = document.createElement("input");
        keep.type = "checkbox"; keep.checked = true; keep.className = "rev-keepfig";
        var keepLabel = document.createElement("label");
        keepLabel.appendChild(keep);
        keepLabel.appendChild(document.createTextNode(" keep figure"));
        figWrap.appendChild(keepLabel);
        var canvas = await pageCanvas(Number(q.source_page));
        var crop = canvas ? cropToSvg(canvas, q.diagram_bbox) : null;
        if (crop) {
          var img = document.createElement("img");
          img.src = crop.preview; img.alt = "figure crop";
          figWrap.appendChild(img);
          state.fig = crop;
          state.keepFig = keep;
        } else {
          figWrap.appendChild(Object.assign(document.createElement("span"), {
            className: "muted", textContent: " (could not crop — use 📷 Add image after import)",
          }));
        }
        wrap.appendChild(figWrap);
      } else if (q.has_diagram) {
        var note = document.createElement("div");
        note.className = "rev-fig muted";
        note.textContent = "figure referenced, no location — use 📷 Add image after import";
        wrap.appendChild(note);
      }

      reviewState.push(state);
      els.review.appendChild(wrap);
    }
    els.foot.hidden = false;
  }

  // ---------- commit ----------
  async function doCommit() {
    var paperType = getPaperType();
    var sourceModule = els.sourceModule || "";
    if (!paperType) { alert("Pick which kind of question paper this is."); return; }

    var chosen = reviewState.filter(function (r) { return r.els.include.checked; });
    if (!chosen.length) { alert("No questions selected."); return; }

    var missingChapter = chosen.filter(function (r) { return !r.els.chapter.value; });
    if (missingChapter.length) {
      alert("Pick a chapter for every included question (" + missingChapter.length + " still unset).");
      return;
    }

    var payload = chosen.map(function (r) {
      var correct = r.node.querySelector('input[name="rev-correct-' + r.idx + '"]:checked');
      return {
        question_number: Number(r.els.num.value),
        chapter_id: r.els.chapter.value,
        stem: r.els.stem.value.trim(),
        options: Array.prototype.map.call(r.node.querySelectorAll(".rev-opt"), function (i) {
          return { label: i.dataset.label, text: i.value.trim() };
        }).filter(function (o) { return o.text; }),
        correct_label: (correct && correct.value) || null,
        difficulty: r.els.diff.value || null,
        has_diagram: !!(r.fig && r.keepFig && r.keepFig.checked),
        source_page: Number.isFinite(Number(r.q.source_page)) ? Number(r.q.source_page) : null,
      };
    });

    els.commit.disabled = true;
    setStatus("Importing " + payload.length + " questions…");
    try {
      var res = await callFn("import-pdf", {
        action: "commit",
        paper_type: paperType,
        source_module: sourceModule,
        questions: payload,
      });

      var idByNum = new Map((res.ids || []).map(function (x) { return [Number(x.question_number), x.id]; }));
      var figDone = 0, figFail = 0;
      for (var i = 0; i < chosen.length; i++) {
        var r = chosen[i];
        if (!r.fig || !r.keepFig || !r.keepFig.checked) continue;
        var id = idByNum.get(Number(r.els.num.value));
        if (!id) continue;
        setStatus("Saving figure " + (figDone + figFail + 1) + "…");
        try {
          await callFn("admin-mutate", { action: "replace_diagram", question_id: id, svg_data_uri: r.fig.svgDataUri });
          figDone++;
        } catch (e) { console.error("figure save failed for Q" + r.els.num.value, e); figFail++; }
      }

      var msg = "Imported " + res.inserted + " question(s)";
      if (res.skipped && res.skipped.length) msg += " · skipped (already exist): " + res.skipped.join(", ");
      if (figDone || figFail) msg += " · figures saved: " + figDone + (figFail ? " (" + figFail + " failed)" : "");
      setStatus(msg);
      alert(msg);
      if (window.loadQuestions) window.loadQuestions();
    } catch (err) {
      console.error(err);
      setStatus("Import failed: " + err.message);
      alert("Import failed: " + err.message);
    } finally {
      els.commit.disabled = false;
    }
  }

  // ---------- scan orchestration ----------
  async function doScan() {
    if (!pdfjsLib) { setStatus("pdf.js failed to load."); return; }
    var file = els.file.files && els.file.files[0];
    if (!file) { alert("Choose a PDF first."); return; }
    if (!getPaperType()) { alert("Pick which kind of question paper this is."); return; }
    if (!getSecret()) { alert("Turn on Admin mode first."); return; }
    if (!chaptersList.length) { alert("Chapters haven't loaded yet — close and reopen this dialog."); return; }

    els.scan.disabled = true;
    els.foot.hidden = true;
    els.review.innerHTML = "";
    setStatus("Opening PDF…");
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
      els.sourceModule = file.name.replace(/\.pdf$/i, "");
      var questions = await extractAll(setStatus);
      setStatus("Extracted " + questions.length + " questions — review below, then Import.");
      await buildReview(questions);
    } catch (err) {
      console.error(err);
      setStatus("Scan failed: " + err.message);
    } finally {
      els.scan.disabled = false;
    }
  }

  async function loadTargets() {
    try {
      var t = await callFn("import-pdf", { action: "list_targets" });
      chaptersList = (t.chapters || []).map(function (c) {
        return { id: c.id, name: String(c.name || ""), subject: c.subject || "" };
      });
      if (!chaptersList.length) setStatus("No chapters exist yet — create one before importing.");
    } catch (err) {
      chaptersList = [];
      setStatus("Could not load chapters: " + err.message);
    }
  }

  // ---------- mount ----------
  function mountUI() {
    var row = document.querySelector(".page-header-row");
    var dialog = document.getElementById("import-dialog");
    if (!row || !dialog) return;

    els.dialog = dialog;
    els.paperType = document.getElementById("import-paper-type");
    els.file = document.getElementById("import-file");
    els.scan = document.getElementById("import-scan");
    els.status = document.getElementById("import-status");
    els.review = document.getElementById("import-review");
    els.foot = document.getElementById("import-foot");
    els.commit = document.getElementById("import-commit");

    var strip = document.createElement("div");
    strip.className = "pdf-import";
    strip.hidden = true;
    var openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "admin-toggle";
    openBtn.textContent = "📄 Import from PDF";
    strip.appendChild(openBtn);
    row.insertAdjacentElement("afterend", strip);

    openBtn.addEventListener("click", function () {
      setStatus("");
      els.review.innerHTML = "";
      els.foot.hidden = true;
      els.sourceModule = "";
      if (els.file) els.file.value = "";
      loadTargets();
      dialog.showModal();
    });
    els.scan.addEventListener("click", doScan);
    els.commit.addEventListener("click", doCommit);
    document.getElementById("import-close").addEventListener("click", function () { dialog.close(); });

    var adminToggle = document.getElementById("admin-toggle");
    function sync() { strip.hidden = !(adminToggle && adminToggle.classList.contains("is-on")); }
    sync();
    if (adminToggle && window.MutationObserver) {
      new MutationObserver(sync).observe(adminToggle, { attributes: true, attributeFilter: ["class"] });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountUI);
  else mountUI();
})();
