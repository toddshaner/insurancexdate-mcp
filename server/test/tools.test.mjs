import assert from "node:assert/strict";
import { test } from "node:test";

import { AddNoteSchema, SetFlagSchema, buildHandlers } from "../dist/tools.js";

const OK_RESULT = { content: [{ type: "text", text: "ok" }] };

function resultText(result) {
  return result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

function stubClient(calls) {
  return {
    search: async (args) => {
      calls.push(["rest_search", args]);
      return OK_RESULT;
    },
    match: async (args) => {
      calls.push(["match", args]);
      return OK_RESULT;
    },
    accountStatus: async () => {
      calls.push(["account_status", {}]);
      return OK_RESULT;
    },
    mcpPassthrough: async (name, args) => {
      calls.push([name, args]);
      return OK_RESULT;
    },
  };
}

test("native_search and account_status route to their intended upstream surfaces", async () => {
  const calls = [];
  const handlers = buildHandlers(stubClient(calls));

  await handlers.native_search({ datamode: 2, lossratiomin: 85 });
  await handlers.account_status({});

  assert.deepEqual(calls, [
    ["search", { datamode: 2, lossratiomin: 85 }],
    ["account_status", {}],
  ]);
});

test("native_search requires an explicit mode and rejects mode-incompatible fields", async () => {
  const calls = [];
  const handlers = buildHandlers(stubClient(calls));

  for (const args of [
    { name: "Acme" },
    { datamode: 0, partmin: 50 },
    { datamode: 1, inspremmin: 1000 },
    { datamode: 2, assetmin: 1000 },
  ]) {
    const result = await handlers.native_search(args);
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);

  await handlers.native_search({ datamode: 0, name: "Acme", naicslist: ["23"] });
  await handlers.native_search({ datamode: 2, featurelist: ["known-exact-value"] });
  assert.deepEqual(calls, [
    ["search", { datamode: 0, name: "Acme", naicslist: ["23"] }],
    ["search", { datamode: 2, featurelist: ["known-exact-value"] }],
  ]);
});

test("write schemas reject whitespace-only identifiers, notes, and appointment times", () => {
  assert.throws(() => AddNoteSchema.uid.parse("   "));
  assert.throws(() => AddNoteSchema.note.parse("\t\n"));
  assert.throws(() => SetFlagSchema.uid.parse("   "));
  assert.throws(() => SetFlagSchema.appttime.parse("   "));
  assert.throws(() => SetFlagSchema.appttime.parse("tomorrow morning"));
  assert.throws(() => SetFlagSchema.appttime.parse("2026-02-30 10:00"));
  assert.equal(
    SetFlagSchema.appttime.parse("2026-08-20 10:00"),
    "2026-08-20 10:00",
  );
  assert.equal(
    SetFlagSchema.appttime.parse("2028-02-29T10:00:00-07:00"),
    "2028-02-29T10:00:00-07:00",
  );
  assert.equal(AddNoteSchema.note.parse("  meaningful note  "), "  meaningful note  ");
});

test("write handlers fail closed, require confirmation, and strip wrapper-only confirm", async (t) => {
  const original = process.env.XDATE_ENABLE_WRITES;
  t.after(() => {
    if (original === undefined) delete process.env.XDATE_ENABLE_WRITES;
    else process.env.XDATE_ENABLE_WRITES = original;
  });

  const calls = [];
  const handlers = buildHandlers(stubClient(calls));

  delete process.env.XDATE_ENABLE_WRITES;
  const disabled = await handlers.add_note({ uid: "abc", note: "hello", confirm: true });
  assert.equal(disabled.isError, true);
  assert.match(resultText(disabled), /write tools are disabled/i);
  assert.equal(calls.length, 0);

  process.env.XDATE_ENABLE_WRITES = "1";
  const unconfirmed = await handlers.add_note({ uid: "abc", note: "hello" });
  assert.equal(unconfirmed.isError, true);
  assert.match(resultText(unconfirmed), /confirm=true/i);
  assert.equal(calls.length, 0);

  await handlers.add_note({ uid: "abc%2Bdef", note: "hello", confirm: true });
  await handlers.set_flag({
    uid: "abc",
    flag: "appt",
    appttime: "2026-08-20T10:00:00-07:00",
    confirm: true,
  });

  assert.deepEqual(calls, [
    ["add_note", { uid: "abc%2Bdef", note: "hello" }],
    ["set_flag", { uid: "abc", flag: "appt", appttime: "2026-08-20T10:00:00-07:00" }],
  ]);
});

test("scheduled flags require an appointment time before any upstream call", async (t) => {
  const original = process.env.XDATE_ENABLE_WRITES;
  t.after(() => {
    if (original === undefined) delete process.env.XDATE_ENABLE_WRITES;
    else process.env.XDATE_ENABLE_WRITES = original;
  });
  process.env.XDATE_ENABLE_WRITES = "true";

  const calls = [];
  const handlers = buildHandlers(stubClient(calls));
  const result = await handlers.set_flag({ uid: "abc", flag: "followup", confirm: true });
  const misplaced = await handlers.set_flag({
    uid: "abc",
    flag: "save",
    appttime: "2026-08-20T10:00:00-07:00",
    confirm: true,
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /requires appttime/i);
  assert.equal(misplaced.isError, true);
  assert.match(resultText(misplaced), /only with followup or appt/i);
  assert.equal(calls.length, 0);
});
