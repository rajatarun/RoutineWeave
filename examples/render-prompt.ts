/**
 * Offline example: render a task prompt with built-in date variables (no API keys).
 *
 *   npx ts-node examples/render-prompt.ts
 */
import { PromptRenderer } from "../src/engine/PromptRenderer";

const renderer = new PromptRenderer();

const template = `
Today is {{current_date}} ({{day_of_week}}).
Summarize developments for: {{topics}}.
Region: {{region}}.
`.trim();

const vars = renderer.injectDefaults({
  topics: JSON.stringify(["releases", "research"]),
  region: "global",
});

const rendered = renderer.render(template, vars);

console.log("--- Rendered prompt ---\n");
console.log(rendered);
