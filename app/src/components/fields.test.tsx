import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormError, Input } from "./fields";

describe("FormError", () => {
  it("renders the live region even with no message", () => {
    // The point of the component: role="alert" announced reliably requires
    // the region to be in the accessibility tree BEFORE the text arrives.
    const html = renderToStaticMarkup(<FormError message={null} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("form-error");
  });

  it("leaves the empty region with no children, so `:empty` collapses it", () => {
    const html = renderToStaticMarkup(<FormError message={null} />);
    expect(html).toMatch(/<span[^>]*><\/span>/);
    expect(renderToStaticMarkup(<FormError message="" />)).toMatch(/<span[^>]*><\/span>/);
  });

  it("renders the message when there is one", () => {
    const html = renderToStaticMarkup(<FormError message="Card declined." />);
    expect(html).toContain("Card declined.");
    expect(html).toContain('role="alert"');
  });
});

describe("Input", () => {
  it("keeps a stable error id and only points at it while invalid", () => {
    const clean = renderToStaticMarkup(<Input label="Email" />);
    expect(clean).toContain('role="alert"');
    expect(clean).not.toContain("aria-invalid");
    expect(clean).not.toContain("aria-describedby");

    const invalid = renderToStaticMarkup(<Input label="Email" error="Required." />);
    expect(invalid).toContain('aria-invalid="true"');
    const errorId = /aria-errormessage="([^"]+)"/.exec(invalid)?.[1];
    expect(errorId).toBeTruthy();
    expect(invalid).toContain(`aria-describedby="${errorId}"`);
    expect(invalid).toContain(`id="${errorId}"`);
  });
});
