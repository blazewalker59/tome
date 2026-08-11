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
  it("renders title, authors, and the rarity label exactly once, on the back face", () => {
    renderWithProviders(<Card card={sampleCard} />);
    // The front face is a full-bleed cover with no text, so every piece of
    // metadata resolves to exactly one node. These are singular `getBy*`
    // queries on purpose — each throws on a second match, so reintroducing a
    // title/author strip on the front face fails here rather than silently
    // passing the way a ">= 1" assertion would.
    //
    // The title is checked twice, by role and by text: the role query pins it
    // as a real heading, while the text query is element-agnostic and so also
    // catches a duplicate rendered as a plain <p>.
    expect(screen.getByRole("heading", { name: /piranesi/i })).toBeInTheDocument();
    expect(screen.getByText("Piranesi")).toBeInTheDocument();
    expect(screen.getByText("Susanna Clarke")).toBeInTheDocument();
    expect(screen.getByText("Legendary")).toBeInTheDocument();
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

  it("flips via transform only — both faces stay mounted, nothing is added or removed", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<Card card={sampleCard} />);
    const button = screen.getByRole("button", { name: /piranesi/i });

    // The two faces are always both in the DOM; `[backface-visibility:hidden]`
    // plus a rotateY transform is what hides one of them. Nothing is
    // conditionally mounted, so the flip cannot drop or duplicate content.
    //
    // The cover is queried through the container because it renders with
    // `alt=""` (it's decorative — the back face carries the real title), which
    // makes it presentational and therefore invisible to role queries.
    const faceContent = () => ({
      covers: container.querySelectorAll("img").length,
      titles: screen.getAllByText("Piranesi").length,
      descriptions: screen.getAllByText(/infinite house of statues/i).length,
    });

    const before = faceContent();
    // Front: one cover. Back: one title, one synopsis. No duplication anywhere.
    expect(before).toEqual({ covers: 1, titles: 1, descriptions: 1 });

    await user.click(button);

    expect(faceContent()).toEqual(before);
  });
});
