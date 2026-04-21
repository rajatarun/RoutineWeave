import { PromptRenderer } from "../engine/PromptRenderer";

describe("PromptRenderer", () => {
  let renderer: PromptRenderer;

  beforeEach(() => {
    renderer = new PromptRenderer();
  });

  it("returns template unchanged when no variables", () => {
    const template = "Hello world";
    expect(renderer.render(template)).toBe("Hello world");
  });

  it("substitutes known variables", () => {
    const template = "Hello {{name}}, today is {{date}}";
    const result = renderer.render(template, { name: "Alice", date: "2024-01-01" });
    expect(result).toBe("Hello Alice, today is 2024-01-01");
  });

  it("leaves unknown placeholders untouched", () => {
    const template = "Hello {{name}}, {{unknown}} variable";
    const result = renderer.render(template, { name: "Bob" });
    expect(result).toBe("Hello Bob, {{unknown}} variable");
  });

  it("handles whitespace inside placeholders", () => {
    const template = "Value: {{ key }}";
    const result = renderer.render(template, { key: "test" });
    expect(result).toBe("Value: test");
  });

  it("injectDefaults adds current_date and current_datetime", () => {
    const defaults = renderer.injectDefaults({ custom: "value" });
    expect(defaults).toHaveProperty("current_date");
    expect(defaults).toHaveProperty("current_datetime");
    expect(defaults).toHaveProperty("day_of_week");
    expect(defaults.custom).toBe("value");
  });

  it("user variables override defaults", () => {
    const defaults = renderer.injectDefaults({ current_date: "custom-date" });
    expect(defaults.current_date).toBe("custom-date");
  });
});
