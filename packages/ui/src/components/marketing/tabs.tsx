"use client";

import { cn } from "@workspace/ui/lib/utils";
import { useState } from "react";
import type * as React from "react";

interface Tab {
  id: string;
  label: string;
}

interface MarketingTabsProps {
  tabs: Tab[];
  variant?: "pill" | "segmented";
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  className?: string;
}

export function MarketingTabs({
  tabs,
  variant = "pill",
  activeTab: controlledTab,
  onTabChange,
  className,
}: MarketingTabsProps) {
  const [internalTab, setInternalTab] = useState(tabs[0]?.id ?? "");
  const isControlled = controlledTab !== undefined;
  const active = isControlled ? controlledTab : internalTab;

  const handleClick = (tabId: string) => {
    if (!isControlled) setInternalTab(tabId);
    onTabChange?.(tabId);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap gap-2",
        variant === "segmented" && "gap-0 border-b border-mistral-hairline",
        className
      )}
      data-slot="marketing-tabs"
      data-variant={variant}
    >
      {tabs.map((tab) => (
        <button
          className={cn(
            "transition-colors",
            variant === "pill" && [
              "rounded-full border px-4 py-2 text-body-sm-medium",
              tab.id === active
                ? "border-mistral-ink bg-mistral-ink text-mistral-on-dark"
                : "border-mistral-hairline bg-mistral-canvas text-mistral-steel hover:border-mistral-hairline-strong",
            ],
            variant === "segmented" && [
              "border-b-2 border-transparent px-4 py-3 text-body-sm-medium",
              tab.id === active
                ? "border-b-2 border-mistral-primary text-mistral-primary"
                : "text-mistral-steel hover:text-mistral-ink",
            ]
          )}
          key={tab.id}
          onClick={() => handleClick(tab.id)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
