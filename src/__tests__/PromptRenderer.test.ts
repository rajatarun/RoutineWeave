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

describe("PromptRenderer — array input values", () => {
  let renderer: PromptRenderer;

  beforeEach(() => {
    renderer = new PromptRenderer();
  });

  it("stringifies array values via JSON.stringify", () => {
    const result = renderer.render("Topics: {{topics}}", {
      topics: ["AI", "ML", "robotics"],
    });
    expect(result).toBe('Topics: ["AI","ML","robotics"]');
  });

  it("handles mixed string and array inputs in one template", () => {
    const result = renderer.render("On {{date}}, focus on {{tags}}", {
      date: "2024-01-15",
      tags: ["news", "research"],
    });
    expect(result).toBe('On 2024-01-15, focus on ["news","research"]');
  });

  it("handles empty array", () => {
    const result = renderer.render("Items: {{list}}", { list: [] });
    expect(result).toBe("Items: []");
  });

  it("handles single-element array", () => {
    const result = renderer.render("Tag: {{t}}", { t: ["only"] });
    expect(result).toBe('Tag: ["only"]');
  });

  it("input values override variables of the same key", () => {
    const base = renderer.injectDefaults({ greeting: "hello" });
    const merged = { ...base, greeting: ["hi", "hey"] };
    const result = renderer.render("{{greeting}}", merged);
    expect(result).toBe('["hi","hey"]');
  });
});
