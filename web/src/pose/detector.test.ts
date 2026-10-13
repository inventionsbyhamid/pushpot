import { afterEach, describe, expect, it, vi } from "vitest";
import { preferredBackend } from "./detector";

const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";

function device(userAgent: string, { search = "", platform = "MacIntel", maxTouchPoints = 0 } = {}) {
  vi.stubGlobal("location", { search });
  vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferredBackend", () => {
  it("keeps desktops off the GPU", () => {
    device(DESKTOP_CHROME);
    expect(preferredBackend()).toEqual({ delegate: "CPU", worker: true });
  });

  it("uses the GPU on phones", () => {
    device(ANDROID_CHROME, { platform: "Linux armv8l", maxTouchPoints: 5 });
    expect(preferredBackend().delegate).toBe("GPU");
    device(IPHONE_SAFARI, { platform: "iPhone", maxTouchPoints: 5 });
    expect(preferredBackend().delegate).toBe("GPU");
  });

  it("recognises iPads that report themselves as Macs", () => {
    device(IPAD_SAFARI, { maxTouchPoints: 5 });
    expect(preferredBackend().delegate).toBe("GPU");
  });

  it("honours URL overrides for testing", () => {
    device(DESKTOP_CHROME, { search: "?delegate=gpu&pose=main" });
    expect(preferredBackend()).toEqual({ delegate: "GPU", worker: false });
    device(ANDROID_CHROME, { search: "?delegate=cpu", maxTouchPoints: 5 });
    expect(preferredBackend().delegate).toBe("CPU");
  });

  it("ignores unknown override values", () => {
    device(DESKTOP_CHROME, { search: "?delegate=tpu" });
    expect(preferredBackend().delegate).toBe("CPU");
  });
});
