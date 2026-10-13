import { darkTheme, type Theme } from "@rainbow-me/rainbowkit";

const base = darkTheme({
  accentColor: "var(--color-volt)",
  accentColorForeground: "var(--color-ink)",
  borderRadius: "medium",
  overlayBlur: "small",
});

/** RainbowKit themed from the app's CSS tokens so wallet modals feel native. */
export const rainbowTheme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    connectButtonBackground: "var(--color-raised)",
    connectButtonInnerBackground: "var(--color-panel)",
    connectButtonText: "var(--color-chalk)",
    connectButtonBackgroundError: "var(--color-flare)",
    error: "var(--color-flare)",
    standby: "var(--color-amber)",
    connectionIndicator: "var(--color-volt)",
    modalBackground: "var(--color-panel)",
    modalBorder: "var(--color-line)",
    generalBorder: "var(--color-line)",
    modalText: "var(--color-chalk)",
    modalTextSecondary: "var(--color-mute)",
    modalBackdrop: "rgba(0, 0, 0, 0.6)",
  },
  fonts: { body: "var(--font-sans)" },
  shadows: { ...base.shadows, connectButton: "none" },
};
