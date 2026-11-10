/**
 * Synthetic micro-benchmark: PromptRenderer throughput on a fixed template.
 * No network, no credentials. Results are for relative regression tracking only.
 *
 *   npx ts-node examples/eval-prompt-render.ts
 */
import { PromptRenderer } from "../src/engine/PromptRenderer";

const renderer = new PromptRenderer();
const template =
  "Date {{current_date}} | Topics {{topics}} | Note {{note}} | " +
  "Repeat {{current_datetime}} | Day {{day_of_week}}";
const vars = renderer.injectDefaults({
  topics: '["a","b","c","d"]',
  note: "synthetic benchmark row",
});

const iterations = 50_000;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  renderer.render(template, vars);
}
const elapsedMs = performance.now() - start;

console.log(
  JSON.stringify(
    {
      label: "synthetic_prompt_render",
      iterations,
      elapsed_ms: Math.round(elapsedMs * 100) / 100,
      renders_per_second: Math.round((iterations / elapsedMs) * 1000),
    },
    null,
    2,
  ),
);
