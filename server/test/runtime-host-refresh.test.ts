import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, any>;
type Call = { name: string; args?: Json };
const tree = (id: string, text = "Synthetic folder") => ({ snapshotId: id, revision: 1, truncated: false, nodes: [
  { nodeId: "n1", text, bounds: [10, 20, 80, 90], enabled: true, clickable: true },
] });
const observed = (id: string, text?: string) => ({ ok: true, result: tree(id, text) });
const action = (id = "initial"): Call => ({ name: "act_and_observe", args: { action: "click_element", arguments: { snapshotId: id, nodeId: "n1" } } });
const accepted = (id = "immediate", text?: string) => ({ ok: true, result: { action: { accepted: true }, observation: tree(id, text) } });
const toolResults = (body: Json): Json[] => body.messages.filter((message: Json) => message.role === "tool").map((message: Json) => JSON.parse(message.content));
const advertised = (body: Json): string[] => body.tools.map((tool: Json) => tool.function.name);

async function scenario(plan: (turn: number, body: Json) => Call[] | undefined, execute: AgentOptions["execute"], signal?: AbortSignal, tools = clientTools) {
  let turn = 0;
  const events: Json[] = [];
  const requests: Json[] = [];
  const result = await runAgent({
    task: "Open the synthetic folder", tools, execute, signal, onEvent: event => events.push(event),
    model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" },
    modelFetch: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      requests.push(body);
      const calls = plan(turn++, body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: {
        role: "assistant", content: calls ? null : "Fixture complete",
        ...(calls ? { tool_calls: calls.map((call, i) => ({ id: `c${turn}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : {}),
      } }], usage: { total_tokens: 100 } }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { result, events, requests };
}

function assertValidToolPairs(body: Json) {
  const pending = new Set<string>();
  for (const message of body.messages) {
    if (message.role === "tool") {
      assert.ok(pending.delete(message.tool_call_id), `unexpected tool response ${message.tool_call_id}`);
    } else {
      assert.equal(pending.size, 0, "all previous tool responses must precede another message");
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

test("one host verification removes the model read round before a node-based touch fallback", async () => {
  let reads = 0;
  const actions: string[] = [];
  const { result, requests, events } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    if (turn === 0) return [action()];
    const latest = toolResults(body).at(-1)!;
    if (latest.hostGuidance?.code === "NATIVE_CLICK_INEFFECTIVE") {
      assert.equal(latest.result.snapshotId, "verified");
      return [{ name: "act_and_observe", args: { action: "tap_element", arguments: {
        snapshotId: latest.result.snapshotId, nodeId: "n1",
      } } }];
    }
    if (latest.hostGuidance?.code === "OBSERVATION_UNCHANGED") return [{ name: "get_ui_tree" }];
    return undefined;
  }, async (name, args) => {
    if (name === "get_ui_tree") return observed(++reads === 1 ? "initial" : "verified");
    actions.push(args.action as string);
    return args.action === "click_element" ? accepted() : accepted("opened", "Synthetic folder contents");
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 3, "click → fallback → finish, without a model round to request verification");
  assert.deepEqual(actions, ["click_element", "tap_element"]);
  assert.equal(reads, 2);
  assert.equal(result.metrics.toolCalls, 4);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(events.filter(event => event.type === "tool_end" && event.toolName === "get_ui_tree").length, 2);
});

test("tap verification reports the touch outcome without suggesting another swipe attempt", async () => {
  let reads = 0;
  const { result, events } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    assert.match(body.messages[0].content, /prefer tap_element with the latest snapshotId\/nodeId/);
    if (turn === 0) return [{ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: "initial", nodeId: "n1" } } }];
    const history = toolResults(body);
    assert.equal(history.at(-1)!.hostGuidance.code, "TOUCH_TAP_INEFFECTIVE");
    assert.match(history.at(-1)!.hostGuidance.message, /Do not repeat the tap or rename it to swipe/);
    const priorAction = history.find(entry => entry.hostAction);
    assert.deepEqual(priorAction.hostAction, { action: "tap_element", accepted: true, observationChanged: false });
    return undefined;
  }, async name => name === "get_ui_tree" ? observed(++reads === 1 ? "initial" : "verified") : accepted());
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.modelRequests, 2);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(reads, 2);
  assert.deepEqual(events.filter(event => event.type === "tool_start" && event.toolName === "act_and_observe").map(event => event.action), ["tap_element"]);
});

test("tap remains a UI-changing action and cannot share a batch with another action", async () => {
  const calls: string[] = [];
  const { result } = await scenario(() => [
    { name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: "initial", nodeId: "n1" } } },
    action(),
  ], async name => { calls.push(name); return observed("initial"); });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /UNOBSERVED_ACTION_BATCH/);
  assert.deepEqual(calls, ["get_ui_tree"], "the whole model batch must be rejected before any mutation");
});

test("recoverable snapshot errors get one fresh observation without replaying the action", async () => {
  for (const code of ["STALE_SNAPSHOT", "NO_KNOWN_SNAPSHOT", "READ_REQUIRED"]) {
    for (const nested of [false, true]) {
      const calls: string[] = [];
      const { result } = await scenario((turn, body) => {
        if (turn === 0) return [action()];
        assertValidToolPairs(body);
        const history = toolResults(body);
        assert.equal(history.at(-1)!.result.snapshotId, "refreshed");
        assert.ok(JSON.stringify(history).includes(code));
        return undefined;
      }, async name => {
        calls.push(name);
        if (name === "get_ui_tree") return observed(calls.length === 1 ? "initial" : "refreshed", "Synthetic refreshed page");
        return nested ? { ok: true, result: { action: { accepted: true }, observationError: { code } } } : { ok: false, error: { code } };
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
      assert.equal(result.metrics.modelRequests, 2);
      assert.equal(result.metrics.hostReads, 1);
    }
  }
});

test("a changed combined observation does not issue a host refresh", async () => {
  const calls: string[] = [];
  const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
    calls.push(name);
    return name === "get_ui_tree" ? observed("initial") : accepted("changed", "New synthetic page");
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
  assert.equal(result.metrics.hostReads, 0);
});

test("a preflight target refusal supplies the fresh UI without another host or model read round", async () => {
  const calls: string[] = [];
  const { result } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    if (turn === 0) return [action()];
    const latest = toolResults(body).at(-1)!;
    assert.equal(latest.ok, false);
    assert.equal(latest.error.code, "TARGET_CHANGED");
    assert.equal(latest.observation.snapshotId, "fresh-before-dispatch");
    assert.equal(latest.hostAction, undefined, "a refused target must never be recorded as accepted");
    assert.equal(advertised(body).includes("get_ui_tree"), false);
    return undefined;
  }, async name => {
    calls.push(name);
    return name === "get_ui_tree" ? observed("initial") : {
      ok: false, error: { code: "TARGET_CHANGED", message: "Target moved to a different context; no action sent." },
      observation: tree("fresh-before-dispatch", "Synthetic new context"), meta: { preflightRead: true, preflightMs: 12 },
    };
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
  assert.equal(result.metrics.preflightReads, 1);
  assert.equal(result.metrics.hostReads, 0);
  assert.equal(result.metrics.modelRequests, 2);
});

test("partial or unmarked failed-action observations cannot become current decision evidence", async () => {
  for (const condition of ["partial", "unmarked", "dispatched-error"]) {
    const { result } = await scenario((turn, body) => {
      if (turn === 0) return [action()];
      assert.ok(advertised(body).includes("get_ui_tree"));
      return undefined;
    }, async name => name === "get_ui_tree" ? observed("initial") : {
      ok: false, error: { code: condition === "dispatched-error" ? "ACTION_REJECTED" : "TARGET_CHANGED" },
      observation: { ...tree("unusable"), truncated: condition === "partial" },
      meta: { preflightRead: condition !== "unmarked" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /NO_OBSERVATION/);
    assert.equal(result.metrics.hostReads, 0);
  }
});

test("interrupted or unconfirmed gestures stop without refreshing or replaying accepted actions", async () => {
  for (const code of ["GESTURE_CANCELLED", "GESTURE_COMPLETION_TIMEOUT"]) {
    const calls: string[] = [];
    const { result } = await scenario(() => [action()], async name => {
      calls.push(name);
      return name === "get_ui_tree" ? observed("initial") : {
        ok: true, result: { action: { accepted: true, completion: code === "GESTURE_CANCELLED" ? "cancelled" : "unknown" }, observation: null, observationError: { code } },
      };
    });
    assert.equal(result.status, "failed");
    assert.match(result.error!, new RegExp(code));
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    assert.equal(result.metrics.modelRequests, 1);
  }
});

test("an explicit full read later in the same model batch satisfies verification without an extra read", async () => {
  let reads = 0;
  const { result } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    if (turn === 0) return [action(), { name: "get_ui_tree" }];
    assert.equal(toolResults(body).at(-1)!.hostGuidance.code, "NATIVE_CLICK_INEFFECTIVE");
    return undefined;
  }, async name => name === "get_ui_tree" ? observed(++reads === 1 ? "initial" : "explicit") : accepted());
  assert.equal(result.status, "completed");
  assert.equal(reads, 2);
  assert.equal(result.metrics.hostReads, 0);
});

test("restricted or terminal action errors never trigger automatic refresh or mutation replay", async () => {
  for (const code of ["MANUAL_ACTION_REQUIRED", "EMERGENCY_STOPPED", "WIRELESS_TIMEOUT", "PROTECTED_APP", "PASSWORD_FIELD_BLOCKED"]) {
    const calls: string[] = [];
    const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
      calls.push(name);
      return name === "get_ui_tree" ? observed("initial") : { ok: false, error: { code } };
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    assert.equal(result.metrics.hostReads, 0);
  }
});

test("cancellation before or during the host read stops without further model requests", async () => {
  for (const duringRead of [false, true]) {
    const controller = new AbortController();
    let reads = 0;
    const { result, requests } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
      if (name === "get_ui_tree") {
        reads++;
        if (reads === 2) { controller.abort(); return new Promise(() => {}); }
        return observed("initial");
      }
      if (!duringRead) controller.abort();
      return accepted();
    }, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(requests.length, 1);
    assert.equal(reads, duringRead ? 2 : 1);
  }
});

test("terminal errors during host refresh stop through the ordinary tool error gate", async () => {
  let reads = 0;
  const { result, requests } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => name === "get_ui_tree" ?
    ++reads === 1 ? observed("initial") : { ok: false, error: { code: "WIRELESS_DISCONNECTED" } } : accepted());
  assert.equal(result.status, "failed");
  assert.match(result.error!, /WIRELESS_DISCONNECTED/);
  assert.equal(requests.length, 1);
  assert.equal(reads, 2);
});

test("empty, partial or disabled-placeholder refresh data cannot certify task completion", async () => {
  for (const observation of [
    { snapshotId: "empty", nodes: [] },
    { snapshotId: "partial", elements: [{ nodeId: "n1", text: "Synthetic match" }] },
    { snapshotId: "placeholder", nodes: [{ nodeId: "n0", className: "android.view.View", bounds: [0, 0, 0, 0], enabled: false }] },
  ]) {
    let reads = 0;
    const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => name === "get_ui_tree" ?
      ++reads === 1 ? observed("initial") : { ok: true, result: observation } : { ok: false, error: { code: "STALE_SNAPSHOT" } });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /NO_OBSERVATION/);
    assert.equal(reads, 2, "a failed verification is not automatically polled again");
  }
});

test("accepted actions with missing or unusable observations get one host read before the next decision", async () => {
  const missing: Json[] = [
    {}, { observation: null },
    { observation: { ...tree("empty"), nodes: [] } },
    { observation: { ...tree("placeholder"), nodes: [{ nodeId: "n0", enabled: false }] } },
    ...["NO_ACTIVE_WINDOW", "BRIDGE_PROTOCOL_ERROR"].map(code => ({ observation: null, observationError: { code } })),
  ];
  for (const detail of missing) {
    const calls: string[] = [];
    const { result } = await scenario((turn, body) => {
      assertValidToolPairs(body);
      if (turn === 0) return [action()];
      assert.equal(toolResults(body).at(-1)!.result.snapshotId, "recovered");
      assert.equal(advertised(body).includes("get_ui_tree"), false);
      return undefined;
    }, async name => {
      calls.push(name);
      return name === "get_ui_tree" ? observed(calls.length === 1 ? "initial" : "recovered", "Synthetic recovered page") :
        { ok: true, result: { action: { accepted: true }, ...detail } };
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
    assert.equal(result.metrics.modelRequests, 2);
    assert.equal(result.metrics.hostReads, 1);
  }
});

test("a failed recovery read is not polled or treated as a usable post-action screen", async () => {
  let reads = 0;
  const { result } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    if (turn === 0) return [action()];
    assert.ok(advertised(body).includes("get_ui_tree"));
    return undefined;
  }, async name => name === "get_ui_tree" ? ++reads === 1 ? observed("initial") :
    { ok: false, error: { code: "NO_ACTIVE_WINDOW" } } : { ok: true, result: { action: { accepted: true }, observation: null } });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /NO_OBSERVATION/);
  assert.equal(reads, 2);
  assert.equal(result.metrics.hostReads, 1);
});

test("nested restricted, terminal or unclassified observation errors never trigger automatic recovery", async () => {
  for (const code of ["PROTECTED_APP", "PASSWORD_FIELD_BLOCKED", "MANUAL_ACTION_REQUIRED", "EMERGENCY_STOPPED", "WIRELESS_TIMEOUT", "INTERNAL_ERROR"]) {
    const calls: string[] = [];
    const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
      calls.push(name);
      return name === "get_ui_tree" ? observed("initial") :
        { ok: true, result: { action: { accepted: true }, observation: null, observationError: { code } } };
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    assert.equal(result.metrics.hostReads, 0);
  }
});

test("event-only and selector waits automatically supply the complete screen, including after timeout", async () => {
  for (const selector of [undefined, { text: "Synthetic match" }]) {
    for (const timedOut of [false, true]) {
      const calls: string[] = [];
      const { result } = await scenario((turn, body) => {
        assertValidToolPairs(body);
        if (turn === 0) return [{ name: "wait_for_ui_change", args: { sinceRevision: 1, timeoutMs: 1, ...(selector ? { selector } : {}) } }];
        assert.equal(toolResults(body).at(-1)!.result.snapshotId, "after-wait");
        assert.equal(advertised(body).includes("get_ui_tree"), false);
        return undefined;
      }, async name => {
        calls.push(name);
        if (name === "get_ui_tree") return observed(calls.length === 1 ? "initial" : "after-wait", "Synthetic ready page");
        return { ok: true, result: { revision: 2, changed: !timedOut, timedOut, matched: Boolean(selector) && !timedOut,
          ...(selector ? { snapshotId: "partial-wait", elements: timedOut ? [] : [{ nodeId: "n1", text: selector.text }] } : {}) } };
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(calls, ["get_ui_tree", "wait_for_ui_change", "get_ui_tree"]);
      assert.equal(result.metrics.modelRequests, 2);
      assert.equal(result.metrics.hostReads, 1);
    }
  }
});

test("a full read in the same wait batch satisfies recovery without a second host read", async () => {
  let reads = 0;
  const { result } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    return turn === 0 ? [
      { name: "wait_for_ui_change", args: { sinceRevision: 1, timeoutMs: 1 } }, { name: "get_ui_tree" },
    ] : undefined;
  }, async name => name === "get_ui_tree" ? observed(++reads === 1 ? "initial" : "explicit", "Synthetic ready page") :
    { ok: true, result: { revision: 2, changed: true, timedOut: false } });
  assert.equal(result.status, "completed");
  assert.equal(reads, 2);
  assert.equal(result.metrics.hostReads, 0);
});

test("cancellation after an event-only wait prevents its recovery read and the next model request", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { result, requests } = await scenario(() => [
    { name: "wait_for_ui_change", args: { sinceRevision: 1, timeoutMs: 1 } },
  ], async name => {
    calls.push(name);
    if (name === "get_ui_tree") return observed("initial");
    controller.abort();
    return { ok: true, result: { revision: 2, changed: true } };
  }, controller.signal);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, ["get_ui_tree", "wait_for_ui_change"]);
  assert.equal(requests.length, 1);
});

test("complete observations reduce advertised tools and avoid a model round requesting the same screen", async () => {
  for (const canWait of [false, true]) {
    const supplied = canWait ? clientTools : clientTools.filter(tool => tool.name !== "wait_for_ui_change");
    const calls: string[] = [];
    const { result, requests } = await scenario((turn, body) => {
      assertValidToolPairs(body);
      const names = advertised(body);
      assert.ok(names.includes("get_current_app"), "Activity information remains available");
      if (canWait) {
        assert.ok(names.includes("wait_for_ui_change"));
        assert.equal(names.includes("get_ui_tree"), false);
        assert.equal(names.includes("find_element"), false);
        assert.equal(names.length, supplied.length - 2);
      }
      if (turn === 0) return [action()];
      if (turn === 1 && names.includes("get_ui_tree")) return [{ name: "get_ui_tree" }];
      assert.equal(toolResults(body).at(-1)!.result.observation?.snapshotId ?? toolResults(body).at(-1)!.result.snapshotId, "after-action");
      return undefined;
    }, async name => {
      calls.push(name);
      return name === "get_ui_tree" ? observed(calls.length === 1 ? "initial" : "after-action", calls.length === 1 ? "Synthetic folder" : "Synthetic opened page") :
        accepted("after-action", "Synthetic opened page");
    }, undefined, supplied);
    assert.equal(result.status, "completed");
    assert.equal(requests.length, canWait ? 2 : 3);
    assert.deepEqual(calls, canWait ? ["get_ui_tree", "act_and_observe"] : ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
    assert.equal(result.metrics.hostReads, 0);
  }
});

test("partial finds and failed actions restore read tools; unadvertised historical calls still execute freshly", async () => {
  let reads = 0;
  const calls: string[] = [];
  const { result } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    const names = advertised(body);
    if (turn === 0) {
      assert.equal(names.includes("find_element"), false);
      return [{ name: "find_element", args: { selector: { text: "Synthetic match" } } }];
    }
    if (turn === 1) {
      assert.ok(names.includes("get_ui_tree"));
      assert.ok(names.includes("find_element"));
      return [{ name: "get_ui_tree" }];
    }
    if (turn === 2) {
      assert.equal(toolResults(body).at(-1)!.result.snapshotId, "fresh-read");
      assert.equal(names.includes("get_ui_tree"), false);
      return [action("fresh-read")];
    }
    assert.ok(names.includes("get_ui_tree"));
    return undefined;
  }, async name => {
    calls.push(name);
    if (name === "get_ui_tree") return observed(++reads === 1 ? "initial" : "fresh-read", "Synthetic refreshed page");
    if (name === "find_element") return { ok: true, result: { snapshotId: "partial", revision: 2, elements: [{ nodeId: "n1", text: "Synthetic match" }] } };
    return { ok: false, error: { code: "NOT_CLICKABLE" } };
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /NO_OBSERVATION/);
  assert.deepEqual(calls, ["get_ui_tree", "find_element", "get_ui_tree", "act_and_observe"]);
  assert.equal(reads, 2);
});

test("truncated screens or an unusable event-wait schema retain explicit read tools", async () => {
  for (const condition of ["truncated", "invalid-wait-schema", "missing-revision"]) {
    const supplied = condition === "invalid-wait-schema" ? clientTools.map(tool => tool.name === "wait_for_ui_change" ? {
      ...tool, inputSchema: { type: "object", properties: { sinceRevision: { type: "integer" }, timeoutMs: { type: "integer", minimum: 2 } },
        required: ["sinceRevision", "timeoutMs"], additionalProperties: false },
    } : tool) : clientTools;
    const { result } = await scenario((_turn, body) => {
      assert.ok(advertised(body).includes("get_ui_tree"));
      assert.ok(advertised(body).includes("find_element"));
      return undefined;
    }, async () => ({ ok: true, result: { ...tree("initial"),
      ...(condition === "truncated" ? { truncated: true } : {}), ...(condition === "missing-revision" ? { revision: undefined } : {}),
    } }), undefined, supplied);
    assert.equal(result.status, "completed");
  }
});
