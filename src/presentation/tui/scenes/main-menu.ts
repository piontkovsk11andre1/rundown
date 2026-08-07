// @ts-nocheck
import { createStatusProbeRegistry } from "../status-probes.ts";

export type MainMenuSceneId = "start" | "continue" | "newWork" | "workers" | "profiles" | "settings" | "help";
export type MainMenuVariant = "initialized" | "emptyBootstrap";

export type MainMenuState = {
  selectedIndex: number;
  variant: MainMenuVariant;
};

export type MainMenuItem = {
  sceneId: MainMenuSceneId;
  label: string;
  probeId: string;
};

const INITIALIZED_MAIN_MENU_ITEMS: readonly MainMenuItem[] = Object.freeze([
  { sceneId: "continue", label: "Continue", probeId: "continue" },
  { sceneId: "newWork", label: "New Work", probeId: "newWork" },
  { sceneId: "workers", label: "Workers", probeId: "workers" },
  { sceneId: "profiles", label: "Profiles", probeId: "profiles" },
  { sceneId: "settings", label: "Settings", probeId: "settings" },
  { sceneId: "help", label: "Help", probeId: "help" },
]);

const EMPTY_BOOTSTRAP_MAIN_MENU_ITEMS: readonly MainMenuItem[] = Object.freeze([
  { sceneId: "start", label: "Start", probeId: "start" },
  { sceneId: "workers", label: "Workers", probeId: "workers" },
  { sceneId: "help", label: "Help", probeId: "help" },
]);

const statusProbeRegistry = createStatusProbeRegistry();

function getMainMenuItemsForVariant(variant: MainMenuVariant): readonly MainMenuItem[] {
  if (variant === "emptyBootstrap") {
    return EMPTY_BOOTSTRAP_MAIN_MENU_ITEMS;
  }
  return INITIALIZED_MAIN_MENU_ITEMS;
}

function resolveMainMenuVariant(variant: unknown): MainMenuVariant {
  return variant === "emptyBootstrap" ? "emptyBootstrap" : "initialized";
}

function normalizeSelectionIndex(index: number, variant: MainMenuVariant): number {
  const items = getMainMenuItemsForVariant(variant);
  if (!Number.isInteger(index) || items.length === 0) {
    return 0;
  }
  const limit = items.length;
  return ((index % limit) + limit) % limit;
}

export function createMainMenuSceneState({ variant = "initialized" }: { variant?: MainMenuVariant } = {}): MainMenuState {
  return { selectedIndex: 0, variant: resolveMainMenuVariant(variant) };
}

export function getMainMenuItems(state?: MainMenuState) {
  return getMainMenuItemsForVariant(resolveMainMenuVariant(state?.variant));
}

export function getMainMenuRows(state: MainMenuState, { probeRegistry = statusProbeRegistry } = {}) {
  const variant = resolveMainMenuVariant(state?.variant);
  const menuItems = getMainMenuItemsForVariant(variant);
  const selectedIndex = normalizeSelectionIndex(state?.selectedIndex ?? 0, variant);
  return menuItems.map((item, index) => {
    const status = probeRegistry.getProbeStatus(item.probeId);
    const workersDrilldownHint = item.sceneId === "workers" ? "   (H: health · T: tools)" : "";
    const profilesDrilldownHint = item.sceneId === "profiles" ? "   (↵: inspect · e: edit · u: scan)" : "";
    return {
      sceneId: item.sceneId,
      label: item.label,
      statusText: `${status.text}${workersDrilldownHint}${profilesDrilldownHint}`,
      statusTone: status.tone,
      isActive: index === selectedIndex,
      index,
    };
  });
}

export async function refreshMainMenuStatuses({ probeRegistry = statusProbeRegistry } = {}) {
  await refreshVisibleMainMenuStatuses(undefined, { probeRegistry });
}

export async function refreshVisibleMainMenuStatuses(
  state?: MainMenuState,
  { probeRegistry = statusProbeRegistry } = {},
) {
  const menuItems = getMainMenuItems(state);
  const visibleProbeIds = Array.from(new Set(menuItems.map((item) => item.probeId)));
  await Promise.all(visibleProbeIds.map((probeId) => probeRegistry.refreshProbe(probeId)));
}

export async function refreshMainMenuStatusProbe(probeId: string, { probeRegistry = statusProbeRegistry } = {}) {
  if (typeof probeId !== "string" || probeId.length === 0) {
    return;
  }
  await probeRegistry.refreshProbe(probeId);
}

export function getSelectedMainMenuItem(state: MainMenuState): MainMenuItem {
  const variant = resolveMainMenuVariant(state?.variant);
  const menuItems = getMainMenuItemsForVariant(variant);
  const selectedIndex = normalizeSelectionIndex(state?.selectedIndex ?? 0, variant);
  return menuItems[selectedIndex];
}

export function moveMainMenuSelection(state: MainMenuState, delta: number): MainMenuState {
  const variant = resolveMainMenuVariant(state?.variant);
  const selectedIndex = normalizeSelectionIndex((state?.selectedIndex ?? 0) + delta, variant);
  return { selectedIndex, variant };
}

export function jumpMainMenuSelection(state: MainMenuState, oneBasedIndex: string): MainMenuState {
  const variant = resolveMainMenuVariant(state?.variant);
  const menuItems = getMainMenuItemsForVariant(variant);
  const target = Number.parseInt(String(oneBasedIndex), 10);
  if (!Number.isInteger(target) || target < 1 || target > menuItems.length) {
    return state ?? createMainMenuSceneState({ variant });
  }
  return { selectedIndex: target - 1, variant };
}

export function handleMainMenuInput(state: MainMenuState, rawInput: string) {
  const currentState = state ?? createMainMenuSceneState();
  const input = String(rawInput ?? "");
  const lowerInput = input.toLowerCase();
  const isEnter = input === "\r" || input === "\n";
  const isArrowUp = input === "\u001b[A";
  const isArrowDown = input === "\u001b[B";

  if (isArrowUp || lowerInput === "k") {
    return {
      handled: true,
      state: moveMainMenuSelection(currentState, -1),
      routeTo: null,
    };
  }

  if (isArrowDown || lowerInput === "j") {
    return {
      handled: true,
      state: moveMainMenuSelection(currentState, 1),
      routeTo: null,
    };
  }

  if (/^[1-9]$/.test(lowerInput)) {
    return {
      handled: true,
      state: jumpMainMenuSelection(currentState, lowerInput),
      routeTo: null,
    };
  }

  if (isEnter) {
    const selected = getSelectedMainMenuItem(currentState);
    return {
      handled: true,
      state: currentState,
      routeTo: selected?.sceneId ?? null,
    };
  }

  return {
    handled: false,
    state: currentState,
    routeTo: null,
  };
}
