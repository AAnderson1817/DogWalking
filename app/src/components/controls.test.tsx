import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { Input, Select, Textarea } from "./fields";

describe("interactive controls", () => {
  it("keeps button variants and disabled state available to the visual system", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain("btn--primary");
    expect(renderToStaticMarkup(<Button variant="ghost">Cancel</Button>)).toContain("btn--ghost");
    expect(renderToStaticMarkup(<Button variant="danger">Delete</Button>)).toContain("btn--danger");
    expect(renderToStaticMarkup(<Button disabled>Unavailable</Button>)).toContain("disabled");
  });

  it("associates visible input errors with their controls", () => {
    const html = renderToStaticMarkup(
      <Input id="client-email" label="Email" error="Enter a valid email" />,
    );

    expect(html).toContain('id="client-email"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="client-email-error"');
    expect(html).toContain('aria-errormessage="client-email-error"');
    expect(html).toContain('id="client-email-error"');
  });

  it("preserves caller descriptions when an error is also present", () => {
    const html = renderToStaticMarkup(
      <Textarea
        id="walk-notes"
        label="Notes"
        aria-describedby="walk-notes-help"
        error="Notes are required"
      />,
    );

    expect(html).toContain('aria-describedby="walk-notes-help walk-notes-error"');
  });

  it("uses the provided select id for its label and error relationship", () => {
    const html = renderToStaticMarkup(
      <Select id="service" label="Service" error="Choose a service">
        <option>Private walk</option>
      </Select>,
    );

    expect(html).toContain('for="service"');
    expect(html).toContain('aria-describedby="service-error"');
  });
});
