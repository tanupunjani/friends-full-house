const DEFAULT_BANK = __DEFAULT_BANK__;
const ASSETS = __STATIC_ASSETS__;

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

function initialState() {
  return {
    game: "setup",
    theme: "amber",
    teams: [
      { name: "Team Cedar", players: ["Alex", "Jordan", "Casey", "Riley", "Morgan"], score: 0, nextPlayer: 0 },
      { name: "Team Maple", players: ["Sam", "Taylor", "Jamie", "Avery", "Drew"], score: 0, nextPlayer: 0 },
    ],
    round: null,
    rounds: [],
    usedQuestionIds: [],
    fastMoney: null,
  };
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function hashHostKey(key) {
  const data = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validBank(bank) {
  return Array.isArray(bank) && bank.length > 0 && bank.length <= 500 && bank.every((question) =>
    question && typeof question.id === "string" && typeof question.question === "string" &&
    Array.isArray(question.answers) && question.answers.length >= 5 && question.answers.length <= 8 &&
    question.answers.reduce((sum, answer) => sum + Number(answer.score), 0) === 100 &&
    question.answers.every((answer) => typeof answer.text === "string" && Number.isFinite(Number(answer.score))));
}

function publicSnapshot(state, bank) {
  const safeState = structuredClone(state);
  const safeBank = [];
  if (safeState.round) {
    const question = bank.find((item) => item.id === safeState.round.questionId);
    if (question) safeBank.push({
      id: question.id,
      question: question.question,
      answers: question.answers.map((answer, index) => safeState.round.revealed.includes(index)
        ? { text: answer.text, score: answer.score }
        : { text: "", score: 0 }),
    });
  }
  if (safeState.fastMoney) {
    const fm = safeState.fastMoney;
    fm.responses = [Array(5).fill(""), Array(5).fill("")];
    if (!fm.submitted.every(Boolean)) fm.scores = [Array(5).fill(null), Array(5).fill(null)];
    for (const id of fm.questionIds) {
      const question = bank.find((item) => item.id === id);
      if (question && !safeBank.some((item) => item.id === id)) safeBank.push({ id: question.id, question: question.question, answers: [] });
    }
  }
  return { state: safeState, bank: safeBank };
}

async function api(request, env, url) {
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    let body;
    try { body = await request.json(); } catch { return response({ error: "bad_request" }, 400); }
    const key = body?.hostKey;
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return response({ error: "bad_request" }, 400);
    const keyHash = await hashHostKey(key);
    await env.DB.prepare("DELETE FROM rooms WHERE updated_at < ?").bind(Date.now() - 72 * 60 * 60 * 1000).run();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = makeRoomCode();
      try {
        await env.DB.prepare("INSERT INTO rooms (room_code, host_hash, state_json, bank_json, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(code, keyHash, JSON.stringify(initialState()), JSON.stringify(DEFAULT_BANK), Date.now()).run();
        return response({ room: code }, 201);
      } catch (_) { /* retry a rare room-code collision */ }
    }
    return response({ error: "room_unavailable" }, 503);
  }

  const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(host|tv)$/);
  if (!match) return response({ error: "not_found" }, 404);
  const [, code, mode] = match;
  const row = await env.DB.prepare("SELECT room_code, host_hash, state_json, bank_json, updated_at FROM rooms WHERE room_code = ?")
    .bind(code).first();
  if (!row || Date.now() - row.updated_at > 72 * 60 * 60 * 1000) return response({ error: "room_expired" }, 404);

  if (mode === "host") {
    const key = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!key || await hashHostKey(key) !== row.host_hash) return response({ error: "host_only" }, 403);
    if (request.method === "GET") return response({ state: JSON.parse(row.state_json), bank: JSON.parse(row.bank_json) });
    if (request.method === "PUT") {
      const raw = await request.text();
      if (raw.length > 2_000_000) return response({ error: "too_large" }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return response({ error: "bad_request" }, 400); }
      if (!body?.state || !["setup", "live", "fast_money", "finished"].includes(body.state.game) || !validBank(body.bank)) return response({ error: "bad_request" }, 400);
      await env.DB.prepare("UPDATE rooms SET state_json = ?, bank_json = ?, updated_at = ? WHERE room_code = ?")
        .bind(JSON.stringify(body.state), JSON.stringify(body.bank), Date.now(), code).run();
      return response({ saved: true });
    }
    return response({ error: "method_not_allowed" }, 405);
  }

  if (request.method !== "GET") return response({ error: "method_not_allowed" }, 405);
  return response(publicSnapshot(JSON.parse(row.state_json), JSON.parse(row.bank_json)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    if (url.pathname === "/questions.json") return new Response("Not found", { status: 404 });

    const pathname = url.pathname === "/" ? "/tv.html" : url.pathname;
    const asset = ASSETS[pathname];
    if (asset === undefined) return new Response("Not found", { status: 404 });
    const contentType = pathname.endsWith(".html") ? "text/html; charset=utf-8"
      : pathname.endsWith(".js") ? "text/javascript; charset=utf-8"
      : pathname.endsWith(".css") ? "text/css; charset=utf-8"
      : "application/octet-stream";
    const body = asset;
    return new Response(body, {
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
      },
    });
  },
};
