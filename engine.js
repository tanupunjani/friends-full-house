(function (root, factory) {
  const engine = factory();
  if (typeof module === "object" && module.exports) module.exports = engine;
  else root.FullHouseEngine = engine;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function makeTeam(name, players, score = 0, nextPlayer = 0) {
    return { name, players: players.slice(), score, nextPlayer };
  }

  function initialState(teams) {
    return {
      game: "setup",
      theme: "amber",
      teams: teams || [
        makeTeam("Team Cedar", ["Alex", "Jordan", "Casey", "Riley", "Morgan"]),
        makeTeam("Team Maple", ["Sam", "Taylor", "Jamie", "Avery", "Drew"])
      ],
      round: null,
      rounds: [],
      usedQuestionIds: [],
      buzzerNonce: 0,
      questionOrder: [],
      fastMoney: null
    };
  }

  function shuffleQuestionIds(questions, random = Math.random) {
    const result = questions.map((question) => question.id);
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function doneRound(state, winner) {
    const round = copy(state.round);
    round.phase = "complete";
    round.winner = winner;
    round.awarded = round.pot * round.multiplier;
    const next = copy(state);
    next.teams[winner].score += round.awarded;
    next.round = round;
    next.rounds.push({
      number: round.number,
      questionId: round.questionId,
      winner,
      pot: round.pot,
      multiplier: round.multiplier,
      awarded: round.awarded
    });
    return next;
  }

  function nextUnusedQuestion(state, questions) {
    const used = new Set(state.usedQuestionIds || []);
    return (state.questionOrder || []).find((id) => questions.some((q) => q.id === id) && !used.has(id)) || null;
  }

  function transition(current, action) {
    const state = copy(current);
    const a = action || {};
    switch (a.type) {
      case "SET_TEAMS": {
        if (state.game !== "setup") return state;
        state.teams = a.teams.map((t) => makeTeam(t.name, t.players, 0, 0));
        return state;
      }
      case "START_GAME":
        if (state.game !== "setup" || state.teams.some((t) => !t.players.length)) return state;
        state.game = "live";
        return state;
      case "START_ROUND":
        if (state.game !== "live" || !a.questionId || state.usedQuestionIds.includes(a.questionId) || (state.round && state.round.phase !== "complete")) return state;
        state.round = {
          number: state.rounds.length + 1,
          questionId: a.questionId,
          multiplier: Math.max(1, Math.min(3, Number(a.multiplier) || 1)),
          phase: "faceoff",
          faceoffShown: null,
          faceoffTeam: null,
          controllingTeam: null,
          turnOffset: 0,
          strikes: 0,
          pot: 0,
          revealed: [],
          startedAt: Date.now()
        };
        if (!state.usedQuestionIds.includes(a.questionId)) state.usedQuestionIds.push(a.questionId);
        state.teams = state.teams.map((team) => ({
          ...team,
          nextPlayer: (state.round.number - 1) % team.players.length
        }));
        return state;
      case "SKIP_QUESTION":
        if (state.game !== "live" || !state.round || state.round.phase === "complete" || !a.questionId || state.usedQuestionIds.includes(a.questionId)) return state;
        state.round = { ...state.round, questionId: a.questionId, phase: "faceoff", faceoffShown: null, faceoffTeam: null, controllingTeam: null, turnOffset: 0, strikes: 0, pot: 0, revealed: [], startedAt: Date.now() };
        delete state.round.stealUntil;
        state.usedQuestionIds.push(a.questionId);
        return state;
      case "PLAY_BUZZER":
        if (state.game !== "live" || state.round?.phase !== "faceoff") return state;
        state.buzzerNonce = (state.buzzerNonce || 0) + 1;
        return state;
      case "FACE_OFF_REVEAL":
        if (!state.round || state.round.phase !== "faceoff") return state;
        state.round.faceoffShown = a.answerIndex;
        return state;
      case "FACE_OFF_WINNER":
        if (!state.round || state.round.phase !== "faceoff") return state;
        state.round.faceoffTeam = Number(a.team);
        state.round.phase = "play_choice";
        return state;
      case "CHOOSE_PLAY":
        if (!state.round || state.round.phase !== "play_choice") return state;
        state.round.controllingTeam = state.round.faceoffTeam;
        state.round.turnOffset = 0;
        state.round.phase = "play";
        return state;
      case "CHOOSE_PASS":
        if (!state.round || state.round.phase !== "play_choice") return state;
        state.round.controllingTeam = 1 - state.round.faceoffTeam;
        state.round.turnOffset = 0;
        state.round.phase = "play";
        return state;
      case "REVEAL_ANSWER": {
        if (!state.round || !["play", "steal"].includes(state.round.phase)) return state;
        if (state.round.revealed.includes(a.answerIndex)) return state;
        state.round.revealed.push(a.answerIndex);
        state.round.pot += Number(a.score) || 0;
        if (state.round.phase === "steal") return doneRound(state, 1 - state.round.controllingTeam);
        if (a.boardComplete) return doneRound(state, state.round.controllingTeam);
        state.round.turnOffset = (state.round.turnOffset + 1) % state.teams[state.round.controllingTeam].players.length;
        return state;
      }
      case "STRIKE":
        if (!state.round || state.round.phase !== "play") return state;
        state.round.strikes = Math.min(3, state.round.strikes + 1);
        if (state.round.strikes === 3) {
          state.round.phase = "steal";
          state.round.stealUntil = Date.now() + 8000;
          state.round.turnOffset = 0;
        } else state.round.turnOffset = (state.round.turnOffset + 1) % state.teams[state.round.controllingTeam].players.length;
        return state;
      case "STEAL_FAIL":
        if (!state.round || state.round.phase !== "steal") return state;
        return doneRound(state, state.round.controllingTeam);
      case "END_ROUND":
        if (!state.round || state.round.phase === "complete") return state;
        return doneRound(state, state.round.controllingTeam ?? state.round.faceoffTeam ?? 0);
      case "NEXT_ROUND":
        if (state.game !== "live" || state.round?.phase !== "complete") return state;
        state.round = null;
        return state;
      case "END_GAME":
        if (state.game !== "live") return state;
        state.game = "fast_money";
        return state;
      case "START_FAST_MONEY":
        if (state.game !== "fast_money") return state;
        if (!Array.isArray(a.questionIds) || a.questionIds.length < 5 || new Set(a.questionIds).size !== 5 || a.questionIds.some((id) => state.usedQuestionIds.includes(id))) return state;
        state.usedQuestionIds.push(...a.questionIds.slice(0, 5));
        state.fastMoney = {
          winningTeam: Number(a.winningTeam) || 0,
          contestants: a.contestants.slice(0, 2),
          questionIds: a.questionIds.slice(0, 5),
          turn: 0,
          index: 0,
          responses: [Array(5).fill(""), Array(5).fill("")],
          scores: [Array(5).fill(null), Array(5).fill(null)],
          submitted: [false, false]
        };
        return state;
      case "FAST_MONEY_RESPONSE":
        if (!state.fastMoney || state.fastMoney.submitted[a.turn]) return state;
        state.fastMoney.responses[a.turn][a.index] = a.response;
        state.fastMoney.index = a.index;
        return state;
      case "FAST_MONEY_NEXT":
        if (!state.fastMoney) return state;
        if (state.fastMoney.index < 4) state.fastMoney.index += 1;
        return state;
      case "FAST_MONEY_BACK":
        if (!state.fastMoney) return state;
        if (state.fastMoney.index > 0) state.fastMoney.index -= 1;
        return state;
      case "FAST_MONEY_TIMER_SET":
        if (!state.fastMoney || state.fastMoney.submitted[state.fastMoney.turn]) return state;
        state.fastMoney.timerUntil = a.until;
        state.fastMoney.timeLimit = a.limit;
        return state;
      case "FAST_MONEY_TIMER_STOP":
        if (!state.fastMoney) return state;
        state.fastMoney.timerUntil = null;
        return state;
      case "FAST_MONEY_SUBMIT":
        if (!state.fastMoney) return state;
        state.fastMoney.submitted[state.fastMoney.turn] = true;
        state.fastMoney.timerUntil = null;
        if (state.fastMoney.turn === 0) {
          state.fastMoney.turn = 1;
          state.fastMoney.index = 0;
        }
        return state;
      case "FAST_MONEY_FINALIZE":
        if (!state.fastMoney || !state.fastMoney.submitted.every(Boolean)) return state;
        state.fastMoney.scores = copy(a.scores);
        state.game = "finished";
        return state;
      default:
        return current;
    }
  }

  function normalizeAnswer(text) {
    return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ").replace(/\b(a|an|the|some|my|your)\b/g, " ").replace(/\s+/g, " ").trim();
  }

  function scoreAnswer(question, response) {
    const guess = normalizeAnswer(response);
    if (!guess) return 0;
    const match = question.answers.find((answer) => [answer.text, ...(answer.synonyms || [])]
      .some((candidate) => {
        const normalized = normalizeAnswer(candidate);
        return normalized && (guess === normalized || (guess.length > 3 && normalized.includes(guess)) || (normalized.length > 3 && guess.includes(normalized)));
      }));
    return match ? match.score : 0;
  }

  return { initialState, transition, normalizeAnswer, scoreAnswer, shuffleQuestionIds, nextUnusedQuestion };
});
