import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { BrowserPreviewView } from "./BrowserPreviewView";

describe("BrowserPreviewView", () => {
  it("renders with default url", () => {
    render(<BrowserPreviewView />);
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument();
  });

  it("renders with provided url", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    const input = screen.getByTestId("browser-url-input") as HTMLInputElement;
    expect(input.value).toBe("http://localhost:3000");
  });

  it("renders iframe with the url", () => {
    render(<BrowserPreviewView url="http://localhost:8080" />);
    const iframe = screen.getByTestId("browser-iframe") as HTMLIFrameElement;
    expect(iframe.src).toBe("http://localhost:8080/");
  });

  it("has a reload button", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    expect(screen.getByTestId("browser-reload-btn")).toBeInTheDocument();
  });

  it("navigates to new url on enter", async () => {
    const user = userEvent.setup();
    render(<BrowserPreviewView url="http://localhost:3000" />);

    const input = screen.getByTestId("browser-url-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "http://localhost:8080{Enter}");

    const iframe = screen.getByTestId("browser-iframe") as HTMLIFrameElement;
    expect(iframe.src).toBe("http://localhost:8080/");
  });

  it("has back and forward buttons", () => {
    render(<BrowserPreviewView url="http://localhost:3000" />);
    expect(screen.getByTestId("browser-back-btn")).toBeInTheDocument();
    expect(screen.getByTestId("browser-forward-btn")).toBeInTheDocument();
  });
});
