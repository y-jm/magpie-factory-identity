import test from "node:test";
import assert from "node:assert/strict";
import { onProvider, onResponse, onEvent } from "./factory-identity.middleware.mjs";

const ORIGINAL = "You are omp's trusted coding assistant.";
const REPLACEMENT = "You are droid's trusted coding assistant.";
const PAIRS = [
  ["_read", "omp_read"], ["_bash", "omp_bash"], ["_edit", "omp_edit"],
  ["_ask", "omp_ask"], ["_eval", "omp_eval"], ["_glob", "omp_glob"],
  ["_grep", "omp_grep"], ["_task", "omp_task"], ["_wait", "omp_wait"],
  ["_todo", "omp_todo"], ["_write", "omp_write"],
  ["web_search", "omp_web_search"],
];
const ORIGINALS = PAIRS.map(([name]) => name);
const ALIASES = PAIRS.map(([, name]) => name);
const PROTOCOLS = ["anthropic", "chat", "responses", "gemini"];
const INPUT = { path: "omp_read/_read.txt", i: "Read omp_read", nested: { name: "_read" } };
const ARGUMENTS = JSON.stringify(INPUT);
const SCHEMA = {
  type: "object", properties: { path: { type: "string", description: "Keep _read and omp_read" } },
  required: ["path"], additionalProperties: false,
};

function context(protocol, provider = "factory") {
  return { protocol, provider: { id: provider }, state: {} };
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function apply(hook, body, ctx) {
  const result = hook(freeze(body), ctx);
  return result === undefined ? body : result;
}

function request(protocol, names) {
  const definitions = names.map((name) => ({ name, description: "Use read; preserve _read and omp_read", parameters: SCHEMA }));
  switch (protocol) {
    case "anthropic":
      return { model: "factory/model", tools: definitions.map(({ parameters, ...tool }) => ({ ...tool, input_schema: parameters })), messages: [{ role: "user", content: "Call _read; omp_read is text" }] };
    case "chat":
      return { model: "factory/model", tools: definitions.map((definition) => ({ type: "function", function: { ...definition, strict: true } })), messages: [{ role: "user", content: "Call _read; omp_read is text" }] };
    case "responses":
      return { model: "factory/model", tools: definitions.map((definition) => ({ type: "function", ...definition, strict: true })), input: [{ role: "user", content: "Call _read; omp_read is text" }] };
    case "gemini":
      return { tools: [{ functionDeclarations: definitions }], contents: [{ role: "user", parts: [{ text: "Call _read; omp_read is text" }] }] };
  }
}

function response(protocol, names) {
  switch (protocol) {
    case "anthropic":
      return {
        id: "message-id", role: "assistant", stop_reason: "tool_use", usage: { output_tokens: 20 },
        content: [
          { type: "thinking", thinking: "Keep omp_read", signature: "signed_omp_read" },
          { type: "text", text: "Keep _read and omp_read" },
          ...names.map((name, index) => ({ type: "tool_use", id: `call-${index}`, name, input: INPUT })),
        ],
      };
    case "chat":
      return {
        id: "chat-id", object: "chat.completion", usage: { completion_tokens: 20 },
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: "Keep _read and omp_read", reasoning_content: "Keep omp_read",
          tool_calls: names.map((name, index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: ARGUMENTS } })),
        } }],
      };
    case "responses":
      return {
        id: "response-id", status: "completed", usage: { output_tokens: 20 },
        output: [
          { type: "reasoning", id: "reasoning-id", summary: [], encrypted_content: "signed_omp_read" },
          ...names.map((name, index) => ({ type: "function_call", id: `item-${index}`, call_id: `call-${index}`, name, arguments: ARGUMENTS, status: "completed" })),
          { type: "message", id: "message-id", role: "assistant", content: [{ type: "output_text", text: "Keep omp_read", annotations: [] }] },
        ],
      };
    case "gemini":
      return {
        candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [
          { text: "Keep omp_read", thought: true, thoughtSignature: "signed_omp_read" },
          ...names.map((name, index) => ({ functionCall: { id: `call-${index}`, name, args: INPUT }, thoughtSignature: "signed_omp_read" })),
        ] } }], usageMetadata: { candidatesTokenCount: 20 },
      };
  }
}

for (const protocol of PROTOCOLS) {
  test(`${protocol}: all twelve declarations and replies preserve schemas, arguments, IDs and metadata`, () => {
    const ctx = context(protocol);
    assert.deepEqual(apply(onProvider, request(protocol, ORIGINALS), ctx), request(protocol, ALIASES));
    assert.deepEqual(apply(onResponse, response(protocol, ALIASES), ctx), response(protocol, ORIGINALS));
  });

  test(`${protocol}: unrelated tools and pre-existing omp_read remain untouched`, () => {
    const ctx = context(protocol);
    const body = request(protocol, ["read", "_new_tool", "omp_read", "mcp__server__read", "websearch", "_web_search", "omp_web_search"]);
    assert.strictEqual(apply(onProvider, body, ctx), body);
    const reply = response(protocol, ["omp_read", "_new_tool", "mcp__server__read", "websearch", "_web_search", "omp_web_search"]);
    assert.strictEqual(apply(onResponse, reply, ctx), reply);
    const mixed = request(protocol, ["_bash", "omp_read"]);
    assert.deepEqual(apply(onProvider, mixed, ctx), request(protocol, ["omp_bash", "omp_read"]));
    assert.deepEqual(apply(onResponse, response(protocol, ["omp_bash", "omp_read"]), ctx), response(protocol, ["_bash", "omp_read"]));
  });

  test(`${protocol}: fallback and provider retries cannot reuse stale aliases`, () => {
    const ctx = context(protocol);
    const original = request(protocol, ["_read"]);
    apply(onProvider, original, ctx);
    ctx.provider = { id: "other" };
    assert.strictEqual(apply(onProvider, original, ctx), original);
    const reply = response(protocol, ["omp_read"]);
    assert.strictEqual(apply(onResponse, reply, ctx), reply);
    ctx.provider = { id: "factory" };
    apply(onProvider, request(protocol, ["_bash"]), ctx);
    assert.deepEqual(apply(onResponse, response(protocol, ["omp_read", "omp_bash"]), ctx), response(protocol, ["omp_read", "_bash"]));
  });

  test(`${protocol}: alias collision in either order leaves no partial mapping`, () => {
    for (const names of [["_read", "omp_read"], ["omp_read", "_read"]]) {
      const ctx = context(protocol);
      apply(onProvider, request(protocol, ["_bash"]), ctx);
      const body = request(protocol, names);
      const snapshot = structuredClone(body);
      assert.throws(() => apply(onProvider, body, ctx), /omp_read/);
      assert.deepEqual(body, snapshot);
      const reply = response(protocol, ["omp_read", "omp_bash"]);
      assert.strictEqual(apply(onResponse, reply, ctx), reply);
    }
  });
}

test("identity replacement stays limited to system/developer instruction fields", () => {
  const text = `${ORIGINAL}\nKeep Engineering, read and _read.\n${ORIGINAL}`;
  const replaced = `${REPLACEMENT}\nKeep Engineering, read and _read.\n${REPLACEMENT}`;
  const message = (role, content) => ({ role, content });
  const cases = [
    ["anthropic", { system: [{ type: "text", text, cache_control: { type: "ephemeral" } }], messages: [message("user", text), message("assistant", text)] }, { system: [{ type: "text", text: replaced, cache_control: { type: "ephemeral" } }], messages: [message("user", text), message("assistant", text)] }],
    ["anthropic", { system: text }, { system: replaced }],
    ["chat", { messages: [message("system", text), message("developer", [{ type: "text", text }]), message("user", text), message("assistant", text), message("tool", text)] }, { messages: [message("system", replaced), message("developer", [{ type: "text", text: replaced }]), message("user", text), message("assistant", text), message("tool", text)] }],
    ["responses", { instructions: text, input: [message("developer", [{ type: "input_text", text }]), message("user", text), { type: "function_call_output", call_id: "call-0", output: text }] }, { instructions: replaced, input: [message("developer", [{ type: "input_text", text: replaced }]), message("user", text), { type: "function_call_output", call_id: "call-0", output: text }] }],
    ["gemini", { systemInstruction: { parts: [{ text }] }, system_instruction: { parts: [{ text }] }, contents: [{ role: "user", parts: [{ text }] }] }, { systemInstruction: { parts: [{ text: replaced }] }, system_instruction: { parts: [{ text: replaced }] }, contents: [{ role: "user", parts: [{ text }] }] }],
  ];
  for (const [protocol, body, expected] of cases) {
    assert.deepEqual(apply(onProvider, body, context(protocol)), expected);
    assert.strictEqual(apply(onProvider, body, context(protocol, "other")), body);
  }
});

test("Anthropic: selected tool and two-turn history use the upstream name without changing results", () => {
  const initial = { ...request("anthropic", ["_read"]), tool_choice: { type: "tool", name: "_read", disable_parallel_tool_use: true } };
  const ctx = context("anthropic");
  const outbound = apply(onProvider, initial, ctx);
  assert.deepEqual(outbound.tool_choice, { type: "tool", name: "omp_read", disable_parallel_tool_use: true });
  const reply = apply(onResponse, response("anthropic", ["omp_read"]), ctx);
  const result = { type: "tool_result", tool_use_id: "call-0", content: `${ORIGINAL} _read omp_read` };
  const next = { ...initial, messages: [...initial.messages, { role: "assistant", content: reply.content }, { role: "user", content: [result] }] };
  const expected = { ...outbound, messages: [...initial.messages, { role: "assistant", content: response("anthropic", ["omp_read"]).content }, { role: "user", content: [result] }] };
  assert.deepEqual(apply(onProvider, next, context("anthropic")), expected);
});

test("Chat: selected tool and second-turn assistant/tool messages keep their call association", () => {
  const initial = { ...request("chat", ["_read"]), tool_choice: { type: "function", function: { name: "_read" } } };
  const ctx = context("chat");
  const outbound = apply(onProvider, initial, ctx);
  assert.deepEqual(outbound.tool_choice, { type: "function", function: { name: "omp_read" } });
  const reply = apply(onResponse, response("chat", ["omp_read"]), ctx);
  const result = { role: "tool", tool_call_id: "call-0", content: `${ORIGINAL} _read omp_read` };
  const next = { ...initial, messages: [...initial.messages, reply.choices[0].message, result] };
  const expected = { ...outbound, messages: [...initial.messages, response("chat", ["omp_read"]).choices[0].message, result] };
  assert.deepEqual(apply(onProvider, next, context("chat")), expected);
});

test("allowed-tool lists and historical calls without current declarations stay consistent", () => {
  const chat = {
    ...request("chat", ["_bash"]),
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", function: { name: "_bash" } }] },
    messages: [response("chat", ["_read"]).choices[0].message, { role: "tool", tool_call_id: "call-0", content: "omp_read" }],
  };
  const expectedChat = {
    ...request("chat", ["omp_bash"]),
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", function: { name: "omp_bash" } }] },
    messages: [response("chat", ["omp_read"]).choices[0].message, { role: "tool", tool_call_id: "call-0", content: "omp_read" }],
  };
  assert.deepEqual(apply(onProvider, chat, context("chat")), expectedChat);
  const responses = {
    ...request("responses", ["_bash"]),
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "_bash" }, { type: "web_search" }] },
    input: [{ type: "function_call", call_id: "call-0", name: "_read", arguments: ARGUMENTS }, { type: "function_call_output", call_id: "call-0", output: "omp_read" }],
  };
  const expectedResponses = {
    ...request("responses", ["omp_bash"]),
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "omp_bash" }, { type: "web_search" }] },
    input: [{ type: "function_call", call_id: "call-0", name: "omp_read", arguments: ARGUMENTS }, { type: "function_call_output", call_id: "call-0", output: "omp_read" }],
  };
  assert.deepEqual(apply(onProvider, responses, context("responses")), expectedResponses);
  assert.deepEqual(apply(onProvider, { tool_choice: { type: "function", name: "_read" } }, context("responses")), { tool_choice: { type: "function", name: "omp_read" } });
});

for (const snake of [false, true]) {
  test(`Gemini: ${snake ? "snake_case" : "camelCase"} declaration, allowed names, call and result agree`, () => {
    const keys = snake
      ? ["function_declarations", "tool_config", "function_calling_config", "allowed_function_names", "function_call", "function_response"]
      : ["functionDeclarations", "toolConfig", "functionCallingConfig", "allowedFunctionNames", "functionCall", "functionResponse"];
    const [declarations, config, calling, allowed, call, result] = keys;
    const body = (name) => ({
      tools: [{ [declarations]: [{ name, description: "Keep omp_read", parameters: SCHEMA }] }],
      [config]: { [calling]: { mode: "ANY", [allowed]: [name, "external"] } },
      contents: [
        { role: "model", parts: [{ [call]: { name, args: INPUT, id: "call-0" }, thoughtSignature: "signature" }] },
        { role: "user", parts: [{ [result]: { name, id: "call-0", response: { name: "_read", value: "omp_read" } } }] },
      ],
    });
    const ctx = context("gemini");
    assert.deepEqual(apply(onProvider, body("_read"), ctx), body("omp_read"));
    const event = (name) => ({ candidates: [{ index: 0, content: { role: "model", parts: [{ [call]: { name, args: INPUT, id: "call-0" }, thoughtSignature: "signature" }] } }] });
    assert.deepEqual(apply(onEvent, event("omp_read"), ctx), event("_read"));
  });
}

test("Anthropic SSE restores starts and preserves argument deltas, signatures and terminal events", () => {
  const ctx = context("anthropic");
  apply(onProvider, request("anthropic", ORIGINALS), ctx);
  PAIRS.forEach(([name, alias], index) => {
    const start = { type: "content_block_start", index, content_block: { type: "tool_use", id: `call-${index}`, name: alias, input: {} } };
    assert.deepEqual(apply(onEvent, start, ctx), { ...start, content_block: { ...start.content_block, name } });
  });
  for (const event of [
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ARGUMENTS } },
    { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "omp_read" } },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "omp_read" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ]) assert.strictEqual(apply(onEvent, event, ctx), event);
});

test("Responses SSE restores items and all terminal response snapshots without touching argument deltas", () => {
  const ctx = context("responses");
  apply(onProvider, request("responses", ORIGINALS), ctx);
  for (const type of ["response.output_item.added", "response.output_item.done"]) {
    const item = { type: "function_call", id: "item-0", call_id: "call-0", name: "omp_read", arguments: ARGUMENTS };
    const event = { type, sequence_number: 1, output_index: 0, item };
    assert.deepEqual(apply(onEvent, event, ctx), { ...event, item: { ...item, name: "_read" } });
  }
  for (const type of ["response.completed", "response.incomplete", "response.failed"]) {
    const status = type.slice("response.".length);
    const event = { type, sequence_number: 5, response: { ...response("responses", ALIASES), status } };
    assert.deepEqual(apply(onEvent, event, ctx), { ...event, response: { ...response("responses", ORIGINALS), status } });
  }
  const delta = { type: "response.function_call_arguments.delta", item_id: "item-0", output_index: 0, delta: ARGUMENTS };
  assert.strictEqual(apply(onEvent, delta, ctx), delta);
});

function chunk(choices) {
  return { id: "chat-id", object: "chat.completion.chunk", created: 1, system_fingerprint: "omp_read", choices };
}

function choice(index, calls, finish_reason = null, extra = {}) {
  return { index, delta: { ...extra, ...(calls ? { tool_calls: calls } : {}) }, finish_reason };
}

function call(index, fields, extra = {}) {
  return { index, ...extra, function: fields };
}

function collect(events) {
  const calls = {};
  for (const event of events) {
    for (const choice of event.choices ?? []) {
      for (const delta of choice.delta?.tool_calls ?? []) {
        const key = `${choice.index}/${delta.index}`;
        const result = calls[key] ??= { name: "", arguments: "" };
        if (delta.id !== undefined) result.id = delta.id;
        if (delta.type !== undefined) result.type = delta.type;
        result.name += delta.function?.name ?? "";
        result.arguments += delta.function?.arguments ?? "";
      }
    }
  }
  return calls;
}

test("Chat SSE keeps interleaved name/argument fragments separate across choices and calls", () => {
  const ctx = context("chat");
  apply(onProvider, request("chat", ["_read", "_bash", "omp_reader"]), ctx);
  const events = [
    chunk([
      choice(0, [call(0, { name: "om", arguments: "{" }, { id: "read-id", type: "function" }), call(1, { name: "omp_b", arguments: "" }, { id: "bash-id", type: "function" })], null, { role: "assistant", content: "Keep omp_read" }),
      choice(1, [call(0, { name: "omp_read", arguments: "{" }, { id: "external-id", type: "function" })]),
    ]),
    chunk([
      choice(0, [call(0, { name: "p_read", arguments: '"path":"omp_read.txt"}' }), call(1, { name: "ash", arguments: '{"command":"echo _read"}' })]),
      choice(1, [call(0, { name: "er", arguments: '"path":"_read.txt"}' })]),
    ]),
    chunk([choice(0, null, "tool_calls"), choice(1, null, "tool_calls")]),
  ];
  const output = events.map((event) => apply(onEvent, event, ctx));
  assert.deepEqual(collect(output), {
    "0/0": { name: "_read", arguments: '{"path":"omp_read.txt"}', id: "read-id", type: "function" },
    "0/1": { name: "_bash", arguments: '{"command":"echo _read"}', id: "bash-id", type: "function" },
    "1/0": { name: "omp_reader", arguments: '{"path":"_read.txt"}', id: "external-id", type: "function" },
  });
  output.forEach((event, index) => {
    assert.equal(event.id, events[index].id);
    assert.equal(event.system_fingerprint, "omp_read");
    assert.deepEqual(event.choices.map((item) => item.finish_reason), events[index].choices.map((item) => item.finish_reason));
  });
  assert.equal(output[0].choices[0].delta.content, "Keep omp_read");
});

test("Chat SSE restores every alias when the name is sent before argument chunks", () => {
  const ctx = context("chat");
  apply(onProvider, request("chat", ORIGINALS), ctx);
  const first = chunk([choice(0, ALIASES.map((name, index) => call(index, { name, arguments: "" }, { id: `call-${index}`, type: "function" })))]);
  const second = chunk([choice(0, ALIASES.map((_, index) => call(index, { arguments: ARGUMENTS })))]);
  const last = chunk([choice(0, null, "tool_calls")]);
  const calls = collect([first, second, last].map((event) => apply(onEvent, event, ctx)));
  ORIGINALS.forEach((name, index) => assert.deepEqual(calls[`0/${index}`], { name, arguments: ARGUMENTS, id: `call-${index}`, type: "function" }));
});

test("Chat SSE flushes an alias and an unmatched prefix even when the final delta is absent", () => {
  const ctx = context("chat");
  apply(onProvider, request("chat", ["_read"]), ctx);
  const start = chunk([choice(0, [call(0, { name: "omp_read" }), call(1, { name: "omp_" })])]);
  const finish = { ...chunk([{ index: 0, finish_reason: "length" }]), usage: { completion_tokens: 2 } };
  const output = [start, finish].map((event) => apply(onEvent, event, ctx));
  assert.deepEqual(collect(output), { "0/0": { name: "_read", arguments: "" }, "0/1": { name: "omp_", arguments: "" } });
  assert.deepEqual(output[1].usage, finish.usage);
  assert.equal(output[1].choices[0].finish_reason, "length");
});

test("Chat SSE request contexts and retries cannot combine name prefixes", () => {
  const readCtx = context("chat");
  const bashCtx = context("chat");
  apply(onProvider, request("chat", ["_read"]), readCtx);
  apply(onProvider, request("chat", ["_bash"]), bashCtx);
  const prefix = chunk([choice(0, [call(0, { name: "omp_" })])]);
  const readStart = apply(onEvent, prefix, readCtx);
  const bashStart = apply(onEvent, prefix, bashCtx);
  const readEnd = apply(onEvent, chunk([choice(0, [call(0, { name: "read", arguments: "{}" })])]), readCtx);
  const bashEnd = apply(onEvent, chunk([choice(0, [call(0, { name: "bash", arguments: "{}" })])]), bashCtx);
  assert.deepEqual(collect([readStart, readEnd]), { "0/0": { name: "_read", arguments: "{}" } });
  assert.deepEqual(collect([bashStart, bashEnd]), { "0/0": { name: "_bash", arguments: "{}" } });
  apply(onProvider, request("chat", ["_read"]), readCtx);
  apply(onEvent, prefix, readCtx);
  apply(onProvider, request("chat", ["_bash"]), readCtx);
  const retried = apply(onEvent, chunk([choice(0, [call(0, { name: "omp_bash", arguments: "{}" })])]), readCtx);
  assert.deepEqual(collect([retried]), { "0/0": { name: "_bash", arguments: "{}" } });
  readCtx.provider = { id: "other" };
  apply(onProvider, request("chat", ["_read"]), readCtx);
  const other = chunk([choice(0, [call(0, { name: "omp_read", arguments: "{}" })])]);
  assert.strictEqual(apply(onEvent, other, readCtx), other);
});

test("identity and response handlers leave unrelated errors and unsupported protocols alone", () => {
  const body = { system: ORIGINAL, tools: [{ name: "_read" }] };
  assert.strictEqual(apply(onProvider, body, context("unknown")), body);
  for (const protocol of PROTOCOLS) {
    const ctx = context(protocol);
    apply(onProvider, request(protocol, ["_read"]), ctx);
    ctx.status = 400;
    const error = { error: { type: "invalid_request_error", message: "omp_read _read" } };
    assert.strictEqual(apply(onResponse, error, ctx), error);
  }
});

test("web_search selection, history and responses preserve query and result content", () => {
  const ctx = context("anthropic");
  const definition = {
    name: "web_search", description: "Search with web_search; keep omp_web_search in text",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  };
  const invocation = { type: "tool_use", id: "search-0", name: "web_search", input: { query: "web_search omp_web_search" } };
  const result = { type: "tool_result", tool_use_id: "search-0", content: "web_search omp_web_search" };
  const body = {
    system: ORIGINAL, tools: [definition], tool_choice: { type: "tool", name: "web_search" },
    messages: [{ role: "assistant", content: [invocation] }, { role: "user", content: [result] }],
  };
  const upstreamCall = { ...invocation, name: "omp_web_search" };
  assert.deepEqual(apply(onProvider, body, ctx), {
    ...body, system: REPLACEMENT, tools: [{ ...definition, name: "omp_web_search" }],
    tool_choice: { type: "tool", name: "omp_web_search" },
    messages: [{ role: "assistant", content: [upstreamCall] }, { role: "user", content: [result] }],
  });
  assert.deepEqual(apply(onResponse, { content: [upstreamCall] }, ctx), { content: [invocation] });
});

test("web_search streamed alias restores the original name without a leading underscore", () => {
  const ctx = context("chat");
  apply(onProvider, request("chat", ["web_search"]), ctx);
  const events = [
    chunk([choice(0, [call(0, { name: "omp_", arguments: "{" }, { id: "search-0", type: "function" })])]),
    chunk([choice(0, [call(0, { name: "web_", arguments: '"query":"web_search ' })])]),
    chunk([choice(0, [call(0, { name: "search", arguments: 'omp_web_search"}' })])]),
    chunk([choice(0, null, "tool_calls")]),
  ];
  assert.deepEqual(collect(events.map((event) => apply(onEvent, event, ctx))), {
    "0/0": { name: "web_search", arguments: '{"query":"web_search omp_web_search"}', id: "search-0", type: "function" },
  });
});

test("web_search alias conflicts cannot retain a previous request mapping", () => {
  for (const names of [["web_search", "omp_web_search"], ["omp_web_search", "web_search"]]) {
    const ctx = context("anthropic");
    apply(onProvider, request("anthropic", ["_read"]), ctx);
    assert.throws(() => apply(onProvider, request("anthropic", names), ctx), /omp_web_search/);
    const reply = response("anthropic", ["omp_read", "omp_web_search"]);
    assert.strictEqual(apply(onResponse, reply, ctx), reply);
  }
});

test("Claude Code tools are aliased for factory and remote-magpie providers", () => {
  for (const provider of ["factory", "remote-magpie", "remote-magpie-2"]) {
    const ctx = context("anthropic", provider);
    const body = request("anthropic", ["ScheduleWakeup", "ReportFindings"]);
    const out = apply(onProvider, body, ctx);
    assert.deepEqual(out.tools.map((tool) => tool.name), ["omp_schedule_wakeup", "omp_report_findings"]);
    assert.deepEqual(body.tools.map((tool) => tool.name), ["ScheduleWakeup", "ReportFindings"]);
  }
});

test("Claude Code tool alias is restored in a non-streamed response", () => {
  const ctx = context("anthropic", "remote-magpie");
  apply(onProvider, request("anthropic", ["ScheduleWakeup"]), ctx);
  const reply = { content: [{ type: "tool_use", id: "toolu_1", name: "omp_schedule_wakeup", input: { delaySeconds: 270 } }] };
  const out = apply(onResponse, reply, ctx);
  assert.equal(out.content[0].name, "ScheduleWakeup");
  assert.equal(out.content[0].id, "toolu_1");
  assert.deepEqual(out.content[0].input, { delaySeconds: 270 });
});

test("Claude Code tool alias is restored in a streamed event", () => {
  const ctx = context("anthropic", "remote-magpie");
  apply(onProvider, request("anthropic", ["ReportFindings"]), ctx);
  const event = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "omp_report_findings", input: {} } };
  const out = apply(onEvent, event, ctx);
  assert.equal(out.content_block.name, "ReportFindings");
});

test("providers that never route to factory are untouched", () => {
  const ctx = context("anthropic", "zhipu");
  const body = request("anthropic", ["ScheduleWakeup"]);
  assert.deepEqual(apply(onProvider, body, ctx), body);
});
