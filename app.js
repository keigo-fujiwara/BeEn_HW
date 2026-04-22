/**
 * BeEngineer
 *
 * 単元JSON（data/.../unitXX.json）:
 * { "unit_title": "...", "questions": [ { "question", "options", "answer", "commentary" } ] }
 * answer: 0〜3
 *
 * カタログ（data/catalog.json）のみがコース名・分野名・単元一覧のソース。
 * app.js には名称をハードコードしない。
 *
 * catalog.json スキーマ（version 2）:
 * {
 *   "version": 2,
 *   "courses": [
 *     {
 *       "id": "A",
 *       "name": "表示名",
 *       "fields": [
 *         { "id": "...", "name": "分野名", "units": [ { "id", "title", "jsonPath" } ] }
 *       ]
 *     }
 *   ]
 * }
 *
 * 旧形式: コース直下に "units" だけある場合は、分野名「単元」1つにラップして解釈する。
 *
 * Aコース: 単元IDは A-u1 … A-u36（表示順）。jsonPath は data/A/unit01.json … unit36.json に対応。
 */

const TEST_COUNT = 10;
/** 確認テストの制限時間（秒） */
const TEST_TIME_LIMIT_SEC = 300;

/** 10問のとき 8 問以上で合格（問数が少ない単元は 80% 切り上げ） */
function testPassThreshold(questionCount) {
  return Math.max(1, Math.ceil(questionCount * 0.8));
}

/** @type {ReturnType<typeof setInterval> | null} */
let testTimerIntervalId = null;
/** テスト終了時刻（Unix ms）。0 はタイマー未設定 */
let testTimerEndAt = 0;
/** 二重提出防止 */
let testSubmitting = false;

function getTestTimeRemainingSec() {
  if (!testTimerEndAt) return 0;
  return Math.max(0, Math.ceil((testTimerEndAt - Date.now()) / 1000));
}

function formatTestClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clearTestTimer() {
  if (testTimerIntervalId !== null) {
    window.clearInterval(testTimerIntervalId);
    testTimerIntervalId = null;
  }
  testTimerEndAt = 0;
}

const CATALOG_URL = "data/catalog.json";

/** @type {ReturnType<typeof parseCatalog> | null} */
let catalogData = null;

/**
 * 単元ID（例: A-u12）の末尾番号を取得する。
 * @param {string} unitId
 * @returns {number|null}
 */
function getUnitNo(unitId) {
  const m = String(unitId).trim().match(/-u(\d+)\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 1学期用: すべてのコースで u12 まで表示する。
 * @param {string} courseId
 * @param {string} unitId
 */
function shouldShowUnit(courseId, unitId) {
  // courseId は将来の拡張用（例: コース別で上限を変える）に残している
  void courseId;
  const no = getUnitNo(unitId);
  if (no === null) return true;
  return no <= 12;
}

/** @type {{ unit_title: string, questions: Array<{question:string, options:string[], answer:number, commentary:string}> } | null} */
let currentUnit = null;

/** @type {'idle'|'homework'|'test'} */
let currentMode = "idle";

/** 宿題: 現在の問題インデックス（0 始まり） */
let homeworkCursor = 0;
/** 宿題: これまでの正解数 */
let homeworkScore = 0;
/** 宿題: 現在の問題に回答済みか */
let homeworkAnswered = false;

/** テストに出す問題の unit 内インデックス（長さ 10 以下） */
let testSubset = [];
/** @type {(number|null)[]} 各問で選んだ選択肢（シャッフル後の 0〜3、未選択は null） */
let testSelections = [];
/**
 * @type {Array<{
 *   qIndex: number,
 *   labels: string[],
 *   answerIndex: number,
 *   question: { question: string, options: string[], answer: number, commentary: string }
 * }>}
 */
let testItems = [];

const els = {
  catalogHint: document.getElementById("catalogHint"),
  courseSelect: document.getElementById("courseSelect"),
  unitSelect: document.getElementById("unitSelect"),
  unitSelectCombo: document.getElementById("unitSelectCombo"),
  unitSelectTrigger: document.getElementById("unitSelectTrigger"),
  unitSelectPanel: document.getElementById("unitSelectPanel"),
  btnLoadUnit: document.getElementById("btnLoadUnit"),
  unitTitleDisplay: document.getElementById("unitTitleDisplay"),
  modeButtons: document.getElementById("modeButtons"),
  setupPanel: document.getElementById("setupPanel"),
  mainArea: document.getElementById("mainArea"),
  btnHomework: document.getElementById("btnHomework"),
  btnTest: document.getElementById("btnTest"),
  btnBack: document.getElementById("btnBack"),
  modeBadge: document.getElementById("modeBadge"),
  homeworkPanel: document.getElementById("homeworkPanel"),
  homeworkHeading: document.getElementById("homeworkHeading"),
  homeworkProgress: document.getElementById("homeworkProgress"),
  homeworkCard: document.getElementById("homeworkCard"),
  homeworkQuestion: document.getElementById("homeworkQuestion"),
  homeworkOptions: document.getElementById("homeworkOptions"),
  homeworkCommentaryWrap: document.getElementById("homeworkCommentaryWrap"),
  homeworkNext: document.getElementById("homeworkNext"),
  homeworkComplete: document.getElementById("homeworkComplete"),
  homeworkScoreSummary: document.getElementById("homeworkScoreSummary"),
  homeworkCompleteCheer: document.getElementById("homeworkCompleteCheer"),
  testPanel: document.getElementById("testPanel"),
  testUnitLine: document.getElementById("testUnitLine"),
  testIntro: document.getElementById("testIntro"),
  testProgressWrap: document.getElementById("testProgressWrap"),
  testProgress: document.getElementById("testProgress"),
  testFormWrap: document.getElementById("testFormWrap"),
  testList: document.getElementById("testList"),
  btnSubmitTest: document.getElementById("btnSubmitTest"),
  testResult: document.getElementById("testResult"),
  scoreLine: document.getElementById("scoreLine"),
  testResultUnit: document.getElementById("testResultUnit"),
  testTimeNotice: document.getElementById("testTimeNotice"),
  passLine: document.getElementById("passLine"),
  testResultDetail: document.getElementById("testResultDetail"),
  btnRetryTest: document.getElementById("btnRetryTest"),
};

/**
 * @param {unknown} raw
 */
function parseCatalog(raw) {
  if (!raw || typeof raw !== "object") throw new Error("catalog.json の形式が不正です。");
  const coursesRaw = /** @type {{ courses?: unknown }} */ (raw).courses;
  if (!Array.isArray(coursesRaw) || coursesRaw.length === 0) {
    throw new Error("courses がありません。");
  }
  const version = typeof /** @type {{ version?: unknown }} */ (raw).version === "number" ? /** @type {{ version: number }} */ (raw).version : 1;
  return {
    version,
    courses: coursesRaw.map((c, i) => normalizeCourse(c, i)),
  };
}

/**
 * @param {unknown} course
 * @param {number} index
 */
function normalizeCourse(course, index) {
  if (!course || typeof course !== "object") throw new Error(`courses[${index}] が不正です。`);
  const c = /** @type {{ id?: unknown, name?: unknown, fields?: unknown, units?: unknown }} */ (course);
  const id = String(c.id ?? "").trim();
  const name = String(c.name ?? "").trim() || id;
  if (!id) throw new Error(`courses[${index}].id がありません。`);

  /** @type {Array<{ id: string, name: string, units: Array<{ id: string, title: string, jsonPath: string }> }>} */
  let fields = [];

  if (Array.isArray(c.fields) && c.fields.length > 0) {
    fields = c.fields.map((f, j) => normalizeField(f, id, j));
  } else if (Array.isArray(c.units) && c.units.length > 0) {
    fields = [
      {
        id: `${id}-legacy-units`,
        name: "単元",
        units: c.units.map((u, j) => normalizeUnitRef(u, id, j)),
      },
    ];
  } else {
    throw new Error(`コース「${id}」に fields または units がありません。`);
  }

  return { id, name, fields };
}

/**
 * @param {unknown} field
 * @param {string} courseId
 * @param {number} index
 */
function normalizeField(field, courseId, index) {
  if (!field || typeof field !== "object") throw new Error(`コース「${courseId}」の分野[${index}] が不正です。`);
  const f = /** @type {{ id?: unknown, name?: unknown, units?: unknown }} */ (field);
  const id = String(f.id ?? "").trim() || `field-${index}`;
  const name = String(f.name ?? "").trim() || id;
  const unitsRaw = f.units;
  if (!Array.isArray(unitsRaw) || unitsRaw.length === 0) {
    throw new Error(`コース「${courseId}」分野「${name}」に units がありません。`);
  }
  return {
    id,
    name,
    units: unitsRaw.map((u, j) => normalizeUnitRef(u, `${courseId}/${id}`, j)),
  };
}

/**
 * @param {unknown} u
 * @param {string} ctx
 * @param {number} index
 */
function normalizeUnitRef(u, ctx, index) {
  if (!u || typeof u !== "object") throw new Error(`単元定義が不正です（${ctx}[${index}]）。`);
  const o = /** @type {{ id?: unknown, title?: unknown, jsonPath?: unknown }} */ (u);
  const id = String(o.id ?? "").trim();
  const title = String(o.title ?? "").trim();
  const jsonPath = String(o.jsonPath ?? "").trim();
  if (!id) throw new Error(`単元 id がありません（${ctx}[${index}]）。`);
  if (!title) throw new Error(`単元 title がありません（${ctx} / ${id}）。`);
  if (!jsonPath) throw new Error(`jsonPath がありません（${ctx} / ${id}）。`);
  return { id, title, jsonPath };
}

/**
 * @param {{ id: string, name: string, fields: Array<{ id: string, name: string, units: Array<{ id: string, title: string, jsonPath: string }> }> }} course
 * @param {string} unitId
 */
function findUnitInCourse(course, unitId) {
  for (const field of course.fields) {
    const u = field.units.find((x) => x.id === unitId);
    if (u) return u;
  }
  return null;
}

function normalizeUnit(raw) {
  if (!raw || typeof raw !== "object") throw new Error("JSONの形式が不正です。");
  const title = String(raw.unit_title ?? "").trim() || "（無題の単元）";
  const qs = raw.questions;
  if (!Array.isArray(qs) || qs.length === 0) throw new Error("questions が空です。");
  const questions = qs.map((q, i) => {
    const question = String(q.question ?? "");
    const options = Array.isArray(q.options) ? q.options.map(String) : [];
    if (options.length !== 4) throw new Error(`問題${i + 1}: options は4件必要です。`);
    let answer = q.answer;
    if (typeof answer === "string" && /^\d+$/.test(answer)) answer = Number(answer);
    if (typeof answer !== "number" || answer < 0 || answer > 3 || !Number.isInteger(answer)) {
      throw new Error(`問題${i + 1}: answer は 0〜3 の整数で指定してください。`);
    }
    return {
      question,
      options,
      answer,
      commentary: String(q.commentary ?? ""),
    };
  });
  return { unit_title: title, questions };
}

function setUnit(data) {
  currentUnit = data;
  els.unitTitleDisplay.textContent = `単元名: ${data.unit_title}（全 ${data.questions.length} 問）`;
  els.modeButtons.hidden = false;
}

/**
 * 単元JSONの問題文・解説に含まれる &lt;pre&gt;&lt;code&gt; 等を表示用に解釈する。
 * 許可タグ以外はタグを外して中身のみ残す（属性は全削除）。
 * @param {string} html
 */
function sanitizeRichHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html);
  const allowed = new Set(["PRE", "CODE", "BR", "STRONG", "EM", "B", "I", "SPAN", "P"]);
  function clean(node) {
    const children = [...node.childNodes];
    for (const child of children) {
      if (!child.parentNode) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (child);
        if (!allowed.has(el.tagName)) {
          const parent = /** @type {Node} */ (el.parentNode);
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          parent.removeChild(el);
          clean(parent);
          continue;
        }
        [...el.attributes].forEach((a) => el.removeAttribute(a.name));
      }
      if (child.parentNode) clean(child);
    }
  }
  clean(tpl.content);
  return tpl.innerHTML;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandomQuestions(all, n) {
  if (all.length <= n) return shuffle([...all.map((_, i) => i)]);
  return shuffle([...all.map((_, i) => i)]).slice(0, n);
}

/**
 * 選択肢の並びをランダム化し、表示上の正解インデックス（0〜）を返す。
 * @param {string[]} options
 * @param {number} answerIndex JSON 上の正解インデックス
 */
function shuffleOptionsOrder(options, answerIndex) {
  const n = options.length;
  const order = shuffle([...Array(n).keys()]);
  const labels = order.map((i) => options[i]);
  const newAnswerIndex = order.indexOf(answerIndex);
  return { labels, answerIndex: newAnswerIndex };
}

/**
 * @param {string} label
 */
function createOptionButton(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "opt-btn";
  const inner = document.createElement("span");
  inner.className = "opt-btn-inner";
  const labelSpan = document.createElement("span");
  labelSpan.className = "opt-btn-label";
  labelSpan.textContent = label;
  inner.appendChild(labelSpan);
  btn.appendChild(inner);
  return btn;
}

/**
 * @param {HTMLElement} container .opt-btn を含む親
 * @param {number} correctIndex
 * @param {number} selectedIndex
 */
function applyAnswerMarks(container, correctIndex, selectedIndex) {
  const btns = container.querySelectorAll(".opt-btn");
  btns.forEach((btn, i) => {
    const inner = btn.querySelector(".opt-btn-inner");
    if (!inner) return;
    if (i === correctIndex) {
      const mark = document.createElement("span");
      mark.className = "opt-mark opt-mark--ok";
      mark.textContent = "〇";
      mark.setAttribute("aria-label", "正解");
      inner.appendChild(mark);
    }
    if (i === selectedIndex && selectedIndex !== correctIndex) {
      const mark = document.createElement("span");
      mark.className = "opt-mark opt-mark--ng";
      mark.textContent = "×";
      mark.setAttribute("aria-label", "不正解");
      inner.appendChild(mark);
    }
  });
}

/**
 * @param {boolean} revealed 直前の問題に回答済みで、分母にその1問を含める
 */
function updateHomeworkProgress(revealed) {
  if (!currentUnit) return;
  const total = currentUnit.questions.length;
  const currentNum = homeworkCursor + 1;
  const doneCount = revealed ? homeworkCursor + 1 : homeworkCursor;
  const barPct = total > 0 ? Math.min(100, (doneCount / total) * 100) : 0;

  els.homeworkProgress.innerHTML = `
    <div class="progress-head">
      <span class="progress-emoji" aria-hidden="true">🎯</span>
      <span class="progress-label">今は <strong>${currentNum}</strong> / <strong>${total}</strong> 問目</span>
    </div>
    <div class="progress-track" role="progressbar" aria-valuenow="${doneCount}" aria-valuemin="0" aria-valuemax="${total}" aria-label="この単元の進み具合">
      <div class="progress-fill" style="width:${barPct}%"></div>
    </div>
    <div class="progress-scores">
      <span class="progress-pill">
        <span class="pill-icon" aria-hidden="true">✨</span>
        正解 <strong>${homeworkScore}</strong> 回
      </span>
      <span class="progress-hint">（ここまで <strong>${doneCount}</strong> 問 やったよ）</span>
    </div>
  `;
}

function finishHomework() {
  if (!currentUnit) return;
  const { questions } = currentUnit;
  const total = questions.length;
  els.homeworkCard.hidden = true;
  els.homeworkNext.hidden = true;
  els.homeworkComplete.hidden = false;
  els.homeworkComplete.classList.toggle("completion-banner--perfect", total > 0 && homeworkScore === total);

  els.homeworkScoreSummary.innerHTML = `正解 <strong>${homeworkScore}</strong> 問 / ぜんぶ <strong>${total}</strong> 問`;

  const ratio = total > 0 ? homeworkScore / total : 0;
  let cheer = "またチャレンジしてね！";
  if (total === 0) cheer = "";
  else if (ratio >= 1) cheer = "ぜんぶ正解！とてもすごい！エンジニアの才能かも！";
  else if (ratio >= 0.7) cheer = "とてもいい調子！このまま伸ばそう！";
  else if (ratio >= 0.4) cheer = "よくがんばった！復習すればもっとできるよ！";
  else cheer = "間違いは成長のチャンス！解説を見て、もう一度やってみよう！";
  els.homeworkCompleteCheer.textContent = cheer;
}

function updateTestPendingProgress() {
  if (testItems.length === 0) return;
  const total = testItems.length;
  const answered = testSelections.filter((s) => s !== null).length;
  const barPct = total > 0 ? (answered / total) * 100 : 0;
  const timeLeft = getTestTimeRemainingSec();
  const timeStr = formatTestClock(timeLeft);
  const urgent = timeLeft <= 60 && timeLeft > 0;
  const timerRow =
    testTimerEndAt > 0
      ? `<div class="test-timer-row${urgent ? " test-timer-row--urgent" : ""}" role="timer" aria-live="polite" aria-atomic="true">
      <span class="test-timer-label">残り時間</span>
      <span class="test-timer-clock">${timeStr}</span>
      <span class="test-timer-sec">（${TEST_TIME_LIMIT_SEC} 秒で自動提出）</span>
    </div>`
      : "";
  els.testProgress.innerHTML = `
    ${timerRow}
    <div class="progress-head">
      <span class="progress-emoji" aria-hidden="true">📝</span>
      <span class="progress-label">回答済み <strong>${answered}</strong> / <strong>${total}</strong> 問</span>
    </div>
    <div class="progress-track" role="progressbar" aria-valuenow="${answered}" aria-valuemin="0" aria-valuemax="${total}" aria-label="回答の進み具合">
      <div class="progress-fill progress-fill--test" style="width:${barPct}%"></div>
    </div>
    <p class="test-pending-hint">※ ここでは正解・不正解はまだ出ません。選び終わったら「提出する」か、時間が来るまでにお答えください。</p>
  `;
}

function renderTestForm() {
  if (!currentUnit || testItems.length === 0) return;
  els.testList.innerHTML = "";

  testItems.forEach((item, qi) => {
    const block = document.createElement("div");
    block.className = "test-q-block";

    const head = document.createElement("div");
    head.className = "test-q-head";
    const num = document.createElement("span");
    num.className = "test-q-num";
    num.textContent = `問題 ${qi + 1}`;
    head.appendChild(num);

    const pq = document.createElement("div");
    pq.className = "question-text";
    pq.innerHTML = sanitizeRichHtml(item.question.question);

    const opts = document.createElement("div");
    opts.className = "options cols-2";

    item.labels.forEach((label, oi) => {
      const btn = createOptionButton(label);
      btn.classList.add("opt-btn--test");
      if (testSelections[qi] === oi) btn.classList.add("selected");
      btn.addEventListener("click", () => {
        testSelections[qi] = oi;
        opts.querySelectorAll(".opt-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        updateTestPendingProgress();
      });
      opts.appendChild(btn);
    });

    block.appendChild(head);
    block.appendChild(pq);
    block.appendChild(opts);
    els.testList.appendChild(block);
  });

  updateTestPendingProgress();
}

/**
 * @param {boolean} [fromTimeUp] 制限時間切れによる自動提出（未回答は不正解として採点）
 */
function submitTest(fromTimeUp = false) {
  if (testSubmitting) return;
  if (!currentUnit || testItems.length === 0) return;
  const total = testItems.length;

  if (!fromTimeUp) {
    const firstUnanswered = testSelections.findIndex((s) => s === null);
    if (firstUnanswered !== -1) {
      alert(`すべての問題に答えてください。（未回答: 問題 ${firstUnanswered + 1} 番）`);
      return;
    }
  }

  testSubmitting = true;
  clearTestTimer();

  let score = 0;
  testItems.forEach((item, qi) => {
    const sel = testSelections[qi];
    if (sel !== null && sel === item.answerIndex) score += 1;
  });

  const threshold = testPassThreshold(total);
  const passed = score >= threshold;

  els.testFormWrap.hidden = true;
  els.testUnitLine.hidden = true;
  els.testIntro.hidden = true;
  els.testProgressWrap.hidden = true;
  els.testResult.hidden = false;

  if (currentUnit) {
    els.testResultUnit.textContent = `単元「${currentUnit.unit_title}」`;
  }

  if (fromTimeUp) {
    els.testTimeNotice.hidden = false;
    els.testTimeNotice.textContent =
      "制限時間に達したため自動提出しました。未回答の問題は不正解として採点しています。";
  } else {
    els.testTimeNotice.hidden = true;
    els.testTimeNotice.textContent = "";
  }

  els.scoreLine.innerHTML = `<strong>${score}</strong> / <strong>${total}</strong> 正解`;

  els.passLine.innerHTML = passed
    ? `<span class="pass-badge pass-badge--ok">合格！</span><span class="pass-note">（${threshold} 問以上で合格）</span>`
    : `<span class="pass-badge pass-badge--ng">不合格</span><span class="pass-note">（合格は ${threshold} 問以上です）</span>`;
  els.passLine.classList.toggle("pass-line--pass", passed);
  els.testResult.classList.toggle("test-result--perfect", passed);

  const parts = [];
  testItems.forEach((item, qi) => {
    const sel = testSelections[qi];
    const ok = sel !== null && sel === item.answerIndex;
    const mark = ok ? "〇" : "×";
    const cls = ok ? "test-review-block test-review-block--ok" : "test-review-block test-review-block--ng";
    const headLabel = ok ? "正解" : "不正解";
    parts.push(
      `<div class="${cls}">
        <div class="test-review-head">
          <span class="test-review-num">問題 ${qi + 1}</span>
          <span class="test-review-mark" aria-hidden="true">${mark}</span>
          <span class="test-review-label">${headLabel}</span>
        </div>
        <div class="question-text">${sanitizeRichHtml(item.question.question)}</div>
        <div class="commentary"><span class="commentary-label">解説</span>${sanitizeRichHtml(item.question.commentary)}</div>
      </div>`,
    );
  });
  els.testResultDetail.innerHTML = parts.join("");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showHomeworkQuestion() {
  if (!currentUnit) return;
  const { questions } = currentUnit;
  const total = questions.length;
  if (homeworkCursor >= total) {
    finishHomework();
    return;
  }

  els.homeworkHeading.textContent = `宿題モード — ${currentUnit.unit_title}`;
  els.homeworkComplete.hidden = true;
  els.homeworkCard.hidden = false;
  els.homeworkNext.hidden = true;
  els.homeworkNext.disabled = true;
  els.homeworkCommentaryWrap.hidden = true;
  els.homeworkCommentaryWrap.innerHTML = "";
  homeworkAnswered = false;

  const q = questions[homeworkCursor];
  const { labels: optionLabels, answerIndex: displayAnswer } = shuffleOptionsOrder(q.options, q.answer);
  updateHomeworkProgress(false);

  els.homeworkQuestion.innerHTML = sanitizeRichHtml(q.question);
  els.homeworkOptions.innerHTML = "";
  els.homeworkOptions.className = "options cols-2";

  let revealed = false;
  const btns = /** @type {HTMLButtonElement[]} */ ([]);

  const reveal = (selectedIdx) => {
    if (revealed) return;
    revealed = true;
    homeworkAnswered = true;
    const correct = selectedIdx === displayAnswer;
    if (correct) homeworkScore += 1;
    updateHomeworkProgress(true);

    btns.forEach((btn, i) => {
      btn.disabled = true;
      if (i === displayAnswer) btn.classList.add("flash-correct");
      else if (i === selectedIdx && !correct) btn.classList.add("flash-wrong");
    });
    applyAnswerMarks(els.homeworkOptions, displayAnswer, selectedIdx);

    const feedback = correct
      ? `<div class="answer-feedback answer-feedback--ok" role="status"><span class="answer-feedback-mark" aria-hidden="true">〇</span> 正解！やったね！</div>`
      : `<div class="answer-feedback answer-feedback--ng" role="status"><span class="answer-feedback-mark" aria-hidden="true">×</span> 残念。でも、次はきっとできる！</div>`;

    els.homeworkCommentaryWrap.hidden = false;
    els.homeworkCommentaryWrap.innerHTML =
      feedback + `<div class="commentary"><span class="commentary-label">解説</span>${sanitizeRichHtml(q.commentary)}</div>`;

    const isLast = homeworkCursor >= total - 1;
    els.homeworkNext.textContent = isLast ? "結果を見る" : "次の問題へ";
    els.homeworkNext.hidden = false;
    els.homeworkNext.disabled = false;
  };

  optionLabels.forEach((label, oi) => {
    const btn = createOptionButton(label);
    btn.addEventListener("click", () => reveal(oi));
    els.homeworkOptions.appendChild(btn);
    btns.push(btn);
  });
}

function renderHomework() {
  if (!currentUnit) return;
  homeworkCursor = 0;
  homeworkScore = 0;
  els.homeworkComplete.hidden = true;
  els.homeworkComplete.classList.remove("completion-banner--perfect");
  showHomeworkQuestion();
}

function startTest() {
  if (!currentUnit) return;
  const nq = currentUnit.questions.length;
  const n = Math.min(TEST_COUNT, nq);
  if (n === 0) return;

  clearTestTimer();
  testSubmitting = false;

  testSubset = pickRandomQuestions(currentUnit.questions, n);
  testItems = testSubset.map((qIdx) => {
    const q = currentUnit.questions[qIdx];
    const { labels, answerIndex } = shuffleOptionsOrder(q.options, q.answer);
    return { qIndex: qIdx, labels, answerIndex, question: q };
  });
  testSelections = testItems.map(() => null);

  testTimerEndAt = Date.now() + TEST_TIME_LIMIT_SEC * 1000;

  els.testResult.hidden = true;
  els.testFormWrap.hidden = false;
  els.testUnitLine.hidden = false;
  els.testIntro.hidden = false;
  els.testProgressWrap.hidden = false;
  els.testResult.classList.remove("test-result--perfect");
  els.testTimeNotice.hidden = true;
  els.testTimeNotice.textContent = "";
  els.testUnitLine.textContent = `単元「${currentUnit.unit_title}」`;
  els.testIntro.textContent = `${n} 問すべてに答えてから「提出する」で答え合わせできます。制限時間は ${TEST_TIME_LIMIT_SEC} 秒です。時間が来ると未回答は不正解のまま自動提出されます。`;
  renderTestForm();

  testTimerIntervalId = window.setInterval(() => {
    if (currentMode !== "test" || !testTimerEndAt) return;
    updateTestPendingProgress();
    if (getTestTimeRemainingSec() <= 0) {
      submitTest(true);
    }
  }, 250);
}

function enterMode(mode) {
  if (!currentUnit) return;
  currentMode = mode;
  els.setupPanel.hidden = true;
  els.mainArea.hidden = false;
  els.homeworkPanel.hidden = mode !== "homework";
  els.testPanel.hidden = mode !== "test";
  els.modeBadge.textContent = mode === "homework" ? "宿題モード" : "確認テストモード";

  if (mode === "homework") {
    renderHomework();
  } else {
    startTest();
  }
}

function resetUnitSelectionState() {
  els.modeButtons.hidden = true;
  currentUnit = null;
  els.unitTitleDisplay.textContent = "単元名: （未読み込み）";
}

function syncUnitTriggerFromSelect() {
  const sel = els.unitSelect;
  const trig = els.unitSelectTrigger;
  trig.disabled = sel.disabled;
  const opt = sel.options[sel.selectedIndex];
  trig.textContent = opt ? opt.textContent : "—";
}

function rebuildUnitDropdownPanel() {
  const panel = els.unitSelectPanel;
  panel.innerHTML = "";
  const sel = els.unitSelect;
  for (const child of sel.children) {
    if (child.tagName === "OPTION") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "unit-select-option";
      btn.role = "option";
      btn.dataset.value = child.value;
      btn.textContent = child.textContent;
      panel.appendChild(btn);
    } else if (child.tagName === "OPTGROUP") {
      const g = document.createElement("div");
      g.className = "unit-select-group";
      const gl = document.createElement("div");
      gl.className = "unit-select-group-label";
      gl.textContent = child.label;
      g.appendChild(gl);
      for (const opt of child.querySelectorAll("option")) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "unit-select-option";
        b.dataset.value = opt.value;
        b.textContent = opt.textContent;
        g.appendChild(b);
      }
      panel.appendChild(g);
    }
  }
}

function setUnitPanelOpen(open) {
  const panel = els.unitSelectPanel;
  const trig = els.unitSelectTrigger;
  panel.hidden = !open;
  trig.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeUnitPanel() {
  setUnitPanelOpen(false);
}

function refreshUnitCustomUI() {
  rebuildUnitDropdownPanel();
  syncUnitTriggerFromSelect();
  closeUnitPanel();
}

async function loadCatalog() {
  els.catalogHint.hidden = false;
  els.catalogHint.textContent = "データを読み込み中です…";
  try {
    const r = await fetch(CATALOG_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    catalogData = parseCatalog(raw);
    els.catalogHint.textContent = "";
    els.catalogHint.hidden = true;
  } catch {
    catalogData = null;
    els.catalogHint.hidden = false;
    els.catalogHint.textContent =
      "data/catalog.json を読み込めませんでした。プロジェクト直下で HTTP サーバーを起動し、ブラウザから開いてください（file:// では fetch が使えません）。";
    els.courseSelect.innerHTML = '<option value="">— 読み込み失敗 —</option>';
    els.courseSelect.disabled = true;
    els.unitSelect.innerHTML = '<option value="">— —</option>';
    els.unitSelect.disabled = true;
    els.btnLoadUnit.disabled = true;
    refreshUnitCustomUI();
    return;
  }

  els.courseSelect.disabled = false;
  els.courseSelect.innerHTML = '<option value="">— コースを選択 —</option>';
  catalogData.courses.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    els.courseSelect.appendChild(opt);
  });
  refreshUnitCustomUI();
}

function onCourseChange() {
  const cid = els.courseSelect.value;
  els.unitSelect.innerHTML = "";
  els.unitSelect.disabled = true;
  els.btnLoadUnit.disabled = true;
  resetUnitSelectionState();

  if (!cid || !catalogData) {
    const ph0 = document.createElement("option");
    ph0.value = "";
    ph0.textContent = "— まずコースを選択 —";
    els.unitSelect.appendChild(ph0);
    refreshUnitCustomUI();
    return;
  }

  const course = catalogData.courses.find((c) => c.id === cid);
  if (!course) {
    const ph1 = document.createElement("option");
    ph1.value = "";
    ph1.textContent = "— まずコースを選択 —";
    els.unitSelect.appendChild(ph1);
    refreshUnitCustomUI();
    return;
  }

  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "— 単元を選択 —";
  els.unitSelect.appendChild(ph);

  for (const field of course.fields) {
    const og = document.createElement("optgroup");
    og.label = field.name;
    let added = 0;
    for (const u of field.units) {
      if (!shouldShowUnit(course.id, u.id)) continue;
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.title;
      opt.dataset.jsonPath = u.jsonPath;
      og.appendChild(opt);
      added += 1;
    }
    if (added > 0) els.unitSelect.appendChild(og);
  }
  els.unitSelect.disabled = false;
  refreshUnitCustomUI();
}

function onUnitChange() {
  const hasUnit = !!els.unitSelect.value;
  els.btnLoadUnit.disabled = !hasUnit;
  resetUnitSelectionState();
}

async function onLoadUnit() {
  const cid = els.courseSelect.value;
  const uid = els.unitSelect.value;
  if (!cid || !uid || !catalogData) return;

  const course = catalogData.courses.find((c) => c.id === cid);
  if (!course) return;
  const unit = findUnitInCourse(course, uid);
  if (!unit) return;

  els.modeButtons.hidden = true;

  try {
    const r = await fetch(unit.jsonPath, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    setUnit(normalizeUnit(raw));
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "単元の読み込みに失敗しました。data/ フォルダに JSON があるか、パスを確認してください。";
    alert(msg);
    resetUnitSelectionState();
  }
}

els.courseSelect.addEventListener("change", onCourseChange);

els.unitSelectTrigger.addEventListener("click", () => {
  if (els.unitSelectTrigger.disabled) return;
  setUnitPanelOpen(els.unitSelectPanel.hidden);
});

els.unitSelectPanel.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const btn = t.closest(".unit-select-option");
  if (!btn || !els.unitSelectPanel.contains(btn)) return;
  const val = btn.dataset.value ?? "";
  els.unitSelect.value = val;
  els.unitSelect.dispatchEvent(new Event("change", { bubbles: true }));
  syncUnitTriggerFromSelect();
  closeUnitPanel();
});

document.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof Node)) return;
  if (els.unitSelectCombo.contains(t)) return;
  closeUnitPanel();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!els.unitSelectPanel.hidden) {
    closeUnitPanel();
  }
});

els.unitSelect.addEventListener("change", onUnitChange);
els.btnLoadUnit.addEventListener("click", () => {
  try {
    void onLoadUnit();
  } catch (e) {
    alert(e instanceof Error ? e.message : "読み込みに失敗しました。");
  }
});

els.btnHomework.addEventListener("click", () => enterMode("homework"));
els.btnTest.addEventListener("click", () => enterMode("test"));

els.btnBack.addEventListener("click", () => {
  clearTestTimer();
  testSubmitting = false;
  els.setupPanel.hidden = false;
  els.mainArea.hidden = true;
  currentMode = "idle";
});

els.btnRetryTest.addEventListener("click", () => {
  if (currentMode === "test" && currentUnit) startTest();
});

els.btnSubmitTest.addEventListener("click", () => {
  if (currentMode === "test" && currentUnit) submitTest();
});

els.homeworkNext.addEventListener("click", () => {
  if (currentMode !== "homework" || !currentUnit) return;
  if (!homeworkAnswered) return;
  homeworkAnswered = false;
  els.homeworkNext.disabled = true;
  homeworkCursor += 1;
  showHomeworkQuestion();
});

async function init() {
  await loadCatalog();
}

init().catch(() => {
  els.catalogHint.hidden = false;
  els.catalogHint.textContent = "カタログの初期化に失敗しました。";
});
