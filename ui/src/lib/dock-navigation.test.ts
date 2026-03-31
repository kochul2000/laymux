import { describe, it, expect } from "vitest";
import { getDockForDirection, getDockExitDirection } from "./dock-navigation";

describe("dock-navigation", () => {
  describe("getDockForDirection", () => {
    it("maps left → left dock", () => {
      expect(getDockForDirection("left")).toBe("left");
    });
    it("maps right → right dock", () => {
      expect(getDockForDirection("right")).toBe("right");
    });
    it("maps up → top dock", () => {
      expect(getDockForDirection("up")).toBe("top");
    });
    it("maps down → bottom dock", () => {
      expect(getDockForDirection("down")).toBe("bottom");
    });
  });

  describe("getDockExitDirection", () => {
    it("left dock exits via right", () => {
      expect(getDockExitDirection("left")).toBe("right");
    });
    it("right dock exits via left", () => {
      expect(getDockExitDirection("right")).toBe("left");
    });
    it("top dock exits via down", () => {
      expect(getDockExitDirection("top")).toBe("down");
    });
    it("bottom dock exits via up", () => {
      expect(getDockExitDirection("bottom")).toBe("up");
    });
  });
});
