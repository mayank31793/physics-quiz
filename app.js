// ---- Configuration ----
// This is the base URL of the Supabase Edge Functions we deployed earlier.
const FUNCTIONS_BASE = "https://nuiftmqtcqdcjytwowta.supabase.co/functions/v1";
const ADMIN_FN = `${FUNCTIONS_BASE}/admin-mutate`;
const EXERCISE = "Exercise-1"; // change this to load a different exercise later
const PAGE_SIZE = 30;

const listEl = document.getElementById("question-list");
const metaEl = document.getElementById("meta-line");
const adminToggleEl = document.getElementById("admin-toggle");

// state.questions holds only the CURRENT page (server-paginated) — see loadQuestions/showPage.
// A single card is still re-rendered in place after an edit via replaceCard().
const state = { questions: [], total: 0, page: 1 };

// Cache of already-fetched pages so Back/Forward and revisiting a page don't refetch.
// Stores the exact array assigned to state.questions, so an in-place edit (replaceCard)
// stays reflected if the user navigates away and back.
const pageCache = new Map();

// ---- Admin mode ----
const ADMIN_KEY = "physicsQuizAdminSecret";
const admin = {
  secret: localStorage.getItem(ADMIN_KEY) || "",
  enabled: false,
};

// POST an action to the admin-mutate Edge Function. Throws on any non-OK response;
// on 401 it also forgets the stored passphrase and drops out of admin mode.
async function adminFetch(action, payload = {}) {
  const res = await fetch(ADMIN_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-secret": admin.secret },
    body: JSON.stringify({ action, ...payload }),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* fall through to the status check */
  }

  if (res.status === 401) {
    admin.secret = "";
    admin.enabled = false;
    localStorage.removeItem(ADMIN_KEY);
    syncAdminToggle();
    renderCurrentPage();
    throw new Error("Admin passphrase rejected.");
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Server responded with ${res.status}`);
  }
  return data;
}

function syncAdminToggle() {
  adminToggleEl.textContent = admin.enabled ? "Admin · on" : "Admin";
  adminToggleEl.classList.toggle("is-on", admin.enabled);
  adminToggleEl.title =
    "Click to toggle admin editing. Shift-click to forget the saved passphrase.";
}

adminToggleEl.addEventListener("click", async (e) => {
  // Shift-click clears the saved passphrase.
  if (e.shiftKey) {
    admin.secret = "";
    admin.enabled = false;
    localStorage.removeItem(ADMIN_KEY);
    syncAdminToggle();
    renderCurrentPage();
    return;
  }

  if (admin.enabled) {
    admin.enabled = false;
    syncAdminToggle();
    renderCurrentPage();
    return;
  }

  if (!admin.secret) {
    const entered = window.prompt("Admin passphrase:");
    if (!entered) return;
    admin.secret = entered;
  }

  // Verify the passphrase with a harmless read against the first question.
  const probeId = state.questions[0] && state.questions[0].id;
  if (!probeId) {
    window.alert("No questions loaded yet — try again once the list appears.");
    return;
  }
  try {
    await adminFetch("get_question", { question_id: probeId });
    localStorage.setItem(ADMIN_KEY, admin.secret);
    admin.enabled = true;
    syncAdminToggle();
    renderCurrentPage();
  } catch (err) {
    admin.secret = "";
    window.alert(err.message);
  }
});

// ---- Fetch one page of questions from the server (only PAGE_SIZE rows travel the wire) ----
async function fetchPage(page) {
  if (pageCache.has(page)) return pageCache.get(page);

  const res = await fetch(
    `${FUNCTIONS_BASE}/questions?exercise=${encodeURIComponent(EXERCISE)}&page=${page}&page_size=${PAGE_SIZE}`,
  );
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* fall through to the status check below */
  }
  if (!res.ok) throw new Error((body && body.error) || `Server responded with ${res.status}`);
  if (!body || !Array.isArray(body.data)) throw new Error("Unexpected response shape from the server.");

  const entry = { data: body.data, total: body.total ?? body.data.length };
  pageCache.set(page, entry);
  return entry;
}

// Fetches and shows a page. Only touches state/URL on success, so a failed
// page-switch leaves the currently-shown page intact instead of going blank.
async function showPage(requestedPage, { pushUrl = false, replaceUrl = false } = {}) {
  listEl.classList.add("is-loading");
  try {
    let page = requestedPage;
    let entry = await fetchPage(page);

    // The very first fetch is the only place we can't clamp against totalPages()
    // beforehand (state.total isn't known yet) — so correct after the fact if the
    // requested page (e.g. a stale/hand-edited ?page=99) turned out to be out of range.
    const pages = Math.max(1, Math.ceil(entry.total / PAGE_SIZE));
    let corrected = false;
    if (page > pages) {
      page = pages;
      entry = await fetchPage(page);
      corrected = true;
    }

    state.questions = entry.data;
    state.total = entry.total;
    state.page = page;
    renderCurrentPage(); // clears any prior error banner too (fresh innerHTML)
    if (corrected) setPageInUrl(page, { replace: true });
    else if (pushUrl) setPageInUrl(page);
    else if (replaceUrl) setPageInUrl(page, { replace: true });
  } catch (err) {
    console.error(err);
    showPageError(`Could not load questions: ${err.message}`);
  } finally {
    listEl.classList.remove("is-loading");
  }
}

// Shows an error without disturbing whatever is currently rendered (e.g. a failed
// page-switch keeps the previous page's cards on screen instead of going blank).
function showPageError(message) {
  const existing = document.getElementById("page-error");
  if (existing) existing.remove();
  const p = document.createElement("p");
  p.id = "page-error";
  p.className = "status page-error";
  p.textContent = message;
  listEl.appendChild(p);
}

// ---- Initial load ----
async function loadQuestions() {
  await showPage(getPageFromUrl(), { replaceUrl: true }); // also normalizes a stale/out-of-range ?page=
}

// ---- Pagination (server-driven: each page is its own fetch, see fetchPage/showPage) ----
function totalPages() {
  return Math.max(1, Math.ceil(state.total / PAGE_SIZE));
}

function getPageFromUrl() {
  const n = parseInt(new URLSearchParams(window.location.search).get("page"), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Reflects the current page in the address bar so it can be shared/reloaded directly.
// page 1 omits the param entirely, keeping the bare URL meaningful.
function setPageInUrl(page, { replace = false } = {}) {
  const url = new URL(window.location.href);
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  history[replace ? "replaceState" : "pushState"]({ page }, "", url);
}

async function goToPage(page) {
  const target = Math.min(Math.max(1, page), totalPages());
  if (target === state.page) return;
  await showPage(target, { pushUrl: true });
  listEl.scrollIntoView({ block: "start" });
}

window.addEventListener("popstate", (e) => {
  const page = (e.state && e.state.page) || getPageFromUrl();
  showPage(Math.min(Math.max(1, page), totalPages()));
});

// Renders the current page's questions (already fetched into state.questions), plus the pager.
function renderCurrentPage() {
  listEl.innerHTML = ""; // clear the "Fetching..." status (or the previous page)

  if (!state.questions.length) {
    const p = document.createElement("p");
    p.className = "status";
    p.textContent = "No questions found for this exercise.";
    listEl.appendChild(p);
    return;
  }

  const first = state.questions[0];
  metaEl.textContent = `${first.subject || "Physics"} · ${first.chapter || ""} · ${EXERCISE} · ${state.total} questions`;

  state.questions.forEach((q) => {
    listEl.appendChild(renderQuestionCard(q));
  });

  renderMath(listEl);

  if (totalPages() > 1) listEl.appendChild(buildPager());
}

// ---- Pager control (Prev / numbered pages, windowed once there are many / Next) ----
function buildPager() {
  const nav = document.createElement("nav");
  nav.className = "pager";
  nav.setAttribute("aria-label", "Pagination");

  const pages = totalPages();
  const current = state.page;

  const addBtn = (label, page, opts = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pager-btn";
    btn.textContent = label;
    if (opts.current) {
      btn.classList.add("is-current");
      btn.setAttribute("aria-current", "page");
    }
    btn.disabled = !!opts.disabled;
    btn.addEventListener("click", () => goToPage(page));
    nav.appendChild(btn);
  };

  const addEllipsis = () => {
    const span = document.createElement("span");
    span.className = "pager-ellipsis";
    span.textContent = "…";
    nav.appendChild(span);
  };

  addBtn("‹ Prev", current - 1, { disabled: current === 1 });

  // Show every page number when there are few; otherwise window around the current page.
  const numbers = [];
  if (pages <= 7) {
    for (let p = 1; p <= pages; p++) numbers.push(p);
  } else {
    const set = new Set([1, pages, current - 1, current, current + 1]);
    numbers.push(...[...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b));
  }
  let prev = 0;
  numbers.forEach((p) => {
    if (p - prev > 1) addEllipsis();
    addBtn(String(p), p, { current: p === current });
    prev = p;
  });

  addBtn("Next ›", current + 1, { disabled: current === pages });

  return nav;
}

function renderMath(scope) {
  if (window.renderMathInElement) {
    renderMathInElement(scope, {
      delimiters: [{ left: "$", right: "$", display: false }],
    });
  }
}

// Swap one card in place for a freshly built one (used after an admin edit).
function replaceCard(oldCard, q) {
  const idx = state.questions.findIndex((x) => x.id === q.id);
  const merged = idx !== -1 ? { ...state.questions[idx], ...q } : q;
  if (idx !== -1) state.questions[idx] = merged;
  const fresh = renderQuestionCard(merged);
  oldCard.replaceWith(fresh);
  renderMath(fresh);
}

// ---- Build one question block ----
function renderQuestionCard(q) {
  const wrap = document.createElement("article");
  wrap.className = "question";
  wrap.dataset.qid = q.id;

  // Head row: question number + admin tools + tag (difficulty, if set)
  const head = document.createElement("div");
  head.className = "question-head";

  const number = document.createElement("span");
  number.className = "question-number";
  number.textContent = `${q.question_number}.`;
  head.appendChild(number);

  if (admin.enabled) {
    head.appendChild(buildAdminToolbar(wrap, q));
  }

  if (q.difficulty) {
    const tag = document.createElement("span");
    tag.className = "question-tag";
    tag.dataset.level = String(q.difficulty).toLowerCase();
    tag.textContent = q.difficulty;
    head.appendChild(tag);
  }
  wrap.appendChild(head);

  // Question stem
  const stem = document.createElement("p");
  stem.className = "question-stem";
  stem.textContent = q.stem;
  wrap.appendChild(stem);

  // Diagram (if this question has one) — shown between the stem and the options
  if (q.has_diagram && Array.isArray(q.images) && q.images.length > 0) {
    const diagramWrap = document.createElement("div");
    diagramWrap.className = "question-diagram";
    const img = document.createElement("img");
    img.src = q.images[0].url; // this is the data:image/svg+xml;base64,... string
    img.alt = q.images[0].alt || "Question diagram";
    diagramWrap.appendChild(img);
    wrap.appendChild(diagramWrap);
  }

  // Options
  const optionsWrap = document.createElement("div");
  optionsWrap.className = "options";

  q.options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "option";
    btn.innerHTML = `<span class="option-label">${opt.label}.</span><span>${opt.text}</span>`;
    btn.addEventListener("click", () => handleAnswer(q.id, opt.label, btn, optionsWrap));
    optionsWrap.appendChild(btn);
  });

  wrap.appendChild(optionsWrap);
  return wrap;
}

// ---- Admin: per-question toolbar ----
function buildAdminToolbar(card, q) {
  const bar = document.createElement("span");
  bar.className = "admin-toolbar";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "admin-btn";
  editBtn.textContent = "✎ Edit";
  editBtn.addEventListener("click", () => enterEditMode(card, q));
  bar.appendChild(editBtn);

  const imgBtn = document.createElement("button");
  imgBtn.type = "button";
  imgBtn.className = "admin-btn";
  imgBtn.textContent = q.has_diagram ? "📷 Replace image" : "📷 Add image";
  imgBtn.addEventListener("click", () => startImageReplace(card, q));
  bar.appendChild(imgBtn);

  if (q.has_diagram) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "admin-btn";
    delBtn.textContent = "🗑 Delete image";
    delBtn.addEventListener("click", async () => {
      if (!window.confirm("Delete the diagram for this question?")) return;
      delBtn.disabled = true;
      try {
        const updated = await adminFetch("delete_diagram", { question_id: q.id });
        replaceCard(card, updated);
      } catch (err) {
        console.error("delete_diagram failed:", err);
        window.alert(err.message);
        delBtn.disabled = false;
      }
    });
    bar.appendChild(delBtn);
  }

  return bar;
}

// ---- Admin: edit stem / options / correct answer ----
async function enterEditMode(card, q) {
  // Guard against double-clicks opening the panel more than once for the same card.
  // Set synchronously, before any await. replaceCard() builds a fresh card so the
  // flag resets on save/cancel; the error path below clears it explicitly.
  if (card.dataset.editing === "1") return;
  card.dataset.editing = "1";

  let full;
  try {
    full = await adminFetch("get_question", { question_id: q.id });
  } catch (err) {
    card.dataset.editing = "";
    window.alert(err.message);
    return;
  }

  const panel = document.createElement("form");
  panel.className = "edit-panel";
  panel.addEventListener("submit", (e) => e.preventDefault());

  const stemField = document.createElement("textarea");
  stemField.className = "edit-stem";
  stemField.rows = 3;
  stemField.value = full.stem;
  panel.appendChild(labelled("Question (raw LaTeX source)", stemField));

  const optWrap = document.createElement("div");
  optWrap.className = "edit-options";
  const radioName = `correct-${q.id}`;
  const optionInputs = full.options.map((opt) => {
    const row = document.createElement("label");
    row.className = "edit-option-row";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = radioName;
    radio.value = opt.label;
    radio.checked = full.correct_label === opt.label;

    const tag = document.createElement("span");
    tag.className = "edit-option-label";
    tag.textContent = `${opt.label}.`;

    const text = document.createElement("input");
    text.type = "text";
    text.className = "edit-option-text";
    text.value = opt.text;

    row.append(radio, tag, text);
    optWrap.appendChild(row);
    return { label: opt.label, original: opt.text, input: text, radio };
  });
  panel.appendChild(labelled("Options (select the correct one)", optWrap));

  const diffSelect = document.createElement("select");
  diffSelect.className = "edit-difficulty";
  ["easy", "medium", "hard"].forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v[0].toUpperCase() + v.slice(1);
    diffSelect.appendChild(o);
  });
  diffSelect.value = (full.difficulty && String(full.difficulty).toLowerCase()) || "medium";
  panel.appendChild(labelled("Difficulty", diffSelect));

  const errEl = document.createElement("p");
  errEl.className = "edit-error";
  errEl.hidden = true;
  panel.appendChild(errEl);

  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "admin-btn admin-btn-primary";
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "admin-btn";
  cancelBtn.textContent = "Cancel";
  actions.append(saveBtn, cancelBtn);
  panel.appendChild(actions);

  cancelBtn.addEventListener("click", () => replaceCard(card, full));

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    errEl.hidden = true;

    try {
      let latest = full;

      const newStem = stemField.value;
      if (newStem !== full.stem) {
        latest = await adminFetch("update_stem", { question_id: q.id, stem: newStem });
      }

      for (const o of optionInputs) {
        if (o.input.value !== o.original) {
          latest = await adminFetch("update_option", {
            question_id: q.id,
            label: o.label,
            text: o.input.value,
          });
        }
      }

      const chosen = optionInputs.find((o) => o.radio.checked);
      if (chosen && chosen.label !== full.correct_label) {
        latest = await adminFetch("update_correct", {
          question_id: q.id,
          correct_label: chosen.label,
        });
      }

      const curDifficulty = full.difficulty && String(full.difficulty).toLowerCase();
      if (diffSelect.value && diffSelect.value !== curDifficulty) {
        latest = await adminFetch("update_difficulty", {
          question_id: q.id,
          difficulty: diffSelect.value,
        });
      }

      replaceCard(card, latest);
    } catch (err) {
      console.error("admin edit save failed:", err);
      errEl.textContent = err.message;
      errEl.hidden = false;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  // Replace the read-only stem + options with the edit panel.
  card.querySelector(".question-stem").hidden = true;
  const opts = card.querySelector(".options");
  if (opts) opts.hidden = true;
  card.appendChild(panel);
  renderMath(card);
}

function labelled(text, control) {
  const l = document.createElement("label");
  l.className = "edit-field";
  const span = document.createElement("span");
  span.className = "edit-field-label";
  span.textContent = text;
  l.append(span, control);
  return l;
}

// ---- Admin: replace a diagram with an uploaded image ----
const imageDialog = document.getElementById("image-dialog");
const imageCandidatesEl = document.getElementById("image-candidates");
const imageDialogError = document.getElementById("image-dialog-error");
const imageConfirmBtn = document.getElementById("image-confirm");
const imageCancelBtn = document.getElementById("image-cancel");
let imageDialogCtx = null; // { card, q, imageId, chosenSvg }

imageCancelBtn.addEventListener("click", () => imageDialog.close());

imageConfirmBtn.addEventListener("click", async () => {
  if (!imageDialogCtx || !imageDialogCtx.chosenSvg) return;
  imageConfirmBtn.disabled = true;
  imageCancelBtn.disabled = true;
  imageDialogError.hidden = true;

  try {
    const payload = {
      question_id: imageDialogCtx.q.id,
      svg_data_uri: svgToDataUri(imageDialogCtx.chosenSvg),
    };
    const updated = await adminFetch("replace_diagram", payload);
    replaceCard(imageDialogCtx.card, updated);
    imageDialog.close();
  } catch (err) {
    console.error("replace_diagram failed:", err);
    imageDialogError.textContent = err.message;
    imageDialogError.hidden = false;
  } finally {
    imageConfirmBtn.disabled = false;
    imageCancelBtn.disabled = false;
  }
});

function svgToDataUri(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return "data:image/svg+xml;base64," + btoa(binary);
}

async function startImageReplace(card, q) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/*";
  picker.addEventListener("change", async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;

    let dataUrl, width, height;
    try {
      ({ dataUrl, width, height } = await processUpload(file));
    } catch (err) {
      window.alert(err.message);
      return;
    }

    imageDialogCtx = { card, q, chosenSvg: null };
    imageConfirmBtn.disabled = true;
    imageDialogError.hidden = true;
    imageCandidatesEl.innerHTML = "";

    // Reference: the current diagram (may be none)
    const hasCurrent = !!(q.images && q.images[0] && q.images[0].url);
    const currentTile = candidateTile(hasCurrent ? "Current" : "Current (none)", hasCurrent ? q.images[0].url : "", null);
    if (!hasCurrent) currentTile.querySelector(".candidate-preview").textContent = "No image yet";
    imageCandidatesEl.appendChild(currentTile);

    // Candidate B: raster wrapped in an <svg>
    const rasterSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${width} ${height}">` +
      `<image href="${dataUrl}" xlink:href="${dataUrl}" width="${width}" height="${height}"/></svg>`;
    imageCandidatesEl.appendChild(
      candidateTile("Uploaded image (exact)", svgToDataUri(rasterSvg), rasterSvg),
    );

    // Candidate A: vector trace (empty string, not null, so the pick button exists but is disabled)
    const tracedTile = candidateTile("Vector trace", "", "");
    tracedTile.querySelector(".candidate-pick").disabled = true;
    tracedTile.querySelector(".candidate-preview").textContent = "Tracing…";
    imageCandidatesEl.appendChild(tracedTile);

    if (typeof ImageTracer !== "undefined") {
      // Tuned for black-line diagrams: force a clean 2-tone (white/black) vector.
      const traceOpts = {
        pal: [{ r: 255, g: 255, b: 255, a: 255 }, { r: 0, g: 0, b: 0, a: 255 }],
        colorsampling: 0,
        numberofcolors: 2,
        pathomit: 4,
        ltres: 1,
        qtres: 1,
        blurradius: 0,
        linefilter: true,
      };
      try {
        ImageTracer.imageToSVG(dataUrl, (svgstr) => {
          const preview = tracedTile.querySelector(".candidate-preview");
          preview.textContent = "";
          const img = document.createElement("img");
          img.src = svgToDataUri(svgstr);
          preview.appendChild(img);
          const pick = tracedTile.querySelector(".candidate-pick");
          pick.disabled = false;
          pick.dataset.svg = svgstr;
        }, traceOpts);
      } catch (err) {
        console.error("trace failed:", err);
        tracedTile.querySelector(".candidate-preview").textContent = "Trace failed — use the exact upload.";
      }
    } else {
      tracedTile.querySelector(".candidate-preview").textContent =
        "Tracer unavailable — use the exact upload.";
    }

    imageDialog.showModal();
    picker.value = "";
  });
  picker.click();
}

function candidateTile(title, previewSrc, svgForPick) {
  const tile = document.createElement("div");
  tile.className = "candidate";

  const h = document.createElement("h3");
  h.textContent = title;
  tile.appendChild(h);

  const preview = document.createElement("div");
  preview.className = "candidate-preview";
  if (previewSrc) {
    const img = document.createElement("img");
    img.src = previewSrc;
    preview.appendChild(img);
  }
  tile.appendChild(preview);

  if (svgForPick !== null) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "candidate-pick admin-btn";
    pick.textContent = "Use this";
    if (svgForPick) pick.dataset.svg = svgForPick;
    pick.addEventListener("click", () => {
      const svg = pick.dataset.svg;
      if (!svg) return;
      imageDialogCtx.chosenSvg = svg;
      imageCandidatesEl
        .querySelectorAll(".candidate")
        .forEach((c) => c.classList.remove("is-chosen"));
      tile.classList.add("is-chosen");
      imageConfirmBtn.disabled = false;
    });
    tile.appendChild(pick);
  }

  return tile;
}

// Read an uploaded image, downscale it (longest side <= 1400px) via canvas, and
// return a bounded data URL plus its pixel size. Keeps the stored SVG small.
function processUpload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load that image."));
      img.onload = () => {
        const maxSide = 1400;
        let w = img.naturalWidth || 800;
        let h = img.naturalHeight || 600;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        const mime = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
        const dataUrl = mime === "image/jpeg"
          ? canvas.toDataURL(mime, 0.9)
          : canvas.toDataURL(mime);
        resolve({ dataUrl, width: w, height: h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- Handle a user picking an option ----
async function handleAnswer(questionId, chosenLabel, clickedBtn, optionsWrap) {
  // Prevent double-answering: disable every option button for this question
  const allButtons = optionsWrap.querySelectorAll(".option");
  allButtons.forEach((b) => (b.disabled = true));

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/check-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: questionId, chosen_label: chosenLabel }),
    });

    const result = await res.json();

    allButtons.forEach((b) => {
      const label = b.querySelector(".option-label").textContent.replace(".", "");
      if (label === result.correct_label) {
        b.classList.add("is-correct");
      } else if (b === clickedBtn) {
        b.classList.add("is-incorrect");
      }
    });

    const feedback = document.createElement("p");
    feedback.className = `feedback ${result.correct ? "correct" : "incorrect"}`;
    feedback.textContent = result.correct ? "Correct." : `Incorrect — correct answer is (${result.correct_label}).`;
    optionsWrap.after(feedback);

    if (result.explanation) {
      const explanation = document.createElement("p");
      explanation.className = "explanation";
      explanation.textContent = result.explanation;
      feedback.after(explanation);
    }
  } catch (err) {
    console.error("check-answer failed:", err);
    allButtons.forEach((b) => (b.disabled = false)); // let them retry
  }
}

syncAdminToggle();
loadQuestions();
