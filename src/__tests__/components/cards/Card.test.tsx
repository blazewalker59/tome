// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { Card } from "@/components/cards/Card";
import { renderWithProviders, screen } from "@test/utils";
import type { CardData } from "@/lib/cards/types";

const sampleCard: CardData = {
  id: "test-card",
  title: "Piranesi",
  authors: ["Susanna Clarke"],
  coverUrl: "https://example.test/cover.jpg",
  description: "A man wanders an infinite house of statues and tides.",
  pageCount: 272,
  publishedYear: 2020,
  genre: "fantasy",
  rarity: "legendary",
  moodTags: ["dreamlike", "literary", "lonely"],
};

describe("<Card>", () => {
  it("renders title, authors, and the rarity label", () => {
    renderWithProviders(<Card card={sampleCard} />);
    // Title and authors appear on both card faces (front + back are both in DOM).
    expect(screen.getAllByRole("heading", { name: /piranesi/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Susanna Clarke").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Legendary").length).toBeGreaterThanOrEqual(1);
  });

  it("limits visible mood tags to 3", () => {
    const overflowing: CardData = {
      ...sampleCard,
      moodTags: ["a", "b", "c", "d", "e"],
    };
    renderWithProviders(<Card card={overflowing} />);
    for (const tag of ["a", "b", "c"]) {
      expect(screen.getByText(tag)).toBeInTheDocument();
    }
    expect(screen.queryByText("d")).not.toBeInTheDocument();
    expect(screen.queryByText("e")).not.toBeInTheDocument();
  });

  it("has an accessible name describing the card", () => {
    renderWithProviders(<Card card={sampleCard} />);
    const button = screen.getByRole("button", { name: /piranesi/i });
    expect(button).toHaveAttribute("aria-label", expect.stringContaining("Legendary"));
    expect(button.getAttribute("aria-label")).toContain("Susanna Clarke");
  });

  it("keeps only one front face in DOM (back face is mirrored 3D, not duplicated content node)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Card card={sampleCard} />);
    const button = screen.getByRole("button", { name: /piranesi/i });
    // Title appears once on each face — both are in DOM (CSS backface flips).
    expect(screen.getAllByText("Piranesi")).toHaveLength(2);
    await user.click(button);
    // Click is a flip toggle; nothing is added or removed from the DOM.
    expect(screen.getAllByText("Piranesi")).toHaveLength(2);
  });
});
