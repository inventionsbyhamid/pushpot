import confetti from "canvas-confetti";

export function celebrate() {
  const style = getComputedStyle(document.documentElement);
  const colors = ["--color-volt", "--color-chalk", "--color-amber"]
    .map((name) => style.getPropertyValue(name).trim())
    .filter(Boolean);
  void confetti({
    particleCount: 150,
    spread: 85,
    startVelocity: 45,
    origin: { y: 0.7 },
    colors,
    disableForReducedMotion: true,
  });
}
