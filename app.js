(() => {
  const ENGINE = window.FullHouseEngine;
  const KEYS = { state: "friends-full-house-state-v1", bank: "friends-full-house-bank-v1" };
  const isTV = document.body.dataset.view === "tv";
  const isRemote = document.body.dataset.network === "remote";
  const remoteRoom = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
    const themeChoices = ["amber", "peacock", "pink-glow", "midnight-citrus"];
  const app = document.getElementById("app");
  let bank = [];
  let state = ENGINE.initialState();
  let channel;
  let selectedQuestionId = "";
  let soundReady = false;
  let desiredVolume = Number(localStorage.getItem("full-house-volume") ?? 0.8);
  let soundMuted = localStorage.getItem("full-house-muted") === "yes";
  let audioContext = null;
  let masterGain = null;
  let previousState = null;
  let hostInterval = null;
  let noticeTimer = null;
  let remoteHostKey = "";
  let remotePollTimer = null;
  let remoteSaveTimer = null;
  let remoteWriteChain = Promise.resolve();
  let remoteSignature = "";
  let rosterEditorOpen = false;
  let rosterDraft = null;

  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const activeTheme = () => themeChoices.includes(state.theme) ? state.theme : "amber";
  const teamName = (index) => state.teams[index]?.name || `Team ${index + 1}`;
  const questionById = (id) => bank.find((question) => question.id === id);
  const needsDeckUpgrade = (questions) => Array.isArray(questions) && questions.some((question) => String(question?.id || "").startsWith("sample-"));

  async function initialize() {
    if (isRemote) {
      const ready = isTV ? true : await initializeRemoteHost();
      if (!ready) return;
      if (isTV && remoteRoom) startRemoteTVSync();
    } else {
      try {
        const response = await fetch("questions.json");
        const defaults = await response.json();
        const savedBank = localStorage.getItem(KEYS.bank);
        bank = savedBank ? JSON.parse(savedBank) : defaults;
        if (!savedBank || needsDeckUpgrade(bank)) { bank = defaults; localStorage.setItem(KEYS.bank, JSON.stringify(bank)); }
        const savedState = localStorage.getItem(KEYS.state);
        if (savedState) state = JSON.parse(savedState);
      } catch (error) {
        bank = [];
        alert("The party question deck could not be loaded. Make sure you opened the local launcher.");
      }
    }
    if (!isRemote && "BroadcastChannel" in window) {
      channel = new BroadcastChannel("friends-full-house-party-night-v1");
      channel.onmessage = (event) => applyRemote(event.data);
    }
    if (!isRemote) window.addEventListener("storage", (event) => {
      if (event.key === KEYS.state && event.newValue) {
        try {
          const old = state;
          state = JSON.parse(event.newValue);
          if (isTV) soundForChange(old, state);
          paint();
        } catch (_) { /* ignore a partial write */ }
      }
      if (event.key === KEYS.bank && event.newValue) {
        try { bank = JSON.parse(event.newValue); paint(); } catch (_) { /* ignore a partial write */ }
      }
    });
    app.addEventListener("click", handleClick);
    app.addEventListener("input", handleInput);
    app.addEventListener("change", handleChange);
    document.addEventListener("keydown", handleKeydown);
    if (!isTV) startHostClock();
    paint();
  }

  function applyRemote(message) {
    if (!message) return;
    if (message.state) {
      const old = state;
      state = { theme: "amber", ...message.state };
      if (isTV) soundForChange(old, state);
    }
    if (message.bank) bank = message.bank;
    paint();
  }

  function publish({ repaint = true, includeBank = false } = {}) {
    if (!isRemote) {
      try { localStorage.setItem(KEYS.state, JSON.stringify(state)); } catch (_) { /* this game fits comfortably in normal browser storage */ }
    } else if (!isTV) scheduleRemoteSave();
    channel?.postMessage({ state, ...(includeBank ? { bank } : {}) });
    if (repaint) paint();
  }

  function commit(type, data = {}, opts = {}) {
    const old = state;
    state = ENGINE.transition(state, { type, ...data });
    if (isTV) soundForChange(old, state);
    publish(opts);
  }

  function saveBank() {
    if (!isRemote) localStorage.setItem(KEYS.bank, JSON.stringify(bank));
    else scheduleRemoteSave();
    channel?.postMessage({ state, bank });
    paint();
  }

  function notify(message) {
    let el = document.querySelector(".alert");
    if (!el) {
      el = document.createElement("div");
      el.className = "alert";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.classList.remove("show"), 2300);
  }

  function paint() {
    if (isTV && isRemote && !remoteRoom) renderTVJoin();
    else if (isTV) renderTV(); else renderHost();
  }

  function renderTVJoin() {
    app.innerHTML = `<main class="tv-screen theme-amber"><div class="stage-light"></div><header class="tv-topbar"><div class="tv-logo">Friends <span>Full House</span><small>PARTY GAME</small></div></header><section class="tv-idle"><div class="eyebrow">Connect to the host screen</div><h1>Join<br>the game</h1><p>Ask your host for the six-character room code, then enter it below.</p><div class="tv-room-join"><input class="tv-room-code" id="tv-room-code" maxlength="6" autocomplete="off" autocapitalize="characters" aria-label="Six-character room code" placeholder="ABC123"><button class="button gold" data-action="join-room">Join the game →</button></div></section><footer class="tv-footer"><span><b>FRIENDS FULL HOUSE · PARTY GAME</b> · PLAY TOGETHER</span><span>Host answers stay private</span></footer></main>`;
    document.getElementById("tv-room-code")?.focus();
  }

  function rosterStatus(teams) {
    const lists = teams.map((team) => team.players.map((name) => name.trim()).filter(Boolean));
    const total = lists.flat().length;
    const unique = new Set(lists.flat().map((name) => name.toLowerCase())).size === total;
    const ready = total >= 9 && total <= 16 && lists.every((players) => players.length >= 4 && players.length <= 8) && unique;
    return { total, lists, ready, unique };
  }

  function renderRosterFields(teams) {
    return `<div class="setup-teams">${teams.map((team, index) => `<div class="team-editor" data-team="${index}">
      <div class="team-editor-heading"><div><div class="eyebrow">Team ${index + 1}</div><div class="subtle team-count">${team.players.filter((name) => name.trim()).length} participants</div></div><span class="pill">${index ? "Blue" : "Pink"} side</span></div>
      <div class="field"><label for="team-name-${index}">Team name</label><input class="text-input team-name-input" id="team-name-${index}" value="${escapeHTML(team.name)}" maxlength="32" placeholder="Give your team a name"></div>
      <div class="label participant-label">Participants</div>
      <div class="participant-list">${team.players.map((name, playerIndex) => `<div class="participant-row"><input class="text-input player-name-input" value="${escapeHTML(name)}" maxlength="40" aria-label="Team ${index + 1}, participant ${playerIndex + 1}" placeholder="Friend’s name"><button class="button danger small remove-participant" data-action="remove-player" data-team="${index}" data-player="${playerIndex}" aria-label="Remove participant ${escapeHTML(name || playerIndex + 1)} from Team ${index + 1}" title="Remove participant">−</button></div>`).join("")}</div>
      <button class="button add-participant" data-action="add-player" data-team="${index}">＋ Add participant</button>
      <div class="subtle roster-hint">4–8 people per team. You’re the host, so you’re not counted here.</div>
    </div>`).join("")}</div>`;
  }

  function renderSetup() {
    const { total, ready } = rosterStatus(state.teams);
    return `<section class="card">
      <div class="section-head"><div><div class="eyebrow">Before the spotlight</div><h2>Create your two teams</h2><div class="subtle">Name both teams, add your friends, or tap − beside anyone you need to remove. The host is separate.</div></div><span class="pill">9–16 friends · 2 teams</span></div>
      ${renderRosterFields(state.teams)}
      <div class="setup-footer"><div class="validation ${ready ? "good" : ""}" id="roster-count">${total} participants · ${ready ? "ready to play" : "add 4–8 people to each team"}</div><button class="button primary" data-action="start-game">Start the party <span aria-hidden="true">→</span></button></div>
    </section>`;
  }

  function readRosterFields(baseTeams) {
    const cards = [...document.querySelectorAll(".team-editor")];
    if (cards.length !== 2) return baseTeams;
    return cards.map((card, index) => ({
      ...baseTeams[index],
      name: card.querySelector(".team-name-input")?.value ?? baseTeams[index].name,
      players: [...card.querySelectorAll(".player-name-input")].map((input) => input.value)
    }));
  }

  function updateRosterCount(teams) {
    const { total, lists, ready, unique } = rosterStatus(teams);
    const status = document.querySelector("#roster-count, #roster-modal-count");
    if (status) {
      status.textContent = ready
        ? `${total} friends across two teams · ready to play`
        : !unique
          ? "Give each friend a unique name."
          : `${total} friends · use 4–8 per team (9–16 total).`;
      status.classList.toggle("good", ready);
    }
    document.querySelectorAll(".team-editor").forEach((card, index) => {
      const count = card.querySelector(".team-count");
      if (count) count.textContent = `${lists[index]?.length || 0} participants`;
    });
  }

  function rosterForCurrentEditor() {
    if (state.game === "setup") {
      state.teams = readRosterFields(state.teams);
      publish({ repaint: false });
      return state.teams;
    }
    rosterDraft = readRosterFields(rosterDraft || state.teams.map((team) => ({ ...team, players: team.players.slice() })));
    return rosterDraft;
  }

  function addRosterPlayer(teamIndex) {
    const teams = rosterForCurrentEditor();
    const rowTotal = teams.reduce((sum, team) => sum + team.players.length, 0);
    if (!teams[teamIndex] || teams[teamIndex].players.length >= 8 || rowTotal >= 16) return notify("Each team can have up to 8 participants, with 16 total.");
    teams[teamIndex].players.push("");
    if (state.game === "setup") { state.teams = teams; publish({ repaint: false }); } else rosterDraft = teams;
    paint();
    document.querySelectorAll(`.team-editor[data-team="${teamIndex}"] .player-name-input`).item(teams[teamIndex].players.length - 1)?.focus();
  }

  function removeRosterPlayer(teamIndex, playerIndex) {
    const teams = rosterForCurrentEditor();
    if (!teams[teamIndex]?.players[playerIndex] && playerIndex >= (teams[teamIndex]?.players.length || 0)) return;
    teams[teamIndex].players.splice(playerIndex, 1);
    if (state.game === "setup") { state.teams = teams; publish({ repaint: false }); } else rosterDraft = teams;
    paint();
  }

  function renderRosterModal() {
    if (!rosterEditorOpen || !rosterDraft) return "";
    const { total, ready } = rosterStatus(rosterDraft);
    return `<div class="roster-modal-backdrop" role="presentation"><section class="roster-modal card" role="dialog" aria-modal="true" aria-labelledby="roster-modal-title"><div class="section-head"><div><div class="eyebrow">Host controls</div><h2 id="roster-modal-title">Manage teams &amp; players</h2><div class="subtle">Add a friend, remove someone, or rename either team. The TV updates when you save.</div></div><button class="button small" data-action="close-roster">Close</button></div>${renderRosterFields(rosterDraft)}<div class="setup-footer"><div class="validation ${ready ? "good" : ""}" id="roster-modal-count">${total} friends · 4–8 per team</div><button class="button primary" data-action="save-roster">Save teams &amp; players</button></div></section></div>`;
  }

  function saveRoster() {
    const draft = readRosterFields(rosterDraft || state.teams);
    const { total, lists, ready, unique } = rosterStatus(draft);
    if (!unique) return notify("Each participant needs a unique name.");
    if (!ready) return notify(`Use 9–16 participants total, with 4–8 on each team. You have ${total}.`);
    state.teams = draft.map((team, index) => ({
      ...state.teams[index],
      name: team.name.trim() || `Team ${index + 1}`,
      players: lists[index],
      nextPlayer: (state.teams[index].nextPlayer || 0) % lists[index].length
    }));
    rosterEditorOpen = false;
    rosterDraft = null;
    publish();
    notify("Teams and players saved.");
  }

  function scoreStrip() {
    return `<div class="score-strip">${state.teams.map((team, index) => `<div class="score-team ${index ? "team-b" : ""}"><span class="name">${escapeHTML(team.name)}</span><span class="score">${team.score}</span></div>`).join(`<div class="score-vs">VS</div>`)}</div>`;
  }

  function setupRoundCard() {
    return `<section class="card"><div class="section-head"><div><div class="eyebrow">The board is ready</div><h2>${state.rounds.length ? "Next round" : "Let’s play"}</h2><div class="subtle">The shuffled question deck is ready. Each question appears once per game, even if you skip it.</div></div><span class="pill">${bank.length} questions</span></div>
      <div class="round-selectors"><label class="label" for="round-multiplier">Round value</label><select class="select multiplier" id="round-multiplier"><option value="1">Standard ×1</option><option value="2" ${state.rounds.length === 1 ? "selected" : ""}>Double ×2</option><option value="3" ${state.rounds.length === 2 ? "selected" : ""}>Triple ×3</option></select><button class="button primary" data-action="start-round">Draw & start round</button></div>
      <div class="host-help">Face off, choose <b>play</b> or <b>pass</b>, then reveal correct answers as friends shout them out. Three misses trigger a steal. The answer board uses fictional points for demonstration.</div>
      ${state.rounds.length ? `<div class="play-actions"><button class="button gold" data-action="end-game">End rounds & play Fast Money</button></div>` : ""}
    </section>`;
  }

  function faceoffPlayer(teamIndex) {
    const team = state.teams[teamIndex];
    return team?.players[team.nextPlayer % Math.max(1, team.players.length)] || "Player";
  }

  function turnPlayer(teamIndex) {
    const team = state.teams[teamIndex];
    const offset = state.round?.turnOffset || 0;
    return team?.players[(team.nextPlayer + offset) % Math.max(1, team.players.length)] || "Player";
  }

  function currentRoundCard() {
    const round = state.round;
    const question = questionById(round?.questionId);
    if (!round || !question) return `<section class="card"><div class="eyebrow">Something went wrong</div><h2>Question missing</h2><p class="subtle">Select a new question from the deck.</p></section>`;
    const phaseInfo = {
      faceoff: `Faceoff · ${faceoffPlayer(0)} vs ${faceoffPlayer(1)}. Decide who had the best first answer.`,
      play_choice: `${escapeHTML(teamName(round.faceoffTeam))} won the faceoff. Will they play or pass?`,
      play: `${escapeHTML(teamName(round.controllingTeam))} is playing · ${escapeHTML(turnPlayer(round.controllingTeam))} up next · ${round.pot} points in the pot.`,
      steal: `${escapeHTML(teamName(1 - round.controllingTeam))} is stealing · ${escapeHTML(turnPlayer(1 - round.controllingTeam))} up next · reveal a match to take the pot.`,
      complete: `${escapeHTML(teamName(round.winner))} wins the round · +${round.awarded} points.`
    }[round.phase];
    let controls = "";
    if (round.phase === "faceoff") controls = `<div class="play-actions"><button class="button gold" data-action="play-buzzer">🔊 Face-off buzzer</button><button class="button primary" data-action="faceoff-win" data-team="0">${escapeHTML(teamName(0))} wins faceoff</button><button class="button cyan" data-action="faceoff-win" data-team="1">${escapeHTML(teamName(1))} wins faceoff</button></div>`;
    if (round.phase === "play_choice") controls = `<div class="play-actions"><button class="button good" data-action="play">▶ Play</button><button class="button gold" data-action="pass">⇢ Pass</button></div>`;
    const answerCards = question.answers.map((answer, index) => {
      const shown = round.revealed.includes(index);
      const canReveal = ["play", "steal"].includes(round.phase) && !shown;
      return `<button class="answer-control ${shown ? "revealed" : "host-answer-hidden"}" ${canReveal ? `data-action="reveal" data-answer="${index}"` : "disabled"}>
        <span class="answer-num">${index + 1}</span><span class="answer-caption">${escapeHTML(answer.text)}</span><span class="answer-score">${answer.score}</span></button>`;
    }).join("");
    if (round.phase === "play") controls = `<div class="play-actions"><button class="button danger" data-action="strike">✕ Strike <span class="strike-row">${[0,1,2].map((x) => `<span class="strike-x ${x < round.strikes ? "active" : ""}">X</span>`).join("")}</span></button><button class="button small" data-action="end-round">Award current pot</button></div>`;
    if (round.phase === "steal") controls = `<div class="play-actions"><button class="button danger" data-action="steal-fail">Steal fails · original team keeps the pot</button><span class="pill">Auto adjudication in <b id="steal-countdown">8</b>s</span></div>`;
    if (round.phase === "complete") controls = `<div class="play-actions"><button class="button primary" data-action="next-round">Set up the next round</button><button class="button gold" data-action="end-game">End rounds & play Fast Money</button></div>`;
    return `<section class="card"><div class="round-question"><div class="eyebrow">Question ${round.number} · ${escapeHTML(question.category || "party brain")} · ${escapeHTML(question.scoreLabel || "Fictional party poll · for fun")}</div><div class="question-text">${escapeHTML(question.question)}</div></div>
      <div class="phase-banner"><span class="phase-text">${phaseInfo}</span><span class="pill">Board ${round.revealed.length}/${question.answers.length} · Pot ${round.pot} · ×${round.multiplier}</span></div>
      ${round.phase !== "faceoff" && round.phase !== "play_choice" ? `<div class="answer-list">${answerCards}</div>` : `<div class="setup-reminder">The faceoff answer is spoken aloud. Pick the winning side above; the board opens when play begins.</div>`}
      ${controls}${round.phase !== "complete" ? `<div class="play-actions"><button class="button small" data-action="skip-question">Skip question</button></div>` : ""}<div class="host-help">This host screen shows the full answer key. Tap a matching answer to reveal it on the TV. Hotkeys: <kbd>Y</kbd> play, <kbd>P</kbd> pass, <kbd>X</kbd> strike, <kbd>R</kbd> reveal next.</div>
    </section>`;
  }

  function historyCard() {
    const rows = state.rounds.slice().reverse().map((round) => `<div class="history-row"><span>Round ${round.number} · ${round.multiplier === 1 ? "Standard" : round.multiplier === 2 ? "Double" : "Triple"}</span><b>${escapeHTML(teamName(round.winner))} +${round.awarded}</b></div>`).join("");
    return `<section class="card"><div class="section-head"><div><div class="eyebrow">Scoreboard</div><h3>Round recap</h3></div><span class="pill">${state.rounds.length} played</span></div>${rows || `<div class="subtle">Round results will land here.</div>`}</section>`;
  }

  function editorCard() {
    const selected = questionById(selectedQuestionId) || bank[0];
    if (!selected) return `<section class="card"><h3>Question deck</h3><p class="subtle">No questions yet. Import a deck or add your first one.</p><button class="button primary" data-action="add-question">Add a question</button></section>`;
    selectedQuestionId = selected.id;
    const answerLines = selected.answers.map((answer) => `${answer.text} | ${answer.score} | ${(answer.synonyms || []).join(", ")}`).join("\n");
    return `<details class="card question-tools" id="question-editor"><summary>Edit and shuffle questions</summary><div class="section-head" style="margin-top:16px"><div><div class="eyebrow">Host only</div><h3>Question deck</h3></div><span class="pill">${bank.length} prompts</span></div>
      <div class="field"><label for="edit-question-id">Choose a question</label><select id="edit-question-id" class="select">${bank.map((q) => `<option value="${escapeHTML(q.id)}" ${q.id === selected.id ? "selected" : ""}>${escapeHTML(q.question.slice(0,72))}</option>`).join("")}</select></div>
      <div class="field"><label for="edit-question">Question prompt</label><textarea id="edit-question" class="text-area" rows="3">${escapeHTML(selected.question)}</textarea></div>
      <div class="field"><label for="edit-answers">Answers · one per line</label><textarea id="edit-answers" class="text-area" rows="8" spellcheck="false">${escapeHTML(answerLines)}</textarea></div>
      <div class="subtle editor-note">Format: answer | points | accepted synonyms. Use 5–8 answers totaling 100. Each question keeps its source label, so crowd-sample boards stay distinct from fictional party-poll boards.</div>
      <div class="utility-row"><button class="button primary small" data-action="save-question">Save edits</button><button class="button small" data-action="add-question">Add question</button><button class="button small" data-action="export-bank">Export deck</button><button class="button small" data-action="import-bank">Import deck</button><input id="bank-file" type="file" accept="application/json,.json" hidden></div>
    </details>`;
  }

  function fastMoneySetup() {
    const leader = state.teams.reduce((best, team, i, teams) => team.score > teams[best].score ? i : best, 0);
    const teamOptions = state.teams.map((team, i) => `<option value="${i}" ${i === leader ? "selected" : ""}>${escapeHTML(team.name)}</option>`).join("");
    const optionsFor = (teamIndex) => state.teams[teamIndex].players.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
    return `<section class="card"><div class="eyebrow">Finale</div><h2>Fast Money</h2><p class="subtle">Choose two players from the winning team. Each answers the same five prompts. The first player gets 20 seconds; the second gets 25. Responses stay on the host screen until the reveal.</p>
      <div class="field"><label for="fm-winning-team">Winning team</label><select id="fm-winning-team" class="select">${teamOptions}</select></div>
      <div class="setup-teams"><div class="field"><label for="fm-player-0">First contestant</label><select id="fm-player-0" class="select"></select></div><div class="field"><label for="fm-player-1">Second contestant</label><select id="fm-player-1" class="select"></select></div></div>
      <button class="button gold" data-action="start-fast-money">Start Fast Money</button>
      <div class="host-help">Responses are automatically matched against board answers and accepted synonyms. You can adjust any score before the final reveal. Duplicate answers from contestant one score zero for contestant two.</div>
    </section>`;
  }

  function renderFastMoneySetupAfterPaint() {
    const winning = document.getElementById("fm-winning-team");
    if (!winning) return;
    const updateContestants = () => {
      const names = state.teams[Number(winning.value)].players;
      [0, 1].forEach((index) => {
        const select = document.getElementById(`fm-player-${index}`);
        const old = select.value;
        select.innerHTML = names.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
        if (names.includes(old)) select.value = old;
        else if (index === 1 && names.length > 1) select.selectedIndex = 1;
      });
    };
    winning.addEventListener("change", updateContestants);
    updateContestants();
  }

  function fastMoneyTurn() {
    const fm = state.fastMoney;
    const question = questionById(fm.questionIds[fm.index]);
    const time = fm.turn === 0 ? 20 : 25;
    const saved = fm.responses[fm.turn][fm.index] || "";
    const dots = Array.from({ length: 5 }, (_, i) => `<span class="fm-dot ${i < fm.index ? "done" : ""} ${i === fm.index ? "current" : ""}"></span>`).join("");
    const timerActive = Boolean(fm.timerUntil);
    const finish = fm.index === 4;
    return `<section class="card"><div class="section-head"><div><div class="eyebrow">Fast Money · contestant ${fm.turn + 1}</div><h2>${escapeHTML(fm.contestants[fm.turn])}</h2><div class="subtle">${fm.turn === 0 ? "20-second round" : "25-second round · try not to repeat earlier answers"}</div></div><div class="timer" id="timer-display">${timerActive ? Math.max(0, Math.ceil((fm.timerUntil - Date.now()) / 1000)) : `${time}s`}</div></div>
      <div class="fm-progress">${dots}</div><div class="round-question"><div class="eyebrow">Prompt ${fm.index + 1} of 5</div><div class="question-text">${escapeHTML(question.question)}</div></div>
      <div class="field"><label for="fm-current-response">Their answer · host view only</label><textarea id="fm-current-response" class="text-area fm-response" autocomplete="off" placeholder="Type what they said…">${escapeHTML(saved)}</textarea></div>
      <div class="play-actions">${fm.index > 0 ? `<button class="button small" data-action="fm-back">← Previous</button>` : ""}${finish ? `<button class="button gold" data-action="fm-submit">Finish contestant ${fm.turn + 1}</button>` : `<button class="button primary" data-action="fm-next">Save & next →</button>`}${timerActive ? `<button class="button small" data-action="fm-stop-timer">Stop clock</button>` : `<button class="button small" data-action="fm-start-timer">Start ${time}s clock</button>`}</div>
      <div class="host-help">Enter each answer as it is given. Advancing saves automatically. When time is up, the contestant’s round submits and the next one is ready.</div>
    </section>`;
  }

  function fastMoneyReview() {
    const fm = state.fastMoney;
    const scoreSheets = [0, 1].map((turn) => {
      const rows = fm.questionIds.map((id, index) => {
        const question = questionById(id);
        const response = fm.responses[turn][index];
        let score = ENGINE.scoreAnswer(question, response);
        if (turn === 1 && response && fm.responses[0].some((first) => ENGINE.normalizeAnswer(first) === ENGINE.normalizeAnswer(response))) score = 0;
        const match = question.answers.find((answer) => ENGINE.scoreAnswer({ ...question, answers: [answer] }, response) > 0);
        return `<div class="review-row"><span><b>Q${index + 1}</b> ${escapeHTML(question.question)}</span><span>“${escapeHTML(response || "No answer") }”${match ? `<br><span class="subtle">Matched: ${escapeHTML(match.text)}</span>` : `<br><span class="subtle">No automatic match</span>`}</span><span class="subtle">${escapeHTML(fm.contestants[turn])}</span><label class="label">Points<input class="text-input score-override" type="number" min="0" max="100" value="${score}" data-turn="${turn}" data-index="${index}"></label></div>`;
      }).join("");
      return `<div class="card"><div class="eyebrow">Contestant ${turn + 1}</div><h3>${escapeHTML(fm.contestants[turn])}</h3>${rows}<div class="subtle" style="margin-top:12px">Subtotal: <b id="subtotal-${turn}">0</b></div></div>`;
    }).join("");
    return `<section class="stack"><section class="card"><div class="eyebrow">Score check</div><h2>Fast Money reveal</h2><p class="subtle">Automatic matches compare answers with the fictional example board. Adjust any score by hand, including a synonym or a close call, then reveal the combined total on the TV.</p><div class="pill">Target: 200 points</div></section>${scoreSheets}<button class="button gold wide" data-action="finalize-fast-money">Reveal Fast Money total</button></section>`;
  }

  function finishedCard() {
    const total = state.fastMoney.scores.flat().reduce((sum, score) => sum + (Number(score) || 0), 0);
    return `<section class="card"><div class="winner-callout"><div class="eyebrow">Fast Money is in</div><strong>${total >= 200 ? "200!" : `${total} points`}</strong><p>${total >= 200 ? "The party-poll target has been hit. You have a Friends Full House champion!" : "A great finish. Reveal the final total on the TV."}</p></div><div class="play-actions"><button class="button primary" data-action="new-game">Start a new game</button></div></section>`;
  }

  function partySettingsCard() {
    const themes = [
      ["amber", "Amber Glow", "#ffcc58", "#f64e9b"],
      ["peacock", "Peacock Neon", "#55efd2", "#6d7dff"],
      ["pink-glow", "Pink Spotlight", "#ff5dbb", "#ffd45e"],
      ["midnight-citrus", "Citrus Midnight", "#c2ff4c", "#ff9b49"],
    ];
    return `<section class="card stage-settings"><div class="eyebrow">Dim-room stage lights</div><h3>Stage colors</h3><p class="subtle">Pick a glow from your host screen. The TV changes with it.</p><div class="theme-picker">${themes.map(([id, label, first, second]) => `<button class="theme-choice ${activeTheme() === id ? "selected" : ""}" data-action="set-theme" data-theme="${id}" aria-pressed="${activeTheme() === id}"><span class="theme-dots"><i style="--swatch:${first}"></i><i style="--swatch:${second}"></i></span><span>${label}</span></button>`).join("")}</div></section>`;
  }

  function renderHost() {
    let main = "";
    if (state.game === "setup") main = renderSetup();
    if (state.game === "live") main = `${scoreStrip()}${state.round && state.round.phase !== "complete" ? currentRoundCard() : state.round?.phase === "complete" ? `${currentRoundCard()}` : setupRoundCard()}`;
    if (state.game === "fast_money" && !state.fastMoney) main = fastMoneySetup();
    if (state.game === "fast_money" && state.fastMoney && !state.fastMoney.submitted.every(Boolean)) main = fastMoneyTurn();
    if (state.game === "fast_money" && state.fastMoney?.submitted.every(Boolean)) main = fastMoneyReview();
    if (state.game === "finished") main = finishedCard();
    const roomControls = isRemote && remoteRoom ? `<span class="pill room-pill">ROOM <b>${escapeHTML(remoteRoom)}</b></span><button class="button" data-action="copy-tv-link">Copy TV link</button><a class="button" href="${escapeHTML(openTVLink())}" target="_blank" rel="noreferrer">Open TV view ↗</a>` : `<button class="button" data-action="open-tv">Open TV display ↗</button>`;
    const rosterControl = state.game === "live" ? `<button class="button gold" data-action="manage-roster">Manage teams &amp; players</button>` : "";
    app.innerHTML = `<main class="host-app theme-${activeTheme()}">
      <header class="host-header"><div class="header-brand"><div class="brand-chip">FH</div><div><div class="logo">Friends <span>Full House</span></div><small class="brand-tagline">Two-screen party game · big guesses, good company</small></div></div><div class="header-actions"><span class="pill"><i class="dot"></i> ${isRemote ? "Online · synced" : "Local game · synced"}</span>${rosterControl}${roomControls}${state.game !== "setup" ? `<button class="button small" data-action="new-game">New game</button>` : ""}</div></header>
      <div class="host-grid"><div class="stack">${main}</div><aside class="stack">${state.game === "live" ? historyCard() : `<section class="card"><div class="eyebrow">Your game, your rules</div><h3>Host quick guide</h3><div class="host-help">1. Open the TV view on the TV and enter room code <b>${isRemote ? escapeHTML(remoteRoom) : ""}</b>.<br>2. Start a round, call two rotating players to face off, and choose who plays.<br>3. Tap correct answers as they’re guessed. Tap Strike for a miss.<br>4. At three strikes, the other team gets one steal attempt.<br>5. End the rounds whenever you like and run Fast Money.</div></section>`}${partySettingsCard()}${editorCard()}<section class="card"><div class="eyebrow">Made for your game night</div><h3>Synthesized sound cues</h3><p class="subtle">Optional short synthesized tones mark face-offs, reveals, strikes, and round results. Enable them on the audience screen; use its volume or mute control.</p><div class="host-help">The host screen keeps the full answer key private. The audience screen receives only answers after you reveal them.</div></section></aside></div>${renderRosterModal()}<div class="alert"></div></main>`;
    renderFastMoneySetupAfterPaint();
    if (state.game === "fast_money" && state.fastMoney?.submitted.every(Boolean)) updateReviewSubtotals();
  }

  function tvScoreboard() {
    return `<div class="tv-scoreboard">${state.teams.map((team, index) => `<div class="tv-team ${index ? "t2" : ""}"><span class="team-name">${escapeHTML(team.name)}</span><span class="team-score">${team.score}</span></div>`).join(`<div class="tv-vs">VS</div>`)}</div>`;
  }

  function tvBoard(question, round) {
    return `<div class="tv-board">${question.answers.map((answer, index) => {
      const shown = round.revealed.includes(index);
      return `<div class="tv-answer ${shown ? "revealed" : "hidden"}"><span class="number">${index + 1}</span><span class="answer-text">${shown ? escapeHTML(answer.text) : "? ? ?"}</span><span class="points">${shown ? answer.score : ""}</span></div>`;
    }).join("")}</div>`;
  }

  function stateChip(round) {
    const labels = {
      faceoff: `FACE OFF · ${faceoffPlayer(0)} VS ${faceoffPlayer(1)}`,
      play_choice: `${teamName(round.faceoffTeam)} · PLAY OR PASS?`,
      play: `${teamName(round.controllingTeam)} · ${turnPlayer(round.controllingTeam)} TO GUESS · ${round.pot} POINTS`,
      steal: `${teamName(1 - round.controllingTeam)} · ${turnPlayer(1 - round.controllingTeam)} TO STEAL`,
      complete: `${teamName(round.winner)} WINS THE ROUND · +${round.awarded}`
    };
    return labels[round.phase] || "LET’S PLAY";
  }

    function tvHomeWelcomeMarkup() {
    return `<section class="tv-idle tv-home-welcome"><div class="tv-home-copy"><div class="eyebrow">A two-screen party game</div><h1>Friends<br>Full House</h1><p>Two teams, a shared answer board, and plenty of room for unexpected guesses.</p><div class="start-cue">HOST CONTROLS ON A SECOND SCREEN</div></div></section>`;
  }

  function renderTV() {
    let middle = "";
    if (state.game === "setup") middle = tvHomeWelcomeMarkup();
    if (state.game === "live") {
      if (!state.round) middle = `<div class="tv-main">${tvScoreboard()}<section class="tv-idle"><div class="eyebrow">The game is on</div><h1>Let’s<br>Play</h1><p>Host is drawing the first question…</p></section></div>`;
      else {
        const round = state.round;
        const question = questionById(round.questionId);
        if (question) {
          middle = `<div class="tv-main">${tvScoreboard()}<div class="tv-roundline"><span>ROUND ${round.number}</span><span class="tv-mult">${round.multiplier === 1 ? "STANDARD" : round.multiplier === 2 ? "DOUBLE POINTS" : "TRIPLE POINTS"}</span><span>${escapeHTML(question.scoreLabel || "Fictional party poll · for fun")}</span>${round.strikes ? `<div class="tv-strikes">${[0,1,2].map((i) => `<span class="${i < round.strikes ? "on" : ""}">X</span>`).join("")}</div>` : ""}${round.phase === "steal" ? `<span class="tv-steal-countdown"><b>STEAL</b><span id="tv-steal-clock">8</span><i>s</i></span>` : ""}</div><section class="tv-question"><span class="survey-title">Answer board</span><p>${escapeHTML(question.question)}</p></section>${tvBoard(question, round)}<div class="tv-state"><span class="state-chip">${escapeHTML(stateChip(round))}</span></div></div>`;
        }
      }
    }
    if (state.game === "fast_money" && !state.fastMoney) middle = `<div class="tv-main">${tvScoreboard()}<section class="tv-idle"><div class="eyebrow">Finale time</div><h1>Fast<br>Money</h1><p>Two teammates. Five quick questions each. Can they reach 200?</p></section></div>`;
    if ((state.game === "fast_money" || state.game === "finished") && state.fastMoney) {
      const fm = state.fastMoney;
      const q = questionById(fm.questionIds[fm.index]);
      const allDone = fm.submitted.every(Boolean);
      if (!allDone) middle = `<div class="tv-main">${tvScoreboard()}<section class="tv-fastmoney"><div class="fm-title">Fast Money</div><div class="fm-person">${escapeHTML(fm.contestants[fm.turn])}</div><div class="fm-count">${fm.turn === 0 ? "First player · 20 seconds" : "Second player · 25 seconds"}${fm.timerUntil ? ` · <span id="tv-fast-timer">${Math.max(0, Math.ceil((fm.timerUntil - Date.now()) / 1000))}</span>` : ""}</div><div class="fm-question">${escapeHTML(q.question)}</div><div class="fm-count">Prompt ${fm.index + 1} of 5 · answers reveal after both turns</div></section></div>`;
      else {
        const total = fm.scores.flat().reduce((sum, score) => sum + (Number(score) || 0), 0);
        const finaleMessage = total >= 200
          ? `${fm.contestants[0]} and ${fm.contestants[1]} hit the 200-point target and take the crown!`
          : `${teamName(fm.winningTeam)} brings home bragging rights!`;
        const confetti = Array.from({ length: 28 }, (_, i) => `<i class="confetti" style="left:${(i * 17 + 3) % 100}%;background:${["#ffbf3f","#49baff","#fff0a0","#68d3ff","#70f0b1"][i % 5]};animation-delay:-${(i % 11) / 2}s"></i>`).join("");
        middle = `<div class="tv-main">${tvScoreboard()}<section class="tv-winner">${confetti}<div class="eyebrow">Fast Money · final score</div><h1>${total >= 200 ? "200!" : `${total} points`}</h1><p>${escapeHTML(finaleMessage)}</p><div class="tv-fastmoney" style="margin-top:2vh"><div class="fm-title" style="font-size:clamp(1.2rem,2.5vw,2rem)">The answers are in</div>${fm.questionIds.map((id, i) => `<div class="history-row"><span>${i + 1}. ${escapeHTML(questionById(id).question)}</span><b>${fm.scores[0][i]} + ${fm.scores[1][i]} = ${Number(fm.scores[0][i]) + Number(fm.scores[1][i])}</b></div>`).join("")}<div class="fm-person">${escapeHTML(fm.contestants[0])}: ${fm.scores[0].reduce((a,b) => a + Number(b),0)} · ${escapeHTML(fm.contestants[1])}: ${fm.scores[1].reduce((a,b) => a + Number(b),0)}</div></div></section></div>`;
      }
    }
    if (state.game === "finished" && !state.fastMoney?.submitted.every(Boolean)) middle = `<section class="tv-idle"><h1>Friends<br>Full House</h1><p>Thanks for playing!</p></section>`;
    const view = `<main class="tv-screen theme-${activeTheme()}"><div class="stage-light"></div><header class="tv-topbar"><div class="tv-logo">Friends <span>Full House</span><small>PARTY GAME</small></div><div class="tv-tools"><button class="sound-toggle" data-action="toggle-mute">${soundMuted ? "🔇 Unmute" : "🔊 Mute"}</button><button class="sound-toggle" data-action="test-buzzer">Test sound</button><input class="volume" type="range" min="0" max="100" value="${Math.round(desiredVolume * 100)}" aria-label="Sound effects volume"><button class="sound-toggle" data-action="fullscreen">⛶ Full screen</button></div></header>${middle}<footer class="tv-footer"><span><b>FRIENDS FULL HOUSE</b> · A PARTY GAME PROTOTYPE</span><span>Fictional points · for fun</span></footer>${!soundReady ? `<div class="sound-gate"><div class="sound-gate-card"><div class="eyebrow">Optional sound effects</div><h2 class="logo" style="margin:12px 0 18px">Enable synthesized cues?</h2><p>The TV can play brief original tones for reveals and game events. You can continue quietly.</p><button class="button primary" data-action="enable-sound">Enable sound effects</button><button class="button" data-action="continue-muted">Continue muted</button></div></div>` : ""}</main>`;
    app.innerHTML = view;
    updateTVCountdowns();
  }

  function handleInput(event) {
    if (isTV) {
      if (event.target.classList.contains("volume")) setVolume(Number(event.target.value) / 100);
      return;
    }
    if (event.target.matches(".team-name-input, .player-name-input")) {
      const teams = readRosterFields(state.game === "setup" ? state.teams : rosterDraft || state.teams);
      if (state.game === "setup") { state.teams = teams; publish({ repaint: false }); }
      else if (rosterEditorOpen) rosterDraft = teams;
      updateRosterCount(teams);
      return;
    }
    if (event.target.id === "fm-current-response" && state.fastMoney) {
      commit("FAST_MONEY_RESPONSE", { turn: state.fastMoney.turn, index: state.fastMoney.index, response: event.target.value }, { repaint: false });
      return;
    }
    if (event.target.classList.contains("score-override")) updateReviewSubtotals();
  }

  function handleChange(event) {
    if (isTV) return;
    if (event.target.id === "edit-question-id") {
      selectedQuestionId = event.target.value;
      paint();
    }
    if (event.target.id === "bank-file" && event.target.files?.[0]) importBank(event.target.files[0]);
  }

  function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (isTV) return handleTVAction(action);
    switch (action) {
      case "set-theme":
        if (themeChoices.includes(button.dataset.theme)) { state = { ...state, theme: button.dataset.theme }; publish(); }
        break;
      case "start-game": startGame(); break;
      case "add-player": addRosterPlayer(Number(button.dataset.team)); break;
      case "remove-player": removeRosterPlayer(Number(button.dataset.team), Number(button.dataset.player)); break;
      case "manage-roster": rosterDraft = state.teams.map((team) => ({ ...team, players: team.players.slice() })); rosterEditorOpen = true; paint(); break;
      case "close-roster": rosterEditorOpen = false; rosterDraft = null; paint(); break;
      case "save-roster": saveRoster(); break;
      case "open-tv": window.open(new URL("tv.html", location.href).href, "friends-full-house-tv", "popup,width=1400,height=820,resizable=yes"); break;
      case "copy-tv-link": copyTVLink(); break;
      case "start-round": startRound(); break;
      case "skip-question": skipQuestion(); break;
      case "play-buzzer": commit("PLAY_BUZZER"); break;
      case "faceoff-win": commit("FACE_OFF_WINNER", { team: Number(button.dataset.team) }); break;
      case "play": commit("CHOOSE_PLAY"); break;
      case "pass": commit("CHOOSE_PASS"); break;
      case "reveal": reveal(Number(button.dataset.answer)); break;
      case "strike": commit("STRIKE"); break;
      case "steal-fail": commit("STEAL_FAIL"); notify("Steal failed — the original team keeps the pot."); break;
      case "end-round": commit("END_ROUND"); break;
      case "next-round": commit("NEXT_ROUND"); window.scrollTo({ top: 0, behavior: "smooth" }); break;
      case "end-game": commit("END_GAME"); break;
      case "start-fast-money": startFastMoney(); break;
      case "fm-back": saveCurrentResponse(); commit("FAST_MONEY_BACK"); break;
      case "fm-next": saveCurrentResponse(); commit("FAST_MONEY_NEXT"); break;
      case "fm-submit": saveCurrentResponse(); submitFastMoneyTurn(); break;
      case "fm-start-timer": startFastMoneyTimer(); break;
      case "fm-stop-timer": commit("FAST_MONEY_TIMER_STOP"); notify("Clock stopped."); break;
      case "finalize-fast-money": finalizeFastMoney(); break;
      case "new-game": newGame(); break;
      case "save-question": saveQuestionEdits(); break;
      case "add-question": addQuestion(); break;
      case "export-bank": exportBank(); break;
      case "import-bank": document.getElementById("bank-file")?.click(); break;
    }
  }

  function makeHostKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function hostKeyFor(room) { return localStorage.getItem(`friends-full-house-host-${room}`) || ""; }

  async function initializeRemoteHost() {
    let room = remoteRoom;
    if (!room) {
      const savedRoom = localStorage.getItem("friends-full-house-current-room");
      const forceNew = new URLSearchParams(location.search).get("new") === "1";
      if (!forceNew && savedRoom && hostKeyFor(savedRoom)) {
        location.replace(`${location.pathname}?room=${encodeURIComponent(savedRoom)}`);
        return false;
      }
      const key = makeHostKey();
      const response = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostKey: key }) });
      if (!response.ok) { renderRemoteProblem("The online game room could not be created. Check your connection and reload."); return false; }
      const result = await response.json();
      room = result.room;
      localStorage.setItem(`friends-full-house-host-${room}`, key);
      localStorage.setItem("friends-full-house-current-room", room);
      location.replace(`${location.pathname}?room=${encodeURIComponent(room)}`);
      return false;
    }
    remoteHostKey = hostKeyFor(room);
    if (!remoteHostKey) { renderRemoteProblem("This room belongs to the host host screen that created it. Open the host link on that host screen."); return false; }
    const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/host`, { headers: { authorization: `Bearer ${remoteHostKey}` }, cache: "no-store" });
    if (!response.ok) { renderRemoteProblem("This host room has expired or is unavailable. Open the host page to start a fresh room."); return false; }
    const saved = await response.json();
    state = { theme: "amber", ...saved.state };
    bank = saved.bank;
    if (needsDeckUpgrade(bank)) {
      try {
        const defaults = await fetch("/questions.json", { cache: "no-store" }).then((result) => result.json());
        if (Array.isArray(defaults) && defaults.length === 30) { bank = defaults; scheduleRemoteSave(); }
      } catch (_) { /* keep the room's saved deck if the bundled deck cannot load */ }
    }
    selectedQuestionId = bank[0]?.id || "";
    return true;
  }

  function renderRemoteProblem(message) {
    app.innerHTML = `<main class="host-app"><section class="card"><div class="eyebrow">Private host control</div><h2>Friends Full House</h2><p class="subtle">${escapeHTML(message)}</p><a class="button primary link-button" href="/host.html?new=1">Start a new host room</a></section></main>`;
  }

  function scheduleRemoteSave() {
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(() => {
      const body = JSON.stringify({ state, bank });
      remoteWriteChain = remoteWriteChain.then(async () => {
        const response = await fetch(`/api/rooms/${encodeURIComponent(remoteRoom)}/host`, {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${remoteHostKey}` },
          body
        });
        if (!response.ok) throw new Error("save failed");
      }).catch(() => notify("Connection interrupted. Your last move may not have synced yet."));
    }, 180);
  }

  async function refreshRemoteTV() {
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(remoteRoom)}/tv`, { cache: "no-store" });
      if (!response.ok) return;
      const snapshot = await response.json();
      const signature = JSON.stringify([snapshot.state, snapshot.bank]);
      if (signature === remoteSignature) return;
      const old = state;
      state = { theme: "amber", ...snapshot.state };
      bank = snapshot.bank;
      remoteSignature = signature;
      soundForChange(old, state);
      paint();
    } catch (_) { /* polling resumes when the network is available */ }
  }

  function startRemoteTVSync() {
    refreshRemoteTV();
    remotePollTimer = setInterval(refreshRemoteTV, 850);
  }

  function openTVLink() {
    const url = new URL("/tv.html", location.origin);
    if (isRemote && remoteRoom) url.searchParams.set("room", remoteRoom);
    return url.href;
  }

  async function copyTVLink() {
    const url = openTVLink();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      notify("TV link copied. Enter the room code on the TV.");
    } catch (_) { notify(`TV: ${url}`); }
  }

  function startGame() {
    const draft = readRosterFields(state.teams);
    const { total, lists, ready, unique } = rosterStatus(draft);
    if (!unique) return notify("Each participant needs a unique name.");
    if (!ready) return notify(`Use 9–16 participants total, with 4–8 on each team. You have ${total}.`);
    const teams = draft.map((team, index) => ({ name: team.name.trim() || `Team ${index + 1}`, players: lists[index] }));
    state = ENGINE.transition(state, { type: "SET_TEAMS", teams });
    state = ENGINE.transition(state, { type: "START_GAME" });
    state.questionOrder = ENGINE.shuffleQuestionIds(bank);
    publish();
  }

  function startRound() {
    if (!bank.length) return notify("Add a question before starting the round.");
    const validIds = new Set(bank.map((question) => question.id));
    const currentOrder = Array.isArray(state.questionOrder) ? state.questionOrder : [];
    if (currentOrder.length !== bank.length || new Set(currentOrder).size !== bank.length || currentOrder.some((id) => !validIds.has(id))) {
      state.questionOrder = ENGINE.shuffleQuestionIds(bank);
    }
    const questionId = ENGINE.nextUnusedQuestion(state, bank);
    if (!questionId) return notify("All questions have been used. Start a new game for a fresh deck.");
    const multiplier = Number(document.getElementById("round-multiplier")?.value || 1);
    commit("START_ROUND", { questionId, multiplier });
  }

  function skipQuestion() {
    if (!state.round || state.round.phase === "complete") return;
    const questionId = ENGINE.nextUnusedQuestion(state, bank);
    if (!questionId) return notify("No unused questions remain. Finish this round or start a new game.");
    if (!window.confirm("Skip this question? Its pot and strikes will clear, and neither team scores.")) return;
    commit("SKIP_QUESTION", { questionId });
    notify("Fresh question ready. Scores are unchanged.");
  }

  function reveal(index) {
    const q = questionById(state.round?.questionId);
    if (!q) return;
    const complete = q.answers.every((_, i) => state.round.revealed.includes(i) || i === index);
    commit("REVEAL_ANSWER", { answerIndex: index, score: q.answers[index].score, boardComplete: complete });
  }

  function newGame() {
    state = ENGINE.initialState(state.teams.map((team) => ({ ...team, score: 0 })));
    publish();
  }

  function addQuestion() {
    const id = `party-poll-${Date.now()}`;
    bank.push({ id, question: "Write your new party question here", answers: [
      { text: "Answer one", score: 30, synonyms: [] }, { text: "Answer two", score: 25, synonyms: [] },
      { text: "Answer three", score: 20, synonyms: [] }, { text: "Answer four", score: 15, synonyms: [] }, { text: "Answer five", score: 10, synonyms: [] }
    ] });
    selectedQuestionId = id;
    saveBank();
    document.getElementById("question-editor")?.setAttribute("open", "");
  }

  function saveQuestionEdits() {
    const question = document.getElementById("edit-question")?.value.trim();
    const rawLines = document.getElementById("edit-answers")?.value.split("\n").map((line) => line.trim()).filter(Boolean) || [];
    const answers = rawLines.map((line) => {
      const [text, score, synonyms = ""] = line.split("|").map((part) => part.trim());
      return { text, score: Number(score), synonyms: synonyms.split(",").map((word) => word.trim()).filter(Boolean) };
    });
    if (!question) return notify("Add a question prompt first.");
    if (answers.length < 5 || answers.length > 8 || answers.some((answer) => !answer.text || !Number.isFinite(answer.score) || answer.score < 0)) return notify("Use 5–8 answers, each with a name and point value.");
    if (answers.reduce((sum, answer) => sum + answer.score, 0) !== 100) return notify("The answer scores must add up to exactly 100.");
    const existing = questionById(selectedQuestionId);
    if (!existing) return;
    const updated = { ...existing, question, answers };
    bank = bank.map((item) => item.id === existing.id ? updated : item);
    saveBank();
    notify("Question saved and synced to the TV.");
  }

  function exportBank() {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(bank, null, 2)], { type: "application/json" }));
    link.download = "friends-full-house-party-poll.json";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function importBank(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const good = Array.isArray(parsed) && parsed.every((q) => q.id && q.question && Array.isArray(q.answers) && q.answers.length >= 5 && q.answers.length <= 8 && q.answers.reduce((sum, answer) => sum + Number(answer.score), 0) === 100);
      if (!good) throw new Error("format");
      bank = parsed;
      selectedQuestionId = bank[0]?.id || "";
      saveBank();
      notify(`Imported ${bank.length} questions.`);
    } catch (_) { notify("That file is not a valid party-poll deck (each question needs 5–8 answers totaling 100). "); }
  }

  function startFastMoney() {
    const winningTeam = Number(document.getElementById("fm-winning-team").value);
    const contestants = [document.getElementById("fm-player-0").value, document.getElementById("fm-player-1").value];
    if (!contestants[0] || !contestants[1] || contestants[0] === contestants[1]) return notify("Choose two different contestants.");
    const questions = ENGINE.shuffleQuestionIds(bank.filter((q) => !state.usedQuestionIds.includes(q.id))).slice(0, 5).map(questionById).filter(Boolean);
    if (questions.length < 5) return notify("Fast Money needs at least five questions in the deck.");
    commit("START_FAST_MONEY", { winningTeam, contestants, questionIds: questions.map((q) => q.id) });
  }

  function saveCurrentResponse() {
    const input = document.getElementById("fm-current-response");
    if (input && state.fastMoney) commit("FAST_MONEY_RESPONSE", { turn: state.fastMoney.turn, index: state.fastMoney.index, response: input.value }, { repaint: false });
  }

  function submitFastMoneyTurn() {
    const finishedFirst = state.fastMoney.turn === 0;
    commit("FAST_MONEY_SUBMIT");
    notify(finishedFirst ? "First player locked in. Bring up contestant two." : "All answers locked. Check the score sheet before reveal.");
  }

  function startFastMoneyTimer() {
    const limit = state.fastMoney.turn === 0 ? 20 : 25;
    commit("FAST_MONEY_TIMER_SET", { until: Date.now() + limit * 1000, limit });
    notify(`${limit}-second clock started.`);
  }

  function finalizeFastMoney() {
    const fm = state.fastMoney;
    const scores = [0, 1].map((turn) => fm.questionIds.map((_, index) => {
      const input = document.querySelector(`.score-override[data-turn="${turn}"][data-index="${index}"]`);
      return Math.max(0, Math.min(100, Number(input?.value || 0)));
    }));
    commit("FAST_MONEY_FINALIZE", { scores });
  }

  function updateReviewSubtotals() {
    [0, 1].forEach((turn) => {
      const total = [...document.querySelectorAll(`.score-override[data-turn="${turn}"]`)].reduce((sum, input) => sum + Number(input.value || 0), 0);
      const el = document.getElementById(`subtotal-${turn}`);
      if (el) el.textContent = total;
    });
  }

  function startHostClock() {
    hostInterval = setInterval(() => {
      if (state.round?.phase === "steal" && state.round.stealUntil) {
        const remaining = Math.max(0, Math.ceil((state.round.stealUntil - Date.now()) / 1000));
        const counter = document.getElementById("steal-countdown");
        if (counter) counter.textContent = remaining;
        if (remaining === 0) {
          commit("STEAL_FAIL");
          notify("Time’s up! The original team keeps the pot.");
        }
      }
      if (state.fastMoney?.timerUntil) {
        const remaining = Math.max(0, Math.ceil((state.fastMoney.timerUntil - Date.now()) / 1000));
        const counter = document.getElementById("timer-display");
        if (counter) counter.textContent = `${remaining}s`;
        if (remaining === 0) {
          saveCurrentResponse();
          submitFastMoneyTurn();
          notify("Time’s up! Answers locked.");
        }
      }
    }, 150);
  }

  function handleKeydown(event) {
    if (isTV) {
      if (event.key.toLowerCase() === "f") toggleFullscreen();
      return;
    }
    if (event.target.matches("input,textarea,select") || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "y" && state.round?.phase === "play_choice") commit("CHOOSE_PLAY");
    if (key === "p" && state.round?.phase === "play_choice") commit("CHOOSE_PASS");
    if (key === "1" && state.round?.phase === "faceoff") commit("FACE_OFF_WINNER", { team: 0 });
    if (key === "2" && state.round?.phase === "faceoff") commit("FACE_OFF_WINNER", { team: 1 });
    if ((key === "x" || key === " ") && state.round?.phase === "play") { event.preventDefault(); commit("STRIKE"); }
    if (key === "r" && ["play", "steal"].includes(state.round?.phase)) {
      const question = questionById(state.round.questionId);
      const next = question.answers.findIndex((_, i) => !state.round.revealed.includes(i));
      if (next >= 0) reveal(next);
    }
  }

  function handleTVAction(action) {
    if (action === "join-room") {
      const code = document.getElementById("tv-room-code")?.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!code || code.length !== 6) return notify("Enter the six-character room code.");
      location.search = `?room=${encodeURIComponent(code)}`;
      return;
    }
    if (action === "enable-sound") { enableSound(); return; }
    if (action === "continue-muted") { soundMuted = true; soundReady = true; localStorage.setItem("full-house-muted", "yes"); paint(); return; }
    if (action === "toggle-mute") { soundMuted = !soundMuted; localStorage.setItem("full-house-muted", soundMuted ? "yes" : "no"); setVolume(desiredVolume); paint(); return; }
    if (action === "test-buzzer") { if (!audioContext) enableSound(); playBuzzer(); return; }
    if (action === "fullscreen") { toggleFullscreen(); return; }
  }

  function enableSound() {
    soundReady = true;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context && !audioContext) {
        audioContext = new Context();
        masterGain = audioContext.createGain();
        masterGain.gain.value = (soundMuted ? 0 : desiredVolume) * .35;
        masterGain.connect(audioContext.destination);
      }
      audioContext?.resume();
    } catch (_) { /* visual play remains available if audio is unavailable */ }
    paint();
  }

  function setVolume(value) {
    desiredVolume = Math.max(0, Math.min(1, Number(value) || 0));
    localStorage.setItem("full-house-volume", String(desiredVolume));
    if (masterGain && audioContext) masterGain.gain.setTargetAtTime((soundMuted ? 0 : desiredVolume) * .35, audioContext.currentTime, .04);
  }

  function tone(frequency, duration = .14, type = "sine", volume = .12, delay = 0) {
    if (!audioContext || !masterGain || soundMuted) return;
    const now = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, volume), now + .015);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start(now);
    oscillator.stop(now + duration + .02);
  }

  function playBuzzer() {
    [0, .16].forEach((delay) => {
      tone(440, .16, "square", .14, delay);
      tone(554.37, .16, "square", .12, delay);
    });
  }

  function playReveal() { tone(740, .11, "sine", .09); tone(988, .16, "sine", .07, .06); }
  function playStrike() { tone(185, .24, "triangle", .12); }
  function playRoundComplete() { tone(523, .16, "sine", .08); tone(659, .16, "sine", .08, .12); tone(784, .22, "sine", .08, .24); }

  function soundForChange(old, next) {
    if (!soundReady || !audioContext || soundMuted || !old) return;
    if ((old.buzzerNonce || 0) < (next.buzzerNonce || 0)) playBuzzer();
    else if ((old.round?.phase !== "complete" && next.round?.phase === "complete") || (old.game !== "finished" && next.game === "finished")) playRoundComplete();
    else if ((old.round?.revealed?.length || 0) < (next.round?.revealed?.length || 0)) playReveal();
    else if ((old.round?.strikes || 0) < (next.round?.strikes || 0)) playStrike();
    else if (old.round?.phase !== next.round?.phase && next.round?.phase === "faceoff") tone(660, .14, "sine", .08);
    else if (old.game !== "fast_money" && next.game === "fast_money") tone(784, .16, "sine", .08);
  }

  function updateTVCountdowns() {
    if (!isTV) return;
    if (state.round?.phase === "steal" && state.round.stealUntil) {
      const el = document.getElementById("tv-steal-clock");
      if (el) el.textContent = Math.max(0, Math.ceil((state.round.stealUntil - Date.now()) / 1000));
    }
    if (state.fastMoney?.timerUntil) {
      const el = document.getElementById("tv-fast-timer");
      if (el) el.textContent = Math.max(0, Math.ceil((state.fastMoney.timerUntil - Date.now()) / 1000));
    }
    if ((state.round?.phase === "steal" && state.round.stealUntil) || state.fastMoney?.timerUntil) setTimeout(updateTVCountdowns, 200);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }

  initialize();
})();
