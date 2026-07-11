"use client";

import { safeUUID } from "@workspace/core/lib/uuid";
import {
  type AgentMessage,
  useAgentStore,
} from "@workspace/core/stores/agent-store";
import { useWorkspaceStore } from "@workspace/core/stores/workspace-store";
import { Button } from "@workspace/ui/components/button";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import {
  Loader2,
  Send,
  Sparkles,
  Square,
  TerminalSquare,
  User,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const MAX_ITERATIONS = 20;
const MAX_HISTORY_CHARS = 2000;
const NUMBER_REGEX = /\d+/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveAgentPanes(
  agentIdInput: string,
  targetPanes: { id: string; title: string }[]
): { id: string; title: string }[] {
  const cleanId = agentIdInput.trim().toLowerCase();

  if (cleanId === "all") {
    return targetPanes;
  }

  // 1. Direct UUID match
  const directMatch = targetPanes.filter((p) => p.id === agentIdInput);
  if (directMatch.length > 0) {
    return directMatch;
  }

  // 2. Index match (e.g. "1" or "2" or "Agent 1" or "Terminal 1")
  const numberMatch = cleanId.match(NUMBER_REGEX);
  if (numberMatch) {
    const index = Number.parseInt(numberMatch[0], 10) - 1;
    if (index >= 0 && index < targetPanes.length) {
      const pane = targetPanes[index];
      if (pane) {
        return [pane];
      }
    }
  }

  // 3. Title match (case-insensitive substring)
  const titleMatch = targetPanes.filter((p) =>
    p.title.toLowerCase().includes(cleanId)
  );
  if (titleMatch.length > 0) {
    return titleMatch;
  }

  return [];
}

function buildSystemPrompt(panes: { id: string; title: string }[]): string {
  const agentList = panes
    .map((p, i) => `  - Agent ${i + 1}: id="${p.id}" (${p.title})`)
    .join("\n");

  return `You are the Hyperion Main Agent — an elite Autonomous Workspace Orchestrator. You coordinate multiple terminal sessions to accomplish complex, multi-step engineering tasks.

## Your Terminal Agents
You have ${panes.length} AI coding assistants (e.g. Claude Code) running in separate terminals:
${agentList}

## Your Tools
1. prompt_agent(agent_id, prompt) — Type a natural-language instruction into a Terminal Agent's input. This ONLY types the text — it does NOT press Enter.
2. send_prompt(agent_id) — Press Enter on the Terminal Agent to submit the typed prompt. You MUST call this after every prompt_agent call.
3. observe_agent(agent_id) — Read the Terminal Agent's recent output to check progress.
4. wait(seconds) — Pause for 1-30 seconds. ALWAYS wait 5-15 seconds after submitting a prompt before observing.

## Coordination & Orchestration Rules (STRICTLY enforced)
1. **Multi-Terminal Coordination**: You can orchestrate multiple terminals at once. For example, you can launch a dev server on Agent 1, and run tests/linters on Agent 2. Make sure you track the role and progress of each session.
2. **Context Preservation**: Always remember what task you assigned to each terminal. Treat the terminals as your team of developers.
3. **Stall & Progress Monitoring**: After submitting a prompt, you MUST call wait(10) then observe_agent(agent_id).
   - If the terminal output shows the task is still running (e.g. download in progress, server starting, build running), do NOT stop. Call wait(10) and observe_agent again. Repeat until it finishes.
   - If the output is unchanged twice in a row, the terminal might be stuck or command was not submitted. Re-type and re-submit the prompt.
4. **Auto-Recovery & Retries**: If a terminal command fails or returns an error:
   - Analyze the error.
   - Send a follow-up corrective prompt to that terminal (or another helper terminal) to resolve the issue (e.g. run "npm install" for missing dependencies, adjust config settings).
   - Retry the operation. Never give up on first failure.
5. **Completion Verification**: You must continue your execution loop until you have read the terminal outputs and verified that all tasks succeeded. Once complete, summarize the work done and confirm success.

## Critical Rules
- You are a PLANNER. NEVER send raw bash commands like 'ls', 'cat', 'cd'. Write prompts in natural language.
- Each prompt must be ONE LINE, under 200 characters. No newlines.
- ALWAYS call send_prompt() immediately after prompt_agent().
- ONLY target agent IDs listed in the active Terminal Agents section.
- If the task is simple and doesn't require terminals, answer directly without tools.`;
}

const TOOLS_DEFINITION = [
  {
    type: "function" as const,
    function: {
      name: "prompt_agent",
      description:
        "Type a short, single-line natural language instruction into a Terminal Agent's input. This ONLY types the text — you MUST call send_prompt after this to actually submit it.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description:
              "The agent ID from the list, or 'all' to prompt every agent.",
          },
          prompt: {
            type: "string",
            description:
              "A short, single-line natural language instruction (under 200 chars, no newlines).",
          },
        },
        required: ["agent_id", "prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_prompt",
      description:
        "Press Enter on a Terminal Agent to submit the previously typed prompt. MUST be called after every prompt_agent call.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description:
              "The agent ID to press Enter on, or 'all' to submit on all agents.",
          },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "observe_agent",
      description:
        "Read the recent output of a Terminal Agent to check their progress and response.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "The agent ID from the list.",
          },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "wait",
      description:
        "Pause execution for a number of seconds. Use this after sending a prompt to give the agent time to process before observing.",
      parameters: {
        type: "object",
        properties: {
          seconds: {
            type: "number",
            description: "Number of seconds to wait (1-30).",
          },
        },
        required: ["seconds"],
      },
    },
  },
];

export function AgentSidebar() {
  const {
    isOpen,
    toggleOpen,
    messages,
    addMessage,
    apiKey,
    baseUrl,
    selectedModel,
  } = useAgentStore();
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();

  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [iterationCount, setIterationCount] = useState(0);
  const [targetTerminalId, setTargetTerminalId] = useState<string>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspaceMessages = activeWorkspaceId
    ? (messages[activeWorkspaceId] ?? [])
    : [];

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message count changes
  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [workspaceMessages.length]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex agent execution loop
  const handleSend = async () => {
    if (!(input.trim() && activeWorkspaceId && activeWorkspace)) {
      return;
    }

    if (!(apiKey && selectedModel)) {
      toast.error("Please configure your AI Provider in Settings first.");
      return;
    }

    const userMessage: AgentMessage = {
      id: safeUUID(),
      role: "user",
      content: input,
      timestamp: Date.now(),
    };

    addMessage(activeWorkspaceId, userMessage);
    setInput("");
    setIsTyping(true);
    setIterationCount(0);

    try {
      abortControllerRef.current = new AbortController();

      const targetedPanes =
        targetTerminalId === "all"
          ? activeWorkspace.panes
          : activeWorkspace.panes.filter((p) => p.id === targetTerminalId);

      const systemPrompt = buildSystemPrompt(targetedPanes);

      // biome-ignore lint/suspicious/noExplicitAny: message array matches LLM format
      const currentMessages: any[] = [
        { role: "system", content: systemPrompt },
        ...workspaceMessages.map((m) => ({
          role: m.role === "agent" ? "assistant" : m.role,
          content: m.content,
        })),
        { role: "user", content: userMessage.content },
      ];

      let isFinished = false;
      const isTauri =
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      let finalAgentContent = "";
      let iterations = 0;
      const lastObservedOutput: Record<string, string> = {};

      while (!isFinished && iterations < MAX_ITERATIONS) {
        iterations++;
        setIterationCount(iterations);

        // Check if aborted
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        const requestBody = {
          model: selectedModel,
          messages: currentMessages,
          tools: TOOLS_DEFINITION,
        };

        // biome-ignore lint/suspicious/noExplicitAny: API data object type
        let data: any;
        if (isTauri) {
          const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
          const res = await tauriFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal: abortControllerRef.current?.signal,
          });
          if (!res.ok) {
            throw new Error(`API Error: ${res.status}`);
          }
          data = await res.json();
        } else {
          const res = await fetch("/api/proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: `${baseUrl}/chat/completions`,
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}` },
              body: requestBody,
            }),
            signal: abortControllerRef.current?.signal,
          });
          if (!res.ok) {
            throw new Error(`Proxy API Error: ${res.status}`);
          }
          data = await res.json();
        }

        const message = data.choices?.[0]?.message;
        if (!message) {
          throw new Error("No message returned from API.");
        }

        if (message.content) {
          finalAgentContent +=
            (finalAgentContent ? "\n" : "") + message.content;
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
          currentMessages.push(message);

          if (isTauri) {
            const { invoke } = await import("@tauri-apps/api/core");

            for (const toolCall of message.tool_calls) {
              const fnName = toolCall.function.name;
              const args = JSON.parse(toolCall.function.arguments);

              if (fnName === "prompt_agent") {
                const agentId = args.agent_id;
                const prompt = args.prompt;
                const targetPanes =
                  targetTerminalId === "all"
                    ? activeWorkspace.panes
                    : activeWorkspace.panes.filter(
                        (p) => p.id === targetTerminalId
                      );

                const panesToRun = resolveAgentPanes(agentId, targetPanes);

                if (panesToRun.length === 0) {
                  currentMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: `Error: No agent found with id "${agentId}" under the targeted selection. Available agents: ${targetPanes.map((p, i) => `"${p.id}" (Agent ${i + 1})`).join(", ")}`,
                  });
                  continue;
                }

                // Clean: strip newlines, trim, cap length
                const cleanPrompt = prompt
                  .replace(/[\n\r]/g, " ")
                  .trim()
                  .slice(0, 500);

                for (const pane of panesToRun) {
                  await invoke("write_terminal", {
                    id: pane.id,
                    data: cleanPrompt,
                  });
                }

                currentMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Prompt typed into ${panesToRun.length} agent(s). Now call send_prompt() to press Enter and submit it.`,
                });
              } else if (fnName === "send_prompt") {
                const agentId = args.agent_id;
                const targetPanes =
                  targetTerminalId === "all"
                    ? activeWorkspace.panes
                    : activeWorkspace.panes.filter(
                        (p) => p.id === targetTerminalId
                      );

                const panesToSend = resolveAgentPanes(agentId, targetPanes);

                if (panesToSend.length === 0) {
                  currentMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: `Error: No agent found with id "${agentId}" under the targeted selection.`,
                  });
                  continue;
                }

                // Small delay to let the terminal process the typed text
                await sleep(200);

                for (const pane of panesToSend) {
                  await invoke("write_terminal", {
                    id: pane.id,
                    data: "\r",
                  });
                }

                currentMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Enter pressed on ${panesToSend.length} agent(s). Prompt submitted. Now call wait(10) then observe_agent() to check the response.`,
                });
              } else if (fnName === "observe_agent") {
                const agentId = args.agent_id;
                const targetPanes =
                  targetTerminalId === "all"
                    ? activeWorkspace.panes
                    : activeWorkspace.panes.filter(
                        (p) => p.id === targetTerminalId
                      );

                const panesToObserve = resolveAgentPanes(agentId, targetPanes);
                const pane = panesToObserve[0];

                if (!pane) {
                  currentMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: `Error: No agent found with id "${agentId}" under the targeted selection.`,
                  });
                  continue;
                }

                try {
                  const info: { history: string } = await invoke(
                    "get_terminal_history",
                    { id: pane.id }
                  );
                  const rawOutput = info.history.trim();

                  if (!rawOutput) {
                    currentMessages.push({
                      role: "tool",
                      tool_call_id: toolCall.id,
                      content:
                        "[Terminal output is empty. The agent may not have started yet. Try waiting longer.]",
                    });
                    continue;
                  }

                  // Truncate to last N chars to avoid context bloat
                  const truncatedOutput = rawOutput.slice(-MAX_HISTORY_CHARS);

                  // Stale-detection
                  const lastOutput = lastObservedOutput[pane.id] ?? "";
                  if (truncatedOutput === lastOutput) {
                    currentMessages.push({
                      role: "tool",
                      tool_call_id: toolCall.id,
                      content: `[Output unchanged since last observation. The agent may still be processing, or the prompt was not received. Try waiting longer with wait(15), or re-send the prompt with prompt_agent.]\n\nLast output:\n${truncatedOutput}`,
                    });
                  } else {
                    lastObservedOutput[pane.id] = truncatedOutput;
                    currentMessages.push({
                      role: "tool",
                      tool_call_id: toolCall.id,
                      content: truncatedOutput,
                    });
                  }
                } catch (e) {
                  const err = e as Error;
                  currentMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: `Error reading agent output: ${err.message || err}`,
                  });
                }
              } else if (fnName === "wait") {
                const seconds = Math.min(
                  30,
                  Math.max(1, Number(args.seconds) || 5)
                );
                await sleep(seconds * 1000);
                currentMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Waited ${seconds} seconds.`,
                });
              } else {
                currentMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Unknown tool: ${fnName}`,
                });
              }
            }
          } else {
            // Not in Tauri, simulate tool success
            for (const toolCall of message.tool_calls) {
              currentMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content:
                  "Simulated tool execution (Native terminal tools not available in browser)",
              });
            }
            isFinished = true;
          }
        } else {
          isFinished = true;
        }
      }

      if (iterations >= MAX_ITERATIONS) {
        finalAgentContent +=
          "\n\n⚠️ Reached maximum iteration limit (20). Stopping execution.";
      }

      if (finalAgentContent) {
        const agentMessage: AgentMessage = {
          id: safeUUID(),
          role: "agent",
          content: finalAgentContent,
          timestamp: Date.now(),
        };
        addMessage(activeWorkspaceId, agentMessage);
      }
    } catch (error) {
      const err = error as Error;
      if (err.name === "AbortError") {
        console.log("Agent loop aborted by user");
        toast.info("Agent execution stopped.");
      } else {
        console.error("Failed to execute agent prompt", err);
        toast.error(err.message || "Failed to communicate with LLM");
      }
    } finally {
      setIsTyping(false);
      setIterationCount(0);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsTyping(false);
  };

  return (
    <AnimatePresence>
      {isOpen && activeWorkspace && (
        <motion.div
          animate={{ width: "400px", opacity: 1 }}
          className="flex h-full shrink-0 flex-col overflow-hidden border-border/40 border-l bg-background/50 backdrop-blur-xl"
          exit={{ width: 0, opacity: 0 }}
          initial={{ width: 0, opacity: 0 }}
          key="agent-sidebar"
          transition={{ bounce: 0, duration: 0.3, type: "spring" }}
        >
          <div className="flex h-full w-[400px] flex-col overflow-hidden">
            {/* Header */}
            <div className="flex h-14 shrink-0 items-center justify-between border-border/40 border-b px-4">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
                  <Sparkles className="size-4 text-primary" />
                </div>
                <span className="font-semibold text-sm tracking-tight">
                  Main Agent
                </span>
              </div>
              <Button
                className="size-7 rounded-lg hover:bg-muted"
                onClick={() => toggleOpen()}
                size="icon"
                variant="ghost"
              >
                <X className="size-4 text-muted-foreground" />
              </Button>
            </div>

            {/* Chat History */}
            <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
              <div className="flex flex-col gap-4 p-4">
                {workspaceMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 pt-10 text-center text-muted-foreground">
                    <Sparkles className="size-8 opacity-20" />
                    <p className="text-sm">
                      I'm your Main Agent.
                      <br />
                      Ask me to plan and execute tasks across your AI terminal
                      agents.
                    </p>
                  </div>
                ) : (
                  workspaceMessages.map((msg) => (
                    <div
                      className={cn(
                        "flex gap-3 text-sm",
                        msg.role === "user" ? "flex-row-reverse" : "flex-row"
                      )}
                      key={msg.id}
                    >
                      <div
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                          msg.role === "user"
                            ? "border-primary/20 bg-primary/10 text-primary"
                            : "border-border/40 bg-muted text-foreground"
                        )}
                      >
                        {msg.role === "user" ? (
                          <User className="size-4" />
                        ) : (
                          <Sparkles className="size-4" />
                        )}
                      </div>
                      <div
                        className={cn(
                          "flex flex-col gap-1 rounded-2xl px-4 py-3",
                          msg.role === "user"
                            ? "rounded-tr-sm bg-primary text-primary-foreground"
                            : "rounded-tl-sm border border-border/40 bg-muted/60 text-foreground"
                        )}
                      >
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  ))
                )}
                {isTyping && (
                  <div className="flex flex-row gap-3 text-sm">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted text-foreground">
                      <Sparkles className="size-4" />
                    </div>
                    <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border/40 bg-muted/60 px-4 py-3 text-foreground">
                      <Loader2 className="size-4 animate-spin opacity-70" />
                      <span className="text-xs opacity-70">
                        {iterationCount > 0
                          ? `Working... (step ${iterationCount}/${MAX_ITERATIONS})`
                          : "Thinking..."}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="shrink-0 border-border/40 border-t bg-background/50 p-4 backdrop-blur-md">
              <div className="flex flex-col gap-3 overflow-hidden rounded-xl border border-border/50 bg-background transition-all duration-200 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/50">
                <Textarea
                  className="min-h-[80px] w-full resize-none border-0 bg-transparent p-3 text-sm shadow-none focus-visible:ring-0"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask the Main Agent to plan and execute a task..."
                  value={input}
                />
                <div className="flex items-center justify-between border-border/40 border-t bg-muted/20 px-3 py-2">
                  <Select
                    onValueChange={setTargetTerminalId}
                    value={targetTerminalId}
                  >
                    <SelectTrigger className="h-7 w-[160px] border-border/40 bg-background text-xs shadow-none">
                      <div className="flex items-center gap-1.5">
                        <TerminalSquare className="size-3.5 opacity-70" />
                        <SelectValue placeholder="Target Terminal" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Terminals</SelectItem>
                      {activeWorkspace.panes.map((pane) => (
                        <SelectItem key={pane.id} value={pane.id}>
                          {pane.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    className="h-7 gap-1.5 rounded-lg px-3"
                    disabled={!(input.trim() || isTyping)}
                    onClick={() => (isTyping ? handleStop() : handleSend())}
                    size="sm"
                    variant={isTyping ? "destructive" : "default"}
                  >
                    {isTyping ? (
                      <Square className="size-3.5 fill-current" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                    <span>{isTyping ? "Stop" : "Send"}</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
