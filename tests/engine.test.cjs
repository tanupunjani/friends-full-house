const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const game = require("../engine.js");
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "questions.json"), "utf8"));

test("shuffles the complete original prompt deck without duplicates", () => {
  const order = game.shuffleQuestionIds(questions, () => 0.5);
  assert.equal(order.length, questions.length);
  assert.equal(new Set(order).size, questions.length);
  assert.notDeepEqual(order, questions.map((question) => question.id));
});

const makeLive = () => {
  let state = game.initialState();
  state = game.transition(state, { type: "START_GAME" });
  state = game.transition(state, { type: "START_ROUND", questionId: questions[0].id, multiplier: 2 });
  return state;
};

test("the included deck has 15 original questions and every answer board totals 100", () => {
  assert.equal(questions.length, 15);
  for (const question of questions) {
    assert.ok(question.answers.length >= 5 && question.answers.length <= 8, question.id);
    assert.equal(question.answers.reduce((sum, answer) => sum + answer.score, 0), 100, question.id);
  }
});

test("a clear board awards the multiplied pot to the team that played", () => {
  let state = makeLive();
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "CHOOSE_PLAY" });
  const question = questions[0];
  question.answers.forEach((answer, index) => {
    state = game.transition(state, { type: "REVEAL_ANSWER", answerIndex: index, score: answer.score, boardComplete: index === question.answers.length - 1 });
  });
  assert.equal(state.round.phase, "complete");
  assert.equal(state.round.awarded, 200);
  assert.equal(state.teams[0].score, 200);
});

test("three strikes start a steal and a miss awards the pot to the original team", () => {
  let state = makeLive();
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "CHOOSE_PLAY" });
  state = game.transition(state, { type: "REVEAL_ANSWER", answerIndex: 0, score: questions[0].answers[0].score });
  state = game.transition(state, { type: "STRIKE" });
  state = game.transition(state, { type: "STRIKE" });
  state = game.transition(state, { type: "STRIKE" });
  assert.equal(state.round.phase, "steal");
  assert.ok(state.round.stealUntil > Date.now());
  state = game.transition(state, { type: "STEAL_FAIL" });
  assert.equal(state.round.winner, 0);
  assert.equal(state.teams[0].score, questions[0].answers[0].score * 2);
});

test("a correct steal awards the accumulated pot to the stealing team", () => {
  let state = makeLive();
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "CHOOSE_PLAY" });
  ["STRIKE", "STRIKE", "STRIKE"].forEach((type) => { state = game.transition(state, { type }); });
  const answer = questions[0].answers[0];
  state = game.transition(state, { type: "REVEAL_ANSWER", answerIndex: 0, score: answer.score });
  assert.equal(state.round.winner, 1);
  assert.equal(state.teams[1].score, answer.score * 2);
});

test("the next-round control clears the finished board and keeps the score", () => {
  let state = makeLive();
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "CHOOSE_PLAY" });
  state = game.transition(state, { type: "END_ROUND" });
  const points = state.teams[0].score;
  state = game.transition(state, { type: "NEXT_ROUND" });
  assert.equal(state.round, null);
  assert.equal(state.teams[0].score, points);
});

test("skipping face-off and active play uses fresh boards without awarding the pot", () => {
  let state = makeLive();
  state.questionOrder = questions.map((question) => question.id);
  const first = state.round.questionId;
  const second = game.nextUnusedQuestion(state, questions);
  state = game.transition(state, { type: "SKIP_QUESTION", questionId: second });
  assert.equal(state.round.phase, "faceoff");
  assert.equal(state.round.questionId, second);
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "CHOOSE_PLAY" });
  state = game.transition(state, { type: "REVEAL_ANSWER", answerIndex: 0, score: 35 });
  state = game.transition(state, { type: "STRIKE" });
  const third = game.nextUnusedQuestion(state, questions);
  state = game.transition(state, { type: "SKIP_QUESTION", questionId: third });
  assert.equal(state.round.phase, "faceoff");
  assert.equal(state.round.pot, 0);
  assert.equal(state.round.strikes, 0);
  assert.deepEqual(state.round.revealed, []);
  assert.deepEqual(state.teams.map((team) => team.score), [0, 0]);
  assert.deepEqual(state.usedQuestionIds, [first, second, third]);
  assert.equal(game.transition(state, { type: "SKIP_QUESTION", questionId: first }).round.questionId, third);
});

test("buzzer is face-off only and does not change the board", () => {
  let state = makeLive();
  state = game.transition(state, { type: "PLAY_BUZZER" });
  assert.equal(state.buzzerNonce, 1);
  assert.equal(state.round.strikes, 0);
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "PLAY_BUZZER" });
  assert.equal(state.buzzerNonce, 1);
});

test("the next guesser rotates after a reveal and after a strike", () => {
  let state = makeLive();
  state = game.transition(state, { type: "FACE_OFF_WINNER", team: 0 });
  state = game.transition(state, { type: "CHOOSE_PLAY" });
  assert.equal(state.round.turnOffset, 0);
  state = game.transition(state, { type: "REVEAL_ANSWER", answerIndex: 0, score: questions[0].answers[0].score });
  assert.equal(state.round.turnOffset, 1);
  state = game.transition(state, { type: "STRIKE" });
  assert.equal(state.round.turnOffset, 2);
});

test("Fast Money matching accepts synonyms and finalizes both score sheets", () => {
  const synonymQuestion = { ...questions[0], answers: questions[0].answers.map((answer, index) => index === 0 ? { ...answer, synonyms: ["getting ready"] } : answer) };
  assert.equal(game.scoreAnswer(synonymQuestion, "getting ready"), questions[0].answers[0].score);
  let state = game.transition(game.initialState(), { type: "START_GAME" });
  state = game.transition(state, { type: "END_GAME" });
  state = game.transition(state, { type: "START_FAST_MONEY", winningTeam: 0, contestants: ["Alex", "Jordan"], questionIds: questions.slice(0, 5).map((q) => q.id) });
  state = game.transition(state, { type: "FAST_MONEY_SUBMIT" });
  state = game.transition(state, { type: "FAST_MONEY_SUBMIT" });
  state = game.transition(state, { type: "FAST_MONEY_FINALIZE", scores: [Array(5).fill(20), Array(5).fill(20)] });
  assert.equal(state.game, "finished");
  assert.equal(state.fastMoney.scores.flat().reduce((a, b) => a + b, 0), 200);
});
