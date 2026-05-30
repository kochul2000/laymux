import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaneNumberBadge } from "./PaneNumberBadge";

describe("PaneNumberBadge", () => {
  it("renders the pane number", () => {
    render(<PaneNumberBadge number={3} />);
    const badge = screen.getByTestId("pane-number-badge");
    expect(badge).toHaveTextContent("3");
  });

  it("renders nothing when number is undefined", () => {
    const { container } = render(<PaneNumberBadge number={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("pane-number-badge")).toBeNull();
  });
});
