import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ViewShell } from "./ViewShell";
import { ViewBody } from "./ViewBody";
import { ViewHeader } from "./ViewHeader";

describe("ViewShell", () => {
  it("renders children", () => {
    render(
      <ViewShell>
        <div data-testid="child">hello</div>
      </ViewShell>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("applies testId as data-testid", () => {
    render(<ViewShell testId="my-view">content</ViewShell>);
    expect(screen.getByTestId("my-view")).toBeInTheDocument();
  });

  it("has flex column layout classes", () => {
    render(<ViewShell testId="shell">content</ViewShell>);
    const el = screen.getByTestId("shell");
    expect(el.className).toContain("flex");
    expect(el.className).toContain("flex-col");
    expect(el.className).toContain("h-full");
    expect(el.className).toContain("w-full");
  });

  it("passes extra className", () => {
    render(
      <ViewShell testId="shell" className="extra">
        content
      </ViewShell>,
    );
    expect(screen.getByTestId("shell").className).toContain("extra");
  });

  it("passes style prop", () => {
    render(
      <ViewShell testId="shell" style={{ outline: "none" }}>
        content
      </ViewShell>,
    );
    expect(screen.getByTestId("shell").style.outline).toBe("none");
  });
});

describe("ViewBody", () => {
  it("renders children", () => {
    render(
      <ViewBody>
        <div data-testid="body-child">content</div>
      </ViewBody>,
    );
    expect(screen.getByTestId("body-child")).toBeInTheDocument();
  });

  it('default variant "scroll" has flex-1 and overflow-auto', () => {
    render(<ViewBody testId="body">content</ViewBody>);
    const el = screen.getByTestId("body");
    expect(el.className).toContain("flex-1");
    expect(el.className).toContain("overflow-auto");
  });

  it('variant "full" has relative flex-1 without overflow-auto', () => {
    render(
      <ViewBody testId="body" variant="full">
        content
      </ViewBody>,
    );
    const el = screen.getByTestId("body");
    expect(el.className).toContain("flex-1");
    expect(el.className).toContain("relative");
    expect(el.className).not.toContain("overflow-auto");
  });

  it("passes className and style", () => {
    render(
      <ViewBody testId="body" className="p-4" style={{ color: "red" }}>
        content
      </ViewBody>,
    );
    const el = screen.getByTestId("body");
    expect(el.className).toContain("p-4");
    expect(el.style.color).toBe("red");
  });
});

describe("ViewHeader", () => {
  it("renders children", () => {
    render(<ViewHeader>My Title</ViewHeader>);
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("uses ui-toolbar class", () => {
    render(<ViewHeader testId="header">Title</ViewHeader>);
    const el = screen.getByTestId("header");
    expect(el.className).toContain("ui-toolbar");
    expect(el.className).toContain("shrink-0");
  });

  it("has default border-bottom", () => {
    render(<ViewHeader testId="header">Title</ViewHeader>);
    const el = screen.getByTestId("header");
    expect(el.style.borderBottom).toContain("1px solid");
  });

  it("borderBottom=false removes border", () => {
    render(
      <ViewHeader testId="header" borderBottom={false}>
        Title
      </ViewHeader>,
    );
    const el = screen.getByTestId("header");
    expect(el.style.borderBottom).toBe("");
  });

  it("passes extra className", () => {
    render(
      <ViewHeader testId="header" className="px-1">
        Title
      </ViewHeader>,
    );
    expect(screen.getByTestId("header").className).toContain("px-1");
  });

  it("works standalone without PaneControlContext", () => {
    render(<ViewHeader testId="header">Standalone</ViewHeader>);
    // No pane controls should appear — just the children
    expect(screen.getByText("Standalone")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-control-bar-content")).not.toBeInTheDocument();
  });
});
