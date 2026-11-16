import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../build/worker.mjs", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`);

class MemoryDatabase {
  constructor() { this.rooms = new Map(); }
  prepare(query) {
    const database = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        if (query.startsWith("DELETE")) {
          for (const [code, room] of database.rooms) if (room.updated_at < args[0]) database.rooms.delete(code);
          return {};
        }
        if (query.startsWith("INSERT")) {
          const [room_code, host_hash, state_json, bank_json, updated_at] = args;
          database.rooms.set(room_code, { room_code, host_hash, state_json, bank_json, updated_at });
          return {};
        }
        if (query.startsWith("UPDATE")) {
          const [state_json, bank_json, updated_at, room_code] = args;
          const room = database.rooms.get(room_code);
          if (room) Object.assign(room, { state_json, bank_json, updated_at });
          return {};
        }
        return {};
      },
      async first() { return database.rooms.get(args[0]) || null; },
    };
  }
}

const db = new MemoryDatabase();
const env = { DB: db };
const hostKey = "a".repeat(64);
const created = await worker.fetch(new Request("https://game.test/api/rooms", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostKey }),
}), env);
assert.equal(created.status, 201);
const { room } = await created.json();

const denied = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/host`), env);
assert.equal(denied.status, 403);

const host = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/host`, {
  headers: { authorization: `Bearer ${hostKey}` },
}), env);
assert.equal(host.status, 200);
const hostData = await host.json();
assert.equal(hostData.bank.length, 15);

const hidden = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/tv`), env);
const hiddenData = await hidden.json();
assert.deepEqual(hiddenData.bank, []);
assert.equal(JSON.stringify(hiddenData).includes(hostData.bank[0].answers[0].text), false);
const publicDeck = await worker.fetch(new Request("https://game.test/questions.json"), env);
assert.equal(publicDeck.status, 404);
const excludedImage = await worker.fetch(new Request("https://game.test/excluded-image.png"), env);
assert.equal(excludedImage.status, 404);
const audiencePage = await worker.fetch(new Request("https://game.test/tv.html"), env);
assert.equal(audiencePage.status, 200);
assert.match(await audiencePage.text(), /data-network="remote"/);

const gameState = {
  game: "live",
  teams: [{ name: "One", score: 0, players: ["Alex"], nextPlayer: 0 }, { name: "Two", score: 0, players: ["Sam"], nextPlayer: 0 }],
  rounds: [], usedQuestionIds: [], fastMoney: null,
  round: { questionId: hostData.bank[0].id, phase: "play", revealed: [0], strikes: 0, pot: 0, multiplier: 1, number: 1 },
};
const updated = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/host`, {
  method: "PUT",
  headers: { authorization: `Bearer ${hostKey}`, "content-type": "application/json" },
  body: JSON.stringify({ state: gameState, bank: hostData.bank }),
}), env);
assert.equal(updated.status, 200);

const revealed = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/tv`), env);
const revealedData = await revealed.json();
assert.equal(revealedData.bank[0].answers[0].text, hostData.bank[0].answers[0].text);
assert.equal(revealedData.bank[0].answers[1].text, "");
assert.equal(JSON.stringify(revealedData).includes(hostData.bank[0].answers[1].text), false);

gameState.game = "fast_money";
gameState.round = null;
gameState.fastMoney = {
  questionIds: hostData.bank.slice(0, 5).map((question) => question.id),
  responses: [["private contestant answer"], ["another private answer"]],
  scores: [[null], [null]], submitted: [false, false], turn: 0, index: 0,
};
const fastMoneySaved = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/host`, {
  method: "PUT",
  headers: { authorization: `Bearer ${hostKey}`, "content-type": "application/json" },
  body: JSON.stringify({ state: gameState, bank: hostData.bank }),
}), env);
assert.equal(fastMoneySaved.status, 200);
const fastMoneyDisplay = await worker.fetch(new Request(`https://game.test/api/rooms/${room}/tv`), env);
const fastMoneyPublic = await fastMoneyDisplay.json();
assert.equal(JSON.stringify(fastMoneyPublic).includes("private contestant answer"), false);
assert.deepEqual(fastMoneyPublic.bank[0].answers, []);

console.log("Room creation, host authorization, hidden answers, private question deck, and safe static routing passed.");
