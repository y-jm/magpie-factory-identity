const ORIGINAL = "You are omp's trusted coding assistant.";
const REPLACEMENT = "You are droid's trusted coding assistant.";
const TOOL_ALIASES = new Map([
  ["_read", "omp_read"], ["_bash", "omp_bash"], ["_edit", "omp_edit"],
  ["_ask", "omp_ask"], ["_eval", "omp_eval"], ["_glob", "omp_glob"],
  ["_grep", "omp_grep"], ["_task", "omp_task"], ["_wait", "omp_wait"],
  ["_todo", "omp_todo"], ["_write", "omp_write"],
  ["web_search", "omp_web_search"],
]);

export function onProvider(body, ctx) {
  // 每次上游尝试都从入口请求开始，不能沿用上一次的映射或流状态。
  ctx.state.factoryIdentity = undefined;
  if (ctx.provider?.id !== "factory") return;

  const state = { reverse: new Map(), originalNames: new Set(), streams: new Map() };
  const rename = (name) => renameRequestTool(name, state);
  let result = body;

  switch (ctx.protocol) {
    case "anthropic":
      result = mapField(result, "system", replaceContent);
      result = mapField(result, "tools", (tools) => mapList(tools, (tool) => mapName(tool, rename)));
      result = mapField(result, "tool_choice", (choice) =>
        choice?.type === "tool" ? mapName(choice, rename) : choice);
      result = mapField(result, "messages", (messages) => mapList(messages, (message) =>
        mapField(message, "content", (content) => mapAnthropicContent(content, rename))));
      break;
    case "chat":
      result = mapField(result, "tools", (tools) => mapList(tools, (tool) => mapChatTool(tool, rename)));
      result = mapField(result, "tool_choice", (choice) => mapChatChoice(choice, rename));
      result = mapField(result, "messages", (messages) => mapList(messages, (message) =>
        mapChatMessage(message, rename, true)));
      break;
    case "responses":
      result = mapField(result, "instructions", replaceText);
      result = mapField(result, "tools", (tools) => mapList(tools, (tool) => mapResponsesTool(tool, rename)));
      result = mapField(result, "tool_choice", (choice) => mapResponsesChoice(choice, rename));
      result = mapField(result, "input", (items) => mapList(items, (item) => {
        const message = replaceMessage(item);
        return mapResponsesItem(message, rename);
      }));
      break;
    case "gemini":
      for (const key of ["systemInstruction", "system_instruction"]) {
        result = mapField(result, key, (instruction) => mapField(instruction, "parts", replaceContent));
      }
      result = mapField(result, "tools", (tools) => mapList(tools, (tool) => mapGeminiTool(tool, rename)));
      for (const key of ["toolConfig", "tool_config"]) {
        result = mapField(result, key, (config) => mapGeminiConfig(config, rename));
      }
      result = mapField(result, "contents", (contents) => mapList(contents, (content) =>
        mapGeminiContent(content, rename, true)));
      break;
    default:
      return;
  }

  if (state.reverse.size) ctx.state.factoryIdentity = state;
  if (result !== body) return result;
}

export function onResponse(body, ctx) {
  const state = ctx.state.factoryIdentity;
  if (ctx.provider?.id !== "factory" || !state) return;
  const restore = (name) => state.reverse.get(name) ?? name;
  let result = body;

  switch (ctx.protocol) {
    case "anthropic":
      result = mapField(result, "content", (content) => mapAnthropicContent(content, restore));
      break;
    case "chat":
      result = mapField(result, "choices", (choices) => mapList(choices, (choice) =>
        mapField(choice, "message", (message) => mapChatMessage(message, restore, false))));
      break;
    case "responses":
      result = mapField(result, "output", (items) => mapList(items, (item) => mapResponsesItem(item, restore)));
      break;
    case "gemini":
      result = mapField(result, "candidates", (candidates) => mapList(candidates, (candidate) =>
        mapField(candidate, "content", (content) => mapGeminiContent(content, restore, false))));
      break;
  }
  if (result !== body) return result;
}

export function onEvent(event, ctx) {
  const state = ctx.state.factoryIdentity;
  if (ctx.provider?.id !== "factory" || !state) return;
  const restore = (name) => state.reverse.get(name) ?? name;
  let result = event;

  switch (ctx.protocol) {
    case "anthropic":
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        result = mapField(event, "content_block", (block) => mapName(block, restore));
      }
      break;
    case "chat":
      result = mapField(event, "choices", (choices) => mapList(choices, (choice) =>
        mapChatStreamChoice(choice, state)));
      break;
    case "responses":
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        result = mapField(event, "item", (item) => mapResponsesItem(item, restore));
      }
      result = mapField(result, "response", (response) => mapField(response, "output", (items) =>
        mapList(items, (item) => mapResponsesItem(item, restore))));
      break;
    case "gemini":
      result = mapField(event, "candidates", (candidates) => mapList(candidates, (candidate) =>
        mapField(candidate, "content", (content) => mapGeminiContent(content, restore, false))));
      break;
  }
  if (result !== event) return result;
}

function replaceText(text) {
  if (typeof text !== "string" || !text.includes(ORIGINAL)) return text;
  return text.split(ORIGINAL).join(REPLACEMENT);
}

function replaceContent(content) {
  if (typeof content === "string") return replaceText(content);
  if (!Array.isArray(content)) return content;

  let changed = false;
  const result = content.map((block) => {
    if (!block || (block.type !== undefined && block.type !== "text" && block.type !== "input_text")) {
      return block;
    }
    const text = replaceText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? result : content;
}

function replaceMessage(message) {
  if (message?.role !== "system" && message?.role !== "developer") return message;
  return mapField(message, "content", replaceContent);
}

function renameRequestTool(name, state) {
  if (typeof name !== "string") return name;
  const alias = TOOL_ALIASES.get(name);
  if (alias !== undefined) {
    if (state.originalNames.has(alias)) throw new Error(`Factory 工具名称冲突：${name} 与 ${alias}`);
    state.reverse.set(alias, name);
    return alias;
  }
  if (state.reverse.has(name)) {
    throw new Error(`Factory 工具名称冲突：${state.reverse.get(name)} 与 ${name}`);
  }
  state.originalNames.add(name);
  return name;
}

function mapField(object, key, transform) {
  if (!object || typeof object !== "object") return object;
  const value = transform(object[key]);
  return value === object[key] ? object : { ...object, [key]: value };
}

function mapList(list, transform) {
  if (!Array.isArray(list)) return list;
  let result;
  for (let index = 0; index < list.length; index++) {
    const value = transform(list[index]);
    if (value !== list[index]) {
      if (!result) result = list.slice();
      result[index] = value;
    }
  }
  return result ?? list;
}

function mapName(object, rename) {
  return mapField(object, "name", rename);
}

function mapAnthropicContent(content, rename) {
  return mapList(content, (block) => block?.type === "tool_use" ? mapName(block, rename) : block);
}

function mapChatTool(tool, rename) {
  if ((tool?.type === "function" || tool?.type === undefined) && tool?.function) {
    return mapField(tool, "function", (definition) => mapName(definition, rename));
  }
  if ((tool?.type === "custom" || tool?.type === undefined) && tool?.custom) {
    return mapField(tool, "custom", (definition) => mapName(definition, rename));
  }
  return tool;
}

function mapChatChoice(choice, rename) {
  if (choice?.type === "allowed_tools") {
    return mapField(choice, "tools", (tools) => mapList(tools, (tool) => mapChatTool(tool, rename)));
  }
  return mapChatTool(choice, rename);
}

function mapChatMessage(message, rename, request) {
  let result = request ? replaceMessage(message) : message;
  result = mapField(result, "tool_calls", (calls) => mapList(calls, (call) => mapChatTool(call, rename)));
  return result;
}

function mapResponsesTool(tool, rename) {
  return tool?.type === "function" || tool?.type === "custom" ? mapName(tool, rename) : tool;
}

function mapResponsesChoice(choice, rename) {
  if (choice?.type === "allowed_tools") {
    return mapField(choice, "tools", (tools) => mapList(tools, (tool) => mapResponsesTool(tool, rename)));
  }
  return mapResponsesTool(choice, rename);
}

function mapResponsesItem(item, rename) {
  return item?.type === "function_call" || item?.type === "custom_tool_call"
    ? mapName(item, rename) : item;
}

function mapGeminiTool(tool, rename) {
  let result = tool;
  for (const key of ["functionDeclarations", "function_declarations"]) {
    result = mapField(result, key, (declarations) => mapList(declarations, (declaration) =>
      mapName(declaration, rename)));
  }
  return result;
}

function mapGeminiConfig(config, rename) {
  let result = config;
  for (const key of ["functionCallingConfig", "function_calling_config"]) {
    result = mapField(result, key, (calling) => {
      let next = calling;
      for (const namesKey of ["allowedFunctionNames", "allowed_function_names"]) {
        next = mapField(next, namesKey, (names) => mapList(names, rename));
      }
      return next;
    });
  }
  return result;
}

function mapGeminiContent(content, rename, request) {
  return mapField(content, "parts", (parts) => mapList(parts, (part) => {
    let result = part;
    for (const key of ["functionCall", "function_call"]) {
      result = mapField(result, key, (call) => mapName(call, rename));
    }
    if (request) {
      for (const key of ["functionResponse", "function_response"]) {
        result = mapField(result, key, (response) => mapName(response, rename));
      }
    }
    return result;
  }));
}

function mapChatStreamChoice(choice, state) {
  if (!choice || typeof choice !== "object") return choice;
  let stream = state.streams.get(choice.index);
  const delta = choice.delta;
  if (!stream && Array.isArray(delta?.tool_calls)) {
    stream = { tools: new Map() };
    state.streams.set(choice.index, stream);
  }
  if (!stream) return choice;

  let next = mapField(delta, "tool_calls", (calls) => mapList(calls, (call) => {
    const kind = call?.function ? "function" : call?.custom ? "custom" : undefined;
    if (!kind || (call.type !== undefined && call.type !== kind)) return call;
    return mapField(call, kind, (part) => mapChatStreamName(part, stream.tools, call.index, kind, state));
  }));

  if (choice.finish_reason != null) {
    next = flushChatStreamNames(next, stream, state.reverse);
    state.streams.delete(choice.index);
  }
  return next === delta ? choice : { ...choice, delta: next };
}

function mapChatStreamName(part, calls, index, kind, state) {
  if (!part || typeof part !== "object") return part;
  const pending = calls.get(index);
  if (pending?.done) return part;

  const fragment = part.name;
  const input = kind === "custom" ? part.input : part.arguments;
  const inputStarted = typeof input === "string" && input.length > 0;
  const started = pending?.started || inputStarted;
  if (!pending && (typeof fragment !== "string" || fragment.length === 0)) return part;
  if (pending && typeof fragment !== "string" && !inputStarted) return part;

  const name = (pending?.name ?? "") + (typeof fragment === "string" ? fragment : "");
  let possible = false;
  for (const alias of state.reverse.keys()) {
    if (alias.startsWith(name)) {
      possible = true;
      break;
    }
  }

  // 参数也可能与名称交错分片；完整别名还可能是另一个已声明名称的前缀。
  let ambiguous = false;
  if (state.reverse.has(name)) {
    for (const original of state.originalNames) {
      if (original.length > name.length && original.startsWith(name)) {
        ambiguous = true;
        break;
      }
    }
  }
  const complete = !possible || (started && state.reverse.has(name) && !ambiguous);
  calls.set(index, complete ? { done: true } : { name, kind, started });
  const value = complete ? (state.reverse.get(name) ?? name) : "";
  return value === fragment ? part : { ...part, name: value };
}

function flushChatStreamNames(delta, stream, reverse) {
  let result = delta;
  for (const [index, pending] of stream.tools) {
    if (pending.done) continue;
    const name = reverse.get(pending.name) ?? pending.name;
    const calls = Array.isArray(result?.tool_calls) ? result.tool_calls.slice() : [];
    const position = calls.findIndex((call) => call?.index === index);
    if (position < 0) {
      calls.push({ index, [pending.kind]: { name } });
    } else {
      const call = calls[position];
      calls[position] = { ...call, [pending.kind]: { ...call[pending.kind], name } };
    }
    result = { ...result, tool_calls: calls };
  }
  return result;
}
