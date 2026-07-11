"use client";

import { Reveal } from "@workspace/ui/components/marketing/reveal";
import { cn } from "@workspace/ui/lib/utils";
import { useReducedMotion } from "motion/react";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import TextType from "./text-type";

/* ─────────────────────────────────────────────────────────────
   Terminal — the site's one shared terminal window, built from
   three reusable pieces:

     TerminalTyping  — TextType preconfigured with Hyperion's
                        terminal cadence (human-feeling variable
                        speed, block cursor, single pass, starts
                        only once scrolled into view).
     TerminalLine     — one row of output: an optional status
                        glyph (success/warning/error/info — the
                        site's one scoped color exception, see
                        the hyperion-landing-palette rule) plus
                        typed or static text.
     Terminal          — the macOS-style window chrome around a
                        fixed-size, internally-scrolling body.

   Every terminal on the site (hero, features, coding, docs) is
   this one component with different `lines`/`code`, so a change
   here is a change everywhere at once.
──────────────────────────────────────────────────────────── */

export type TerminalLineStatus = "success" | "warning" | "error" | "info";

export interface TerminalLineData {
  status?: TerminalLineStatus;
  text: string;
}

export type TerminalLineInput = string | TerminalLineData;

const STATUS_GLYPH: Record<TerminalLineStatus, string> = {
  success: "✓",
  warning: "!",
  error: "✗",
  info: "→",
};

// Desaturated on purpose (never neon) — the only place besides the
// traffic lights where this site's monochrome rule is deliberately
// relaxed, scoped to semantic success/warning/error meaning only.
const STATUS_CLASS: Record<TerminalLineStatus, string> = {
  success: "text-[#8bbf93]",
  warning: "text-[#cca868]",
  error: "text-[#c98a7f]",
  info: "text-muted-foreground",
};

const CHAR_MS = 42;
const LINE_PAUSE_MS = 950;
const BLANK_LINE_MS = 260;

/** TerminalTyping — TextType preconfigured with Hyperion's terminal
 *  cadence. The one place every terminal's typing animation comes
 *  from, so tuning it once tunes it everywhere. */
export function TerminalTyping({
  text,
  delay = 0,
  className,
  showCursor = true,
}: {
  text: string;
  delay?: number;
  className?: string;
  showCursor?: boolean;
}) {
  return (
    <TextType
      as="span"
      className={className}
      cursorCharacter="▋"
      cursorClassName="ml-0.5 text-primary/80"
      initialDelay={delay}
      loop={false}
      showCursor={showCursor}
      startOnVisible={true}
      text={text}
      typingSpeed={CHAR_MS}
      variableSpeed={{ min: 26, max: 62 }}
    />
  );
}

/** TerminalLine — one row of terminal output. Empty text renders as
 *  a blank spacer between log groups. When typing, the whole row
 *  (status glyph included) waits for its scheduled `delay` before
 *  mounting at all — otherwise every glyph would flash in at once on
 *  mount while only the text trailed in behind it. Once a line
 *  finishes typing its cursor is hidden again (estimated, since
 *  TextType has no completion callback in single-pass mode) unless
 *  it's the terminal's last line, which keeps the resting cursor. */
export function TerminalLine({
  line,
  typing,
  delay = 0,
  isLast = false,
}: {
  line: TerminalLineInput;
  typing: boolean;
  delay?: number;
  isLast?: boolean;
}) {
  const data: TerminalLineData =
    typeof line === "string" ? { text: line } : line;
  const [started, setStarted] = useState(!typing);
  const [finished, setFinished] = useState(!typing);

  useEffect(() => {
    if (!typing) {
      setStarted(true);
      setFinished(true);
      return;
    }
    setStarted(false);
    setFinished(false);
    const startTimer = setTimeout(() => setStarted(true), delay);
    const finishTimer = setTimeout(
      () => setFinished(true),
      delay + data.text.length * CHAR_MS + 150
    );
    return () => {
      clearTimeout(startTimer);
      clearTimeout(finishTimer);
    };
  }, [typing, delay, data.text]);

  if (data.text === "") {
    return <div aria-hidden={true} className="h-3" />;
  }

  if (!started) {
    return null;
  }

  return (
    <div className="flex items-start gap-2 py-0.5">
      {data.status && (
        <span
          className={cn(
            "mt-px shrink-0 font-semibold",
            STATUS_CLASS[data.status]
          )}
        >
          {STATUS_GLYPH[data.status]}
        </span>
      )}
      {typing ? (
        <TerminalTyping showCursor={isLast || !finished} text={data.text} />
      ) : (
        <span>{data.text}</span>
      )}
    </div>
  );
}

// TextType's onSentenceComplete never fires in single-pass (loop=false)
// mode, so sibling lines can't chain off it — instead each line's
// start is pre-scheduled from an estimate of how long the line before
// it takes to finish typing, which is what actually produces the
// "realistic pause between steps" the lines/typed mode is going for.
function estimateDuration(text: string) {
  return text.length * CHAR_MS + LINE_PAUSE_MS;
}

interface TerminalProps extends Omit<React.ComponentProps<"div">, "title"> {
  /** One static or typed block — for real file dumps (config, SDK
   *  usage) where per-line status glyphs don't make sense. */
  code?: string;
  /** Structured CLI session — command + status log, each line typed
   *  in sequence. Use for genuine terminal sessions. */
  lines?: TerminalLineInput[];
  /** Bump to force the whole `lines` sequence to replay from scratch. */
  replayKey?: number;
  /** Right-aligned context label, e.g. "zsh", "shell", "typescript". */
  shell?: string;
  /** Left-aligned window title, next to the traffic lights. */
  title?: string;
  typing?: boolean;
}

/**
 * Terminal — fixed-size viewport like a real terminal app (Warp/
 * iTerm/VS Code): the window never grows with its content. Output
 * scrolls internally and stays pinned to the newest line while
 * typing — unless the visitor has scrolled up to read earlier
 * output, in which case autoscroll pauses until they scroll back
 * down themselves.
 */
export function Terminal({
  className,
  title,
  shell = "zsh",
  lines,
  code,
  typing = false,
  replayKey = 0,
  children,
  ...props
}: TerminalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const reduceMotion = useReducedMotion();
  const animate = typing && !reduceMotion;

  const lineDelays = useMemo(() => {
    if (!lines) {
      return [];
    }
    let running = 0;
    return lines.map((line) => {
      const text = typeof line === "string" ? line : line.text;
      const delay = running;
      running += text === "" ? BLANK_LINE_MS : estimateDuration(text);
      return delay;
    });
  }, [lines]);

  // Auto-scroll: keep pinned to the newest line while output grows,
  // but only while the visitor hasn't manually scrolled up — pinnedRef
  // is the source of truth, flipped by the body's own onScroll below.
  useEffect(() => {
    const el = bodyRef.current;
    if (!(el && animate)) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (pinnedRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [animate]);

  return (
    <Reveal className={className} direction="up" duration={350} offset={32}>
      <div
        className="mx-auto flex h-[360px] w-full max-w-[1000px] flex-col overflow-hidden rounded-xl border border-border bg-card/60 shadow-2xl shadow-black/40 backdrop-blur-sm md:h-[440px] lg:h-[500px]"
        data-slot="terminal"
        {...props}
      >
        <div className="flex shrink-0 items-center gap-2 border-border border-b bg-muted/30 px-4 py-2.5">
          <span
            aria-hidden={true}
            className="size-2.5 rounded-full bg-[#ec6a5e]"
          />
          <span
            aria-hidden={true}
            className="size-2.5 rounded-full bg-[#f4bf4f]"
          />
          <span
            aria-hidden={true}
            className="size-2.5 rounded-full bg-[#61c454]"
          />
          {title && (
            <span className="ml-2 truncate font-mono text-muted-foreground text-xs">
              {title}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
            {shell}
          </span>
        </div>
        <div
          className="landing-terminal-scroll flex-1 overflow-y-auto overflow-x-hidden p-4 [overscroll-behavior:contain]"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          }}
          ref={bodyRef}
        >
          {children ??
            (lines ? (
              <div
                className="font-mono text-foreground/85 text-sm"
                key={replayKey}
              >
                {lines.map((line, i) => (
                  <TerminalLine
                    delay={lineDelays[i]}
                    isLast={i === lines.length - 1}
                    // biome-ignore lint/suspicious/noArrayIndexKey: line order is static per Terminal instance, never reordered at runtime
                    key={i}
                    line={line}
                    typing={animate}
                  />
                ))}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-foreground/85 text-sm leading-relaxed">
                {animate && code ? (
                  <TerminalTyping text={code} />
                ) : (
                  <code>{code}</code>
                )}
              </pre>
            ))}
        </div>
      </div>
    </Reveal>
  );
}
