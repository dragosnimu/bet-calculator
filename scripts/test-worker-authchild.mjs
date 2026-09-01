#!/usr/bin/env node
// Child process for the worker security regression suite (test-worker-security.mjs).
// Runs price-alert-worker.mjs AS MAIN with a faked Telegram API so pollTelegram()
// processes one crafted getUpdates batch, then prints a RESULT line and exits.
//
// Verifies (High + Low findings):
//  - sender authorization: updates from a chat != TELEGRAM_CHAT_ID are ignored;
//  - prototype-pollution guard on inline "ack:__proto__";
//  - authorized "ack:SYM" still mutes the symbol.
//
// Env in: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALERT_STATE_FILE (pre-seeded by parent).
import { readFileSync } from "fs";

const WORKER_URL = new URL("./price-alert-worker.mjs", import.meta.url).href;
const STATE = process.env.ALERT_STATE_FILE;

let served = false;
const UPDATES = [
  // unauthorized inline ack for TLV (foreign chat) -> must be ignored
  { update_id: 101, callback_query: { id: "c1", data: "ack:TLV", from: { id: 999 }, message: { chat: { id: 999 } } } },
  // authorized ack for __proto__ -> must not pollute Object.prototype, must not crash
  { update_id: 102, callback_query: { id: "c2", data: "ack:__proto__", from: { id: 111 }, message: { chat: { id: 111 } } } },
  // unauthorized /reset SNP (foreign chat) -> must be ignored
  { update_id: 103, message: { chat: { id: 999 }, text: "/reset SNP" } },
  // authorized ack for SNP -> must mute SNP
  { update_id: 104, callback_query: { id: "c4", data: "ack:SNP", from: { id: 111 }, message: { chat: { id: 111 } } } },
  // authorized /status -> must not crash
  { update_id: 105, message: { chat: { id: 111 }, text: "/status" } },
];

globalThis.fetch = async (url) => {
  if (String(url).includes("/getUpdates")) {
    const result = served ? [] : UPDATES;
    served = true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => "" };
};

// Silence the worker's own logging; make the isMain guard match this dynamic import
// (portable across Windows "file:///C:/..." and POSIX "file:///...").
console.log = () => {};
process.argv[1] = WORKER_URL.slice("file://".length);

await import(WORKER_URL);

setTimeout(() => {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const out = {
    tlvMuted: st.symbols.TLV.muted === true,
    snpMuted: st.symbols.SNP.muted === true,
    protoPolluted: ({}).muted !== undefined,
    offset: st.tgOffset,
  };
  process.stdout.write("RESULT " + JSON.stringify(out) + "\n");
  process.exit(0);
}, 1800);
